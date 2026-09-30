/**
 * M9 — Dashboard "Hari ini" / Ringkasan H+0 (US-M9-01; US-M4-06 KP-5/KP-6; NFR-03/04/19; KPI-08; Bab 5.3; 7.9.7).
 *
 * - Enam blok (omzet per lini + transfer internal terpisah, kas, piutang, rit per truk, galon per depot, pengecualian)
 *   dihitung `metrics.ts` — satu definisi untuk hari ini, kemarin, 7 hari, bulan berjalan, dan riwayat per tanggal.
 * - Sebelum kas ditutup: angka berjalan berlabel "Belum ditutup — angka dapat berubah". `cash_day.closed` (M4) →
 *   `publishDailySummary` menyimpan snapshot TERKUNCI (`daily_summaries`, status Terbit) dengan cap waktu kas ditutup &
 *   H+0 terbit (KPI-08) + notifikasi pemilik. Job cadangan menerbitkan hari kas tertutup yang belum terbit (penanda
 *   terlambat). Tidak ada H+0 manual.
 * - Setelah terbit angka tidak pernah berubah: transaksi terlambat sinkron & koreksi menjadi ADDENDA bertanda
 *   (`daily_summary_addenda`) pada tanggal masing-masing (lihat `addenda.ts`).
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";

import { cashDays, customers, dailySummaries, dailySummaryAddenda, deposits, discrepancies, employees, outlets, posSaleLines, posSales, shifts, trips, trucks } from "@/db/schema";
import type { AddendumView, CashFigures, DailySnapshot, H0Range, ReceivableFigures, RevenueFigures, SummaryStatusView } from "@/client/m9-reports/types";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, businessDateToUtcRange, firstDayOfMonth, formatJam, formatTanggal, toBusinessDate, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, can, runService } from "@/server/core/rbac";
import * as m4 from "@/server/modules/m4-cash";
import * as m6 from "@/server/modules/m6-pos";

import {
  cashForDay,
  datesInRange,
  discrepanciesAwaitingOwner,
  exceptionsForRange,
  gallonsDaily,
  metricsContext,
  receivablesAsOf,
  receivablesFlowDaily,
  kpi04TargetPercent,
  revenueDaily,
  sumCash,
  sumGallons,
  sumRevenue,
  sumTrips,
  tripsDaily,
  userNames,
  emptyRevenue,
  type TripDayRow,
} from "../metrics";
import { dashboardSchema, decideDiscrepancySchema, drilldownSchema, reviewSummarySchema } from "../schemas";

export type DailySummaryRow = typeof dailySummaries.$inferSelect;

export type M9ReportRules = {
  h0_publish_minutes: number;
  h0_catch_up_days: number;
  trend_periods: number;
  on_time_window_minutes: number;
  inbox_lookback_days: number;
  water_cost_trend_months: number;
  pilot_start_date: string | null;
};

export async function reportRules(tx: Tx, date: BusinessDate, tenantId: string): Promise<M9ReportRules> {
  return (await params.get(tx, "m9.report_rules", date, { tenantId })) as M9ReportRules;
}

// =====================================================================================================================
// Snapshot satu hari (dipakai terbit H+0 & tampilan berjalan)
// =====================================================================================================================

/** Hitung enam blok H+0 untuk satu tanggal (angka berjalan atau snapshot yang akan dikunci). */
export async function computeDaySnapshot(tx: Tx, tenantId: string, date: BusinessDate, now: Date): Promise<DailySnapshot> {
  const ctx = metricsContext(tenantId, now);
  const [revMap, tripRows, gallonRows, flow, asOf, targetPct] = await Promise.all([
    revenueDaily(tx, tenantId, date, date),
    tripsDaily(tx, tenantId, date, date),
    gallonsDaily(tx, tenantId, date, date),
    receivablesFlowDaily(tx, tenantId, date, date),
    receivablesAsOf(tx, tenantId, date),
    kpi04TargetPercent(tx, tenantId, date),
  ]);
  const cash = await cashForDay(tx, ctx, date);
  const exceptions = await exceptionsForRange(tx, tenantId, date, date, now, cash.unmatchedTransfers);
  const f = flow.get(date) ?? { formed: 0, paid: 0 };
  const { rows: _rows, ...cashFigures } = cash;
  void _rows;
  return {
    version: 1,
    from: date,
    to: date,
    computedAt: now.toISOString(),
    revenue: revMap.get(date) ?? emptyRevenue(),
    cash: cashFigures,
    receivables: { balance: asOf.balance, overdue: asOf.overdue, overduePct: asOf.overduePct, formed: f.formed, paid: f.paid, targetPct },
    trips: sumTrips(tripRows),
    gallons: sumGallons(gallonRows),
    exceptions,
  };
}

