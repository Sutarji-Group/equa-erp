/**
 * M3 — kas di tangan & setoran sopir (US-M3-07, BR-07/08/10, PTB-20/23; Bab 5.2 setoran sopir).
 *
 * - Kas di tangan = Σ tunai rit Selesai + Σ pelunasan tunai − Σ pengeluaran rit dari kas (dihitung sistem).
 * - Setor: aktif bila tidak ada rit Berangkat/Tiba → ringkasan TERKUNCI (`deposits.summary_snapshot`) & status
 *   Diajukan; M3 memiliki transisi Berjalan → Diajukan, M4 memiliki Diterima → Ditutup. Setelah Setor tidak ada rit baru
 *   hari itu kecuali Admin Keuangan membuka kembali setoran yang belum Diterima (`reopenDriverDeposit`).
 * - Cara setor: serah fisik (bawaan) atau setor bank dengan slip bila pemilik mengizinkan sopir itu (PTB-23).
 * - US-M3-09 KP-3: `isDriverDayFullySynced` — Admin Keuangan (M4) tidak dapat menerima setoran bila data hari itu dari
 *   perangkat belum lengkap tersinkron ("menunggu sinkron").
 */
import "server-only";

import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";

import { customerPayments, customers, deposits, deviceUsageLogs, discrepancies, employees, tripExpenses, tripPayments, trips, users } from "@/db/schema";
import { formatRupiah } from "@/lib/money";
import { addDays, formatTanggal, parseHourMinute, toBusinessDate, toWibParts, type BusinessDate } from "@/lib/time";

import { computeDayFigures, type DayFigures, type DepositManifest, type M3DepositHistoryRow, type M3PaymentRef } from "@/client/m3-driver/contract";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, ValidationError, parseInput } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { notify } from "@/server/core/notifications";
import { nextNumber } from "@/server/core/numbering";
import { authorize, runService } from "@/server/core/rbac";
import { linkAttachment, type AttachmentRow } from "@/server/core/storage";

import { depositNoteSchema, depositSubmitSchema, reopenDepositSchema } from "../schemas";
import { collectionsOf } from "./collections";
import { actingTruckId, attachmentsOfKind, depositOf, fieldValues, m3Rules, staleRunningDeposits, substituteConditionsAt, type DepositRow, type M3WriteMeta } from "./common";
import { expensesOf } from "./expenses";

// =====================================================================================================================
// Angka hari itu (server) — fungsi murni yang sama dengan perangkat (`computeDayFigures`)
// =====================================================================================================================

export async function paymentsOf(tx: Tx, userId: string, date: string): Promise<M3PaymentRef[]> {
  const rows = await tx
    .select({ p: tripPayments, tripNumber: trips.number, customerName: customers.name })
    .from(tripPayments)
    .innerJoin(trips, eq(trips.id, tripPayments.tripId))
    .innerJoin(customers, eq(customers.id, tripPayments.customerId))
    .where(and(eq(tripPayments.driverUserId, userId), eq(tripPayments.businessDate, date), isNull(tripPayments.reversalOfId), isNull(tripPayments.reversedAt)));
  return rows.map((r) => ({
    id: r.p.id,
    tripId: r.p.tripId,
    tripNumber: r.tripNumber,
    customerId: r.p.customerId,
    customerName: r.customerName,
    method: r.p.method as "cash" | "transfer" | "credit",
    expectedAmount: r.p.expectedAmount,
    receivedAmount: r.p.receivedAmount,
    underpaymentAmount: r.p.underpaymentAmount,
    originalMethod: r.p.originalMethod,
    recordedAt: (r.p.deviceTime ?? r.p.createdAt).toISOString(),
  }));
}

/** Rit yang dikerjakan pengguna pada tanggal (Selesai/Gagal pada tanggal bisnis itu + yang masih berjalan). */
export async function tripsWorkedBy(tx: Tx, userId: string, date: string) {
  const rows = await tx
    .select({ id: trips.id, number: trips.number, status: trips.status, completionBusinessDate: trips.completionBusinessDate, scheduledDate: trips.scheduledDate })
    .from(trips)
    .where(and(eq(trips.driverUserId, userId), inArray(trips.status, ["departed", "arrived", "completed", "failed"])));
  return rows.filter((t) => (t.status === "completed" || t.status === "failed" ? t.completionBusinessDate === date : t.scheduledDate <= date));
}

