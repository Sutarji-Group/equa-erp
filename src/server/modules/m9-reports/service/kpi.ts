/**
 * M9 — Laporan KPI program KPI-01–KPI-11 (US-M9-07; BRD 2.3, 12.8; PRD 1.3; PTB-30; RL-6). Rumus sesuai PRD 1.3:
 *
 * - KPI-01 transaksi lapangan (rit Selesai, POS, pembacaan meter, pengisian) tercatat di sumber oleh pelakunya DAN
 *   tersinkron sebelum hari kasnya ditutup ÷ seluruh transaksi lapangan ("dicatat kantor" & "terlambat sinkron" = tidak).
 * - KPI-02 menit setoran terakhir Diterima → kas ditutup (rata-rata harian bulan itu, `cash_days`).
 * - KPI-03 selisih belum Selesai > 24 jam (M4 `kpi03`).
 * - KPI-04 lewat tempo ÷ total piutang terbuka per akhir hari (metrics `receivablesAsOf`, sasaran M5).
 * - KPI-05 pesanan bernomor & berstatus — 100% menurut rancangan (US-M2-02) + verifikasi lembar pencocokan NFR-35:
 *   nota kertas yang tidak punya transaksi sistem & perjalanan GPS di luar jadwal (tanpa rit).
 * - KPI-06 pesanan terlewat + dibatalkan "dobel" (M2 `kpi06Report`).
 * - KPI-07 rit Selesai ÷ terjadwal per truk per hari; pelanggan & internal terpisah (metrics `tripsDaily`) — baseline.
 * - KPI-08 % hari H+0 terbit ≤ batas menit setelah tutup kas (`daily_summaries`).
 * - KPI-09 laporan bulanan Final (periode Dikunci) paling lambat tanggal PAR-23 bulan berikutnya.
 * - KPI-10 jam pemilik per minggu — input manual pemilik; pembanding: total durasi sesi web pemilik per bulan.
 * - KPI-11 pengguna aktif per peran per hari ÷ jumlah karyawan pada peran itu (peran lapangan) + tanggal nota kertas ditarik.
 * Target di parameter `m9.kpi_targets` (KPI-04: `m5.receivable_rules`, KPI-09: PAR-23).
 */
import "server-only";

import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import { accountingPeriods, cashDays, dailySummaries, employees, kpiManualInputs, parallelRunChecks, userRoles, users } from "@/db/schema";
import type { KpiStatus, KpiValue } from "@/client/m9-reports/types";
import { label, type RoleCode } from "@/lib/labels";
import { businessDateToUtcRange, lastDayOfMonth, toBusinessDate, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, parseInput } from "@/server/core/errors";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";
import * as m2 from "@/server/modules/m2-orders";
import * as m4 from "@/server/modules/m4-cash";

import { kpi04TargetPercent, receivablesAsOf, sumTrips, tripsDaily } from "../metrics";
import { kpiSchema, ownerHoursSchema } from "../schemas";
import { reportRules } from "./h0";
import { shiftMonth } from "./monthly";
import { parallelUnits } from "./parallel";

export type KpiTargets = {
  kpi01_min_percent: number;
  kpi02_max_minutes: number;
  kpi03_max_count: number;
  kpi05_min_percent: number;
  kpi06_max_count: number;
  kpi08_min_percent: number;
  kpi11_min_percent: number;
};

/** Peran lapangan untuk KPI-11 (kernet dihitung hanya saat menjadi pengemudi pengganti — tidak dimasukkan). */
export const KPI11_ROLES: readonly RoleCode[] = ["driver", "depot_operator", "store_cashier", "production_operator"];

const pct = (a: number, b: number) => (b === 0 ? null : Math.round((a / b) * 10_000) / 100);
const fmtPct = (v: number | null) => (v === null ? "—" : `${v.toLocaleString("id-ID", { maximumFractionDigits: 2 })}%`);

function monthBounds(month: string, today: BusinessDate): { from: BusinessDate; to: BusinessDate; complete: boolean } {
  const from = `${month}-01`;
  const end = lastDayOfMonth(from);
  return { from, to: end < today ? end : today, complete: end < today };
}

export type KpiMonth = { month: string; from: BusinessDate; to: BusinessDate; complete: boolean; values: KpiValue[] };

