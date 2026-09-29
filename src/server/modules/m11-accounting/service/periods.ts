/**
 * M11 — tutup & kunci periode (US-M11-10, BR-32, P-07 langkah 7, TG-8):
 * - Prasyarat (diperiksa sistem, tampil dengan tautan tindakan): hari kas Ditutup (M4), rekonsiliasi bank & kas nol,
 *   daftar tunggu jurnal kosong, penyusutan terposting, jurnal manual > PAR-20 diputuskan & daftar tinjauan ≤ PAR-20
 *   ditandai pemilik, opname toko bulan itu selesai (M7), alokasi L1 & biaya bersama terposting, (+ saldo awal
 *   terposting & verifikasi retroaktif & catatan akuntan TG-8 pada periode cut-over).
 * - Admin Keuangan menutup (penyusutan diposting otomatis dulu) → persetujuan `period_lock` ke pemilik → Dikunci
 *   (versi Final laporan disimpan). Tutup setelah tanggal PAR-23 → terlambat. Pengingat tanggal PAR-71 (5 & 8).
 * - Periode Dikunci menolak semua posting (penjaga DB EQ005; peristiwa terlambat → periode terbuka berikutnya).
 * - Pemilik membuka kembali dengan alasan (berjejak, akuntan diberi tahu, revisi baru; Final lama tetap tersimpan).
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, lte, ne } from "drizzle-orm";
import { z } from "zod";

import { accountingPeriods, cashDays, costAllocationRuns, deposits, journals, notifications, outlets, periodReviewNotes, stockCounts } from "@/db/schema";
import { enumValues, label, type EnumValue } from "@/lib/labels";
import { monthOf, toBusinessDate, wibToUtc, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import type { ApprovalRow } from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Tx } from "@/server/core/db";
import { DomainError, parseInput } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";

import { previewL1Allocation, previewSharedAllocation } from "./allocation";
import { depreciationPending, postDepreciationFor } from "./assets";
import { currentCutover, ensurePeriod, inJobTx, isAccountingTenant, isOpenStatus, listPeriodRows, loadPeriod, shiftPeriod, type PeriodRow } from "./common";
import { openingPosted } from "./opening";
import { pendingQueueCount } from "./queue";
import { reconciliationOverviewTx } from "./reconciliation";
import { unverifiedRetroactive } from "./retroactive";
import { finalVersions, saveFinalSnapshots } from "./statements";

type PrereqKey = EnumValue<"period_prerequisite">;

export type Prerequisite = { key: PrereqKey; label: string; ok: boolean; detail: string; href: string };

/** Batas tutup buku periode (PAR-23: tanggal N bulan berikutnya). */
export async function closeDeadlineDate(tx: Tx, period: PeriodRow): Promise<BusinessDate> {
  const { day_of_next_month } = await params.get(tx, "PAR-23", period.endDate);
  return `${shiftPeriod(period.period, 1)}-${String(day_of_next_month).padStart(2, "0")}`;
}