export type DayFiguresFull = DayFigures & {
  collections: Awaited<ReturnType<typeof collectionsOf>>;
  expenses: Awaited<ReturnType<typeof expensesOf>>;
  payments: M3PaymentRef[];
  trips: Awaited<ReturnType<typeof tripsWorkedBy>>;
};

export async function dayFigures(tx: Tx, userId: string, date: string): Promise<DayFiguresFull> {
  const [workTrips, payments, collections, expenses] = await Promise.all([tripsWorkedBy(tx, userId, date), paymentsOf(tx, userId, date), collectionsOf(tx, userId, date), expensesOf(tx, userId, date)]);
  const figures = computeDayFigures({
    trips: workTrips,
    payments,
    collections,
    expenses: expenses.map((e) => ({ fundingSource: e.fundingSource, amount: e.amount, status: e.status })),
  });
  return { ...figures, collections, expenses, payments, trips: workTrips };
}

/** Kas di tangan sopir (US-M3-07 KP-1) — izin `m3.cash_on_hand.read` (sopir / kernet pengganti). */
export async function cashOnHand(ctx: ActorContext, input: { date?: BusinessDate } = {}, opts: { tx?: Tx } = {}): Promise<DayFigures> {
  const db = opts.tx ?? getDb();
  const date = input.date ?? ctxBusinessDate(ctx);
  // US-M2-11 KP-3: kas di tangan milik pengguna sendiri — juga setelah digantikan pengemudi lain.
  const conditions = await depositHolderConditions(db, ctx);
  await authorize(ctx, "m3.cash_on_hand.read", { tx: opts.tx, conditions });
  const f = await dayFigures(db, ctx.userId!, date);
  return f;
}

// =====================================================================================================================
// Setor (US-M3-07 KP-2/KP-3/KP-5)
// =====================================================================================================================

function isAfterCloseTime(deviceTime: Date, closeTime: string): boolean {
  const p = toWibParts(deviceTime);
  return p.hour * 60 + p.minute > parseHourMinute(closeTime as `${number}:${number}`);
}

export type DepositSnapshot = {
  figures: DayFigures;
  cashTrips: DayFigures["cashTrips"];
  collections: { id: string; customerName: string; method: string; amount: number }[];
  expenses: { id: string; kind: string; amount: number; fundingSource: string; status: string }[];
  transfers: { tripNumber: string; customerName: string; amount: number }[];
  credit: { tripNumber: string; customerName: string; amount: number }[];
  underpayments: { tripNumber: string; customerName: string; amount: number }[];
  manifest: DepositManifest;
  missing: DepositManifest;
  deviceExpectedNet: number | null;
  submittedFromDeviceId: string | null;
  note: string | null;
};

async function missingFromManifest(tx: Tx, manifest: DepositManifest): Promise<DepositManifest> {
  const done = manifest.completedTripIds.length
    ? await tx.select({ id: trips.id }).from(trips).where(and(inArray(trips.id, manifest.completedTripIds), eq(trips.status, "completed")))
    : [];
  const failed = manifest.failedTripIds.length ? await tx.select({ id: trips.id }).from(trips).where(and(inArray(trips.id, manifest.failedTripIds), eq(trips.status, "failed"))) : [];
  const cols = manifest.collectionIds.length ? await tx.select({ id: customerPayments.id }).from(customerPayments).where(inArray(customerPayments.id, manifest.collectionIds)) : [];
  const exps = manifest.expenseIds.length ? await tx.select({ id: tripExpenses.id }).from(tripExpenses).where(inArray(tripExpenses.id, manifest.expenseIds)) : [];
  const has = (rows: { id: string }[]) => new Set(rows.map((r) => r.id));
  const d = has(done);
  const f = has(failed);
  const c = has(cols);
  const e = has(exps);
  return {
    completedTripIds: manifest.completedTripIds.filter((id) => !d.has(id)),
    failedTripIds: manifest.failedTripIds.filter((id) => !f.has(id)),
    collectionIds: manifest.collectionIds.filter((id) => !c.has(id)),
    expenseIds: manifest.expenseIds.filter((id) => !e.has(id)),
  };
}

