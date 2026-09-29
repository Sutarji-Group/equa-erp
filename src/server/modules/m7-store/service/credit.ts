/**
 * M7 — kontrol tempo toko (US-M7-04; BR-04, BR-06, BR-18, PTB-25, PTB-42).
 *
 * Tempo hanya untuk pelanggan bertanda mitra toko (BR-18) berstatus kredit Tempo/Tempo migrasi. Eksposur memakai SATU
 * definisi lintas lini (M2 `computeCreditExposure` = M5 `computeExposure`, B-35: piutang semua lini + tagihan belum
 * difakturkan + pesanan tempo air truk berjalan + penjualan tempo toko yang belum difakturkan M5) ditambah transaksi ini.
 */
import "server-only";

import { and, eq, isNull, ne, sql } from "drizzle-orm";

import { invoices, posSales } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";

import type { Tx } from "@/server/core/db";
import { computeCreditExposure, type CreditExposure } from "@/server/modules/m2-orders";

import { loadCustomer, type CustomerRow } from "./common";

export type StoreCreditExposure = CreditExposure & {
  /** Nilai transaksi ini. */
  saleAmount: number;
};

export type StoreCreditCheck =
  | { ok: true; customer: CustomerRow; exposure: StoreCreditExposure }
  | {
      ok: false;
      reason: "customer_required" | "not_partner" | "cash_customer" | "on_hold" | "over_limit";
      /** Dapat diajukan ke pemilik (6.2a `store_credit_sale`). */
      canRequestApproval: boolean;
      message: string;
      customer: CustomerRow | null;
      exposure: StoreCreditExposure | null;
    };

/** Penjualan tempo toko Sah pelanggan yang belum difakturkan (faktur M5 belum terbit). */
export async function uninvoicedStoreCredit(tx: Tx, customerId: string, opts: { excludeSaleId?: string | null } = {}): Promise<number> {
  const conds = [
    eq(posSales.customerId, customerId),
    eq(posSales.paymentMethod, "credit"),
    eq(posSales.status, "valid"),
    eq(posSales.isReversal, false),
    isNull(posSales.invoiceId),
    sql`not exists (select 1 from ${invoices} where ${invoices.posSaleId} = ${posSales.id})`,
  ];
  if (opts.excludeSaleId) conds.push(ne(posSales.id, opts.excludeSaleId));
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${posSales.total}), 0)` })
    .from(posSales)
    .where(and(...conds));
  return Number(row?.total ?? 0);
}

/**
 * Eksposur lintas lini + transaksi ini (tanpa keputusan). SATU definisi dengan pesanan air tempo (B-35): M2
 * `computeCreditExposure` (= M5 `computeExposure`) sudah memuat tempo toko belum difakturkan.
 */
export async function storeCreditExposure(tx: Tx, customerId: string, amount: number, opts: { excludeSaleId?: string | null } = {}): Promise<StoreCreditExposure> {
  const base = await computeCreditExposure(tx, customerId, { extraAmount: amount, excludeSaleId: opts.excludeSaleId });
  return { ...base, saleAmount: amount };
}

/**
 * Evaluasi tempo toko (US-M7-04 KP-1/KP-2). Pelanggan bukan mitra toko → tempo tidak tersedia (tanpa pengajuan);
 * Tunai/Ditahan/melampaui batas → ditolak dengan keterangan + pilihan persetujuan pemilik.
 */
export async function evaluateStoreCredit(
  tx: Tx,
  input: { tenantId: string; customerId: string | null; amount: number; excludeSaleId?: string | null },
): Promise<StoreCreditCheck> {
  if (!input.customerId) {
    return { ok: false, reason: "customer_required", canRequestApproval: false, message: "Pilih pelanggan mitra toko untuk penjualan tempo.", customer: null, exposure: null };
  }
  const customer = await loadCustomer(tx, input.customerId);
  if (!customer || customer.tenantId !== input.tenantId || !customer.isActive) {
    return { ok: false, reason: "customer_required", canRequestApproval: false, message: "Pelanggan tidak ditemukan atau nonaktif. Pilih pelanggan lain.", customer: null, exposure: null };
  }
  if (!customer.isStorePartner) {
    return {
      ok: false,
      reason: "not_partner",
      canRequestApproval: false,
      message: `${customer.name} bukan mitra toko terdaftar (BR-18) — tempo toko tidak tersedia. Pilih tunai atau QRIS.`,
      customer,
      exposure: null,
    };
  }
  const exposure = await storeCreditExposure(tx, customer.id, input.amount, { excludeSaleId: input.excludeSaleId });
  const piutang = exposure.openInvoices + exposure.unbilledCharges;
  if (exposure.creditStatus === "cash") {
    return {
      ok: false,
      reason: "cash_customer",
      canRequestApproval: true,
      message: `Tempo ditolak: status kredit ${customer.name} ${label("credit_status", "cash")}. Pilih tunai/QRIS atau ajukan persetujuan pemilik.`,
      customer,
      exposure,
    };
  }
  if (exposure.creditStatus === "on_hold") {
    return {
      ok: false,
      reason: "on_hold",
      canRequestApproval: true,
      message: `Tempo ditolak: status kredit ${customer.name} ${label("credit_status", "on_hold")} karena ada piutang lewat tempo (piutang belum lunas ${formatRupiah(piutang)}). Tagih piutangnya, pilih tunai/QRIS, atau ajukan persetujuan pemilik.`,
      customer,
      exposure,
    };
  }
  if (exposure.exceedsLimit) {
    return {
      ok: false,
      reason: "over_limit",
      canRequestApproval: true,
      message: `Tempo ditolak: eksposur ${formatRupiah(exposure.exposure)} melampaui batas kredit ${formatRupiah(exposure.creditLimit)} (piutang ${formatRupiah(piutang)} + pesanan air tempo berjalan ${formatRupiah(exposure.openCreditOrders)} + tempo toko belum difakturkan ${formatRupiah(exposure.uninvoicedStoreCredit)} + transaksi ini ${formatRupiah(input.amount)}). Pilih tunai/QRIS atau ajukan persetujuan pemilik.`,
      customer,
      exposure,
    };
  }
  return { ok: true, customer, exposure };
}
