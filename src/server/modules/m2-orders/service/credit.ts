/**
 * M2 — kontrol kredit pesanan tempo (US-M2-05; BR-03, BR-04, BR-06; PTB-18, PTB-25).
 *
 * - `computeCreditExposure(tx, customerId, { extraAmount })` — SATU batas lintas lini (PTB-25; M7 memakainya untuk
 *   penjualan tempo toko) = M5 `computeExposure` (B-35): piutang belum lunas (faktur `outstanding_amount` + tagihan
 *   belum difakturkan `unbilled_charges`) + nilai rit tempo pesanan Baru/Menunggu persetujuan/Terjadwal/Dalam
 *   pengiriman yang belum Selesai + penjualan tempo toko belum difakturkan + nilai transaksi ini.
 * - `evaluateCreditOrder` — status Tunai → tempo tidak tersedia; Ditahan → ditolak (dapat diajukan ke pemilik);
 *   eksposur > batas → ditolak dengan angka (dapat diajukan ke pemilik).
 * - `underpaymentStatus` — faktur kurang bayar terbuka (PTB-18): ≥ 1 → pesanan bertanda "tagih kurang bayar";
 *   kurang bayar kedua saat yang pertama belum lunas → pesanan baru hanya dapat dijadwalkan setelah lunas atau
 *   disetujui pemilik (6.2a).
 */
import "server-only";

import { and, eq, gt, sql, sum } from "drizzle-orm";

import { customers, invoices } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";

