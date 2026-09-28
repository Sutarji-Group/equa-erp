/**
 * M6 — pembantu internal layanan POS (tidak diekspor lewat index.ts kecuali disebut): pemuatan outlet/shift dengan
 * cek tenant & lingkup (NFR-30), pengaturan outlet (kas awal tetap, ambang), predikat "transaksi dihitung".
 */
import "server-only";

import { and, eq, sql, type SQL } from "drizzle-orm";

import { outlets, posSales, shifts, tenants } from "@/db/schema";
import { addDays, isBusinessDate, toBusinessDate, weekdayOf, type BusinessDate } from "@/lib/time";

import { isSystem, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, ForbiddenError, NotFoundError } from "@/server/core/errors";
import * as params from "@/server/core/params";
import { assertOutletScope, assertTenantScope, inOutletScope } from "@/server/core/rbac";

export type OutletRow = typeof outlets.$inferSelect;
export type ShiftRow = typeof shifts.$inferSelect;
export type PosSaleRow = typeof posSales.$inferSelect;
export type TenantRow = typeof tenants.$inferSelect;

/** Perangkat pemanggil (subset `DeviceRow` yang dibutuhkan). */
export type PosDevice = { id: string; tenantId: string; outletId: string | null; deviceCode?: string };

/**
 * Konteks tulis perintah lapangan (dari `SyncMeta`): transaksi, perangkat, waktu & tanggal bisnis PERANGKAT,
 * dan nilai kolom `fieldMeta()` (`fieldMetaValues(meta)`).
 */
export type FieldWriteMeta = {
  tx: Tx;
  device: PosDevice;
  deviceTime: Date;
  businessDate: BusinessDate;
  commandId: string | null;
  fieldValues: {
    deviceId: string;
    deviceTime: Date;
    syncedAt: Date;
    syncCommandId: string;
    lateSync: boolean;
    clockSkewFlagged: boolean;
  };
  attachmentIds: string[];
};

export async function loadOutlet(tx: Tx, id: string): Promise<OutletRow> {
  const rows = await tx.select().from(outlets).where(eq(outlets.id, id)).limit(1);
  if (!rows[0]) throw new NotFoundError("Outlet tidak ditemukan.");
  return rows[0];
}

/**
 * Outlet tempat perangkat POS bekerja (NFR-30): outlet perangkat, atau (perangkat cadangan tanpa outlet) outlet
 * dari payload / lingkup operator. Tenant perangkat = tenant outlet = tenant pengguna; outlet dalam lingkup pelaku.
 */
export async function resolvePosOutlet(tx: Tx, ctx: ActorContext, device: PosDevice, requested?: string | null): Promise<OutletRow> {
  let outletId = device.outletId;
  if (!outletId) outletId = requested ?? ctx.scope.outletIds[0] ?? null;
  else if (requested && requested !== device.outletId) {
    throw new DomainError("OUTLET_MISMATCH", "Perangkat ini terdaftar untuk outlet lain. Gunakan tablet POS outlet Anda.");
  }
  if (!outletId) throw new DomainError("OUTLET_REQUIRED", "Outlet POS belum ditentukan. Minta admin sistem menautkan perangkat ke outlet.");
  const outlet = await loadOutlet(tx, outletId);
  if (outlet.tenantId !== device.tenantId || outlet.tenantId !== ctx.tenantId) {
    // NFR-30: tidak ada data lintas tenant — perlakukan seperti tidak ada.
    throw new NotFoundError("Outlet tidak ditemukan.");
  }
  if (!outlet.isActive) throw new DomainError("OUTLET_INACTIVE", `${outlet.name} nonaktif. Hubungi pemilik.`);
  await assertOutletScope(tx, ctx, outlet.id);
  return outlet;
}

/** Outlet untuk tampilan kantor: tenant pelaku + lingkup (US-M6-07 KP-2). */
export async function loadOutletForOffice(tx: Tx, ctx: ActorContext, outletId: string): Promise<OutletRow> {
  const outlet = await loadOutlet(tx, outletId);
  if (!isSystem(ctx)) {
    if (outlet.tenantId !== ctx.tenantId) throw new NotFoundError("Outlet tidak ditemukan.");
    assertTenantScope(ctx, outlet.tenantId);
    if (!inOutletScope(ctx, outlet.id, outlet.tenantId)) {
      throw new ForbiddenError("Anda tidak memiliki akses ke outlet ini.", { rule: "SCOPE", objectType: "outlet", objectId: outlet.id });
    }
  }
  return outlet;
}

