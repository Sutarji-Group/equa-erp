/**
 * M7 — perintah sinkron POS TOKO (D-07: semua aksi kasir lewat POS, offline-first & idempoten) + pull `m7.store`.
 *
 * Penjualan, shift, void, setoran & tutup shift toko memakai perintah kerangka POS M6 (`m6.*`, izin `m7.*` lewat
 * `PosKindPolicy` toko yang dipasang di sini — B-05). Perintah khusus toko:
 * | Perintah                         | Layanan                 | Izin                            |
 * |----------------------------------|-------------------------|---------------------------------|
 * | `m7.purchase_receipt.create`     | `recordPurchaseReceipt` | m7.purchase_receipt.create      |
 * | `m7.store_product.propose`       | `proposeStoreProduct`   | m7.store_product.propose        |
 * | `m7.store_price.propose`         | `proposeStorePrice`     | m7.store_product.propose        |
 * | `m7.supplier.create`             | `proposeSupplier`       | m7.supplier.create              |
 * | `m7.reorder.mark_ordered`        | `markReorderOrdered`    | m7.reorder.update               |
 * | `m7.stock_count.count`           | `recordStoreCount`      | m7.stock_count.create           |
 * | `m7.internal_transfer.create`    | `sendInternalTransfer`  | m7.internal_transfer.create     |
 */
import "server-only";

import { registerPullProvider, registerSyncHandler } from "@/server/core/sync";
import { registerPosKindPolicy, toFieldWriteMeta } from "@/server/modules/m6-pos";

import { proposePriceSchema, proposeProductSchema, proposeStorePrice, proposeStoreProduct, proposeSupplier, proposeSupplierSchema } from "./service/catalog";
import { storePolicy } from "./service/policy";
import { buildStoreReference } from "./service/pull";
import { purchaseReceiptSchema, recordPurchaseReceipt } from "./service/purchases";
import { markOrderedSchema, markReorderOrdered } from "./service/reorder";
import { recordStoreCount, storeCountSchema } from "./service/stock-count";
import { internalTransferSchema, sendInternalTransfer } from "./service/transfers";

export function registerSync(): void {
  // B-05: kebijakan POS toko di atas kerangka M6 (handler `pos_void`/`stock_adjustment` TIDAK didaftarkan ulang).
  registerPosKindPolicy(storePolicy);

  registerSyncHandler("m7.purchase_receipt.create", {
    permission: "m7.purchase_receipt.create",
    schema: purchaseReceiptSchema,
    labels: { supplierId: "Pemasok", supplierNoteNumber: "Nomor nota", supplierNoteDate: "Tanggal nota", lines: "Barang", totalAmount: "Total nota" },
    description: "Penerimaan barang dari nota pemasok (foto nota wajib) atau nota pengganti (foto barang + keterangan).",
    handle: async (ctx, payload, meta) => {
      const res = await recordPurchaseReceipt(ctx, payload, toFieldWriteMeta(meta));
      return { objectType: "purchase_receipt", objectId: res.receipt.id, result: { number: res.receipt.number, status: res.receipt.status, dueDate: res.receipt.dueDate } };
    },
  });

  registerSyncHandler("m7.store_product.propose", {
    permission: "m7.store_product.propose",
    schema: proposeProductSchema,
    labels: { code: "Kode", name: "Nama barang", unit: "Satuan", generalPrice: "Harga umum", partnerPrice: "Harga mitra", minStock: "Stok minimum" },
    description: "Usulan barang toko baru (berlaku setelah disetujui Admin Keuangan).",
    handle: async (ctx, payload, meta) => {
      const res = await proposeStoreProduct(ctx, payload, toFieldWriteMeta(meta));
      return { objectType: "product", objectId: res.product.id, result: { approvalNumber: res.approval.number } };
    },
  });

  registerSyncHandler("m7.store_price.propose", {
    permission: "m7.store_product.propose",
    schema: proposePriceSchema,
    labels: { price: "Harga baru", effectiveFrom: "Tanggal berlaku", reason: "Alasan" },
    description: "Usulan perubahan harga jual toko (persetujuan Admin Keuangan, tanggal berlaku).",
    handle: async (ctx, payload, meta) => {
      const res = await proposeStorePrice(ctx, payload, toFieldWriteMeta(meta));
      return { objectType: "product_price", objectId: res.price.id, result: { approvalNumber: res.approval.number } };
    },
  });

  registerSyncHandler("m7.supplier.create", {
    permission: "m7.supplier.create",
    schema: proposeSupplierSchema,
    labels: { name: "Nama pemasok", paymentTermDays: "Tempo (hari)" },
    description: "Usulan pemasok baru (aktif setelah disetujui Admin Keuangan).",
    handle: async (ctx, payload, meta) => {
      const res = await proposeSupplier(ctx, payload, toFieldWriteMeta(meta));
      return { objectType: "supplier", objectId: res.supplier.id, result: { approvalNumber: res.approval.number } };
    },
  });

  registerSyncHandler("m7.reorder.mark_ordered", {
    permission: "m7.reorder.update",
    schema: markOrderedSchema,
    labels: { supplierId: "Pemasok" },
    description: "Tandai barang di daftar pesan ulang sudah dipesan (tanggal, pemasok).",
    handle: async (ctx, payload, meta) => {
      const row = await markReorderOrdered(ctx, payload, toFieldWriteMeta(meta));
      return { objectType: "reorder_item", objectId: row.id };
    },
  });

  registerSyncHandler("m7.stock_count.count", {
    permission: "m7.stock_count.create",
    schema: storeCountSchema,
    labels: { lines: "Hitungan" },
    description: "Opname bulanan toko: hitung fisik per barang (saldo sistem pada waktu hitung).",
    handle: async (ctx, payload, meta) => {
      const res = await recordStoreCount(ctx, payload, toFieldWriteMeta(meta));
      const base = {
        objectType: "stock_count",
        objectId: res.stockCount.id,
        result: { lines: res.lines.map((l) => ({ productId: l.productId, systemQty: l.systemQty, differenceQty: l.differenceQty, differenceValue: l.differenceValue })), lockedProductIds: res.lockedProductIds },
      };
      // US-M7-05 KP-1: hitung ulang barang yang sudah dihitung tidak mengubah lembar (hanya lewat Admin Keuangan).
      return res.lockedProductIds.length
        ? { ...base, status: "conflict" as const, message: `${res.lockedProductIds.length} barang sudah dihitung sebelumnya; hitungan pertama dipakai. Hitung ulang lewat Admin Keuangan.` }
        : base;
    },
  });

  registerSyncHandler("m7.internal_transfer.create", {
    permission: "m7.internal_transfer.create",
    schema: internalTransferSchema,
    labels: { toOutletId: "Depot tujuan", lines: "Barang" },
    description: "Transfer internal bahan toko → depot sendiri (nilai harga mitra, tanpa uang).",
    handle: async (ctx, payload, meta) => {
      const res = await sendInternalTransfer(ctx, payload, toFieldWriteMeta(meta));
      return { objectType: "internal_transfer", objectId: res.transfer.id, result: { number: res.transfer.number, totalValue: res.totalValue } };
    },
  });

  registerPullProvider("m7.store", {
    roles: ["store_cashier"],
    fetch: async ({ ctx, device, now, tx }) => buildStoreReference(tx, ctx, device, now),
  });
}