// =====================================================================================================================
// Terbit H+0 (handler cash_day.closed + job cadangan)
// =====================================================================================================================

export type PublishInput = {
  tenantId: string;
  date: BusinessDate;
  now: Date;
  cashDayId?: string | null;
  cashClosedAt?: Date | null;
  cashClosedLate?: boolean;
  trigger: "cash_day_closed" | "catch_up";
};

/**
 * Terbitkan ringkasan H+0 (idempoten): snapshot terkunci + cap waktu kas ditutup & terbit + penanda terlambat
 * (> `m9.report_rules.h0_publish_minutes` setelah tutup kas, atau tutup kas sendiri terlambat — 7.9.7) + notifikasi pemilik.
 */
export async function publishDailySummary(tx: Tx, input: PublishInput): Promise<{ summary: DailySummaryRow; created: boolean }> {
  const existing = await tx
    .select()
    .from(dailySummaries)
    .where(and(eq(dailySummaries.tenantId, input.tenantId), eq(dailySummaries.businessDate, input.date)))
    .for("update")
    .limit(1);
  if (existing[0] && existing[0].status !== "running") return { summary: existing[0], created: false };
  let cashDay = input.cashDayId
    ? (await tx.select().from(cashDays).where(eq(cashDays.id, input.cashDayId)).limit(1))[0]
    : (await tx.select().from(cashDays).where(and(eq(cashDays.tenantId, input.tenantId), eq(cashDays.businessDate, input.date))).limit(1))[0];
  if (!cashDay || cashDay.status !== "closed") {
    // Tidak ada H+0 tanpa tutup kas (7.9.7).
    throw new DomainError("CASH_DAY_OPEN", "H+0 hanya terbit setelah kas harian ditutup Admin Keuangan.");
  }
  cashDay = cashDay!;
  const closedAt = input.cashClosedAt ?? cashDay.closedAt ?? input.now;
  const rules = await reportRules(tx, input.date, input.tenantId);
  const snapshot = await computeDaySnapshot(tx, input.tenantId, input.date, input.now);
  const minutes = Math.max(0, Math.round((input.now.getTime() - closedAt.getTime()) / 60_000));
  const late = (input.cashClosedLate ?? cashDay.closedLate) || minutes > rules.h0_publish_minutes;
  const values = {
    status: "published" as const,
    snapshot: snapshot as unknown as Record<string, unknown>,
    cashDayId: cashDay.id,
    cashClosedAt: closedAt,
    publishedAt: input.now,
    publishedLate: late,
    updatedAt: input.now,
  };
  let row: DailySummaryRow;
  if (existing[0]) {
    [row] = (await tx.update(dailySummaries).set(values).where(eq(dailySummaries.id, existing[0].id)).returning()) as [DailySummaryRow];
  } else {
    const inserted = await tx
      .insert(dailySummaries)
      .values({ tenantId: input.tenantId, businessDate: input.date, ...values })
      .onConflictDoNothing()
      .returning();
    if (!inserted[0]) {
      const again = await tx.select().from(dailySummaries).where(and(eq(dailySummaries.tenantId, input.tenantId), eq(dailySummaries.businessDate, input.date))).limit(1);
      return { summary: again[0]!, created: false };
    }
    row = inserted[0];
  }
  const ctx = systemContext({ tenantId: input.tenantId, now: input.now });
  await auditRecord(tx, {
    ctx,
    objectType: "daily_summary",
    objectId: row.id,
    action: "publish",
    after: {
      businessDate: input.date,
      cashClosedAt: closedAt.toISOString(),
      publishedAt: input.now.toISOString(),
      publishMinutes: minutes,
      publishedLate: late,
      externalRevenue: snapshot.revenue.external,
      cashDiscrepancy: snapshot.cash.discrepancy,
      trigger: input.trigger,
    },
    rule: "NFR-04, US-M9-01 KP-2, KPI-08",
    businessDate: input.date,
  });
  await notify(tx, {
    event: "daily_summary.published",
    tenantId: input.tenantId,
    title: `H+0 ${formatTanggal(input.date)} terbit${late ? " (terlambat)" : ""}`,
    body:
      `Kas ditutup ${formatJam(closedAt)} · H+0 terbit ${formatJam(input.now)} (${minutes} menit)${late ? " — terlambat" : ""}. ` +
      `Omzet luar ${formatRupiah(snapshot.revenue.external)}, selisih kas ${formatRupiah(snapshot.cash.discrepancy, { signed: true })}, ` +
      `${snapshot.exceptions.total} pengecualian menunggu.`,
    objectType: "daily_summary",
    objectId: row.id,
    valueAmount: snapshot.revenue.external,
    link: `/laporan/hari-ini?tanggal=${input.date}`,
    groupKey: `daily_summary:${input.date}`,
    now: input.now,
  });
  return { summary: row, created: true };
}

