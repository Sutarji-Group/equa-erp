/**
 * M6 — handler perintah sinkron POS (outbox offline, docs/ARCHITECTURE.md §7; US-M6-06) + penyedia pull `m6.pos`.
 *
 * Semua aksi POS adalah perintah lapangan idempoten (ID perintah = ID klien; ID objek dibuat di perangkat):
 * | Perintah                         | Layanan                    | Izin (depot / toko)                                  |
 * |----------------------------------|----------------------------|------------------------------------------------------|
 * | `m6.shift.open`                  | `openShift`                | m6.shift.open / m7.shift.open                        |
 * | `m6.pos_sale.create`             | `recordSale`               | m6.pos_sale.create / m7.pos_sale.create              |
 * | `m6.pos_sale.void`               | `voidSale`                 | m6.pos_sale.void / m7.pos_sale.void                  |
 * | `m6.shift_deposit.partial`       | `recordPartialDeposit`     | m6.shift_deposit.create / m7.shift_deposit.create    |
 * | `m6.shift.close`                 | `closeShift`               | m6.shift.close / m7.shift.close                      |
 * | `m6.shift_deposit.submit`        | `submitShiftDeposit`       | m6.shift_deposit.create / m7.shift_deposit.create    |
 * | `m6.water_supply.confirm`        | `confirmWaterSupply`       | m6.water_supply.confirm                              |
 * | `m6.water_supply.record_other`   | `recordOtherSupply`        | m6.water_supply.confirm                              |
 * | `m6.consumable_receipt.create`   | `recordConsumableReceipt`  | m6.consumable_receipt.create                         |
 * | `m6.internal_transfer.receive`   | `receiveInternalTransfer`  | m6.internal_transfer.receive                         |
 * | `m6.stock_count.submit`          | `submitStockCount`         | m6.stock_count.create / m7.stock_count.create        |
 * Izin spesifik jenis outlet diperiksa ulang di layanan lewat `PosKindPolicy` (depot → m6.*, toko → m7.*).
 */
import "server-only";

import { fieldMetaValues, registerPullProvider, registerSyncHandler, type SyncMeta } from "@/server/core/sync";

import type { FieldWriteMeta } from "./service/common";
import { buildPosReference } from "./service/pull";
import { recordSale, recordSaleSchema, voidSale, voidSaleSchema } from "./service/sales";
import {
  closeShift,
  closeShiftSchema,
  openShift,
  openShiftSchema,
  partialDepositSchema,
  recordPartialDeposit,
  submitShiftDeposit,
  submitShiftDepositSchema,
} from "./service/shifts";
import {
  consumableReceiptSchema,
  receiveInternalTransfer,
  receiveTransferSchema,
  recordConsumableReceipt,
  stockCountSchema,
  submitStockCount,
} from "./service/stock";
import { confirmSupplySchema, confirmWaterSupply, otherSupplySchema, recordOtherSupply } from "./service/water";

/** `SyncMeta` → konteks tulis layanan M6. */
export function toFieldWriteMeta(meta: SyncMeta): FieldWriteMeta {
  return {
    tx: meta.tx,
    device: meta.device,
    deviceTime: meta.command.deviceTime,
    businessDate: meta.command.businessDate,
    commandId: meta.command.id,
    fieldValues: fieldMetaValues(meta),
    attachmentIds: meta.command.attachmentIds,
  };
}

function withConflict<T extends Record<string, unknown>>(base: T, conflict: string | null | undefined) {
  return conflict ? { ...base, status: "conflict" as const, message: conflict } : base;
}

/** Koleksi delta pull `m6.pos` (jalur → ukuran ember sasaran). */
export const POS_PULL_COLLECTIONS = {
  "openShift.sales": 16,
  "openShift.openingStock": 8,
  conflictShifts: 1,
  materials: 1,
  recipes: 8,
  transfers: 2,
  history: 4,
} as const;

