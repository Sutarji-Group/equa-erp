/**
 * M9 — Periode paralel nota kertas per unit (NFR-35, PRD 11.5; masukan KPI-05 & KPI-11, US-M9-07 KP-2).
 *
 * - Admin Keuangan / manajer proyek (admin sistem) mengisi LEMBAR PENCOCOKAN HARIAN per unit (truk/outlet): jumlah &
 *   nilai nota kertas; angka sistem dihitung dari transaksi unit hari itu; selisih ditandai terjelaskan/tak terjelaskan.
 * - Tanggal nota kertas ditarik per unit dicatat. Sebelum hari ke-PAR-84 (14) hanya dengan persetujuan pemilik DAN
 *   syarat PAR-84 terpenuhi (N hari operasi terakhir 100% tercatat di sumber, 0 selisih tak terjelaskan) — persetujuan
 *   `paper_withdrawal_early`. Perpanjangan (pengecualian komite pengarah) maksimal PAR-88.
 * Tidak ada penghapusan: koreksi lembar = ubah beralasan berjejak audit.
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";

import { approvalRequests, outlets, parallelRunChecks, trips, trucks, unitPaperWithdrawals } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, daysBetween, formatTanggal, wibToUtc, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";
import * as m6 from "@/server/modules/m6-pos";

import { extendParallelSchema, parallelCheckSchema, startParallelSchema, withdrawPaperSchema } from "../schemas";

export type UnitRef = { unitType: "truck" | "outlet"; truckId?: string | null; outletId?: string | null };
export type WithdrawalRow = typeof unitPaperWithdrawals.$inferSelect;
export type ParallelCheckRow = typeof parallelRunChecks.$inferSelect;

function unitWhere<T extends { unitType: unknown; truckId: unknown; outletId: unknown }>(table: T, unit: UnitRef) {
  const t = table as unknown as typeof parallelRunChecks;
  return unit.unitType === "truck" ? and(eq(t.unitType, "truck"), eq(t.truckId, unit.truckId!)) : and(eq(t.unitType, "outlet"), eq(t.outletId, unit.outletId!));
}

async function assertUnit(tx: Tx, ctx: ActorContext, unit: UnitRef): Promise<string> {
  if (unit.unitType === "truck") {
    if (!unit.truckId) throw new DomainError("UNIT_REQUIRED", "Pilih truk.");
    const [t] = await tx.select({ code: trucks.code, tenantId: trucks.tenantId }).from(trucks).where(eq(trucks.id, unit.truckId)).limit(1);
    if (!t || t.tenantId !== ctx.tenantId) throw new NotFoundError("Truk tidak ditemukan.");
    return `Truk ${t.code}`;
  }
  if (!unit.outletId) throw new DomainError("UNIT_REQUIRED", "Pilih outlet.");
  const [o] = await tx.select({ code: outlets.code, name: outlets.name, tenantId: outlets.tenantId }).from(outlets).where(eq(outlets.id, unit.outletId)).limit(1);
  if (!o || o.tenantId !== ctx.tenantId) throw new NotFoundError("Outlet tidak ditemukan.");
  return `${o.code} — ${o.name}`;
}

/** Angka sistem unit per hari: truk = rit Selesai (jumlah & Σ harga); outlet = transaksi POS yang dihitung (M6). */
export async function systemFiguresForUnit(tx: Tx, tenantId: string, unit: UnitRef, date: BusinessDate): Promise<{ count: number; amount: number }> {
  if (unit.unitType === "truck") {
    const [r] = await tx
      .select({ n: sql<string>`count(*)`, amount: sql<string>`coalesce(sum(${trips.price}), 0)` })
      .from(trips)
      .where(and(eq(trips.tenantId, tenantId), eq(trips.truckId, unit.truckId!), eq(trips.status, "completed"), eq(trips.completionBusinessDate, date)));
    return { count: Number(r?.n ?? 0), amount: Number(r?.amount ?? 0) };
  }
  const rows = await m6.salesAggregates(tx, tenantId, { from: date, to: date, outletIds: [unit.outletId!] });
  return { count: rows.reduce((s, r) => s + r.transactions, 0), amount: rows.reduce((s, r) => s + r.salesTotal, 0) };
}