function emptyManifest(): DepositManifest {
  return { completedTripIds: [], failedTripIds: [], collectionIds: [], expenseIds: [] };
}

function countManifest(m: DepositManifest): number {
  return m.completedTripIds.length + m.failedTripIds.length + m.collectionIds.length + m.expenseIds.length;
}

/**
 * Kondisi izin Setor (US-M2-11 KP-3 "setoran dipisah per pengguna — masing-masing menyetor kas yang diterimanya"):
 * sopir berperan `driver` selalu boleh menyetor kasnya sendiri; kernet boleh bila pengemudi pengganti pada waktu
 * perangkat ATAU memegang setoran sopir miliknya yang masih Berjalan (kas dari masa pengganti). `anyStatus` untuk
 * keterangan atas selisih setoran miliknya yang sudah diterima.
 */
export async function depositHolderConditions(tx: Tx, ctx: ActorContext, opts: { anyStatus?: boolean } = {}): Promise<{ substitute_driver: boolean }> {
  if (!ctx.roles.includes("helper") || !ctx.userId) return { substitute_driver: false };
  const date = ctxBusinessDate(ctx);
  const truckId = await actingTruckId(tx, ctx, date);
  if (truckId && (await substituteConditionsAt(tx, ctx, truckId, date)).substitute_driver) return { substitute_driver: true };
  const own = await tx
    .select({ id: deposits.id })
    .from(deposits)
    .where(and(eq(deposits.sourceType, "driver"), eq(deposits.depositorUserId, ctx.userId), ...(opts.anyStatus ? [] : [eq(deposits.status, "running")])))
    .limit(1);
  return { substitute_driver: own.length > 0 };
}

export type SubmitDepositResult = {
  deposit: DepositRow;
  duplicate: boolean;
  waitingSync: number;
  late: boolean;
  /** Setoran hari sebelumnya yang masih Berjalan dan ikut diajukan (terlambat) pada Setor ini (US-M3-07 KP-5). */
  lateDeposits: { id: string; number: string; businessDate: string; expectedNet: number }[];
};

type SubmitCore = {
  userId: string;
  employeeId: string | null;
  method: "physical" | "bank_slip";
  slip: AttachmentRow | null;
  note: string | null;
  manifest: DepositManifest;
  deviceExpectedNet: number | null;
  truckId: string | null;
  late: boolean;
  /** Keterangan tambahan jejak audit (mis. diajukan bersama setoran hari ini / dicatat kantor). */
  auditReason: string | null;
};