/** Hitung sebelas KPI untuk satu bulan (tanpa otorisasi kecuali KPI-06 yang memakai laporan M2 berizin pelaku). */
export async function computeKpiMonth(tx: Tx, ctx: ActorContext, month: string): Promise<KpiMonth> {
  const tenantId = ctx.tenantId;
  const today = ctxBusinessDate(ctx);
  const { from, to, complete } = monthBounds(month, today);
  if (from > today) return { month, from, to: from, complete: false, values: [] };
  const targets = (await params.get(tx, "m9.kpi_targets", to, { tenantId })) as KpiTargets;
  const rules = await reportRules(tx, to, tenantId);
  const { start } = businessDateToUtcRange(from);
  const { end } = businessDateToUtcRange(to);
  const values: KpiValue[] = [];

  // KPI-01 ------------------------------------------------------------------------------------------------------
  const k1 = await tx.execute<{ total: string; ok: string }>(sql`
    select count(*) as total, count(*) filter (where recorded_by_office = false and late_sync = false) as ok from (
      select recorded_by_office, late_sync from trips where tenant_id = ${tenantId} and status = 'completed'
        and completion_business_date >= ${from} and completion_business_date <= ${to}
      union all select recorded_by_office, late_sync from pos_sales where tenant_id = ${tenantId} and is_reversal = false
        and business_date >= ${from} and business_date <= ${to}
      union all select recorded_by_office, late_sync from meter_readings where tenant_id = ${tenantId} and adjustment_kind is null
        and business_date >= ${from} and business_date <= ${to}
      union all select recorded_by_office, late_sync from truck_fills where tenant_id = ${tenantId} and volume_l > 0 and reversal_of_id is null
        and business_date >= ${from} and business_date <= ${to}
    ) x`);
  const k1Total = Number(k1.rows[0]?.total ?? 0);
  const k1Ok = Number(k1.rows[0]?.ok ?? 0);
  const k1Val = pct(k1Ok, k1Total);
  values.push({
    code: "KPI-01",
    name: "Transaksi tercatat hari yang sama",
    formula: "Transaksi lapangan tercatat di perangkat sumber oleh pelakunya dan tersinkron sebelum kas harinya ditutup ÷ seluruh transaksi lapangan",
    source: "M3, M6, M7, M8, M4",
    unit: "percent",
    value: k1Val,
    display: fmtPct(k1Val),
    target: `${targets.kpi01_min_percent}%`,
    status: k1Val === null ? "no_data" : k1Val >= targets.kpi01_min_percent ? "met" : "not_met",
    detail: `${k1Ok} dari ${k1Total} transaksi (dicatat kantor & terlambat sinkron tidak memenuhi).`,
  });

  // KPI-02 ------------------------------------------------------------------------------------------------------
  const days = await tx
    .select({ closedAt: cashDays.closedAt, last: cashDays.lastDepositReceivedAt })
    .from(cashDays)
    .where(and(eq(cashDays.tenantId, tenantId), eq(cashDays.status, "closed"), gte(cashDays.businessDate, from), lte(cashDays.businessDate, to)));
  const minutes = days.filter((d) => d.closedAt && d.last).map((d) => Math.max(0, Math.round((d.closedAt!.getTime() - d.last!.getTime()) / 60_000)));
  const avg = minutes.length ? Math.round(minutes.reduce((s, m) => s + m, 0) / minutes.length) : null;
  values.push({
    code: "KPI-02",
    name: "Waktu rekonsiliasi harian",
    formula: "Menit dari setoran terakhir hari itu Diterima sampai kas ditutup Admin Keuangan (rata-rata harian)",
    source: "M4, M10",
    unit: "minutes",
    value: avg,
    display: avg === null ? "—" : `${avg} menit`,
    target: `≤ ${targets.kpi02_max_minutes} menit`,
    status: avg === null ? "no_data" : avg <= targets.kpi02_max_minutes ? "met" : "not_met",
    detail: minutes.length ? `${minutes.length} hari kas ditutup; terlama ${Math.max(...minutes)} menit; ${minutes.filter((m) => m > targets.kpi02_max_minutes).length} hari di atas target.` : "Belum ada hari kas ditutup.",
  });

  // KPI-03 ------------------------------------------------------------------------------------------------------
  const k3 = await m4.kpi03(tx, tenantId, { from, to, now: ctx.now });
  values.push({
    code: "KPI-03",
    name: "Selisih tak terjelaskan > 24 jam",
    formula: `Jumlah selisih yang belum Selesai lebih dari ${k3.followUpHours} jam sejak terbentuk`,
    source: "M4",
    unit: "count",
    value: k3.overdue,
    display: `${k3.overdue} selisih`,
    target: `${targets.kpi03_max_count}/bulan`,
    status: k3.overdue <= targets.kpi03_max_count ? "met" : "not_met",
    detail: `${k3.total} selisih terbentuk bulan ini.`,
  });

  // KPI-04 ------------------------------------------------------------------------------------------------------
  const recv = await receivablesAsOf(tx, tenantId, to);
  const k4Target = await kpi04TargetPercent(tx, tenantId, to);
  values.push({
    code: "KPI-04",
    name: "Piutang lewat tempo",
    formula: "Nilai faktur lewat jatuh tempo ÷ total piutang terbuka, per akhir hari",
    source: "M5",
    unit: "percent",
    value: recv.balance ? recv.overduePct : null,
    display: recv.balance ? fmtPct(recv.overduePct) : "—",
    target: `< ${k4Target}%`,
    status: recv.balance === 0 ? "no_data" : recv.overduePct < k4Target ? "met" : "not_met",
    detail: `Per ${to}: lewat tempo ${recv.overdue.toLocaleString("id-ID")} dari ${recv.balance.toLocaleString("id-ID")} rupiah.`,
  });

  // KPI-05 ------------------------------------------------------------------------------------------------------
  const checks = await tx
    .select({ paper: parallelRunChecks.paperCount, system: parallelRunChecks.systemCount })
    .from(parallelRunChecks)
    .where(and(eq(parallelRunChecks.tenantId, tenantId), gte(parallelRunChecks.businessDate, from), lte(parallelRunChecks.businessDate, to)));
  const paper = checks.reduce((s, c) => s + c.paper, 0);
  const shortfall = checks.reduce((s, c) => s + Math.max(0, c.paper - c.system), 0);
  const gps = await tx.execute<{ n: string }>(sql`
    select count(*) as n from fleet_events where tenant_id = ${tenantId} and kind in ('off_schedule_trip')
      and business_date >= ${from} and business_date <= ${to} and coalesce(review_decision::text, '') <> 'accepted'`);
  const gpsNoOrder = Number(gps.rows[0]?.n ?? 0);
  const k5Val = paper ? pct(paper - shortfall, paper) : 100;
  values.push({
    code: "KPI-05",
    name: "Pesanan bernomor & berstatus",
    formula: "100% menurut rancangan (US-M2-02); diverifikasi: setiap nota kertas (lembar pencocokan NFR-35) dan setiap rit terdeteksi GPS punya nomor pesanan",
    source: "M2, M12",
    unit: "percent",
    value: k5Val,
    display: paper ? fmtPct(k5Val) : "100% (menurut rancangan)",
    target: `${targets.kpi05_min_percent}%`,
    status: (k5Val ?? 0) >= targets.kpi05_min_percent && gpsNoOrder === 0 ? "met" : "not_met",
    detail: `${paper} nota kertas dicocokkan (${shortfall} tanpa transaksi sistem); ${gpsNoOrder} perjalanan GPS di luar jadwal belum diterima alasannya.`,
  });

  // KPI-06 ------------------------------------------------------------------------------------------------------
  let k6: { dup: number; overdue: number } | null = null;
  try {
    const r = await m2.kpi06Report(ctx, month, { tx });
    k6 = { dup: r.duplicateCancelled, overdue: r.overdueUnscheduled };
  } catch {
    k6 = null;
  }
  const k6Val = k6 ? k6.dup + k6.overdue : null;
  values.push({
    code: "KPI-06",
    name: "Pesanan terlewat/dobel",
    formula: "Pesanan lewat tanggal diminta tanpa penjadwalan ulang beralasan + pesanan dibatalkan dengan alasan \"dobel\"",
    source: "M2",
    unit: "count",
    value: k6Val,
    display: k6Val === null ? "—" : `${k6Val} pesanan`,
    target: `${targets.kpi06_max_count}/bulan`,
    status: k6Val === null ? "no_data" : k6Val <= targets.kpi06_max_count ? "met" : "not_met",
    detail: k6 ? `${k6.overdue} terlewat, ${k6.dup} dibatalkan dobel.` : "Butuh izin pesanan (M2).",
  });

  // KPI-07 ------------------------------------------------------------------------------------------------------
  const t = sumTrips(await tripsDaily(tx, tenantId, from, to)).totals;
  const k7 = pct(t.completed, t.scheduled);
  const cust = pct(t.completed - t.internalCompleted, t.scheduled - t.internalScheduled);
  const internal = pct(t.internalCompleted, t.internalScheduled);
  values.push({
    code: "KPI-07",
    name: "Rit terealisasi vs terjadwal",
    formula: "Rit Selesai ÷ rit terjadwal, per truk per hari; rit pelanggan dan rit internal (pasokan depot) dilaporkan terpisah dan gabungan",
    source: "M2, M3",
    unit: "percent",
    value: k7,
    display: fmtPct(k7),
    target: "Baseline 3 bulan (kalibrasi PAR-33)",
    status: t.scheduled ? "baseline" : "no_data",
    detail: `Pelanggan ${fmtPct(cust)}, internal ${fmtPct(internal)} — ${t.completed} dari ${t.scheduled} rit.`,
  });

  // KPI-08 ------------------------------------------------------------------------------------------------------
  const closedDays = days.length;
  const sums = await tx
    .select({ publishedAt: dailySummaries.publishedAt, cashClosedAt: dailySummaries.cashClosedAt, late: dailySummaries.publishedLate })
    .from(dailySummaries)
    .where(and(eq(dailySummaries.tenantId, tenantId), gte(dailySummaries.businessDate, from), lte(dailySummaries.businessDate, to), inArray(dailySummaries.status, ["published", "reviewed"])));
  const onTime = sums.filter((s) => s.publishedAt && s.cashClosedAt && s.publishedAt.getTime() - s.cashClosedAt.getTime() <= rules.h0_publish_minutes * 60_000).length;
  const k8 = pct(onTime, closedDays);
  values.push({
    code: "KPI-08",
    name: "Laporan H+0",
    formula: `Hari dengan H+0 terbit ≤ ${rules.h0_publish_minutes} menit setelah tutup kas ÷ hari kas ditutup (NFR-04)`,
    source: "M9",
    unit: "percent",
    value: k8,
    display: fmtPct(k8),
    target: `${targets.kpi08_min_percent}% hari`,
    status: k8 === null ? "no_data" : k8 >= targets.kpi08_min_percent ? "met" : "not_met",
    detail: `${onTime} dari ${closedDays} hari kas ditutup; ${sums.length} H+0 terbit.`,
  });

  // KPI-09 ------------------------------------------------------------------------------------------------------
  const par23 = await params.get(tx, "PAR-23", to, { tenantId });
  const deadline = `${shiftMonth(month, 1)}-${String(par23.day_of_next_month).padStart(2, "0")}`;
  const [period] = await tx.select().from(accountingPeriods).where(and(eq(accountingPeriods.tenantId, tenantId), eq(accountingPeriods.period, month))).limit(1);
  const lockedOn = period?.status === "locked" && period.lockedAt ? toBusinessDate(period.lockedAt) : null;
  const k9Status: KpiStatus = lockedOn ? (lockedOn <= deadline ? "met" : "not_met") : today <= deadline ? "pending" : "not_met";
  values.push({
    code: "KPI-09",
    name: "Laba kotor per lini",
    formula: `Laporan bulanan Final (periode dikunci) paling lambat tanggal ${par23.day_of_next_month} bulan berikutnya (BR-32)`,
    source: "M11",
    unit: "text",
    value: null,
    display: lockedOn ? `Final ${lockedOn}` : period ? label("period_status", period.status) : "Belum ada periode",
    target: `≤ ${deadline}`,
    status: k9Status,
    detail: lockedOn ? `Periode dikunci ${lockedOn}.` : `Batas ${deadline}.`,
  });

  // KPI-10 ------------------------------------------------------------------------------------------------------
  const [manual] = await tx
    .select()
    .from(kpiManualInputs)
    .where(and(eq(kpiManualInputs.tenantId, tenantId), eq(kpiManualInputs.kpiCode, "KPI-10"), eq(kpiManualInputs.period, month)))
    .limit(1);
  const sessionHours = await ownerSessionHours(tx, tenantId, start, end);
  values.push({
    code: "KPI-10",
    name: "Waktu pemilik untuk pencatatan",
    formula: "Jam pemilik per minggu dari catatan pemilik (input manual); pembanding: total durasi sesi pemilik per bulan",
    source: "M9, M10",
    unit: "hours",
    value: manual ? Number(manual.value) : null,
    display: manual ? `${Number(manual.value).toLocaleString("id-ID")} jam/minggu` : "Belum diisi",
    target: "Baseline sebelum go-live",
    status: manual ? "baseline" : "no_data",
    detail: `Durasi sesi web pemilik bulan ini ± ${sessionHours.toLocaleString("id-ID", { maximumFractionDigits: 1 })} jam.${manual?.note ? ` Catatan: ${manual.note}` : ""}`,
  });

  // KPI-11 ------------------------------------------------------------------------------------------------------
  const adoption = await fieldAdoption(tx, tenantId, from, to);
  const units = await parallelUnits(tx, tenantId, today);
  const withdrawn = units.filter((u) => u.withdrawnDate && u.withdrawnDate <= to);
  values.push({
    code: "KPI-11",
    name: "Adopsi lapangan",
    formula: "Pengguna aktif per peran per hari ÷ jumlah karyawan pada peran itu (rata-rata hari operasi); tanggal nota kertas ditarik per unit",
    source: "M10, M9",
    unit: "percent",
    value: adoption.overall,
    display: fmtPct(adoption.overall),
    target: `${targets.kpi11_min_percent}%`,
    status: adoption.overall === null ? "no_data" : adoption.overall >= targets.kpi11_min_percent ? "met" : "not_met",
    detail:
      adoption.byRole.map((r) => `${r.label} ${fmtPct(r.pct)}`).join(" · ") +
      `. Nota kertas ditarik: ${withdrawn.length ? withdrawn.map((u) => `${u.unitLabel} (${u.withdrawnDate})`).join(", ") : "belum ada unit"}.`,
  });
  return { month, from, to, complete, values };
}