/** Transaksi lapangan unit yang tercatat di sumber (bukan "dicatat kantor", tidak terlambat sinkron) — PAR-84 / KPI-01. */
export async function sourceRecordedForUnit(tx: Tx, tenantId: string, unit: UnitRef, from: BusinessDate, to: BusinessDate): Promise<{ total: number; atSource: number; pct: number | null }> {
  const res =
    unit.unitType === "truck"
      ? await tx.execute<{ total: string; ok: string }>(sql`
          select count(*) as total, count(*) filter (where recorded_by_office = false and late_sync = false) as ok from (
            select recorded_by_office, late_sync from trips where tenant_id = ${tenantId} and truck_id = ${unit.truckId!} and status = 'completed'
              and completion_business_date >= ${from} and completion_business_date <= ${to}
            union all
            select recorded_by_office, late_sync from truck_fills where truck_id = ${unit.truckId!} and volume_l > 0
              and business_date >= ${from} and business_date <= ${to}
          ) x`)
      : await tx.execute<{ total: string; ok: string }>(sql`
          select count(*) as total, count(*) filter (where recorded_by_office = false and late_sync = false) as ok
          from pos_sales where tenant_id = ${tenantId} and outlet_id = ${unit.outletId!} and is_reversal = false
            and business_date >= ${from} and business_date <= ${to}`);
  const total = Number(res.rows[0]?.total ?? 0);
  const atSource = Number(res.rows[0]?.ok ?? 0);
  return { total, atSource, pct: total ? Math.round((atSource / total) * 10_000) / 100 : null };
}