/** Kunci ringkasan satu setoran sopir (Berjalan → Diajukan) — dipakai Setor perangkat & "dicatat kantor". */
async function lockDepositSummary(ctx: ActorContext, meta: M3WriteMeta, date: BusinessDate, existing: DepositRow | null, c: SubmitCore): Promise<{ deposit: DepositRow; waitingSync: number }> {
  const tx = meta.tx;
  const f = await dayFigures(tx, c.userId, date);
  const missing = await missingFromManifest(tx, c.manifest);
  const snapshot: DepositSnapshot = {
    figures: { ...f, cashTrips: f.cashTrips },
    cashTrips: f.cashTrips,
    collections: f.collections.map((x) => ({ id: x.id, customerName: x.customerName, method: x.method, amount: x.amount })),
    expenses: f.expenses.map((e) => ({ id: e.id, kind: e.kind, amount: e.amount, fundingSource: e.fundingSource, status: e.status })),
    transfers: f.payments.filter((p) => p.method === "transfer").map((p) => ({ tripNumber: p.tripNumber, customerName: p.customerName, amount: p.receivedAmount })),
    credit: f.payments.filter((p) => p.method === "credit").map((p) => ({ tripNumber: p.tripNumber, customerName: p.customerName, amount: p.expectedAmount })),
    underpayments: f.payments.filter((p) => p.underpaymentAmount > 0).map((p) => ({ tripNumber: p.tripNumber, customerName: p.customerName, amount: p.underpaymentAmount })),
    manifest: c.manifest,
    missing,
    deviceExpectedNet: c.deviceExpectedNet,
    submittedFromDeviceId: meta.office ? null : meta.deviceId,
    note: c.note,
  };
  const values = {
    status: "submitted" as const,
    method: c.method,
    bankSlipAttachmentId: c.slip?.id ?? null,
    expectedCash: f.expectedCash,
    acceptedExpenses: 0,
    expectedNet: f.cashOnHand,
    summarySnapshot: snapshot as unknown as Record<string, unknown>,
    submittedAt: meta.deviceTime,
    submittedLate: c.late,
    truckId: c.truckId ?? existing?.truckId ?? null,
    ...fieldValues(meta),
    updatedAt: ctx.now,
  };
  let deposit: DepositRow;
  if (existing) {
    [deposit] = (await tx.update(deposits).set(values).where(eq(deposits.id, existing.id)).returning()) as [DepositRow];
  } else {
    const number = await nextNumber(tx, "deposit", date, { tenantId: ctx.tenantId });
    [deposit] = (await tx
      .insert(deposits)
      .values({ tenantId: ctx.tenantId, number, sourceType: "driver", businessDate: date, depositorUserId: c.userId, depositorEmployeeId: c.employeeId, createdBy: ctx.userId, ...values })
      .returning()) as [DepositRow];
  }
  if (c.slip) await linkAttachment(tx, c.slip.id, { type: "deposit", id: deposit.id });
  await auditRecord(tx, {
    ctx,
    objectType: "deposit",
    objectId: deposit.id,
    action: "submit",
    before: { status: existing?.status ?? null },
    after: {
      status: "submitted",
      expectedCash: f.expectedCash,
      expectedNet: f.cashOnHand,
      method: c.method,
      submittedLate: c.late,
      waitingSync: countManifest(missing),
      recordedByOffice: !!meta.office || undefined,
      onBehalfOfUserId: meta.office ? c.userId : undefined,
    },
    reason: [c.note, c.auditReason].filter(Boolean).join(" — ") || null,
    rule: meta.office ? "US-M3-09 KP-5 dicatat kantor" : c.late ? "US-M3-07 KP-5" : "US-M3-07 KP-2",
    businessDate: date,
  });
  await emit(
    tx,
    "deposit.submitted",
    {
      depositId: deposit.id,
      sourceType: "driver",
      sourceUserId: c.userId,
      truckId: deposit.truckId,
      outletId: null,
      expectedAmount: f.cashOnHand,
      depositNumber: deposit.number,
      businessDate: date,
      expectedCash: f.expectedCash,
      claimedCashExpenses: f.expensesFromCash,
      method: c.method,
      submittedLate: c.late,
      lateSync: meta.lateSync,
    },
    { ctx, businessDate: date, objectType: "deposit", objectId: deposit.id },
  );
  return { deposit, waitingSync: countManifest(missing) };
}

/**
 * Ajukan setoran Berjalan atas nama sopir ("dicatat kantor", US-M3-09 KP-5) — dipanggil `officeSubmitDeposit` (izin
 * & alasan diperiksa di sana). Ringkasan dihitung sistem; serah fisik; penanda terlambat bila tanggalnya sudah lewat.
 */
export async function submitDepositOnBehalf(ctx: ActorContext, meta: M3WriteMeta, dep: DepositRow, who: { userId: string; employeeId: string | null; reason: string }) {
  const rules = await m3Rules(meta.tx, dep.businessDate, ctx.tenantId);
  const late = dep.businessDate < toBusinessDate(ctx.now) || isAfterCloseTime(meta.deviceTime, rules.cashCloseTime);
  return lockDepositSummary(ctx, meta, dep.businessDate, dep, {
    userId: who.userId,
    employeeId: who.employeeId,
    method: "physical",
    slip: null,
    note: null,
    manifest: emptyManifest(),
    deviceExpectedNet: null,
    truckId: dep.truckId,
    late,
    auditReason: `Dicatat kantor: ${who.reason}`,
  });
}