/**
 * Job cadangan (≤ 5 menit): terbitkan H+0 untuk hari kas yang sudah DITUTUP dalam `h0_catch_up_days` terakhir tetapi
 * belum terbit (mis. handler gagal) — penanda terlambat bila > batas terbit.
 */
export async function publishPendingSummaries(now: Date, db: Tx = getDb()): Promise<{ published: string[] }> {
  const today = toBusinessDate(now);
  const rows = await db.execute<{ tenant_id: string; business_date: string; id: string; closed_at: Date | string | null; closed_late: boolean }>(sql`
    select cd.tenant_id, cd.business_date, cd.id, cd.closed_at, cd.closed_late
    from cash_days cd
    left join daily_summaries ds on ds.tenant_id = cd.tenant_id and ds.business_date = cd.business_date and ds.status <> 'running'
    where cd.status = 'closed' and ds.id is null and cd.business_date >= ${addDays(today, -60)}
    order by cd.business_date`);
  const published: string[] = [];
  for (const r of rows.rows) {
    const date = String(r.business_date);
    const rules = await reportRules(db, today, r.tenant_id);
    if (date < addDays(today, -rules.h0_catch_up_days)) continue;
    await withTx(async (tx) => {
      const res = await publishDailySummary(tx, {
        tenantId: r.tenant_id,
        date,
        now,
        cashDayId: r.id,
        cashClosedAt: r.closed_at ? new Date(r.closed_at) : null,
        cashClosedLate: r.closed_late,
        trigger: "catch_up",
      });
      if (res.created) published.push(`${r.tenant_id}:${date}`);
    });
  }
  return { published };
}

// =====================================================================================================================
// Tampilan dashboard (US-M9-01 KP-1/2/5/6/7)
// =====================================================================================================================

export type DailyDashboard = {
  range: H0Range | "history";
  from: BusinessDate;
  to: BusinessDate;
  today: BusinessDate;
  isSingleDay: boolean;
  /** Ada hari dalam rentang yang belum terbit → label "Belum ditutup — angka dapat berubah" (KP-2). */
  unclosed: boolean;
  status: SummaryStatusView;
  data: DailySnapshot;
  /** Catatan tambahan bertanda untuk tanggal dalam rentang (terlambat sinkron / koreksi / setoran tertunda) — KP-6. */
  addenda: AddendumView[];
  /** Koreksi yang DICATAT dalam rentang atas hari lain (7.9.7: tampil pada tanggal koreksi dengan rujukan hari asal). */
  correctionsRecorded: AddendumView[];
  /** Selisih menunggu keputusan pemilik (aksi satu ketuk, KP-4) — selalu data terkini. */
  pendingDiscrepancies: Awaited<ReturnType<typeof discrepanciesAwaitingOwner>>;
  canDecide: boolean;
  canReview: boolean;
  computeMs: number;
};

function resolveRange(today: BusinessDate, range: H0Range | undefined, date: BusinessDate | null | undefined): { range: H0Range | "history"; from: BusinessDate; to: BusinessDate } {
  if (date) return { range: date === today ? "today" : "history", from: date, to: date };
  switch (range ?? "today") {
    case "yesterday":
      return { range: "yesterday", from: addDays(today, -1), to: addDays(today, -1) };
    case "last7":
      return { range: "last7", from: addDays(today, -6), to: today };
    case "month":
      return { range: "month", from: firstDayOfMonth(today), to: today };
    default:
      return { range: "today", from: today, to: today };
  }
}

function toAddendumView(a: typeof dailySummaryAddenda.$inferSelect): AddendumView {
  return {
    id: a.id,
    businessDate: a.businessDate,
    recordedOn: a.recordedOn,
    kind: a.kind,
    kindLabel: label("summary_addendum_kind", a.kind),
    description: a.description,
    objectType: a.objectType,
    objectId: a.objectId,
    delta: (a.delta as Record<string, unknown> | null) ?? null,
  };
}

export async function listAddenda(tx: Tx, tenantId: string, from: BusinessDate, to: BusinessDate): Promise<{ onDates: AddendumView[]; recorded: AddendumView[] }> {
  const rows = await tx
    .select({ a: dailySummaryAddenda })
    .from(dailySummaryAddenda)
    .innerJoin(dailySummaries, eq(dailySummaries.id, dailySummaryAddenda.dailySummaryId))
    .where(
      and(
        eq(dailySummaries.tenantId, tenantId),
        sql`((${dailySummaryAddenda.businessDate} >= ${from} and ${dailySummaryAddenda.businessDate} <= ${to}) or (${dailySummaryAddenda.recordedOn} >= ${from} and ${dailySummaryAddenda.recordedOn} <= ${to}))`,
      ),
    )
    .orderBy(asc(dailySummaryAddenda.createdAt));
  const onDates = rows.filter((r) => r.a.businessDate >= from && r.a.businessDate <= to).map((r) => toAddendumView(r.a));
  const recorded = rows.filter((r) => r.a.recordedOn >= from && r.a.recordedOn <= to && (r.a.businessDate < from || r.a.businessDate > to)).map((r) => toAddendumView(r.a));
  return { onDates, recorded };
}