export async function loadShift(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<ShiftRow | null> {
  const q = tx.select().from(shifts).where(eq(shifts.id, id)).limit(1);
  const rows = opts.forUpdate ? await q.for("update") : await q;
  return rows[0] ?? null;
}

export async function loadSale(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<PosSaleRow | null> {
  const q = tx.select().from(posSales).where(eq(posSales.id, id)).limit(1);
  const rows = opts.forUpdate ? await q.for("update") : await q;
  return rows[0] ?? null;
}

/** Shift terbuka (bukan konflik) outlet — satu per outlet. */
export async function openShiftOf(tx: Tx, outletId: string): Promise<ShiftRow | null> {
  const rows = await tx
    .select()
    .from(shifts)
    .where(and(eq(shifts.outletId, outletId), eq(shifts.status, "open"), eq(shifts.syncConflict, false)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Transaksi yang DIHITUNG sebagai penjualan: sah & menunggu persetujuan void (PTB-43), baris pembalik (negatif), dan
 * transaksi asal yang di-void SETELAH shift ditutup (ditandai `reversal_reason` pada baris asal; pembaliknya
 * menetralkan). Void efektif di shift terbuka tidak dihitung.
 */
export const COUNTED_SALE: SQL = sql`(${posSales.isReversal} = true or ${posSales.status} in ('valid', 'void_pending') or (${posSales.status} = 'voided' and ${posSales.reversalReason} is not null))`;

/** Kas awal tetap per outlet (PTB-40): kolom outlet, bila kosong PAR-57 (lingkup outlet/tenant/global). */
export async function fixedOpeningCash(tx: Tx, outlet: OutletRow, date: BusinessDate): Promise<number> {
  if (outlet.fixedOpeningCash !== null && outlet.fixedOpeningCash !== undefined) return outlet.fixedOpeningCash;
  const v = await params.get(tx, "PAR-57", date, { tenantId: outlet.tenantId, outletId: outlet.id });
  return v.amount;
}

export type OutletPosSettings = {
  fixedOpeningCash: number;
  /** PAR-02 kas maksimal di outlet. */
  cashLimit: number;
  /** PAR-03 void per hari per outlet → notifikasi. */
  voidDailyCount: number;
  /** PAR-04 void > nilai ini perlu persetujuan. */
  voidApprovalAbove: number;
  /** PAR-58 toleransi selisih stok harian per bahan. */
  stockTolerance: number;
  /** PAR-59 toleransi neraca air (%). */
  waterTolerancePct: number;
  /** PAR-27 setoran dianggap terlambat (hari). */
  depositLateDays: number;
  qrisEnabled: boolean;
  printerEnabled: boolean;
  rules: params.ParamValue<"m6.pos_rules">;
};

/** Pengaturan POS berlaku untuk outlet pada tanggal bisnis (US-M6-07 KP-3: per tenant/outlet tanpa kode). */
export async function outletPosSettings(tx: Tx, outlet: OutletRow, date: BusinessDate): Promise<OutletPosSettings> {
  const scope = { tenantId: outlet.tenantId, outletId: outlet.id };
  const [cash, voidCount, voidAbove, tol, water, late, rules] = await Promise.all([
    params.get(tx, "PAR-02", date, scope),
    params.get(tx, "PAR-03", date, scope),
    params.get(tx, "PAR-04", date, scope),
    params.get(tx, "PAR-58", date, scope),
    params.get(tx, "PAR-59", date, scope),
    params.get(tx, "PAR-27", date, scope),
    params.get(tx, "m6.pos_rules", date, scope),
  ]);
  return {
    fixedOpeningCash: await fixedOpeningCash(tx, outlet, date),
    cashLimit: cash.amount,
    voidDailyCount: voidCount.count,
    voidApprovalAbove: voidAbove.amount_gt,
    stockTolerance: tol.units_per_material,
    waterTolerancePct: water.percent,
    depositLateDays: late.days_gt,
    qrisEnabled: outlet.qrisEnabled,
    printerEnabled: outlet.printerEnabled,
    rules,
  };
}

/** Label minggu ISO `YYYY-Www` untuk tanggal bisnis (opname mingguan PAR-32). */
export function isoWeekLabel(date: BusinessDate): string {
  if (!isBusinessDate(date)) throw new RangeError(`Tanggal tidak valid: ${date}`);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  const dayNum = t.getUTCDay() || 7; // Senin = 1 … Minggu = 7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum); // Kamis minggu ini menentukan tahun ISO
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Senin & Minggu minggu ISO yang memuat tanggal. */
export function isoWeekRange(date: BusinessDate): { from: BusinessDate; to: BusinessDate } {
  const wd = weekdayOf(date); // 0 = Minggu
  const offset = wd === 0 ? 6 : wd - 1;
  const from = addDays(date, -offset);
  return { from, to: addDays(from, 6) };
}

/** Tanggal bisnis perintah lapangan / pelaku. */
export function businessDateOf(ctx: ActorContext, fallback?: string | null): BusinessDate {
  if (fallback && isBusinessDate(fallback)) return fallback;
  return ctx.businessDate ?? toBusinessDate(ctx.deviceTime ?? ctx.now);
}

/** Teks alasan gabungan kode + keterangan. */
export function reasonText(code: string, labelText: string, note?: string | null): string {
  const n = note?.trim();
  if (code === "other") return n ? `Lainnya: ${n}` : "Lainnya";
  return n ? `${labelText} — ${n}` : labelText;
}