/**
 * Setor (US-M3-07 KP-2/KP-3/KP-5). Otorisasi berdasarkan KEPEMILIKAN kas (setoran milik pelaku), bukan status
 * pengemudi truk saat sinkron — sopir yang digantikan di tengah hari tetap menyetor kas yang ia terima (US-M2-11 KP-3).
 *
 * - `depositDate` < tanggal perintah: mengajukan setoran hari sebelumnya yang belum sempat diajukan (lewat tengah
 *   malam) dengan penanda terlambat; rit hari ini tidak ikut terkunci.
 * - Setor hari ini juga mengajukan setoran hari-hari sebelumnya milik pelaku yang masih Berjalan (terlambat), agar kas
 *   tidak tertahan dan kunci BR-10 dapat dibuka Admin Keuangan. Bila hari ini belum ada aktivitas kas/rit, setoran
 *   hari ini TIDAK dibuat (hari ini tetap terbuka untuk rit).
 */
export async function submitDeposit(ctx: ActorContext, input: unknown, meta: M3WriteMeta): Promise<SubmitDepositResult> {
  const data = parseInput(depositSubmitSchema, input, { method: "Cara setor", note: "Catatan", depositDate: "Tanggal setoran" });
  const tx = meta.tx;
  const userId = ctx.userId!;
  const today = meta.businessDate;
  if (!meta.office) await authorize(ctx, "m3.deposit.submit", { tx, conditions: await depositHolderConditions(tx, ctx) });
  const date = data.depositDate ?? today;
  if (date > today) throw ValidationError.field("depositDate", "Tanggal setoran tidak boleh setelah hari ini. Periksa tanggal & jam ponsel.");
  const truckId = await actingTruckId(tx, ctx, today);
  // PTB-23: setor bank dengan slip hanya bila diizinkan pemilik per orang.
  const slip = attachmentsOfKind(meta, "deposit_slip")[0] ?? null;
  if (data.method === "bank_slip") {
    const emp = ctx.employeeId ? (await tx.select({ allow: employees.allowBankDeposit }).from(employees).where(eq(employees.id, ctx.employeeId)).limit(1))[0] : null;
    if (!emp?.allow) throw new DomainError("BANK_DEPOSIT_NOT_ALLOWED", "Anda belum diizinkan setor ke bank. Serahkan uang langsung ke Admin Keuangan.");
    if (!slip) throw new DomainError("SLIP_REQUIRED", "Foto slip setoran bank wajib.");
  }
  const rules = await m3Rules(tx, today, ctx.tenantId);
  const core = (late: boolean, over: Partial<SubmitCore> = {}): SubmitCore => ({
    userId,
    employeeId: ctx.employeeId,
    method: data.method,
    slip,
    note: data.note ?? null,
    manifest: data.manifest,
    deviceExpectedNet: data.deviceExpectedNet ?? null,
    truckId,
    late,
    auditReason: null,
    ...over,
  });
  const alreadySubmitted = (dep: DepositRow): SubmitDepositResult | never => {
    if (dep.status === "submitted" && dep.syncCommandId === meta.commandId) return { deposit: dep, duplicate: true, waitingSync: 0, late: dep.submittedLate, lateDeposits: [] };
    throw new DomainError("DEPOSIT_ALREADY_SUBMITTED", `Setoran ${date === today ? "hari ini" : formatTanggal(date, { weekday: false })} (${dep.number}) sudah ${dep.status === "submitted" ? "diajukan" : "diterima Admin Keuangan"}.`);
  };

  // --- Setoran hari sebelumnya yang belum diajukan (dipilih eksplisit di perangkat) ---
  if (date < today) {
    const dep = await depositOf(tx, userId, date, { forUpdate: true });
    if (!dep) throw new NotFoundError(`Tidak ada setoran ${formatTanggal(date, { weekday: false })} untuk diajukan. Tarik data terbaru lalu periksa menu Setor.`);
    if (dep.status !== "running") return alreadySubmitted(dep);
    const res = await lockDepositSummary(ctx, meta, date, dep, core(true, { truckId: dep.truckId }));
    return { deposit: res.deposit, duplicate: false, waitingSync: res.waitingSync, late: true, lateDeposits: [] };
  }

  const existing = await depositOf(tx, userId, date, { forUpdate: true });
  if (existing && existing.status !== "running") return alreadySubmitted(existing);
  // US-M3-07 KP-2: Setor hanya bila tidak ada rit Berangkat/Tiba.
  const active = await tx.select({ number: trips.number }).from(trips).where(and(eq(trips.driverUserId, userId), inArray(trips.status, ["departed", "arrived"]))).limit(1);
  if (active[0]) throw new DomainError("ACTIVE_TRIP_EXISTS", `Rit ${active[0].number} masih berjalan. Selesaikan atau tandai gagal dulu sebelum Setor.`);

  // US-M3-07 KP-5: setoran hari sebelumnya yang masih Berjalan ikut diajukan (terlambat) — serah fisik.
  const stale = await staleRunningDeposits(tx, userId, date, { forUpdate: true });
  const lateDeposits: SubmitDepositResult["lateDeposits"] = [];
  for (const dep of stale) {
    const res = await lockDepositSummary(
      ctx,
      meta,
      dep.businessDate,
      dep,
      core(true, { method: "physical", slip: null, manifest: emptyManifest(), deviceExpectedNet: null, truckId: dep.truckId, auditReason: `Diajukan terlambat bersama Setor ${formatTanggal(date, { weekday: false })}.` }),
    );
    lateDeposits.push({ id: res.deposit.id, number: res.deposit.number, businessDate: res.deposit.businessDate, expectedNet: res.deposit.expectedNet });
  }
  if (!existing && lateDeposits.length > 0) {
    const f = await dayFigures(tx, userId, date);
    const idle = f.trips.length === 0 && f.payments.length === 0 && f.collections.length === 0 && f.expenses.length === 0;
    if (idle) {
      const last = (await depositOf(tx, userId, lateDeposits[lateDeposits.length - 1]!.businessDate))!;
      return { deposit: last, duplicate: false, waitingSync: 0, late: true, lateDeposits: lateDeposits.slice(0, -1) };
    }
  }
  const late = isAfterCloseTime(meta.deviceTime, rules.cashCloseTime) || date < toBusinessDate(ctx.now);
  const res = await lockDepositSummary(ctx, meta, date, existing, core(late));
  return { deposit: res.deposit, duplicate: false, waitingSync: res.waitingSync, late, lateDeposits };
}