/** Evaluasi prasyarat tutup periode (tanpa menulis). */
export async function periodPrerequisites(tx: Tx, period: PeriodRow, today: BusinessDate): Promise<Prerequisite[]> {
  const out: Prerequisite[] = [];
  const add = (key: PrereqKey, ok: boolean, detail: string, href: string) => out.push({ key, label: label("period_prerequisite", key), ok, detail, href });
  const tenantId = period.tenantId;

  // 1. Hari kas
  const openDays = await tx
    .select({ d: cashDays.businessDate })
    .from(cashDays)
    .where(and(eq(cashDays.tenantId, tenantId), gte(cashDays.businessDate, period.startDate), lte(cashDays.businessDate, period.endDate), ne(cashDays.status, "closed")))
    .orderBy(asc(cashDays.businessDate));
  const depositDays = await tx
    .selectDistinct({ d: deposits.businessDate })
    .from(deposits)
    .where(and(eq(deposits.tenantId, tenantId), gte(deposits.businessDate, period.startDate), lte(deposits.businessDate, period.endDate)));
  const closedDays = new Set(
    (
      await tx
        .select({ d: cashDays.businessDate })
        .from(cashDays)
        .where(and(eq(cashDays.tenantId, tenantId), gte(cashDays.businessDate, period.startDate), lte(cashDays.businessDate, period.endDate), eq(cashDays.status, "closed")))
    ).map((r) => r.d),
  );
  const missing = [...new Set([...openDays.map((r) => r.d), ...depositDays.map((r) => r.d).filter((d) => !closedDays.has(d))])].sort();
  add("cash_days_closed", missing.length === 0, missing.length ? `${missing.length} hari kas belum Ditutup (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""})` : "Semua hari kas Ditutup", "/kas/tutup");

  // 2–3. Rekonsiliasi
  const rec = await reconciliationOverviewTx(tx, period);
  const bankOpen = rec.bank.filter((b) => b.required && !b.zero);
  add("bank_reconciled", bankOpen.length === 0, bankOpen.length ? `${bankOpen.length} rekening belum nol selisih` : "Semua rekening nol selisih", "/akuntansi/rekonsiliasi");
  const cashOpen = rec.cash.filter((c) => c.required && !c.zero);
  add("cash_reconciled", cashOpen.length === 0, cashOpen.length ? `Belum nol: ${cashOpen.map((c) => c.label).join(", ")}` : "Kas nol selisih", "/akuntansi/rekonsiliasi");

  // 4. Antrean jurnal
  const queued = await pendingQueueCount(tx, tenantId, period.endDate);
  add("queue_empty", queued === 0, queued ? `${queued} jurnal di daftar tunggu` : "Daftar tunggu kosong", "/akuntansi/jurnal?antrean=1");

  // 5. Penyusutan
  const dep = await depreciationPending(tx, tenantId, period.period);
  add("depreciation_posted", dep === 0, dep ? `${dep} aset belum disusutkan (diposting otomatis saat tutup)` : "Penyusutan terposting", "/akuntansi/aset");

  // 6–7. Jurnal manual
  const pendingManual = await tx
    .select({ number: journals.number })
    .from(journals)
    .where(and(eq(journals.tenantId, tenantId), eq(journals.status, "submitted"), gte(journals.journalDate, period.startDate), lte(journals.journalDate, period.endDate)));
  add("manual_decided", pendingManual.length === 0, pendingManual.length ? `${pendingManual.length} jurnal manual menunggu keputusan pemilik` : "Tidak ada jurnal menunggu persetujuan", "/persetujuan");
  const unreviewed = await tx
    .select({ number: journals.number })
    .from(journals)
    .where(and(eq(journals.periodId, period.id), eq(journals.requiresOwnerReview, true), isNull(journals.ownerReviewedAt), eq(journals.status, "posted")));
  add("manual_reviewed", unreviewed.length === 0, unreviewed.length ? `${unreviewed.length} jurnal manual belum ditandai pemilik "ditinjau"` : "Daftar tinjauan pemilik lengkap", `/akuntansi/jurnal?tinjauan=${period.period}`);

  // 8. Opname toko
  const stores = await tx.select({ id: outlets.id, name: outlets.name }).from(outlets).where(and(eq(outlets.tenantId, tenantId), eq(outlets.kind, "store"), eq(outlets.isActive, true)));
  const counted = stores.length
    ? new Set(
        (
          await tx
            .select({ outletId: stockCounts.outletId })
            .from(stockCounts)
            .where(
              and(
                inArray(
                  stockCounts.outletId,
                  stores.map((s) => s.id),
                ),
                eq(stockCounts.kind, "monthly_store"),
                eq(stockCounts.periodLabel, period.period),
                inArray(stockCounts.status, ["approved", "rejected"]),
              ),
            )
        ).map((r) => r.outletId),
      )
    : new Set<string>();
  const notCounted = stores.filter((s) => !counted.has(s.id));
  add("store_count_done", notCounted.length === 0, notCounted.length ? `Opname belum selesai: ${notCounted.map((s) => s.name).join(", ")}` : "Opname toko selesai", "/toko/opname");

  // 9. Alokasi
  const l1 = await previewL1Allocation(tx, period);
  const shared = await previewSharedAllocation(tx, period);
  const allocOk = (!l1.required || !!l1.posted) && (!shared.required || !!shared.posted);
  add("allocations_posted", allocOk, allocOk ? "Alokasi terposting / tidak diperlukan" : `Belum terposting: ${[!l1.posted && l1.required ? "alokasi L1" : null, !shared.posted && shared.required ? "biaya bersama" : null].filter(Boolean).join(", ")}`, `/akuntansi/periode/${period.id}`);

  // 10–12. Periode cut-over & retroaktif
  const cutover = await currentCutover(tx, today);
  if (cutover && monthOf(cutover) === period.period) {
    const posted = await openingPosted(tx, tenantId);
    add("opening_posted", posted, posted ? "Saldo awal terposting" : "Saldo awal belum terposting", "/akuntansi/saldo-awal");
    const rules = await params.get(tx, "m11.accounting_rules", today);
    if (rules.first_close_requires_accountant_note) {
      const [note] = await tx.select({ id: periodReviewNotes.id }).from(periodReviewNotes).where(and(eq(periodReviewNotes.periodId, period.id), inArray(periodReviewNotes.kind, ["review", "tg8"]))).limit(1);
      add("accountant_note", !!note, note ? "Catatan tinjauan akuntan tersimpan (TG-8)" : "Tutup buku pertama wajib catatan tinjauan akuntan (TG-8)", `/akuntansi/periode/${period.id}`);
    }
  }
  if (period.isRetroactive) {
    const unverified = await unverifiedRetroactive(tx, tenantId, period.period);
    add("retroactive_verified", !unverified, unverified ? "Jurnal retroaktif belum diverifikasi akuntan" : "Jurnal retroaktif diverifikasi akuntan", `/akuntansi/periode/${period.id}`);
  }
  return out;
}