function summaryStatus(rows: DailySummaryRow[], dates: BusinessDate[]): SummaryStatusView {
  if (dates.length === 1) {
    const s = rows[0];
    if (!s || s.status === "running") {
      return { status: "running", label: label("daily_summary_status", "running"), cashClosedAt: null, publishedAt: null, publishedLate: false, publishMinutes: null, reviewedAt: null, summaryId: s?.id ?? null };
    }
    const minutes = s.publishedAt && s.cashClosedAt ? Math.max(0, Math.round((s.publishedAt.getTime() - s.cashClosedAt.getTime()) / 60_000)) : null;
    return {
      status: s.status,
      label: label("daily_summary_status", s.status),
      cashClosedAt: s.cashClosedAt?.toISOString() ?? null,
      publishedAt: s.publishedAt?.toISOString() ?? null,
      publishedLate: s.publishedLate,
      publishMinutes: minutes,
      reviewedAt: s.reviewedAt?.toISOString() ?? null,
      summaryId: s.id,
    };
  }
  const published = rows.filter((r) => r.status !== "running").length;
  return {
    status: published === dates.length ? "published" : published === 0 ? "running" : "mixed",
    label: published === dates.length ? "Semua hari terbit" : `${published} dari ${dates.length} hari terbit`,
    cashClosedAt: null,
    publishedAt: null,
    publishedLate: rows.some((r) => r.publishedLate),
    publishMinutes: null,
    reviewedAt: null,
    summaryId: null,
    publishedDays: published,
    totalDays: dates.length,
  };
}

/** Hari dengan aktivitas kas (setoran/shift) — hanya hari ini yang dihitung posisi kas M4-nya di rentang berjalan. */
async function cashActivityDates(tx: Tx, tenantId: string, from: BusinessDate, to: BusinessDate): Promise<Set<string>> {
  const rows = await tx.execute<{ d: string }>(sql`
    select business_date as d from deposits where tenant_id = ${tenantId} and business_date >= ${from} and business_date <= ${to}
    union select business_date as d from shifts where tenant_id = ${tenantId} and business_date >= ${from} and business_date <= ${to}
    union select completion_business_date as d from trips where tenant_id = ${tenantId} and status = 'completed' and completion_business_date >= ${from} and completion_business_date <= ${to}`);
  return new Set(rows.rows.map((r) => String(r.d)));
}

/**
 * Dashboard H+0. Satu hari: snapshot terbit (terkunci) atau angka berjalan. Rentang: Σ angka harian (hari terbit =
 * snapshot, hari lain = berjalan) — definisi sama; piutang = saldo akhir rentang. Hari kas yang sudah ditutup tetapi
 * belum terbit diterbitkan otomatis (cadangan job; terlambat bertanda).
 */