/** Keterangan sopir atas selisih setoran yang sudah Diterima (US-M3-07 KP-4) → alur selisih M4. */
export async function addDepositorNote(ctx: ActorContext, input: unknown, meta: M3WriteMeta) {
  const data = parseInput(depositNoteSchema, input, { note: "Keterangan" });
  const tx = meta.tx;
  const rows = await tx.select().from(deposits).where(eq(deposits.id, data.depositId)).for("update").limit(1);
  const dep = rows[0];
  if (!dep || dep.depositorUserId !== ctx.userId) throw new NotFoundError("Setoran tidak ditemukan.");
  if (dep.status !== "received" && dep.status !== "closed") throw new DomainError("NOT_RECEIVED", "Keterangan selisih diisi setelah setoran diterima Admin Keuangan.");
  const note = dep.depositorNote && dep.depositorNote !== data.note ? `${dep.depositorNote}\n---\n${data.note}` : data.note;
  if (dep.depositorNote === data.note) return { deposit: dep, duplicate: true };
  const [updated] = await tx.update(deposits).set({ depositorNote: note, updatedAt: ctx.now }).where(eq(deposits.id, dep.id)).returning();
  await auditRecord(tx, { ctx, objectType: "deposit", objectId: dep.id, action: "depositor_note", before: { depositorNote: dep.depositorNote }, after: { depositorNote: note }, rule: "US-M3-07 KP-4", businessDate: dep.businessDate });
  await notify(tx, {
    event: "deposit.depositor_note",
    tenantId: dep.tenantId,
    title: `Keterangan sopir atas selisih setoran ${dep.number}`,
    body: `${data.note}${dep.discrepancyAmount ? ` (selisih ${formatRupiah(dep.discrepancyAmount, { signed: true })})` : ""}`,
    objectType: "deposit",
    objectId: dep.id,
    link: "/kas/selisih",
    groupKey: `deposit.depositor_note:${dep.id}`,
    now: ctx.now,
  });
  return { deposit: updated!, duplicate: false };
}