export async function listPeriods(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.period.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  // Pastikan periode berjalan & bulan lalu ada di daftar.
  const current = monthOf(today);
  const rows = await listPeriodRows(tx, ctx.tenantId);
  const labels = new Set(rows.map((r) => r.period));
  const extras: string[] = [current, shiftPeriod(current, -1)].filter((p) => !labels.has(p));
  const all = [
    ...rows,
    ...extras.map((p) => ({ period: p, status: "open", id: null as string | null, startDate: `${p}-01`, endDate: null as string | null, closedLate: false, revision: 1, isRetroactive: false }) as unknown as PeriodRow),
  ].sort((a, b) => b.period.localeCompare(a.period));
  return all.map((p) => ({ ...p, isVirtual: !p.id }));
}

export async function periodDetail(ctx: ActorContext, input: { periodId?: string | null; period?: string | null }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.period.read", { tx: opts.tx });
  const run = async (tx: Tx) => {
    const period = input.periodId ? await loadPeriod(tx, ctx.tenantId, input.periodId) : await ensurePeriod(tx, ctx.tenantId, input.period ?? monthOf(ctxBusinessDate(ctx)));
    const today = ctxBusinessDate(ctx);
    const prerequisites = await periodPrerequisites(tx, period, today);
    const notes = await tx.select().from(periodReviewNotes).where(eq(periodReviewNotes.periodId, period.id)).orderBy(desc(periodReviewNotes.createdAt));
    const versions = await finalVersions(tx, ctx.tenantId, period.period);
    const lockRequests = await approvals.listForObject(tx, "accounting_period", period.id);
    const allocationRuns = await tx.select().from(costAllocationRuns).where(eq(costAllocationRuns.periodId, period.id));
    return { period, prerequisites, notes, versions, lockRequests, allocationRuns, deadline: await closeDeadlineDate(tx, period), today };
  };
  return opts.tx ? run(opts.tx) : withTx(run);
}

const periodSchema = z.object({ periodId: z.uuid() }).strict();

