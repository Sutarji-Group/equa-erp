/**
 * M6 — TITIK PERLUASAN kerangka POS per jenis outlet (depot M6, toko M7 — D-07, PRD 7.7.2 "kerangka POS yang sama").
 *
 * Satu mesin POS (shift, transaksi, void, setoran, opname, pull `m6.pos`, persetujuan `pos_void`/`stock_adjustment`)
 * dipakai semua outlet; perilaku yang berbeda per jenis outlet dipasang lewat `PosKindPolicy`:
 * - izin per aksi (depot `m6.*`, toko `m7.*`), sumber setoran (`depot_shift`/`store_shift`), jenis harga;
 * - kait `validateSale` (M7: pelanggan wajib untuk harga mitra/tempo, diskon ≤ PAR-14, stok > 0, tempo mitra),
 *   `afterSaleRecorded`/`afterSaleVoided` (M7: kartu stok per barang), `onShiftClosing` (M6: pemakaian bahan dari
 *   resep, buku air, penerimaan pasokan otomatis PAR-61).
 * M7 memanggil `registerPosKindPolicy(storePolicy)` dari `registerSync()`-nya; JANGAN mendaftarkan ulang handler
 * persetujuan `pos_void`/`stock_adjustment` (registri persetujuan satu handler per jenis — milik kerangka ini).
 */
import "server-only";

import type { EnumValue, OutletKind, PriceKind } from "@/lib/labels";

import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError } from "@/server/core/errors";

import type { OutletRow, PosSaleRow, ShiftRow } from "./common";
import { depotPolicy } from "./depot-policy";
import type { ShiftFigures } from "./figures";

export type PosSaleLineInput = { productId: string; quantity: number; unitPrice: number };

export type PosSaleHookArgs = {
  tx: Tx;
  ctx: ActorContext;
  outlet: OutletRow;
  shift: ShiftRow;
  sale: PosSaleRow;
  lines: { productId: string; quantity: number; unitPrice: number; lineTotal: number; gallonSizeL: number | null }[];
};

export type PosShiftClosingArgs = {
  tx: Tx;
  ctx: ActorContext;
  outlet: OutletRow;
  shift: ShiftRow;
  figures: ShiftFigures;
  closedAt: Date;
  businessDate: string;
};

export type PosKindPolicy = {
  kind: OutletKind;
  label: string;
  depositSourceType: EnumValue<"deposit_source_type">;
  stockCountKind: EnumValue<"stock_count_kind">;
  permissions: {
    saleCreate: string;
    saleVoid: string;
    saleCorrect: string;
    shiftOpen: string;
    shiftClose: string;
    shiftRead: string;
    shiftDeposit: string;
    stockCount: string;
    stockAdjustment: string;
    consumableReceipt: string;
  };
  /** Jenis harga master untuk transaksi (depot: standar; toko: umum/mitra). */
  priceKind: (input: { customerId: string | null }) => PriceKind;
  /** Pelanggan disimpan pada transaksi? Depot: tidak (FR-M6-08 C — kolom disiapkan kosong). */
  acceptsCustomer: boolean;
  /** Lini produk yang boleh dijual di outlet ini. */
  productLine: "depot" | "store";
  validateSale?: (args: Omit<PosSaleHookArgs, "sale"> & { customerId: string | null }) => Promise<void>;
  afterSaleRecorded?: (args: PosSaleHookArgs & { shiftClosed: boolean }) => Promise<void>;
  afterSaleVoided?: (args: PosSaleHookArgs & { afterClose: boolean; reversalId: string | null }) => Promise<void>;
  /** Dipanggil di dalam transaksi tutup shift; hasil digabung ke ringkasan shift. */
  onShiftClosing?: (args: PosShiftClosingArgs) => Promise<Record<string, unknown> | void>;
};

/** Kebijakan depot (M6) terpasang bawaan; toko dipasang M7. */
const policies = new Map<OutletKind, PosKindPolicy>([["depot", depotPolicy]]);

/** Pasang (atau ganti) kebijakan POS satu jenis outlet. */
export function registerPosKindPolicy(policy: PosKindPolicy): () => void {
  policies.set(policy.kind, policy);
  return () => {
    if (policies.get(policy.kind) === policy) policies.delete(policy.kind);
  };
}

export function posKindPolicy(kind: OutletKind): PosKindPolicy {
  const p = policies.get(kind);
  if (!p) {
    throw new DomainError("POS_KIND_UNSUPPORTED", `POS untuk outlet jenis "${kind}" belum diaktifkan di aplikasi ini. Hubungi admin sistem.`);
  }
  return p;
}

export function hasPosKindPolicy(kind: OutletKind): boolean {
  return policies.has(kind);
}