/**
 * Admin Keuangan membuka kembali setoran sopir yang belum Diterima (US-M3-07 KP-2) — dipakai M4. Diajukan → Berjalan;
 * sopir dapat melanjutkan rit lalu menekan Setor lagi. Alasan wajib, berjejak.
 */
export async function reopenDriverDeposit(ctx: ActorContext, input: { depositId: string; reason: string }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m4.deposit.reopen", { tx: opts.tx, objectType: "deposit", objectId: input.depositId });
  const data = parseInput(reopenDepositSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const rows = await tx.select().from(deposits).where(eq(deposits.id, data.depositId)).for("update").limit(1);
    const dep = rows[0];
    if (!dep || dep.tenantId !== ctx.tenantId || dep.sourceType !== "driver") throw new NotFoundError("Setoran sopir tidak ditemukan.");
    if (dep.status !== "submitted") {
      throw new DomainError("DEPOSIT_NOT_SUBMITTED", `Setoran ${dep.number} berstatus ${dep.status === "running" ? "Berjalan" : "sudah diterima"} — hanya setoran Diajukan yang belum Diterima dapat dibuka kembali.`);
    }
    const [updated] = await tx
      .update(deposits)
      .set({ status: "running", reopenedAt: ctx.now, reopenedBy: ctx.userId, reopenReason: data.reason, updatedAt: ctx.now })
      .where(eq(deposits.id, dep.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "deposit", objectId: dep.id, action: "reopen", before: { status: "submitted" }, after: { status: "running" }, reason: data.reason, rule: "US-M3-07 KP-2", businessDate: dep.businessDate });
    if (dep.depositorUserId) {
      await notify(tx, {
        event: "deposit.reopened",
        tenantId: dep.tenantId,
        recipients: { userIds: [dep.depositorUserId] },
        title: `Setoran ${dep.number} dibuka kembali`,
        body: `${data.reason}. Lanjutkan rit lalu tekan "Setor" lagi.`,
        objectType: "deposit",
        objectId: dep.id,
        now: ctx.now,
      });
    }
    return updated!;
  });
}

// =====================================================================================================================
// Sinkron (US-M3-09 KP-3) — dipakai M4 sebelum menerima setoran
// =====================================================================================================================

export type DriverDaySyncStatus = {
  deposit: { id: string; number: string; status: string } | null;
  submitted: boolean;
  /** Item yang tercatat di perangkat (manifest Setor) tetapi belum sampai di server. */
  missing: DepositManifest;
  /** Antrean pengguna menurut laporan kesehatan perangkat terakhir setelah Setor (null = tidak ada laporan). */
  deviceQueue: number | null;
  fullySynced: boolean;
  message: string;
};