/** Admin Keuangan menutup periode (penyusutan otomatis → prasyarat → Ditutup + permintaan kunci ke pemilik). */
export async function closePeriod(ctx: ActorContext, input: z.input<typeof periodSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.period.close", { tx: opts.tx });
  const data = parseInput(periodSchema, input);
  return runService(ctx, opts, async (tx) => {
    const period = await loadPeriod(tx, ctx.tenantId, data.periodId, { forUpdate: true });
    if (!isOpenStatus(period.status)) throw new DomainError("PERIOD_STATUS", `Periode ${period.period} berstatus ${label("period_status", period.status)}.`);
    const today = ctxBusinessDate(ctx);
    if (today <= period.endDate) throw new DomainError("PERIOD_NOT_ENDED", `Periode ${period.period} baru dapat ditutup setelah ${period.endDate}.`);
    // Penyusutan bulanan diposting otomatis pada hari pertama tutup periode (US-M11-05 KP-2).
    const depreciation = await postDepreciationFor(tx, ctx, period);
    const prerequisites = await periodPrerequisites(tx, period, today);
    const failed = prerequisites.filter((p) => !p.ok);
    if (failed.length) {
      throw new DomainError("PREREQUISITES", `Periode belum dapat ditutup: ${failed.map((f) => `${f.label} (${f.detail})`).join("; ")}.`, { prerequisites: failed });
    }
    const deadline = await closeDeadlineDate(tx, period);
    const late = today > deadline;
    const [row] = await tx
      .update(accountingPeriods)
      .set({ status: "closed", closedAt: ctx.now, closedBy: ctx.userId, closedLate: late, prerequisitesSnapshot: { checkedAt: ctx.now.toISOString(), items: prerequisites } as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(accountingPeriods.id, period.id))
      .returning();
    const req = await approvals.submit(
      ctx,
      {
        type: "period_lock",
        objectType: "accounting_period",
        objectId: period.id,
        reason: `Tutup buku ${period.period}${late ? " (terlambat, lewat " + deadline + ")" : ""} — kunci periode`,
        businessDate: period.endDate,
        payload: { period: period.period, late, link: `/akuntansi/periode/${period.id}` },
      },
      { tx },
    );
    await auditRecord(tx, { ctx, objectType: "accounting_period", objectId: period.id, action: "close", before: { status: period.status }, after: { status: "closed", late, depreciation: depreciation.entries, lockApproval: req.number }, rule: "US-M11-10 KP-2, BR-32" });
    await emit(tx, "period.closed", { periodId: period.id, period: period.period, closedBy: ctx.userId!, late }, { ctx, objectType: "accounting_period", objectId: period.id, businessDate: today });
    return { period: row!, approvalId: req.id, late };
  });
}

/** Handler persetujuan `period_lock` disetujui: Dikunci + simpan laporan Final (ctx = pemilik). */
export async function onPeriodLockApproved(tx: Tx, request: ApprovalRow, ctx: ActorContext): Promise<Record<string, unknown>> {
  const period = await loadPeriod(tx, request.tenantId, request.objectId, { forUpdate: true });
  if (period.status !== "closed") return { skipped: true, status: period.status };
  const [row] = await tx.update(accountingPeriods).set({ status: "locked", lockedAt: ctx.now, lockedBy: ctx.userId, updatedAt: new Date() }).where(eq(accountingPeriods.id, period.id)).returning();
  const snapshots = await saveFinalSnapshots(tx, ctx, row!);
  await auditRecord(tx, { ctx, objectType: "accounting_period", objectId: period.id, action: "lock", before: { status: "closed" }, after: { status: "locked", revision: row!.revision, snapshots }, rule: "BR-32" });
  await emit(tx, "period.locked", { periodId: period.id, period: period.period, lockedBy: ctx.userId! }, { ctx, tenantId: period.tenantId, objectType: "accounting_period", objectId: period.id, businessDate: period.endDate });
  return { status: "locked", revision: row!.revision };
}

/** Pemilik menolak mengunci → periode kembali Terbuka untuk diperbaiki Admin Keuangan. */
export async function onPeriodLockRejected(tx: Tx, request: ApprovalRow, ctx: ActorContext, reason: string | null): Promise<Record<string, unknown>> {
  const period = await loadPeriod(tx, request.tenantId, request.objectId, { forUpdate: true });
  if (period.status !== "closed") return { skipped: true };
  await tx.update(accountingPeriods).set({ status: period.reopenedAt ? "reopened" : "open", updatedAt: new Date() }).where(eq(accountingPeriods.id, period.id));
  await auditRecord(tx, { ctx, objectType: "accounting_period", objectId: period.id, action: "reject_lock", before: { status: "closed" }, after: { status: "open" }, reason, rule: "BR-32" });
  return { status: "open" };
}

/** Tenggat kunci lewat (eskalasi): tandai terlambat. */
export async function onPeriodLockOverdue(tx: Tx, request: ApprovalRow): Promise<Record<string, unknown>> {
  await tx.update(accountingPeriods).set({ closedLate: true, updatedAt: new Date() }).where(eq(accountingPeriods.id, request.objectId));
  return { late: true };
}

const lockSchema = z.object({ periodId: z.uuid(), note: z.string().trim().max(300).nullable().optional() }).strict();

/** Pemilik mengunci periode (memutuskan permintaan `period_lock` yang terbuka). */
export async function lockPeriod(ctx: ActorContext, input: z.input<typeof lockSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.period.lock", { tx: opts.tx });
  const data = parseInput(lockSchema, input);
  return runService(ctx, opts, async (tx) => {
    const period = await loadPeriod(tx, ctx.tenantId, data.periodId);
    if (period.status !== "closed") throw new DomainError("PERIOD_NOT_CLOSED", "Periode harus Ditutup Admin Keuangan sebelum dikunci.");
    const open = (await approvals.listForObject(tx, "accounting_period", period.id)).find((r) => r.type === "period_lock" && r.status === "submitted");
    if (!open) throw new DomainError("LOCK_REQUEST_MISSING", "Permintaan kunci periode tidak ditemukan — minta Admin Keuangan menutup ulang.");
    await approvals.decide(ctx, open.id, "approve", data.note ?? "Periode dikunci pemilik", { tx });
    return loadPeriod(tx, ctx.tenantId, period.id);
  });
}

const reopenSchema = z.object({ periodId: z.uuid(), reason: z.string().trim().min(10, { error: "Alasan membuka periode wajib diisi (minimal 10 karakter)." }) }).strict();

/** Pemilik membuka kembali periode terkunci dengan alasan (BR-32): berjejak, akuntan diberi tahu, revisi baru. */
export async function reopenPeriod(ctx: ActorContext, input: z.input<typeof reopenSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.period.reopen", { tx: opts.tx });
  const data = parseInput(reopenSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const period = await loadPeriod(tx, ctx.tenantId, data.periodId, { forUpdate: true });
    if (period.status !== "locked") throw new DomainError("PERIOD_NOT_LOCKED", "Hanya periode Dikunci yang dapat dibuka kembali.");
    const [row] = await tx
      .update(accountingPeriods)
      .set({ status: "reopened", reopenedAt: ctx.now, reopenedBy: ctx.userId, reopenReason: data.reason, revision: period.revision + 1, manualReviewMarkedAt: null, manualReviewMarkedBy: null, updatedAt: new Date() })
      .where(eq(accountingPeriods.id, period.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "accounting_period", objectId: period.id, action: "reopen", before: { status: "locked", revision: period.revision }, after: { status: "reopened", revision: row!.revision }, reason: data.reason, rule: "BR-32, 6.2b" });
    await notify(tx, {
      event: "period.reopened",
      tenantId: ctx.tenantId,
      recipients: { roles: ["finance_admin", "accountant"] },
      title: `Periode ${period.period} dibuka kembali pemilik`,
      body: `Alasan: ${data.reason}. Laporan Final revisi ${period.revision} tetap tersimpan; revisi ${row!.revision} terbit setelah dikunci ulang.`,
      objectType: "accounting_period",
      objectId: period.id,
      link: `/akuntansi/periode/${period.id}`,
      now: ctx.now,
    });
    return row!;
  });
}