/** Total durasi sesi web pemilik (jam) dalam rentang — pembanding KPI-10 [USULAN]. */
export async function ownerSessionHours(tx: Tx, tenantId: string, start: Date, end: Date): Promise<number> {
  const res = await tx.execute<{ seconds: string }>(sql`
    select coalesce(sum(extract(epoch from (least(coalesce(s.revoked_at, s.last_active_at), s.last_active_at) - s.created_at))), 0) as seconds
    from sessions s
    join users u on u.id = s.user_id
    join user_roles r on r.user_id = u.id and r.role = 'owner' and r.status = 'active'
    where u.tenant_id = ${tenantId} and s.kind = 'web' and s.created_at >= ${start} and s.created_at < ${end}`);
  return Math.round((Number(res.rows[0]?.seconds ?? 0) / 3600) * 10) / 10;
}

/** KPI-11: pengguna aktif (perintah sinkron diterima) per peran lapangan per hari ÷ pengguna berperan itu. */
export async function fieldAdoption(tx: Tx, tenantId: string, from: BusinessDate, to: BusinessDate): Promise<{ overall: number | null; byRole: { role: RoleCode; label: string; users: number; pct: number | null }[] }> {
  const roleUsers = await tx
    .select({ role: userRoles.role, userId: users.id })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(and(eq(users.tenantId, tenantId), eq(users.status, "active"), eq(userRoles.status, "active"), inArray(userRoles.role, [...KPI11_ROLES])));
  const active = await tx.execute<{ user_id: string; d: string }>(sql`
    select distinct user_id, coalesce(business_date::text, to_char(received_at at time zone 'Asia/Jakarta', 'YYYY-MM-DD')) as d
    from sync_commands where tenant_id = ${tenantId} and user_id is not null and status in ('applied', 'conflict')
      and received_at >= ${businessDateToUtcRange(from).start} and received_at < ${businessDateToUtcRange(to).end}`);
  const operatingDays = [...new Set(active.rows.map((r) => String(r.d)))].filter((d) => d >= from && d <= to);
  const byRole = KPI11_ROLES.map((role) => {
    const members = new Set(roleUsers.filter((r) => r.role === role).map((r) => r.userId));
    if (!members.size || !operatingDays.length) return { role, label: label("role", role), users: members.size, pct: null as number | null };
    let sum = 0;
    for (const d of operatingDays) {
      const act = new Set(active.rows.filter((r) => String(r.d) === d && members.has(r.user_id)).map((r) => r.user_id));
      sum += act.size / members.size;
    }
    return { role, label: label("role", role), users: members.size, pct: Math.round((sum / operatingDays.length) * 10_000) / 100 };
  });
  const measured = byRole.filter((r) => r.pct !== null);
  const overall = measured.length ? Math.round((measured.reduce((s, r) => s + r.pct!, 0) / measured.length) * 100) / 100 : null;
  return { overall, byRole };
}