export async function driverDaySyncStatus(tx: Tx, userId: string, date: BusinessDate): Promise<DriverDaySyncStatus> {
  const dep = await depositOf(tx, userId, date);
  if (!dep || dep.status === "running") {
    return {
      deposit: dep ? { id: dep.id, number: dep.number, status: dep.status } : null,
      submitted: false,
      missing: emptyManifest(),
      deviceQueue: null,
      fullySynced: false,
      message: "Setoran belum diajukan sopir dari aplikasi.",
    };
  }
  const snap = (dep.summarySnapshot ?? {}) as Partial<DepositSnapshot>;
  const missing = await missingFromManifest(tx, snap.manifest ?? emptyManifest());
  let deviceQueue: number | null = null;
  const deviceId = snap.submittedFromDeviceId ?? dep.deviceId;
  if (deviceId && dep.submittedAt) {
    const logs = await tx
      .select({ occurredAt: deviceUsageLogs.occurredAt, details: deviceUsageLogs.details, queueCount: deviceUsageLogs.queueCount })
      .from(deviceUsageLogs)
      .where(and(eq(deviceUsageLogs.deviceId, deviceId), eq(deviceUsageLogs.event, "health_report"), gte(deviceUsageLogs.occurredAt, dep.submittedAt)))
      .orderBy(desc(deviceUsageLogs.occurredAt))
      .limit(1);
    const byUser = (logs[0]?.details as { queueByUser?: Record<string, number> } | null)?.queueByUser;
    if (logs[0]) deviceQueue = byUser ? (byUser[userId] ?? 0) : null;
  }
  const n = countManifest(missing);
  const fullySynced = n === 0 && (deviceQueue === null || deviceQueue === 0);
  return {
    deposit: { id: dep.id, number: dep.number, status: dep.status },
    submitted: true,
    missing,
    deviceQueue,
    fullySynced,
    message: fullySynced ? "Semua data hari itu sudah tersinkron." : `Menunggu sinkron: ${n || deviceQueue} data dari ponsel sopir belum masuk. Minta sopir menekan "Kirim sekarang" saat ada sinyal.`,
  };
}

/** US-M3-09 KP-3: benar bila seluruh transaksi hari itu dari perangkat sopir sudah tersinkron (setoran boleh diterima). */
export async function isDriverDayFullySynced(tx: Tx, userId: string, date: BusinessDate): Promise<boolean> {
  return (await driverDaySyncStatus(tx, userId, date)).fullySynced;
}

// =====================================================================================================================
// Riwayat 90 hari (US-M3-07 KP-6) — hanya milik sendiri
// =====================================================================================================================

export async function depositHistory(tx: Tx, userId: string, today: BusinessDate, days: number): Promise<M3DepositHistoryRow[]> {
  const from = addDays(today, -days);
  const rows = await tx
    .select()
    .from(deposits)
    .where(and(eq(deposits.sourceType, "driver"), eq(deposits.depositorUserId, userId), gte(deposits.businessDate, from), lte(deposits.businessDate, today)))
    .orderBy(desc(deposits.businessDate));
  const ids = rows.map((r) => r.id);
  const discs = ids.length ? await tx.select().from(discrepancies).where(inArray(discrepancies.depositId, ids)) : [];
  return rows.map((d) => ({
    id: d.id,
    number: d.number,
    businessDate: d.businessDate,
    status: d.status,
    method: d.method,
    expectedCash: d.expectedCash,
    expectedNet: d.expectedNet,
    receivedAmount: d.receivedAmount,
    discrepancyAmount: d.discrepancyAmount,
    discrepancyReason: d.discrepancyReason,
    discrepancyNote: d.discrepancyNote,
    depositorNote: d.depositorNote,
    submittedAt: d.submittedAt?.toISOString() ?? null,
    submittedLate: d.submittedLate,
    receivedAt: d.receivedAt?.toISOString() ?? null,
    closedAt: d.closedAt?.toISOString() ?? null,
    discrepancies: discs
      .filter((x) => x.depositId === d.id)
      .map((x) => ({ id: x.id, amount: x.amount, status: x.status, reason: x.reason, explanation: x.explanation, decisionReason: x.decisionReason })),
  }));
}

/** Setoran sopir untuk kantor (M4/laporan): nama penyetor. */
export async function depositorName(tx: Tx, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const rows = await tx.select({ name: employees.fullName }).from(users).innerJoin(employees, eq(employees.id, users.employeeId)).where(eq(users.id, userId)).limit(1);
  return rows[0]?.name ?? null;
}