import type { ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { NotFoundError } from "@/server/core/errors";
import { assertTenantScope, authorizeAny } from "@/server/core/rbac";
import { computeExposure } from "@/server/modules/m5-receivables";

import { SECOND_UNDERPAYMENT_OPEN_INVOICES, type CustomerRow } from "./common";

export type CreditExposure = {
  customerId: string;
  creditStatus: CustomerRow["creditStatus"];
  creditLimit: number;
  /** Faktur belum lunas (semua lini, termasuk kurang bayar). */
  openInvoices: number;
  /** Tagihan tempo yang belum difakturkan (faktur bulanan). */
  unbilledCharges: number;
  /** Rit tempo pesanan berjalan yang belum Selesai (BR-06). */
  openCreditOrders: number;
  /** Penjualan tempo toko Sah yang belum menjadi faktur M5 (shift toko masih terbuka) — B-35. */
  uninvoicedStoreCredit: number;
  /** Nilai transaksi yang sedang dinilai. */
  extraAmount: number;
  /** Eksposur = piutang belum lunas + pesanan tempo berjalan + tempo toko belum difakturkan + transaksi ini (BR-06). */
  exposure: number;
  /** Batas − eksposur (negatif = melampaui). */
  remaining: number;
  exceedsLimit: boolean;
};

/**
 * Eksposur kredit pelanggan (BR-06, PTB-25). Dipakai M2 (pesanan tempo) dan M7 (penjualan tempo toko) — satu batas
 * lintas lini. Angkanya SATU definisi dengan M5 `computeExposure` (B-35): pesanan air tempo & tempo toko memakai
 * eksposur yang sama. `excludeOrderId` mengecualikan pesanan yang sedang dinilai ulang (mis. saat persetujuan);
 * `excludeSaleId` mengecualikan penjualan toko yang sedang dinilai ulang.
 */
export async function computeCreditExposure(
  tx: Tx,
  customerId: string,
  opts: { extraAmount?: number; excludeOrderId?: string | null; excludeSaleId?: string | null } = {},
): Promise<CreditExposure> {
  const view = await computeExposure(tx, customerId, { extraAmount: opts.extraAmount, excludeOrderId: opts.excludeOrderId, excludeSaleId: opts.excludeSaleId });
  return {
    customerId,
    creditStatus: view.creditStatus,
    creditLimit: view.creditLimit,
    openInvoices: view.openInvoices,
    unbilledCharges: view.unbilledCharges,
    openCreditOrders: view.openCreditOrders,
    uninvoicedStoreCredit: view.uninvoicedStoreCredit,
    extraAmount: view.extraAmount,
    exposure: view.exposure,
    remaining: view.remaining,
    exceedsLimit: view.exceedsLimit,
  };
}

/** Eksposur kredit untuk layar (izin baca pesanan/eksposur). */
export async function getCreditExposure(ctx: ActorContext, customerId: string, opts: { extraAmount?: number; tx?: Tx } = {}): Promise<CreditExposure> {
  await authorizeAny(ctx, ["m5.credit_exposure.read", "m2.order.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx.select({ tenantId: customers.tenantId }).from(customers).where(eq(customers.id, customerId)).limit(1);
  if (!rows[0]) throw new NotFoundError("Pelanggan tidak ditemukan.");
  assertTenantScope(ctx, rows[0].tenantId);
  return computeCreditExposure(tx, customerId, { extraAmount: opts.extraAmount });
}

export type CreditCheck =
  | { ok: true; exposure: CreditExposure }
  | {
      ok: false;
      /** `cash_customer` = status Tunai (tempo tidak tersedia); `on_hold` = Ditahan; `over_limit` = eksposur > batas. */
      reason: "cash_customer" | "on_hold" | "over_limit";
      /** Dapat diajukan ke pemilik (6.2a "Pesanan tempo di luar kontrol kredit"). */
      canRequestApproval: boolean;
      message: string;
      exposure: CreditExposure;
    };

/** Nilai kontrol kredit pesanan tempo senilai `amount` (US-M2-05 KP-1/KP-2). */
export async function evaluateCreditOrder(tx: Tx, customerId: string, amount: number, opts: { excludeOrderId?: string | null } = {}): Promise<CreditCheck> {
  const exposure = await computeCreditExposure(tx, customerId, { extraAmount: amount, excludeOrderId: opts.excludeOrderId });
  if (exposure.creditStatus === "cash") {
    return {
      ok: false,
      reason: "cash_customer",
      canRequestApproval: false,
      message: "Cara bayar tempo tidak tersedia: status kredit pelanggan Tunai. Pilih tunai atau transfer; pemberian Tempo diajukan lewat Data master > Pelanggan.",
      exposure,
    };
  }
  if (exposure.creditStatus === "on_hold") {
    return {
      ok: false,
      reason: "on_hold",
      canRequestApproval: true,
      message: `Pesanan tempo ditolak: status kredit ${label("credit_status", "on_hold")} karena ada piutang lewat tempo (piutang belum lunas ${formatRupiah(exposure.openInvoices + exposure.unbilledCharges)}). Tagih piutangnya, ubah ke tunai, atau ajukan persetujuan pemilik.`,
      exposure,
    };
  }
  if (exposure.exceedsLimit) {
    return {
      ok: false,
      reason: "over_limit",
      canRequestApproval: true,
      message: `Pesanan tempo ditolak: eksposur ${formatRupiah(exposure.exposure)} melampaui batas kredit ${formatRupiah(exposure.creditLimit)} (piutang ${formatRupiah(exposure.openInvoices + exposure.unbilledCharges)} + pesanan tempo berjalan ${formatRupiah(exposure.openCreditOrders)}${exposure.uninvoicedStoreCredit ? ` + tempo toko belum difakturkan ${formatRupiah(exposure.uninvoicedStoreCredit)}` : ""} + pesanan ini ${formatRupiah(exposure.extraAmount)}). Ubah ke tunai atau ajukan persetujuan pemilik.`,
      exposure,
    };
  }
  return { ok: true, exposure };
}

export type UnderpaymentStatus = {
  /** Jumlah faktur kurang bayar terbuka. */
  openCount: number;
  openAmount: number;
  /** ≥ 1 → pesanan bertanda "tagih kurang bayar" (sopir menagih sisanya, US-M3-05). */
  collect: boolean;
  /** Kurang bayar kedua saat yang pertama belum lunas → jadwal perlu lunas atau persetujuan pemilik. */
  secondUnpaid: boolean;
};

/** Faktur kurang bayar terbuka pelanggan (PTB-18; baca-saja tabel M5). */
export async function underpaymentStatus(tx: Tx, customerId: string): Promise<UnderpaymentStatus> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int`, total: sum(invoices.outstandingAmount) })
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), eq(invoices.kind, "underpayment"), gt(invoices.outstandingAmount, 0)));
  const openCount = Number(row?.n ?? 0);
  return {
    openCount,
    openAmount: Number(row?.total ?? 0),
    collect: openCount >= 1,
    secondUnpaid: openCount >= SECOND_UNDERPAYMENT_OPEN_INVOICES,
  };
}