export async function getDailyDashboard(ctx: ActorContext, input: unknown = {}, opts: { tx?: Tx } = {}): Promise<DailyDashboard> {
  await authorize(ctx, "m9.daily_summary.read", { tx: opts.tx });
  const data = parseInput(dashboardSchema, input ?? {}, { range: "Rentang", date: "Tanggal" });
  const started = Date.now();
  const today = ctxBusinessDate(ctx);
  const { range, from, to } = resolveRange(today, data.range, data.date);
  if (to > today) throw new DomainError("FUTURE_DATE", "Tanggal belum terjadi. Pilih hari ini atau tanggal sebelumnya.");
  const db = opts.tx ?? getDb();
  const dates = datesInRange(from, to);

  let summaries = await db.select().from(dailySummaries).where(and(eq(dailySummaries.tenantId, ctx.tenantId), gte(dailySummaries.businessDate, from), lte(dailySummaries.businessDate, to)));
  // Cadangan: hari kas tertutup yang belum terbit (handler gagal/job belum jalan) diterbitkan sistem sekarang.
  if (!opts.tx) {
    const closed = await db
      .select({ date: cashDays.businessDate })
      .from(cashDays)
      .where(and(eq(cashDays.tenantId, ctx.tenantId), eq(cashDays.status, "closed"), gte(cashDays.businessDate, from), lte(cashDays.businessDate, to)));
    const missing = closed.filter((c) => !summaries.some((s) => s.businessDate === c.date && s.status !== "running"));
    if (missing.length) {
      await publishPendingSummaries(ctx.now);
      summaries = await db.select().from(dailySummaries).where(and(eq(dailySummaries.tenantId, ctx.tenantId), gte(dailySummaries.businessDate, from), lte(dailySummaries.businessDate, to)));
    }
  }
  const published = new Map(summaries.filter((s) => s.status !== "running" && s.snapshot).map((s) => [s.businessDate, s.snapshot as unknown as DailySnapshot]));

  let figures: DailySnapshot;
  if (dates.length === 1) {
    figures = published.get(from) ?? (await computeDaySnapshot(db, ctx.tenantId, from, ctx.now));
  } else {
    // Angka hidup hanya untuk tanggal yang BELUM terbit (biasanya hari ini); tanggal terbit memakai snapshot. Agregat
    // harian dihitung atas rentang tanggal belum terbit saja — sebelumnya selalu sebulan penuh (uji beban NFR-05).
    const live = dates.filter((d) => !published.has(d));
    const liveFrom = live[0];
    const liveTo = live[live.length - 1];
    const [revMap, tripRows, gallonRows, flowMap] =
      liveFrom && liveTo
        ? await Promise.all([
            revenueDaily(db, ctx.tenantId, liveFrom, liveTo),
            tripsDaily(db, ctx.tenantId, liveFrom, liveTo),
            gallonsDaily(db, ctx.tenantId, liveFrom, liveTo),
            receivablesFlowDaily(db, ctx.tenantId, liveFrom, liveTo),
          ])
        : [new Map<string, RevenueFigures>(), [] as TripDayRow[], [] as Awaited<ReturnType<typeof gallonsDaily>>, new Map<string, { formed: number; paid: number }>()];
    const activity = liveFrom && liveTo ? await cashActivityDates(db, ctx.tenantId, liveFrom, liveTo) : new Set<string>();
    const revenue: RevenueFigures[] = [];
    const tripsList: TripDayRow[] = [];
    const gallonsList: typeof gallonRows = [];
    const cashList: CashFigures[] = [];
    let formed = 0;
    let paid = 0;
    for (const d of dates) {
      const snap = published.get(d);
      if (snap) {
        revenue.push(snap.revenue);
        tripsList.push(...snap.trips.byTruck.map((t) => ({ ...t, date: d })));
        gallonsList.push(...snap.gallons.byDepot.map((g) => ({ ...g, date: d })));
        cashList.push(snap.cash);
        formed += snap.receivables.formed;
        paid += snap.receivables.paid;
      } else {
        revenue.push(revMap.get(d) ?? emptyRevenue());
        tripsList.push(...tripRows.filter((t) => t.date === d));
        gallonsList.push(...gallonRows.filter((g) => g.date === d));
        if (activity.has(d)) {
          const { rows: _r, ...c } = await cashForDay(db, metricsContext(ctx.tenantId, ctx.now), d);
          void _r;
          cashList.push(c);
        }
        formed += flowMap.get(d)?.formed ?? 0;
        paid += flowMap.get(d)?.paid ?? 0;
      }
    }
    const last = published.get(to);
    const asOf = last ? last.receivables : { ...(await receivablesAsOf(db, ctx.tenantId, to)), targetPct: await kpi04TargetPercent(db, ctx.tenantId, to) };
    const cash = sumCash(cashList);
    const receivables: ReceivableFigures = { balance: asOf.balance, overdue: asOf.overdue, overduePct: asOf.overduePct, targetPct: "targetPct" in asOf ? asOf.targetPct : 0, formed, paid };
    figures = {
      version: 1,
      from,
      to,
      computedAt: ctx.now.toISOString(),
      revenue: sumRevenue(revenue),
      cash,
      receivables,
      trips: sumTrips(tripsList),
      gallons: sumGallons(gallonsList),
      exceptions: await exceptionsForRange(db, ctx.tenantId, from, to, ctx.now, cash.unmatchedTransfers),
    };
  }
  const addenda = await listAddenda(db, ctx.tenantId, from, to);
  const status = summaryStatus(
    dates.length === 1 ? summaries.filter((s) => s.businessDate === from) : summaries,
    dates,
  );
  return {
    range,
    from,
    to,
    today,
    isSingleDay: dates.length === 1,
    unclosed: status.status !== "published" && status.status !== "reviewed",
    status,
    data: figures,
    addenda: addenda.onDates,
    correctionsRecorded: addenda.recorded,
    pendingDiscrepancies: await discrepanciesAwaitingOwner(db, ctx.tenantId, ctx.now),
    canDecide: can(ctx, "m4.discrepancy.decide"),
    canReview: can(ctx, "m9.daily_summary.review"),
    computeMs: Date.now() - started,
  };
}

