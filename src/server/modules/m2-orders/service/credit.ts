/**
 * M2 — kontrol kredit pesanan tempo (US-M2-05; BR-03, BR-04, BR-06; PTB-18, PTB-25).
 *
 * - `computeCreditExposure(tx, customerId, { extraAmount })` — SATU batas lintas lini (PTB-25; M7 memakainya untuk
 *   penjualan tempo toko): piutang belum lunas (faktur `outstanding_amount` + tagihan belum difakturkan
 *   `unbilled_charges`, baca-saja tabel M5) + nilai rit tempo pesanan Baru/Menunggu persetujuan/Terjadwal/Dalam
 *   pengiriman yang belum Selesai + nilai transaksi ini.
 * - `evaluateCreditOrder` — status Tunai → tempo tidak tersedia; Ditahan → ditolak (dapat diajukan ke pemilik);
 *   eksposur > batas → ditolak dengan angka (dapat diajukan ke pemilik).
 * - `underpaymentStatus` — faktur kurang bayar terbuka (PTB-18): ≥ 1 → pesanan bertanda "tagih kurang bayar";
 *   kurang bayar kedua saat yang pertama belum lunas → pesanan baru hanya dapat dijadwalkan setelah lunas atau
 *   disetujui pemilik (6.2a).
 */
import "server-only";

import { and, eq, gt, inArray, ne, sql, sum } from "drizzle-orm";

import { customers, invoices, orders, trips, unbilledCharges } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";

import type { ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { NotFoundError } from "@/server/core/errors";
import { assertTenantScope, authorizeAny } from "@/server/core/rbac";

import { ACTIVE_ORDER_STATUSES, SECOND_UNDERPAYMENT_OPEN_INVOICES, type CustomerRow } from "./common";

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
  /** Nilai transaksi yang sedang dinilai. */
  extraAmount: number;
  /** Eksposur = piutang belum lunas + pesanan tempo berjalan + transaksi ini (BR-06). */
  exposure: number;
  /** Batas − eksposur (negatif = melampaui). */
  remaining: number;
  exceedsLimit: boolean;
};

/**
 * Eksposur kredit pelanggan (BR-06, PTB-25). Dipakai M2 (pesanan tempo) dan M7 (penjualan tempo toko) — satu batas
 * lintas lini. `excludeOrderId` mengecualikan pesanan yang sedang dinilai ulang (mis. saat persetujuan).
 */
export async function computeCreditExposure(
  tx: Tx,
  customerId: string,
  opts: { extraAmount?: number; excludeOrderId?: string | null } = {},
): Promise<CreditExposure> {
  const rows = await tx
    .select({ id: customers.id, creditStatus: customers.creditStatus, creditLimit: customers.creditLimit })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  const customer = rows[0];
  if (!customer) throw new NotFoundError("Pelanggan tidak ditemukan.");
  const [inv] = await tx
    .select({ total: sum(invoices.outstandingAmount) })
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), gt(invoices.outstandingAmount, 0)));
  const [unbilled] = await tx
    .select({ total: sum(unbilledCharges.amount) })
    .from(unbilledCharges)
    .where(and(eq(unbilledCharges.customerId, customerId), eq(unbilledCharges.status, "unbilled")));
  const orderConds = [
    eq(trips.customerId, customerId),
    eq(trips.paymentMethod, "credit"),
    inArray(trips.status, ["assigned", "departed", "arrived"]),
    sql`${trips.withdrawnAt} is null`,
    inArray(orders.status, [...ACTIVE_ORDER_STATUSES]),
  ];
  if (opts.excludeOrderId) orderConds.push(ne(trips.orderId, opts.excludeOrderId));
  const [open] = await tx
    .select({ total: sum(trips.price) })
    .from(trips)
    .innerJoin(orders, eq(orders.id, trips.orderId))
    .where(and(...orderConds));
  const openInvoices = Number(inv?.total ?? 0);
  const unbilledTotal = Number(unbilled?.total ?? 0);
  const openCreditOrders = Number(open?.total ?? 0);
  const extraAmount = Math.max(0, Math.round(opts.extraAmount ?? 0));
  const exposure = openInvoices + unbilledTotal + openCreditOrders + extraAmount;
  return {
    customerId,
    creditStatus: customer.creditStatus,
    creditLimit: customer.creditLimit,
    openInvoices,
    unbilledCharges: unbilledTotal,
    openCreditOrders,
    extraAmount,
    exposure,
    remaining: customer.creditLimit - exposure,
    exceedsLimit: exposure > customer.creditLimit,
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
      message: `Pesanan tempo ditolak: eksposur ${formatRupiah(exposure.exposure)} melampaui batas kredit ${formatRupiah(exposure.creditLimit)} (piutang ${formatRupiah(exposure.openInvoices + exposure.unbilledCharges)} + pesanan tempo berjalan ${formatRupiah(exposure.openCreditOrders)} + pesanan ini ${formatRupiah(exposure.extraAmount)}). Ubah ke tunai atau ajukan persetujuan pemilik.`,
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