const noteSchema = z
  .object({ periodId: z.uuid(), note: z.string().trim().min(5, { error: "Catatan tinjauan minimal 5 karakter." }).max(2000), kind: z.enum(enumValues("period_review_kind")).default("review") })
  .strict();

/** Catatan tinjauan akuntan per periode (US-M11-04 KP-5; bukti TG-8 US-M11-10 KP-5). */
export async function addPeriodReviewNote(ctx: ActorContext, input: z.input<typeof noteSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.period.review_note", { tx: opts.tx });
  const data = parseInput(noteSchema, input, { note: "Catatan" });
  return runService(ctx, opts, async (tx) => {
    const period = await loadPeriod(tx, ctx.tenantId, data.periodId);
    const [row] = await tx.insert(periodReviewNotes).values({ tenantId: ctx.tenantId, periodId: period.id, kind: data.kind, note: data.note, createdBy: ctx.userId }).returning();
    await tx.update(accountingPeriods).set({ accountantReviewNote: data.note, updatedAt: new Date() }).where(eq(accountingPeriods.id, period.id));
    await auditRecord(tx, { ctx, objectType: "accounting_period", objectId: period.id, action: "review_note", after: { kind: data.kind }, reason: data.note, rule: "US-M11-04 KP-5" });
    return row!;
  });
}