export type KpiPage = {
  month: string;
  current: KpiMonth;
  history: KpiMonth[];
  canInputOwnerHours: boolean;
  ownerHours: { month: string; value: number; note: string | null }[];
};

/** Halaman KPI: bulan berjalan/dipilih + riwayat bulanan sejak pilot (US-M9-07 KP-1). Hanya pemilik. */
export async function getKpiReport(ctx: ActorContext, input: unknown = {}, opts: { tx?: Tx } = {}): Promise<KpiPage> {
  await authorize(ctx, "m9.kpi.read", { tx: opts.tx });
  const data = parseInput(kpiSchema, input ?? {}, { month: "Bulan" });
  const db = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const month = data.month ?? today.slice(0, 7);
  if (`${month}-01` > today) throw new DomainError("FUTURE_MONTH", "Bulan belum dimulai.");
  const rules = await reportRules(db, today, ctx.tenantId);
  const startMonth = rules.pilot_start_date ? rules.pilot_start_date.slice(0, 7) : shiftMonth(month, -11);
  const history: KpiMonth[] = [];
  for (let m = startMonth; m <= month; m = shiftMonth(m, 1)) {
    history.push(await computeKpiMonth(db, ctx, m));
    if (history.length > 36) break;
  }
  const current = history.find((h) => h.month === month) ?? (await computeKpiMonth(db, ctx, month));
  const owner = await db.select().from(kpiManualInputs).where(and(eq(kpiManualInputs.tenantId, ctx.tenantId), eq(kpiManualInputs.kpiCode, "KPI-10"))).orderBy(asc(kpiManualInputs.period));
  return {
    month,
    current,
    history,
    canInputOwnerHours: ctx.roles.includes("owner"),
    ownerHours: owner.map((o) => ({ month: o.period, value: Number(o.value), note: o.note })),
  };
}