/** Pemilik menandai H+0 "Ditinjau pemilik" (status siklus 7.9.3). Angka tidak berubah. */
export async function markSummaryReviewed(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<DailySummaryRow> {
  await authorize(ctx, "m9.daily_summary.review", { tx: opts.tx });
  const data = parseInput(reviewSummarySchema, input, { date: "Tanggal", note: "Catatan" });
  return runService(ctx, opts, async (tx) => {
    const [s] = await tx
      .select()
      .from(dailySummaries)
      .where(and(eq(dailySummaries.tenantId, ctx.tenantId), eq(dailySummaries.businessDate, data.date)))
      .for("update")
      .limit(1);
    if (!s || s.status === "running") throw new DomainError("SUMMARY_NOT_PUBLISHED", "H+0 tanggal ini belum terbit. Tunggu kas ditutup Admin Keuangan.");
    if (s.status === "reviewed") return s;
    const [row] = await tx
      .update(dailySummaries)
      .set({ status: "reviewed", reviewedBy: ctx.userId, reviewedAt: ctx.now, updatedAt: ctx.now })
      .where(eq(dailySummaries.id, s.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "daily_summary", objectId: s.id, action: "review", before: { status: s.status }, after: { status: "reviewed" }, reason: data.note ?? null, businessDate: data.date });
    return row!;
  });
}

/**
 * Setujui/tolak penjelasan selisih langsung dari H+0 (US-M9-01 KP-4 = US-M4-06 KP-6): satu ketuk; alasan wajib bila
 * menolak. Memakai keputusan M4 (`decideDiscrepancy`) — lewat persetujuan terbuka bila ada.
 */
export async function decideDiscrepancyFromDashboard(ctx: ActorContext, input: unknown): Promise<void> {
  const data = parseInput(decideDiscrepancySchema, input, { discrepancyId: "Selisih", decision: "Keputusan", reason: "Alasan" });
  await m4.decideDiscrepancy(ctx, data.discrepancyId, { decision: data.decision, reason: data.reason ?? undefined });
}

// =====================================================================================================================
// Turun ke rincian tanpa pindah modul (US-M9-01 KP-3)
// =====================================================================================================================

export type DrilldownResult =
  | { kind: "truck"; title: string; rows: { id: string; number: string; customerName: string; status: string; statusLabel: string; price: number; paymentMethod: string; isInternal: boolean; at: string | null; failReason: string | null; scheduledDate: string }[] }
  | { kind: "depot"; title: string; rows: { id: string; businessDate: string; operatorName: string; status: string; openedAt: string; closedAt: string | null; sales: number; transactions: number; gallons: number; voidCount: number; cashDifference: number | null; depositStatus: string }[] }
  | { kind: "discrepancy"; title: string; rows: { id: string; number: string; businessDate: string; sourceLabel: string; personName: string | null; expected: number; received: number | null; discrepancy: number | null; reason: string | null; status: string; discrepancyId: string | null; discrepancyStatus: string | null; awaitingOwner: boolean }[] }
  | { kind: "receivable"; title: string; rows: { customerId: string; customerName: string; formed: number; paid: number; balance: number; overdue: number }[] };

export async function getDailyDrilldown(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<DrilldownResult> {
  await authorize(ctx, "m9.daily_summary.read", { tx: opts.tx });
  const data = parseInput(drilldownSchema, input, { kind: "Rincian", from: "Dari", to: "Sampai", id: "Objek" });
  const db = opts.tx ?? getDb();
  const period = data.from === data.to ? formatTanggal(data.from) : `${formatTanggal(data.from)} – ${formatTanggal(data.to)}`;
  if (data.kind === "truck") {
    if (!data.id) throw new DomainError("DRILLDOWN_ID", "Pilih truk.");
    const [truck] = await db.select({ code: trucks.code, plate: trucks.plateNumber, tenantId: trucks.tenantId }).from(trucks).where(eq(trucks.id, data.id)).limit(1);
    if (!truck || truck.tenantId !== ctx.tenantId) throw new NotFoundError("Truk tidak ditemukan.");
    const rows = await db
      .select({ t: trips, customerName: customers.name })
      .from(trips)
      .innerJoin(customers, eq(customers.id, trips.customerId))
      .where(and(eq(trips.tenantId, ctx.tenantId), eq(trips.truckId, data.id), gte(trips.scheduledDate, data.from), lte(trips.scheduledDate, data.to)))
      .orderBy(asc(trips.scheduledDate), asc(trips.routeOrder), asc(trips.number));
    return {
      kind: "truck",
      title: `Rit truk ${truck.code} (${truck.plate}) — ${period}`,
      rows: rows.map(({ t, customerName }) => ({
        id: t.id,
        number: t.number,
        customerName,
        status: t.status,
        statusLabel: label("trip_status", t.status),
        price: t.price,
        paymentMethod: label("payment_method", t.paymentMethod),
        isInternal: t.isInternal,
        at: (t.completedAt ?? t.failedAt ?? t.departedAt)?.toISOString() ?? null,
        failReason: t.failReason ? label("trip_fail_reason", t.failReason) : null,
        scheduledDate: t.scheduledDate,
      })),
    };
  }
  if (data.kind === "depot") {
    if (!data.id) throw new DomainError("DRILLDOWN_ID", "Pilih depot.");
    const [outlet] = await db.select().from(outlets).where(eq(outlets.id, data.id)).limit(1);
    if (!outlet || outlet.tenantId !== ctx.tenantId) throw new NotFoundError("Depot tidak ditemukan.");
    const list = await db
      .select()
      .from(shifts)
      .where(and(eq(shifts.outletId, data.id), gte(shifts.businessDate, data.from), lte(shifts.businessDate, data.to)))
      .orderBy(asc(shifts.businessDate), asc(shifts.openedAt));
    const ids = list.map((s) => s.id);
    const salesByShift = ids.length
      ? await db
          .select({
            shiftId: posSales.shiftId,
            sales: sql<string>`coalesce(sum(case when ${m6.COUNTED_SALE} then ${posSales.total} else 0 end), 0)`,
            n: sql<string>`count(*) filter (where ${posSales.isReversal} = false)`,
          })
          .from(posSales)
          .where(inArray(posSales.shiftId, ids))
          .groupBy(posSales.shiftId)
      : [];
    const gallonsByShift = ids.length
      ? await db
          .select({ shiftId: posSales.shiftId, gallons: sql<string>`coalesce(sum(${posSaleLines.quantity}), 0)` })
          .from(posSaleLines)
          .innerJoin(posSales, eq(posSales.id, posSaleLines.posSaleId))
          .where(and(inArray(posSales.shiftId, ids), isNotNull(posSaleLines.gallonSizeL), m6.COUNTED_SALE))
          .groupBy(posSales.shiftId)
      : [];
    const byShift = new Map(salesByShift.map((r) => [r.shiftId, r]));
    const gallonMap = new Map(gallonsByShift.map((r) => [r.shiftId, Number(r.gallons)]));
    const names = await userNames(db, list.map((s) => s.operatorUserId));
    return {
      kind: "depot",
      title: `Shift ${outlet.code} — ${outlet.name} (${period})`,
      rows: list.map((s) => ({
        id: s.id,
        businessDate: s.businessDate,
        operatorName: names.get(s.operatorUserId) ?? "Operator",
        status: label("shift_status", s.status),
        openedAt: s.openedAt.toISOString(),
        closedAt: s.closedAt?.toISOString() ?? null,
        sales: Number(byShift.get(s.id)?.sales ?? 0),
        transactions: Number(byShift.get(s.id)?.n ?? 0),
        gallons: gallonMap.get(s.id) ?? 0,
        voidCount: s.voidCount ?? 0,
        cashDifference: s.cashDifference,
        depositStatus: label("shift_deposit_status", s.depositStatus),
      })),
    };
  }
  if (data.kind === "discrepancy") {
    const deps = await db
      .select({ d: deposits, personName: employees.fullName, outletCode: outlets.code, disc: discrepancies })
      .from(deposits)
      .leftJoin(employees, eq(employees.id, deposits.depositorEmployeeId))
      .leftJoin(outlets, eq(outlets.id, deposits.outletId))
      .leftJoin(discrepancies, eq(discrepancies.depositId, deposits.id))
      .where(and(eq(deposits.tenantId, ctx.tenantId), gte(deposits.businessDate, data.from), lte(deposits.businessDate, data.to)))
      .orderBy(desc(sql`abs(coalesce(${deposits.discrepancyAmount}, 0))`), asc(deposits.number));
    return {
      kind: "discrepancy",
      title: `Setoran & selisih — ${period}`,
      rows: deps.map(({ d, personName, outletCode, disc }) => ({
        id: d.id,
        number: d.number,
        businessDate: d.businessDate,
        sourceLabel: `${label("deposit_source_type", d.sourceType)}${outletCode ? ` ${outletCode}` : ""}${d.isPartial ? " (sebagian)" : ""}`,
        personName: personName ?? null,
        expected: d.expectedNet,
        received: d.receivedAmount,
        discrepancy: d.discrepancyAmount,
        reason: d.discrepancyReason ? label("discrepancy_reason", d.discrepancyReason) + (d.discrepancyNote ? ` — ${d.discrepancyNote}` : "") : null,
        status: label("deposit_status", d.status),
        discrepancyId: disc?.id ?? null,
        discrepancyStatus: disc ? label("discrepancy_status", disc.status) : null,
        awaitingOwner: !!disc && disc.requiresOwnerDecision && !disc.decision && (disc.status === "formed" || disc.status === "explained"),
      })),
    };
  }
  // Piutang per pelanggan: terbentuk & dilunasi dalam rentang, saldo & lewat tempo akhir rentang.
  const { start } = businessDateToUtcRange(data.from);
  const { end } = businessDateToUtcRange(data.to);
  const res = await db.execute<{ customer_id: string; name: string; formed: string; paid: string; balance: string; overdue: string }>(sql`
    with a as (
      select invoice_id, sum(amount) as paid from payment_allocations where credit_note_id is null and allocated_at < ${end} group by invoice_id
    ), c as (
      select invoice_id, sum(amount) as credited from credit_notes where status = 'issued' and issue_date <= ${data.to} group by invoice_id
    ), inv as (
      select i.customer_id, i.due_date,
        greatest(0, i.amount - coalesce(a.paid, 0) - coalesce(c.credited, 0)
          - case when i.written_off_at is not null and i.written_off_at < ${end} then i.written_off_amount else 0 end) as outstanding,
        case when i.issue_date >= ${data.from} and i.kind not in ('monthly','opening_balance') and i.is_opening_balance = false then i.amount else 0 end as formed
      from invoices i left join a on a.invoice_id = i.id left join c on c.invoice_id = i.id
      where i.tenant_id = ${ctx.tenantId} and i.issue_date <= ${data.to}
    ), pay as (
      select i.customer_id, sum(pa.amount) as paid from payment_allocations pa join invoices i on i.id = pa.invoice_id
      where i.tenant_id = ${ctx.tenantId} and pa.credit_note_id is null and pa.allocated_at >= ${start} and pa.allocated_at < ${end}
      group by i.customer_id
    ), agg as (
      select customer_id, sum(formed) as formed, sum(outstanding) as balance, sum(outstanding) filter (where due_date < ${data.to}) as overdue from inv group by customer_id
    )
    select cu.id as customer_id, cu.name, coalesce(agg.formed, 0) as formed, coalesce(pay.paid, 0) as paid, coalesce(agg.balance, 0) as balance, coalesce(agg.overdue, 0) as overdue
    from customers cu
    left join agg on agg.customer_id = cu.id
    left join pay on pay.customer_id = cu.id
    where cu.tenant_id = ${ctx.tenantId} and (coalesce(agg.formed, 0) <> 0 or coalesce(pay.paid, 0) <> 0 or coalesce(agg.overdue, 0) <> 0)
    order by coalesce(agg.overdue, 0) desc, coalesce(agg.balance, 0) desc
    limit 100`);
  return {
    kind: "receivable",
    title: `Piutang per pelanggan — ${period}`,
    rows: res.rows.map((r) => ({ customerId: r.customer_id, customerName: r.name, formed: Number(r.formed), paid: Number(r.paid), balance: Number(r.balance), overdue: Number(r.overdue) })),
  };
}

/** Ringkasan H+0 terbit per tanggal (riwayat; KPI-08). */
export async function listDailySummaries(ctx: ActorContext, input: { from: BusinessDate; to: BusinessDate }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m9.daily_summary.read", { tx: opts.tx });
  const db = opts.tx ?? getDb();
  const rows = await db
    .select()
    .from(dailySummaries)
    .where(and(eq(dailySummaries.tenantId, ctx.tenantId), gte(dailySummaries.businessDate, input.from), lte(dailySummaries.businessDate, input.to)))
    .orderBy(desc(dailySummaries.businessDate));
  return rows.map((r) => {
    const snap = r.snapshot as unknown as DailySnapshot | null;
    return {
      id: r.id,
      businessDate: r.businessDate,
      status: r.status,
      statusLabel: label("daily_summary_status", r.status),
      cashClosedAt: r.cashClosedAt,
      publishedAt: r.publishedAt,
      publishedLate: r.publishedLate,
      publishMinutes: r.publishedAt && r.cashClosedAt ? Math.max(0, Math.round((r.publishedAt.getTime() - r.cashClosedAt.getTime()) / 60_000)) : null,
      externalRevenue: snap?.revenue.external ?? null,
      cashDiscrepancy: snap?.cash.discrepancy ?? null,
      exceptions: snap?.exceptions.total ?? null,
    };
  });
}

/** Rit dalam rentang tanggal jadwal per truk (untuk tautan rincian). */
export async function tripsOfTruck(tx: Tx, tenantId: string, truckId: string, from: BusinessDate, to: BusinessDate) {
  return tx
    .select({ id: trips.id })
    .from(trips)
    .where(and(eq(trips.tenantId, tenantId), eq(trips.truckId, truckId), gte(trips.scheduledDate, from), lte(trips.scheduledDate, to), inArray(trips.status, ["assigned", "departed", "arrived", "completed", "failed"])));
}