/** Job harian: pengingat tanggal PAR-71 (5 & 8) dan penanda terlambat setelah PAR-23 (10). */
export async function runPeriodReminders(now: Date, opts: { db?: Tx } = {}): Promise<number> {
  const run = async (tx: Tx) => {
    const today = toBusinessDate(now);
    const day = Number(today.slice(8, 10));
    const { days_of_next_month } = await params.get(tx, "PAR-71", today);
    const { day_of_next_month } = await params.get(tx, "PAR-23", today);
    const previous = shiftPeriod(monthOf(today), -1);
    const tenants = await tx.selectDistinct({ tenantId: accountingPeriods.tenantId }).from(accountingPeriods);
    let sent = 0;
    for (const { tenantId } of tenants) {
      if (!(await isAccountingTenant(tx, tenantId))) continue;
      const cutover = await currentCutover(tx, today);
      if (cutover && previous < monthOf(cutover)) continue;
      const period = await ensurePeriod(tx, tenantId, previous);
      if (!isOpenStatus(period.status)) continue;
      const reminder = days_of_next_month.includes(day);
      const late = day > day_of_next_month;
      if (!reminder && !late) continue;
      const groupKey = `period.not_closed:${tenantId}:${previous}:${late ? "late" : day}`;
      const [dup] = await tx.select({ id: notifications.id }).from(notifications).where(eq(notifications.groupKey, groupKey)).limit(1);
      if (dup) continue;
      await notify(tx, {
        event: "period.not_closed",
        tenantId,
        title: late ? `Periode ${previous} TERLAMBAT ditutup` : `Pengingat: tutup periode ${previous}`,
        body: late
          ? `Batas tutup buku tanggal ${day_of_next_month} sudah lewat (BR-32). Selesaikan prasyarat lalu tutup; periode akan ditandai terlambat.`
          : `Tutup buku paling lambat tanggal ${day_of_next_month}. Periksa prasyarat di Akuntansi > Periode.`,
        objectType: "accounting_period",
        objectId: period.id,
        groupKey,
        deadlineAt: wibToUtc(`${monthOf(today)}-${String(day_of_next_month).padStart(2, "0")}`, "23:59"),
        link: `/akuntansi/periode/${period.id}`,
        now,
      });
      sent++;
    }
    return sent;
  };
  return inJobTx(opts.db, run);
}

/** Dasar sistem untuk handler persetujuan (ctx penyetuju) — dipakai `approvals.ts`. */
export function periodSystemContext(tenantId: string, now: Date) {
  return systemContext({ tenantId, now });
}