export function registerSync(): void {
  registerSyncHandler("m6.shift.open", {
    permission: ["m6.shift.open", "m7.shift.open"],
    schema: openShiftSchema,
    labels: { openingCashCounted: "Kas awal (hitung fisik)" },
    description: "Buka shift POS (kas awal tetap dikonfirmasi hitung fisik).",
    handle: async (ctx, payload, meta) => {
      const res = await openShift(ctx, payload, toFieldWriteMeta(meta));
      return withConflict({ objectType: "shift", objectId: res.shift.id, result: { syncConflict: res.shift.syncConflict } }, res.conflict);
    },
  });

  registerSyncHandler("m6.pos_sale.create", {
    permission: ["m6.pos_sale.create", "m7.pos_sale.create"],
    schema: recordSaleSchema,
    labels: { lines: "Barang", cashReceived: "Uang diterima", localNumber: "Nomor lokal" },
    description: "Transaksi POS (tunai/QRIS statis).",
    handle: async (ctx, payload, meta) => {
      const res = await recordSale(ctx, payload, toFieldWriteMeta(meta));
      return withConflict(
        {
          objectType: "pos_sale",
          objectId: res.sale.id,
          result: { number: res.sale.number, localNumber: res.sale.localNumber, total: res.sale.total, priceMismatch: res.priceMismatch, cashAlert: res.cashAlert },
        },
        res.conflict,
      );
    },
  });

  registerSyncHandler("m6.pos_sale.void", {
    permission: ["m6.pos_sale.void", "m7.pos_sale.void"],
    schema: voidSaleSchema,
    labels: { reason: "Alasan void", note: "Keterangan" },
    description: "Void transaksi POS beralasan (> PAR-04 menunggu persetujuan pemilik).",
    handle: async (ctx, payload, meta) => {
      const res = await voidSale(ctx, payload, toFieldWriteMeta(meta));
      return {
        objectType: "pos_sale",
        objectId: res.sale.id,
        result: { status: res.status, approvalNumber: res.approval?.number ?? null, excessiveVoids: res.excessiveVoids },
      };
    },
  });

  registerSyncHandler("m6.shift_deposit.partial", {
    permission: ["m6.shift_deposit.create", "m7.shift_deposit.create"],
    schema: partialDepositSchema,
    labels: { amount: "Jumlah setor" },
    description: "Setor sebagian (setor bank + foto slip) saat kas melebihi PAR-02.",
    handle: async (ctx, payload, meta) => {
      const res = await recordPartialDeposit(ctx, payload, toFieldWriteMeta(meta));
      return { objectType: "deposit", objectId: res.deposit.id, result: { number: res.deposit.number, partialDepositTotal: res.partialDepositTotal } };
    },
  });

  registerSyncHandler("m6.shift.close", {
    permission: ["m6.shift.close", "m7.shift.close"],
    schema: closeShiftSchema,
    labels: { closingCashCounted: "Kas fisik", cashDifferenceReason: "Alasan selisih kas", stock: "Stok fisik" },
    description: "Tutup shift: kas fisik & stok fisik → selisih dihitung sistem; setoran terbentuk.",
    handle: async (ctx, payload, meta) => {
      const res = await closeShift(ctx, payload, toFieldWriteMeta(meta));
      return withConflict(
        {
          objectType: "shift",
          objectId: res.shift.id,
          result: { cashDifference: res.shift.cashDifference, depositAmount: res.shift.depositAmount, depositId: res.depositId },
        },
        res.conflict,
      );
    },
  });

  registerSyncHandler("m6.shift_deposit.submit", {
    permission: ["m6.shift_deposit.create", "m7.shift_deposit.create"],
    schema: submitShiftDepositSchema,
    description: "Serahkan setoran shift (fisik ke Admin Keuangan atau setor bank + slip).",
    handle: async (ctx, payload, meta) => {
      const res = await submitShiftDeposit(ctx, payload, toFieldWriteMeta(meta));
      return { objectType: "shift", objectId: res.shiftId, result: { depositId: res.depositId } };
    },
  });

  registerSyncHandler("m6.water_supply.confirm", {
    permission: "m6.water_supply.confirm",
    schema: confirmSupplySchema,
    labels: { receivedVolumeL: "Volume diterima", reason: "Alasan" },
    description: "Konfirmasi pasokan air tiba (volume sama atau berbeda + alasan).",
    handle: async (ctx, payload, meta) => {
      const res = await confirmWaterSupply(ctx, payload, toFieldWriteMeta(meta));
      return withConflict(
        { objectType: "water_supply_receipt", objectId: res.receipt.id, result: { status: res.receipt.status, overCapacity: res.overCapacity, waterStockL: res.waterStockL } },
        res.conflict,
      );
    },
  });

  registerSyncHandler("m6.water_supply.record_other", {
    permission: "m6.water_supply.confirm",
    schema: otherSupplySchema,
    labels: { volumeL: "Volume", reason: "Alasan" },
    description: "Pasokan air darurat dari sumber lain (beralasan).",
    handle: async (ctx, payload, meta) => {
      const row = await recordOtherSupply(ctx, payload, toFieldWriteMeta(meta));
      return { objectType: "water_supply_receipt", objectId: row.id };
    },
  });

  registerSyncHandler("m6.consumable_receipt.create", {
    permission: "m6.consumable_receipt.create",
    schema: consumableReceiptSchema,
    labels: { lines: "Bahan", supplierNoteNumber: "Nomor nota" },
    description: "Penerimaan bahan habis pakai dari pemasok lain (nota + foto).",
    handle: async (ctx, payload, meta) => {
      const res = await recordConsumableReceipt(ctx, payload, toFieldWriteMeta(meta));
      return { objectType: "consumable_receipt", objectId: res.receipt.id, result: { totalValue: res.totalValue } };
    },
  });

  registerSyncHandler("m6.internal_transfer.receive", {
    permission: "m6.internal_transfer.receive",
    schema: receiveTransferSchema,
    labels: { lines: "Barang" },
    description: "Terima transfer internal bahan dari toko EQUA (US-M7-06).",
    handle: async (ctx, payload, meta) => {
      const res = await receiveInternalTransfer(ctx, payload, toFieldWriteMeta(meta));
      return { objectType: "internal_transfer", objectId: payload.transferId, result: { receiptId: res.receipt.id, hasDifference: res.hasDifference } };
    },
  });

  registerSyncHandler("m6.stock_count.submit", {
    permission: ["m6.stock_count.create", "m7.stock_count.create"],
    schema: stockCountSchema,
    labels: { lines: "Hitungan" },
    description: "Opname: hitung fisik → usulan penyesuaian beralasan (persetujuan pemilik).",
    handle: async (ctx, payload, meta) => {
      const res = await submitStockCount(ctx, payload, toFieldWriteMeta(meta));
      return {
        objectType: "stock_count",
        objectId: res.stockCount.id,
        result: { status: res.stockCount.status, differences: res.differences, approvalNumber: res.approval?.number ?? null },
      };
    },
  });

  registerPullProvider("m6.pos", {
    roles: ["depot_operator", "store_cashier"],
    fetch: async ({ ctx, device, now, tx }) => buildPosReference(tx, ctx, device, now),
    // Pull bersyarat v1.0.1 (D-14 butir 3, B-89): penjualan shift terbuka tumbuh sepanjang hari → delta per ember;
    // saldo bahan berubah tiap penjualan → per butir; sisanya jarang berubah.
    collections: POS_PULL_COLLECTIONS,
  });
}
