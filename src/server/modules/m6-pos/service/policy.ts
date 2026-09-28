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
import type { PosSaleRecordedPayload } from "@/server/core/events.types";

import type { FieldWriteMeta, OutletRow, PosSaleRow, ShiftRow } from "./common";
import { depotPolicy } from "./depot-policy";
import type { ShiftFigures } from "./figures";
import type { RecordSaleInput } from "./sales";

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

/**
 * Keputusan kebijakan outlet atas transaksi (tambahan M7): `pending_approval` = transaksi menunggu persetujuan
 * (diskon > PAR-14, tempo di luar kontrol kredit) — tidak dihitung, stok tidak berubah, tanpa `pos_sale.recorded`
 * sampai disetujui (`completePendingSale`) atau ditolak (`rejectPendingSale`).
 */
export type PosSaleDecision = {
  status?: "valid" | "pending_approval";
  /** PTB-42: tempo dicatat dengan data eksposur sinkron terakhir (perangkat offline) → tinjauan Admin Keuangan. */
  creditOffline?: boolean;
  /** Catatan untuk ditinjau (tidak menolak transaksi). */
  conflict?: string | null;
  /** Persetujuan yang perlu diajukan kait `afterSalePending` (jenis + alasan + nilai). */
  approvals?: { type: string; reason: string; amount?: number | null }[];
};

export type PosSaleValidateArgs = Omit<PosSaleHookArgs, "sale"> & {
  customerId: string | null;
  /** Masukan perintah (tambahan M7: diskon, tempo, permintaan persetujuan). */
  input: RecordSaleInput;
  subtotal: number;
  discountAmount: number;
  total: number;
  meta: FieldWriteMeta;
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
  validateSale?: (args: PosSaleValidateArgs) => Promise<PosSaleDecision | void>;
  /** Kait setelah transaksi BERLAKU (langsung atau setelah persetujuan); boleh menambah field opsional payload event. */
  afterSaleRecorded?: (args: PosSaleHookArgs & { shiftClosed: boolean }) => Promise<{ payload?: Partial<PosSaleRecordedPayload> } | void>;
  afterSaleVoided?: (args: PosSaleHookArgs & { afterClose: boolean; reversalId: string | null }) => Promise<void>;
  /** Tambahan M7: transaksi disimpan "menunggu persetujuan" (ajukan persetujuan di sini). */
  afterSalePending?: (args: PosSaleHookArgs & { decision: PosSaleDecision }) => Promise<void>;
  /** Tambahan M7: jenis harga dari data (mis. pelanggan bertanda mitra toko → harga mitra, BR-18). */
  resolvePriceKind?: (args: { tx: Tx; outlet: OutletRow; customerId: string | null }) => Promise<PriceKind>;
  /** Cara bayar yang diterima (bawaan tunai & QRIS; toko + tempo mitra). */
  paymentMethods?: readonly ("cash" | "qris" | "credit")[];
  /** Diskon per transaksi diizinkan (toko, BR-17). Depot: tidak (PTB-48). */
  allowsDiscount?: boolean;
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