/** Mulai periode paralel satu unit (tanggal mulai nota kertas + sistem berjalan bersama). */
export async function startParallelPeriod(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<WithdrawalRow> {
  await authorize(ctx, "m9.parallel_run.create", { tx: opts.tx });
  const data = parseInput(startParallelSchema, input, { parallelStartDate: "Tanggal mulai", truckId: "Truk", outletId: "Outlet" });
  return runService(ctx, opts, async (tx) => {
    const unit: UnitRef = { unitType: data.unitType, truckId: data.truckId, outletId: data.outletId };
    const unitLabel = await assertUnit(tx, ctx, unit);
    const open = await tx
      .select({ id: unitPaperWithdrawals.id })
      .from(unitPaperWithdrawals)
      .where(and(eq(unitPaperWithdrawals.tenantId, ctx.tenantId), unitWhere(unitPaperWithdrawals, unit), isNull(unitPaperWithdrawals.withdrawnDate)))
      .limit(1);
    if (open[0]) throw new DomainError("PARALLEL_RUNNING", `${unitLabel} masih dalam periode paralel. Catat penarikan nota kertasnya dulu.`);
    const [row] = await tx
      .insert(unitPaperWithdrawals)
      .values({
        tenantId: ctx.tenantId,
        unitType: data.unitType,
        truckId: data.unitType === "truck" ? data.truckId! : null,
        outletId: data.unitType === "outlet" ? data.outletId! : null,
        parallelStartDate: data.parallelStartDate,
        notes: data.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    await auditRecord(tx, { ctx, objectType: "unit_paper_withdrawal", objectId: row!.id, action: "create", after: { unit: unitLabel, parallelStartDate: data.parallelStartDate }, rule: "NFR-35" });
    return row!;
  });
}

/** Isi / koreksi lembar pencocokan harian (satu baris per unit per hari; koreksi berjejak, tanpa hapus). */
export async function recordParallelCheck(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<ParallelCheckRow> {
  await authorize(ctx, "m9.parallel_run.create", { tx: opts.tx });
  const data = parseInput(parallelCheckSchema, input, { businessDate: "Tanggal", paperCount: "Jumlah nota kertas", paperAmount: "Nilai nota kertas", cause: "Penyebab selisih" });
  return runService(ctx, opts, async (tx) => {
    const unit: UnitRef = { unitType: data.unitType, truckId: data.truckId, outletId: data.outletId };
    const unitLabel = await assertUnit(tx, ctx, unit);
    if (data.businessDate > ctxBusinessDate(ctx)) throw new DomainError("FUTURE_DATE", "Tanggal belum terjadi.");
    const sys = await systemFiguresForUnit(tx, ctx.tenantId, unit, data.businessDate);
    const differenceCount = data.paperCount - sys.count;
    const differenceAmount = data.paperAmount - sys.amount;
    const hasDiff = differenceCount !== 0 || differenceAmount !== 0;
    if (hasDiff && data.explained === undefined) {
      throw new DomainError("CAUSE_REQUIRED", `Ada selisih ${differenceCount} nota / ${formatRupiah(differenceAmount, { signed: true })}. Tandai terjelaskan atau tak terjelaskan.`);
    }
    if (hasDiff && !data.cause) throw new DomainError("CAUSE_REQUIRED", "Tulis penyebab selisih (terjelaskan atau tidak).");
    const values = {
      paperCount: data.paperCount,
      paperAmount: data.paperAmount,
      systemCount: sys.count,
      systemAmount: sys.amount,
      differenceCount,
      differenceAmount,
      explained: hasDiff ? !!data.explained : true,
      cause: data.cause ?? null,
    };
    const [existing] = await tx
      .select()
      .from(parallelRunChecks)
      .where(and(eq(parallelRunChecks.tenantId, ctx.tenantId), unitWhere(parallelRunChecks, unit), eq(parallelRunChecks.businessDate, data.businessDate)))
      .limit(1);
    if (existing) {
      const [row] = await tx.update(parallelRunChecks).set({ ...values, updatedAt: ctx.now }).where(eq(parallelRunChecks.id, existing.id)).returning();
      await auditRecord(tx, { ctx, objectType: "parallel_run_check", objectId: existing.id, action: "update", before: existing, after: values, reason: data.cause ?? "Koreksi lembar pencocokan", businessDate: data.businessDate });
      return row!;
    }
    const [row] = await tx
      .insert(parallelRunChecks)
      .values({
        tenantId: ctx.tenantId,
        unitType: data.unitType,
        truckId: data.unitType === "truck" ? data.truckId! : null,
        outletId: data.unitType === "outlet" ? data.outletId! : null,
        businessDate: data.businessDate,
        ...values,
        createdBy: ctx.userId,
      })
      .returning();
    await auditRecord(tx, { ctx, objectType: "parallel_run_check", objectId: row!.id, action: "create", after: { unit: unitLabel, ...values }, businessDate: data.businessDate, rule: "NFR-35" });
    return row!;
  });
}

type Par84 = { last_operating_days: number; recorded_at_source_percent: number; max_unexplained_discrepancies: number; deadline_day: number };

/** Evaluasi syarat PAR-84 untuk unit: N hari operasi terakhir (lembar pencocokan) — 100% di sumber & 0 tak terjelaskan. */
export async function par84Status(
  tx: Tx,
  tenantId: string,
  unit: UnitRef,
  asOf: BusinessDate,
): Promise<{ met: boolean; days: number; required: number; sourcePct: number | null; unexplained: number; reasons: string[]; rule: Par84 }> {
  const rule = (await params.get(tx, "PAR-84", asOf, { tenantId })) as Par84;
  const checks = await tx
    .select()
    .from(parallelRunChecks)
    .where(and(eq(parallelRunChecks.tenantId, tenantId), unitWhere(parallelRunChecks, unit), lte(parallelRunChecks.businessDate, asOf)))
    .orderBy(desc(parallelRunChecks.businessDate))
    .limit(rule.last_operating_days);
  const reasons: string[] = [];
  if (checks.length < rule.last_operating_days) reasons.push(`Baru ${checks.length} dari ${rule.last_operating_days} hari operasi tercatat di lembar pencocokan.`);
  const unexplained = checks.filter((c) => !c.explained).length;
  if (unexplained > rule.max_unexplained_discrepancies) reasons.push(`${unexplained} hari dengan selisih tak terjelaskan (maksimal ${rule.max_unexplained_discrepancies}).`);
  let sourcePct: number | null = null;
  if (checks.length) {
    const from = checks[checks.length - 1]!.businessDate;
    const src = await sourceRecordedForUnit(tx, tenantId, unit, from, checks[0]!.businessDate);
    sourcePct = src.pct;
    if (src.pct !== null && src.pct < rule.recorded_at_source_percent) reasons.push(`Tercatat di sumber ${src.pct}% (wajib ${rule.recorded_at_source_percent}%).`);
  }
  return { met: reasons.length === 0, days: checks.length, required: rule.last_operating_days, sourcePct, unexplained, reasons, rule };
}

/**
 * Catat penarikan nota kertas. Pada/sesudah hari ke-PAR-84 → langsung dicatat. Sebelum itu → syarat PAR-84 wajib
 * terpenuhi lalu diajukan ke pemilik (`paper_withdrawal_early`); ditarik saat disetujui.
 */
export async function withdrawPaper(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<{ status: "withdrawn" | "pending_approval"; withdrawal: WithdrawalRow; approvalId?: string }> {
  await authorize(ctx, "m9.parallel_run.create", { tx: opts.tx });
  const data = parseInput(withdrawPaperSchema, input, { withdrawnDate: "Tanggal tarik", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const [w] = await tx.select().from(unitPaperWithdrawals).where(eq(unitPaperWithdrawals.id, data.withdrawalId)).for("update").limit(1);
    if (!w || w.tenantId !== ctx.tenantId) throw new NotFoundError("Periode paralel unit tidak ditemukan.");
    if (w.withdrawnDate) throw new DomainError("ALREADY_WITHDRAWN", `Nota kertas unit ini sudah ditarik pada ${formatTanggal(w.withdrawnDate)}.`);
    if (data.withdrawnDate < w.parallelStartDate) throw new DomainError("DATE_BEFORE_START", "Tanggal tarik tidak boleh sebelum tanggal mulai paralel.");
    if (data.withdrawnDate > ctxBusinessDate(ctx)) throw new DomainError("FUTURE_DATE", "Tanggal tarik belum terjadi.");
    const unit: UnitRef = { unitType: w.unitType, truckId: w.truckId, outletId: w.outletId };
    const rule = (await params.get(tx, "PAR-84", data.withdrawnDate, { tenantId: ctx.tenantId })) as Par84;
    const dayNumber = daysBetween(w.parallelStartDate, data.withdrawnDate) + 1;
    if (dayNumber < rule.deadline_day) {
      const status = await par84Status(tx, ctx.tenantId, unit, data.withdrawnDate);
      if (!status.met) {
        throw new DomainError("PAR84_NOT_MET", `Penarikan lebih cepat (hari ke-${dayNumber}) belum memenuhi PAR-84: ${status.reasons.join(" ")}`);
      }
      const unitLabel = await assertUnit(tx, ctx, unit);
      const request = await approvals.submit(
        ctx,
        {
          type: "paper_withdrawal_early",
          objectType: "unit_paper_withdrawal",
          objectId: w.id,
          reason: data.reason ?? `Tarik nota kertas ${unitLabel} pada hari ke-${dayNumber} (syarat PAR-84 terpenuhi).`,
          payload: { withdrawnDate: data.withdrawnDate, dayNumber, unit: unitLabel, sourcePct: status.sourcePct, link: "/laporan/periode-paralel" },
          deadlineAt: wibToUtc(addDays(w.parallelStartDate, rule.deadline_day - 1), "23:59"),
        },
        { tx },
      );
      return { status: "pending_approval" as const, withdrawal: w, approvalId: request.id };
    }
    const [row] = await tx.update(unitPaperWithdrawals).set({ withdrawnDate: data.withdrawnDate, updatedAt: ctx.now }).where(eq(unitPaperWithdrawals.id, w.id)).returning();
    await auditRecord(tx, { ctx, objectType: "unit_paper_withdrawal", objectId: w.id, action: "withdraw", before: { withdrawnDate: null }, after: { withdrawnDate: data.withdrawnDate, dayNumber }, reason: data.reason ?? null, rule: "NFR-35, 11.5" });
    return { status: "withdrawn" as const, withdrawal: row! };
  });
}

/** Perpanjangan periode paralel (pengecualian keputusan komite pengarah, maks PAR-88). */
export async function extendParallelPeriod(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<WithdrawalRow> {
  await authorize(ctx, "m9.parallel_run.create", { tx: opts.tx });
  const data = parseInput(extendParallelSchema, input, { extensionDays: "Hari perpanjangan", reason: "Keputusan komite" });
  return runService(ctx, opts, async (tx) => {
    const [w] = await tx.select().from(unitPaperWithdrawals).where(eq(unitPaperWithdrawals.id, data.withdrawalId)).for("update").limit(1);
    if (!w || w.tenantId !== ctx.tenantId) throw new NotFoundError("Periode paralel unit tidak ditemukan.");
    if (w.withdrawnDate) throw new DomainError("ALREADY_WITHDRAWN", "Nota kertas unit ini sudah ditarik.");
    const par88 = await params.get(tx, "PAR-88", ctxBusinessDate(ctx), { tenantId: ctx.tenantId });
    const maxDays = par88.max_weeks * 7;
    const total = w.extensionDays + data.extensionDays;
    if (total > maxDays) throw new DomainError("EXTENSION_TOO_LONG", `Perpanjangan maksimal ${maxDays} hari (PAR-88). Sudah ${w.extensionDays} hari.`);
    const [row] = await tx
      .update(unitPaperWithdrawals)
      .set({ extensionDays: total, extensionReason: data.reason, updatedAt: ctx.now })
      .where(eq(unitPaperWithdrawals.id, w.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "unit_paper_withdrawal", objectId: w.id, action: "extend", before: { extensionDays: w.extensionDays }, after: { extensionDays: total }, reason: data.reason, rule: "PAR-88, CR-17" });
    return row!;
  });
}

export type ParallelUnitView = {
  id: string;
  unitType: "truck" | "outlet";
  unitId: string;
  unitLabel: string;
  parallelStartDate: string;
  withdrawnDate: string | null;
  dayNumber: number;
  maxDay: number;
  extensionDays: number;
  status: "running" | "withdrawn" | "early_pending" | "overdue";
  statusLabel: string;
  earlyApproved: boolean;
  checks: number;
  matchedDays: number;
  unexplained: number;
  par84: { met: boolean; reasons: string[] } | null;
  pendingApprovalId: string | null;
};

/** Daftar unit & periode paralel (NFR-35) — status, hari ke-, hasil pencocokan, syarat PAR-84. */
export async function listParallelUnits(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<ParallelUnitView[]> {
  await authorize(ctx, "m9.parallel_run.read", { tx: opts.tx });
  const db = opts.tx ?? getDb();
  return parallelUnits(db, ctx.tenantId, ctxBusinessDate(ctx));
}

export async function parallelUnits(db: Tx, tenantId: string, today: BusinessDate): Promise<ParallelUnitView[]> {
  const rows = await db
    .select({ w: unitPaperWithdrawals, truckCode: trucks.code, outletCode: outlets.code, outletName: outlets.name })
    .from(unitPaperWithdrawals)
    .leftJoin(trucks, eq(trucks.id, unitPaperWithdrawals.truckId))
    .leftJoin(outlets, eq(outlets.id, unitPaperWithdrawals.outletId))
    .where(eq(unitPaperWithdrawals.tenantId, tenantId))
    .orderBy(asc(unitPaperWithdrawals.parallelStartDate));
  const weeks = await params.get(db, "PAR-28", today, { tenantId });
  const pending = rows.length
    ? await db
        .select({ id: approvalRequests.id, objectId: approvalRequests.objectId })
        .from(approvalRequests)
        .where(and(eq(approvalRequests.type, "paper_withdrawal_early"), eq(approvalRequests.status, "submitted"), inArray(approvalRequests.objectId, rows.map((r) => r.w.id))))
    : [];
  const out: ParallelUnitView[] = [];
  for (const { w, truckCode, outletCode, outletName } of rows) {
    const unit: UnitRef = { unitType: w.unitType, truckId: w.truckId, outletId: w.outletId };
    const checks = await db.select().from(parallelRunChecks).where(and(eq(parallelRunChecks.tenantId, tenantId), unitWhere(parallelRunChecks, unit), gte(parallelRunChecks.businessDate, w.parallelStartDate)));
    const end = w.withdrawnDate ?? today;
    const dayNumber = daysBetween(w.parallelStartDate, end) + 1;
    const maxDay = weeks.max_weeks * 7 + w.extensionDays;
    const pend = pending.find((p) => p.objectId === w.id);
    const status: ParallelUnitView["status"] = w.withdrawnDate ? "withdrawn" : pend ? "early_pending" : dayNumber > maxDay ? "overdue" : "running";
    const par84 = w.withdrawnDate ? null : await par84Status(db, tenantId, unit, today);
    out.push({
      id: w.id,
      unitType: w.unitType,
      unitId: (w.truckId ?? w.outletId)!,
      unitLabel: w.unitType === "truck" ? `Truk ${truckCode ?? "—"}` : `${outletCode ?? "—"} — ${outletName ?? ""}`,
      parallelStartDate: w.parallelStartDate,
      withdrawnDate: w.withdrawnDate,
      dayNumber,
      maxDay,
      extensionDays: w.extensionDays,
      status,
      statusLabel: label("parallel_status", status),
      earlyApproved: !!w.earlyWithdrawalApprovedBy,
      checks: checks.length,
      matchedDays: checks.filter((c) => c.differenceCount === 0 && c.differenceAmount === 0).length,
      unexplained: checks.filter((c) => !c.explained).length,
      par84: par84 ? { met: par84.met, reasons: par84.reasons } : null,
      pendingApprovalId: pend?.id ?? null,
    });
  }
  return out;
}

/** Lembar pencocokan dalam rentang. */
export async function listParallelChecks(ctx: ActorContext, input: { from: BusinessDate; to: BusinessDate }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m9.parallel_run.read", { tx: opts.tx });
  const db = opts.tx ?? getDb();
  return parallelChecksInRange(db, ctx.tenantId, input.from, input.to);
}

export async function parallelChecksInRange(db: Tx, tenantId: string, from: BusinessDate, to: BusinessDate) {
  const rows = await db
    .select({ c: parallelRunChecks, truckCode: trucks.code, outletCode: outlets.code })
    .from(parallelRunChecks)
    .leftJoin(trucks, eq(trucks.id, parallelRunChecks.truckId))
    .leftJoin(outlets, eq(outlets.id, parallelRunChecks.outletId))
    .where(and(eq(parallelRunChecks.tenantId, tenantId), gte(parallelRunChecks.businessDate, from), lte(parallelRunChecks.businessDate, to)))
    .orderBy(desc(parallelRunChecks.businessDate));
  return rows.map(({ c, truckCode, outletCode }) => ({ ...c, unitLabel: c.unitType === "truck" ? `Truk ${truckCode ?? "—"}` : (outletCode ?? "—") }));
}

/** Handler persetujuan tarik lebih awal disetujui: nota kertas ditarik pada tanggal yang diajukan. */
export async function applyEarlyWithdrawal(tx: Tx, ctx: ActorContext, request: { objectId: string; payload: Record<string, unknown> | null; id: string }): Promise<Record<string, unknown>> {
  const [w] = await tx.select().from(unitPaperWithdrawals).where(eq(unitPaperWithdrawals.id, request.objectId)).for("update").limit(1);
  if (!w) throw new NotFoundError("Periode paralel unit tidak ditemukan.");
  if (w.withdrawnDate) return { alreadyWithdrawn: w.withdrawnDate };
  const withdrawnDate = String(request.payload?.withdrawnDate ?? ctxBusinessDate(ctx));
  await tx.update(unitPaperWithdrawals).set({ withdrawnDate, earlyWithdrawalApprovedBy: ctx.userId, updatedAt: ctx.now }).where(eq(unitPaperWithdrawals.id, w.id));
  await auditRecord(tx, {
    ctx,
    objectType: "unit_paper_withdrawal",
    objectId: w.id,
    action: "withdraw",
    before: { withdrawnDate: null },
    after: { withdrawnDate, earlyWithdrawalApprovedBy: ctx.userId, approvalId: request.id },
    rule: "PAR-84, 11.5 butir 2",
  });
  return { withdrawnDate };
}

/** Pilihan unit (truk & outlet aktif) untuk formulir periode paralel. */
export async function parallelUnitOptions(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<{ value: string; label: string }[]> {
  await authorize(ctx, "m9.parallel_run.read", { tx: opts.tx });
  const db = opts.tx ?? getDb();
  const t = await db.select({ id: trucks.id, code: trucks.code, plate: trucks.plateNumber }).from(trucks).where(and(eq(trucks.tenantId, ctx.tenantId), inArray(trucks.status, ["active", "maintenance"]))).orderBy(asc(trucks.code));
  const o = await db
    .select({ id: outlets.id, code: outlets.code, name: outlets.name })
    .from(outlets)
    .where(and(eq(outlets.tenantId, ctx.tenantId), eq(outlets.isActive, true), inArray(outlets.kind, ["depot", "store"])))
    .orderBy(asc(outlets.code));
  return [...t.map((x) => ({ value: `truck:${x.id}`, label: `Truk ${x.code} (${x.plate})` })), ...o.map((x) => ({ value: `outlet:${x.id}`, label: `${x.code} — ${x.name}` }))];
}