/** KPI-10: pemilik mengisi jam pencatatan per minggu (rata-rata bulan) dari catatannya (US-M9-07 KP-2). */
export async function setOwnerHours(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m9.kpi_input.create", { tx: opts.tx });
  const data = parseInput(ownerHoursSchema, input, { month: "Bulan", hoursPerWeek: "Jam per minggu", note: "Catatan" });
  if (!ctx.roles.includes("owner")) throw new DomainError("OWNER_ONLY", "KPI-10 diisi pemilik dari catatannya sendiri.");
  if (`${data.month}-01` > ctxBusinessDate(ctx)) throw new DomainError("FUTURE_MONTH", "Bulan belum dimulai.");
  return runService(ctx, opts, async (tx) => {
    const [existing] = await tx
      .select()
      .from(kpiManualInputs)
      .where(and(eq(kpiManualInputs.tenantId, ctx.tenantId), eq(kpiManualInputs.kpiCode, "KPI-10"), eq(kpiManualInputs.period, data.month)))
      .limit(1);
    if (existing) {
      const [row] = await tx.update(kpiManualInputs).set({ value: data.hoursPerWeek, note: data.note ?? null, updatedAt: ctx.now }).where(eq(kpiManualInputs.id, existing.id)).returning();
      await auditRecord(tx, { ctx, objectType: "kpi_manual_input", objectId: existing.id, action: "update", before: { value: Number(existing.value), note: existing.note }, after: { value: data.hoursPerWeek, note: data.note ?? null }, reason: data.note ?? null });
      return row!;
    }
    const [row] = await tx.insert(kpiManualInputs).values({ tenantId: ctx.tenantId, kpiCode: "KPI-10", period: data.month, value: data.hoursPerWeek, note: data.note ?? null, createdBy: ctx.userId }).returning();
    await auditRecord(tx, { ctx, objectType: "kpi_manual_input", objectId: row!.id, action: "create", after: { kpiCode: "KPI-10", period: data.month, value: data.hoursPerWeek } });
    return row!;
  });
}

