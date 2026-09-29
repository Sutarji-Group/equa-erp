/**
 * M4 — tutup kas harian (US-M4-06; FR-M4-06, BR-14, P-06 langkah 3–4, KPI-02, KPI-08).
 *
 * "Tutup kas" hanya aktif bila: semua setoran sopir hari itu Diterima/Ditutup, semua shift depot & toko Ditutup dan
 * setorannya Diterima atau tercatat setor bank, tidak ada rit Berangkat/Tiba, dan hari sebelumnya sudah ditutup.
 * Penghalang ditampilkan dengan tombol hubungi. Pengecualian per kejadian (PTB-21, CR-06, 6.2a `cash_close_exception`):
 * pemilik mengizinkan tutup kas dengan setoran tertunda maks PAR-89 hari; rit sopir tetap terkunci (setoran belum
 * Ditutup, BR-10); kas harus diterima ≤ N jam — lewat itu menjadi Selisih (US-M4-03).
 * Layar tutup kas: selisih hari itu, transfer belum dicocokkan, kas kantor sistem vs hitung fisik (selisih wajib alasan →
 * alur Selisih). Dicatat: setoran terakhir Diterima, mulai tutup kas, kas ditutup (KPI-02); lewat PAR-06 → terlambat.
 * Hari yang ditutup terkunci; `cash_day.closed` memicu ringkasan H+0 M9 (≤ 30 menit, NFR-04).
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";

import { cashCloseExceptions, cashDays, deposits, outlets, posSales, shifts, tripPayments, trips, trucks } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, daysBetween, formatTanggal, formatTanggalJam, wibToUtc, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Db, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { notify } from "@/server/core/notifications";
import { authorize, runService } from "@/server/core/rbac";
import * as m7 from "@/server/modules/m7-store";

import { cashDateSchema, closeCashDaySchema, closeExceptionSchema } from "../schemas";
import { assertNotFuture, cashDayOf, cashRules, depositSourceInfo, isAfterCutoff, officeCashBalance, postOfficeCash, userNames, type DepositRow } from "./common";
import { depositFigures, lastReceivedAt, resolveExceptionsForDeposit } from "./deposits";
import { discrepanciesOn, formDiscrepancy } from "./discrepancies";
import { unmatchedTransfers } from "./transfers";

export type CashDayRow = typeof cashDays.$inferSelect;
export type CashCloseExceptionRow = typeof cashCloseExceptions.$inferSelect;

export type CashBlockerKind = "driver_deposit" | "shift_open" | "shift_deposit" | "trip_active" | "previous_day";

export type CashBlocker = {
  kind: CashBlockerKind;
  kindLabel: string;
  label: string;
  detail: string | null;
  phone: string | null;
  businessDate: string;
  depositId: string | null;
  shiftId: string | null;
  outletId: string | null;
  tripId: string | null;
  employeeId: string | null;
  sourceType: DepositRow["sourceType"] | null;
  /** Ditutupi pengecualian yang disetujui pemilik (PTB-21). */
  covered: boolean;
  exception: { id: string; status: CashCloseExceptionRow["status"] } | null;
  /** Dapat diajukan pengecualian (setoran/shift berhalangan, ≤ PAR-89 hari). */
  canRequestException: boolean;
};

async function ensureCashDay(tx: Tx, tenantId: string, date: BusinessDate): Promise<CashDayRow> {
  const existing = await cashDayOf(tx, tenantId, date);
  if (existing) return existing;
  const [row] = await tx.insert(cashDays).values({ tenantId, businessDate: date, status: "open" }).onConflictDoNothing().returning();
  return row ?? (await cashDayOf(tx, tenantId, date))!;
}

/** Penghalang tutup kas (US-M4-06 KP-1) beserta cakupan pengecualian. */
export async function closeBlockers(tx: Tx, tenantId: string, date: BusinessDate): Promise<CashBlocker[]> {
  const rules = await cashRules(tx, date, tenantId);
  const day = await cashDayOf(tx, tenantId, date);
  const exceptions = day ? await tx.select().from(cashCloseExceptions).where(eq(cashCloseExceptions.cashDayId, day.id)) : [];
  const liveExceptions = exceptions.filter((e) => e.status === "submitted" || e.status === "approved" || e.status === "resolved");
  const blockers: CashBlocker[] = [];
  const base = { detail: null, phone: null, depositId: null, shiftId: null, outletId: null, tripId: null, employeeId: null, sourceType: null, covered: false, exception: null, canRequestException: false };

  // Hari sebelumnya (dengan aktivitas setoran) sudah ditutup.
  const [prev] = await tx
    .select({ d: sql<string | null>`max(${deposits.businessDate})` })
    .from(deposits)
    .where(and(eq(deposits.tenantId, tenantId), lt(deposits.businessDate, date)));
  const prevDate = prev?.d ? String(prev.d).slice(0, 10) : null;
  if (prevDate) {
    const prevDay = await cashDayOf(tx, tenantId, prevDate);
    if (prevDay?.status !== "closed") {
      blockers.push({ ...base, kind: "previous_day", kindLabel: label("cash_close_blocker", "previous_day"), label: `Kas ${formatTanggal(prevDate)} belum ditutup`, businessDate: prevDate });
    }
  }

  const matchException = (b: Pick<CashBlocker, "depositId" | "outletId" | "sourceType">) =>
    liveExceptions.find((e) => (b.depositId && e.depositId === b.depositId) || (!b.depositId && b.outletId && e.outletId === b.outletId && e.sourceType === b.sourceType)) ?? null;

  // Setoran sopir hari itu belum Diterima/Ditutup.
  const driverDeps = await tx.select().from(deposits).where(and(eq(deposits.tenantId, tenantId), eq(deposits.businessDate, date), eq(deposits.sourceType, "driver"), inArray(deposits.status, ["running", "submitted"])));
  for (const d of driverDeps) {
    const info = await depositSourceInfo(tx, d);
    const exc = matchException({ depositId: d.id, outletId: null, sourceType: "driver" });
    blockers.push({
      ...base,
      kind: "driver_deposit",
      kindLabel: label("cash_close_blocker", "driver_deposit"),
      label: info.label,
      detail: `${d.number} · ${label("deposit_status", d.status)}${d.method === "bank_slip" ? " · setor bank (menunggu mutasi)" : ""}`,
      phone: info.phone,
      businessDate: d.businessDate,
      depositId: d.id,
      employeeId: d.depositorEmployeeId,
      sourceType: "driver",
      covered: exc?.status === "approved" || exc?.status === "resolved",
      exception: exc ? { id: exc.id, status: exc.status } : null,
      canRequestException: !exc && daysBetween(d.businessDate, date) < rules.pendingDepositMaxDays,
    });
  }

  // Shift depot & toko terbuka (≤ tanggal); M7: shift toko terbuka menghalangi tutup kas (US-M7-09 KP-3).
  const openDepot = await tx
    .select({ s: shifts, code: outlets.code, name: outlets.name, phone: outlets.phone, kind: outlets.kind })
    .from(shifts)
    .innerJoin(outlets, eq(outlets.id, shifts.outletId))
    .where(and(eq(shifts.tenantId, tenantId), eq(shifts.status, "open"), lte(shifts.businessDate, date), eq(outlets.kind, "depot")));
  const openStore = await m7.storeShiftsBlockingCashClose(tx, tenantId, date);
  const storeOutlets = openStore.length ? await tx.select({ id: outlets.id, code: outlets.code, phone: outlets.phone }).from(outlets).where(inArray(outlets.id, openStore.map((s) => s.outletId))) : [];
  const openAll = [
    ...openDepot.map((r) => ({ shiftId: r.s.id, outletId: r.s.outletId, label: `Depot ${r.code} — ${r.name}`, phone: r.phone, businessDate: r.s.businessDate, openedAt: r.s.openedAt, sourceType: "depot_shift" as const })),
    ...openStore.map((s) => ({ shiftId: s.shiftId, outletId: s.outletId, label: `Toko ${storeOutlets.find((o) => o.id === s.outletId)?.code ?? ""} — ${s.outletName}`, phone: storeOutlets.find((o) => o.id === s.outletId)?.phone ?? null, businessDate: s.businessDate, openedAt: s.openedAt, sourceType: "store_shift" as const })),
  ];
  for (const s of openAll) {
    const exc = matchException({ depositId: null, outletId: s.outletId, sourceType: s.sourceType });
    blockers.push({
      ...base,
      kind: "shift_open",
      kindLabel: label("cash_close_blocker", "shift_open"),
      label: s.label,
      detail: `Shift dibuka ${formatTanggalJam(s.openedAt)}`,
      phone: s.phone,
      businessDate: s.businessDate,
      shiftId: s.shiftId,
      outletId: s.outletId,
      sourceType: s.sourceType,
      covered: exc?.status === "approved" || exc?.status === "resolved",
      exception: exc ? { id: exc.id, status: exc.status } : null,
      canRequestException: !exc && daysBetween(s.businessDate, date) < rules.pendingDepositMaxDays,
    });
  }

  // Shift ditutup yang setorannya belum Diterima (setor bank dengan slip tercatat = cukup).
  const shiftDeps = await tx
    .select({ d: deposits, code: outlets.code, name: outlets.name, phone: outlets.phone, kind: outlets.kind })
    .from(deposits)
    .innerJoin(outlets, eq(outlets.id, deposits.outletId))
    .where(and(eq(deposits.tenantId, tenantId), eq(deposits.businessDate, date), inArray(deposits.sourceType, ["depot_shift", "store_shift"]), eq(deposits.isPartial, false), inArray(deposits.status, ["running", "submitted"])));
  for (const { d, code, name, phone, kind } of shiftDeps) {
    if (d.method === "bank_slip" && d.bankSlipAttachmentId) continue;
    const exc = matchException({ depositId: d.id, outletId: d.outletId, sourceType: d.sourceType });
    blockers.push({
      ...base,
      kind: "shift_deposit",
      kindLabel: label("cash_close_blocker", "shift_deposit"),
      label: `${kind === "store" ? "Toko" : "Depot"} ${code} — ${name}`,
      detail: `${d.number} · ${formatRupiah(d.expectedNet)}`,
      phone,
      businessDate: d.businessDate,
      depositId: d.id,
      shiftId: d.shiftId,
      outletId: d.outletId,
      employeeId: d.depositorEmployeeId,
      sourceType: d.sourceType,
      covered: exc?.status === "approved" || exc?.status === "resolved",
      exception: exc ? { id: exc.id, status: exc.status } : null,
      canRequestException: !exc && daysBetween(d.businessDate, date) < rules.pendingDepositMaxDays,
    });
  }

  // Rit masih Berangkat/Tiba.
  const active = await tx
    .select({ id: trips.id, number: trips.number, status: trips.status, truckCode: trucks.code, driverUserId: trips.driverUserId, scheduledDate: trips.scheduledDate })
    .from(trips)
    .leftJoin(trucks, eq(trucks.id, trips.truckId))
    .where(and(eq(trips.tenantId, tenantId), lte(trips.scheduledDate, date), inArray(trips.status, ["departed", "arrived"])));
  const driverNames = await userNames(tx, active.map((a) => a.driverUserId));
  for (const t of active) {
    const d = t.driverUserId ? driverNames.get(t.driverUserId) : undefined;
    blockers.push({
      ...base,
      kind: "trip_active",
      kindLabel: label("cash_close_blocker", "trip_active"),
      label: `Rit ${t.number}${t.truckCode ? ` (${t.truckCode})` : ""}`,
      detail: `${label("trip_status", t.status)}${d ? ` · ${d.name}` : ""}`,
      phone: d?.phone ?? null,
      businessDate: t.scheduledDate,
      tripId: t.id,
    });
  }
  return blockers;
}

export type CashDayScreen = {
  date: BusinessDate;
  day: CashDayRow | null;
  blockers: CashBlocker[];
  openBlockers: CashBlocker[];
  exceptions: (CashCloseExceptionRow & { sourceLabel: string })[];
  discrepancies: Awaited<ReturnType<typeof discrepanciesOn>>;
  unmatchedTransfers: Awaited<ReturnType<typeof unmatchedTransfers>>;
  /** Saldo sistem pembanding hitung fisik (tutup kas tanggal lampau: saldo sampai saat ini). */
  officeCashSystem: number;
  /** Saldo kas kantor sampai akhir tanggal itu. */
  officeCashThroughDate: number;
  /** Mutasi bersih bertanggal sesudah tanggal itu yang sudah ada di laci (tutup kas tertunda). */
  officeCashLaterNet: number;
  lastDepositReceivedAt: Date | null;
  lateSyncCount: number;
  cutoff: string;
  canClose: boolean;
  pendingDepositMaxDays: number;
};

/**
 * Saldo sistem pembanding hitung fisik kas kantor. Tutup kas tanggal lampau (tutup kas tertunda 7.4.6): laci saat ini
 * juga memuat mutasi bertanggal SESUDAH tanggal itu (setor bank/kas kecil pagi ini, setoran tertunda) — pembanding =
 * saldo sampai saat ini; `throughDate` = saldo sampai akhir tanggal itu, `laterNet` = mutasi bersih sesudahnya.
 */
export async function officeCashForClose(tx: Tx, tenantId: string, date: BusinessDate, today: BusinessDate): Promise<{ system: number; throughDate: number; laterNet: number }> {
  const throughDate = await officeCashBalance(tx, tenantId, date);
  if (date >= today) return { system: throughDate, throughDate, laterNet: 0 };
  const current = await officeCashBalance(tx, tenantId, "9999-12-31");
  return { system: current, throughDate, laterNet: current - throughDate };
}

async function lateSyncCount(tx: Tx, tenantId: string, date: BusinessDate): Promise<number> {
  const [a] = await tx.select({ n: sql<number>`count(*)::int` }).from(tripPayments).where(and(eq(tripPayments.tenantId, tenantId), eq(tripPayments.businessDate, date), eq(tripPayments.lateSync, true)));
  const [b] = await tx.select({ n: sql<number>`count(*)::int` }).from(posSales).where(and(eq(posSales.tenantId, tenantId), eq(posSales.businessDate, date), eq(posSales.lateSync, true)));
  return Number(a?.n ?? 0) + Number(b?.n ?? 0);
}

/** Layar tutup kas (US-M4-06 KP-1/KP-3/KP-4). */
export async function getCashDayScreen(ctx: ActorContext, filter: { date?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<CashDayScreen> {
  await authorize(ctx, "m4.cash_day.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const date = filter.date ?? ctxBusinessDate(ctx);
  const rules = await cashRules(tx, date, ctx.tenantId);
  const day = await cashDayOf(tx, ctx.tenantId, date);
  const blockers = day?.status === "closed" ? [] : await closeBlockers(tx, ctx.tenantId, date);
  const excRows = day ? await tx.select().from(cashCloseExceptions).where(eq(cashCloseExceptions.cashDayId, day.id)).orderBy(asc(cashCloseExceptions.createdAt)) : [];
  const exceptions = [];
  for (const e of excRows) {
    let sourceLabel = label("deposit_source_type", e.sourceType);
    if (e.depositId) {
      const d = (await tx.select().from(deposits).where(eq(deposits.id, e.depositId)).limit(1))[0];
      if (d) sourceLabel = `${(await depositSourceInfo(tx, d)).label} · ${d.number}`;
    } else if (e.outletId) {
      const o = (await tx.select({ code: outlets.code, name: outlets.name }).from(outlets).where(eq(outlets.id, e.outletId)).limit(1))[0];
      if (o) sourceLabel = `${label("deposit_source_type", e.sourceType)} ${o.code} — ${o.name}`;
    }
    exceptions.push({ ...e, sourceLabel });
  }
  const openBlockers = blockers.filter((b) => !b.covered);
  const cash = await officeCashForClose(tx, ctx.tenantId, date, ctxBusinessDate(ctx));
  return {
    date,
    day,
    blockers,
    openBlockers,
    exceptions,
    discrepancies: await discrepanciesOn(tx, ctx.tenantId, date),
    unmatchedTransfers: await unmatchedTransfers(tx, ctx.tenantId, date),
    officeCashSystem: cash.system,
    officeCashThroughDate: cash.throughDate,
    officeCashLaterNet: cash.laterNet,
    lastDepositReceivedAt: await lastReceivedAt(tx, ctx.tenantId, date),
    lateSyncCount: await lateSyncCount(tx, ctx.tenantId, date),
    cutoff: rules.cashCloseTime,
    canClose: day?.status !== "closed" && openBlockers.length === 0,
    pendingDepositMaxDays: rules.pendingDepositMaxDays,
  };
}

/** Catat "mulai tutup kas" (KPI-02 pendukung); penghalang → notifikasi Admin Keuangan (6.3). */
export async function startCashClose(ctx: ActorContext, input: unknown = {}, opts: { tx?: Tx } = {}): Promise<{ day: CashDayRow; blockers: CashBlocker[] }> {
  await authorize(ctx, "m4.cash_day.close", { tx: opts.tx });
  const data = parseInput(cashDateSchema, input);
  return runService(ctx, opts, async (tx) => {
    const today = ctxBusinessDate(ctx);
    const date = data.date ?? today;
    assertNotFuture(date, today);
    let day = await ensureCashDay(tx, ctx.tenantId, date);
    if (day.status === "closed") throw new DomainError("CASH_DAY_CLOSED", `Kas ${formatTanggal(date, { weekday: false })} sudah ditutup.`);
    if (!day.closeStartedAt) {
      [day] = (await tx.update(cashDays).set({ closeStartedAt: ctx.now, updatedAt: ctx.now }).where(eq(cashDays.id, day.id)).returning()) as [CashDayRow];
      await auditRecord(tx, { ctx, objectType: "cash_day", objectId: day.id, action: "start_close", after: { closeStartedAt: ctx.now }, businessDate: date });
    }
    const blockers = (await closeBlockers(tx, ctx.tenantId, date)).filter((b) => !b.covered);
    if (blockers.some((b) => b.kind === "driver_deposit" || b.kind === "shift_deposit")) await notifyNotReceived(tx, ctx, date, blockers);
    return { day, blockers };
  });
}

async function notifyNotReceived(tx: Tx, ctx: ActorContext, date: BusinessDate, blockers: CashBlocker[]) {
  const deps = blockers.filter((b) => b.kind === "driver_deposit" || b.kind === "shift_deposit");
  await notify(tx, {
    event: "deposit.not_received_at_close",
    tenantId: ctx.tenantId,
    recipients: { roles: ["finance_admin"] },
    title: `${deps.length} setoran belum diterima saat tutup kas ${formatTanggal(date, { weekday: false })}`,
    body: deps.map((b) => `${b.label} (${b.detail ?? ""})`).join("; "),
    objectType: "cash_day",
    objectId: date,
    link: `/kas/tutup?tanggal=${date}`,
    groupKey: `deposit.not_received_at_close:${ctx.tenantId}:${date}`,
    now: ctx.now,
  });
}

/** Ajukan pengecualian tutup kas dengan setoran tertunda (PTB-21) — per kejadian, persetujuan pemilik sebelum tutup kas. */
export async function requestCloseException(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<CashCloseExceptionRow> {
  await authorize(ctx, "m4.cash_close_exception.request", { tx: opts.tx });
  const data = parseInput(closeExceptionSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const today = ctxBusinessDate(ctx);
    const date = data.date ?? today;
    assertNotFuture(date, today);
    const day = await ensureCashDay(tx, ctx.tenantId, date);
    if (day.status === "closed") throw new DomainError("CASH_DAY_CLOSED", "Kas hari itu sudah ditutup.");
    const blockers = await closeBlockers(tx, ctx.tenantId, date);
    const blocker = blockers.find((b) => (data.depositId && b.depositId === data.depositId) || (!data.depositId && data.shiftId && b.shiftId === data.shiftId));
    if (!blocker || (blocker.kind !== "driver_deposit" && blocker.kind !== "shift_deposit" && blocker.kind !== "shift_open")) {
      throw new DomainError("NOT_A_PENDING_SOURCE", "Pengecualian hanya untuk setoran/shift yang menghalangi tutup kas hari ini.");
    }
    if (blocker.exception) throw new DomainError("EXCEPTION_EXISTS", "Sudah ada pengecualian untuk sumber ini pada hari kas ini (per kejadian).");
    const rules = await cashRules(tx, date, ctx.tenantId);
    if (daysBetween(blocker.businessDate, date) >= rules.pendingDepositMaxDays) {
      throw new DomainError("PENDING_TOO_OLD", `Setoran tertunda maksimal ${rules.pendingDepositMaxDays} hari (PAR-89). Setoran ${formatTanggal(blocker.businessDate, { weekday: false })} harus diterima dulu.`);
    }
    const [exc] = await tx
      .insert(cashCloseExceptions)
      .values({
        tenantId: ctx.tenantId,
        cashDayId: day.id,
        businessDate: date,
        sourceType: blocker.sourceType ?? "driver",
        depositId: blocker.depositId,
        employeeId: blocker.employeeId,
        outletId: blocker.outletId,
        reason: data.reason,
        status: "submitted",
        createdBy: ctx.userId,
      })
      .returning();
    const cutoffAt = wibToUtc(date, "23:59");
    const deadlineAt = cutoffAt.getTime() > ctx.now.getTime() + 3_600_000 ? cutoffAt : new Date(ctx.now.getTime() + 6 * 3_600_000);
    const req = await approvals.submit(
      ctx,
      {
        type: "cash_close_exception",
        objectType: "cash_close_exception",
        objectId: exc!.id,
        amount: blocker.depositId ? ((await tx.select({ v: deposits.expectedNet }).from(deposits).where(eq(deposits.id, blocker.depositId)).limit(1))[0]?.v ?? null) : null,
        reason: `Tutup kas ${formatTanggal(date, { weekday: false })} dengan setoran tertunda: ${blocker.label}${blocker.detail ? ` (${blocker.detail})` : ""}. ${data.reason}`,
        deadlineAt,
        businessDate: date,
        payload: { link: `/kas/tutup?tanggal=${date}`, blocker: blocker.kind, depositId: blocker.depositId, outletId: blocker.outletId },
      },
      { tx },
    );
    const [updated] = await tx.update(cashCloseExceptions).set({ approvalRequestId: req.id, updatedAt: ctx.now }).where(eq(cashCloseExceptions.id, exc!.id)).returning();
    await auditRecord(tx, { ctx, objectType: "cash_close_exception", objectId: exc!.id, action: "submit", after: { depositId: blocker.depositId, outletId: blocker.outletId, sourceType: blocker.sourceType }, reason: data.reason, rule: "PTB-21", businessDate: date });
    return updated!;
  });
}

/** Keputusan pemilik atas pengecualian (handler `cash_close_exception`). */
export async function decideCloseException(tx: Tx, ctx: ActorContext, exceptionId: string, status: "approved" | "rejected" | "expired"): Promise<Record<string, unknown>> {
  const exc = (await tx.select().from(cashCloseExceptions).where(eq(cashCloseExceptions.id, exceptionId)).for("update").limit(1))[0];
  if (!exc) throw new NotFoundError("Pengecualian tutup kas tidak ditemukan.");
  if (exc.status !== "submitted") return { status: exc.status };
  await tx.update(cashCloseExceptions).set({ status, updatedAt: ctx.now }).where(eq(cashCloseExceptions.id, exc.id));
  await auditRecord(tx, { ctx, objectType: "cash_close_exception", objectId: exc.id, action: status === "approved" ? "approve" : status === "rejected" ? "reject" : "expire", before: { status: "submitted" }, after: { status }, rule: "PTB-21, 6.2a", businessDate: exc.businessDate });
  return { status };
}

/** Tutup kas harian (US-M4-06). */
export async function closeCashDay(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<CashDayRow> {
  await authorize(ctx, "m4.cash_day.close", { tx: opts.tx });
  const data = parseInput(closeCashDaySchema, input, { officeCashPhysical: "Hitung fisik kas kantor", officeCashReason: "Alasan selisih kas kantor", officeCashNote: "Keterangan" });
  return runService(ctx, opts, async (tx) => {
    const today = ctxBusinessDate(ctx);
    const date = data.date ?? today;
    assertNotFuture(date, today);
    const existing = await cashDayOf(tx, ctx.tenantId, date);
    if (existing?.status === "closed") throw new DomainError("CASH_DAY_CLOSED", `Kas ${formatTanggal(date, { weekday: false })} sudah ditutup.`);
    const blockers = (await closeBlockers(tx, ctx.tenantId, date)).filter((b) => !b.covered);
    if (blockers.length) {
      const list = blockers.slice(0, 4).map((b) => `${b.kindLabel}: ${b.label}`).join("; ");
      throw new DomainError("CASH_CLOSE_BLOCKED", `Kas belum dapat ditutup — ${list}${blockers.length > 4 ? ` (+${blockers.length - 4} lagi)` : ""}. Hubungi sumbernya atau ajukan pengecualian ke pemilik.`, {
        blockers: blockers.map((b) => ({ kind: b.kind, label: b.label })),
      });
    }
    const rules = await cashRules(tx, date, ctx.tenantId);
    // Tutup kas tanggal lampau: fisik laci dibandingkan dengan saldo sampai saat ini (7.4.6).
    const cash = await officeCashForClose(tx, ctx.tenantId, date, today);
    const system = cash.system;
    const difference = data.officeCashPhysical - system;
    if (difference !== 0) {
      if (!data.officeCashReason) {
        throw new DomainError(
          "OFFICE_CASH_REASON_REQUIRED",
          `Kas kantor fisik berselisih ${formatRupiah(difference, { signed: true })} dari sistem (${formatRupiah(system)}${cash.laterNet ? `, termasuk mutasi sesudah ${formatTanggal(date, { weekday: false })} ${formatRupiah(cash.laterNet, { signed: true })}` : ""}) — pilih alasan selisih.`,
        );
      }
      if (data.officeCashReason === "other" && (!data.officeCashNote || data.officeCashNote.length < 3)) throw new DomainError("OFFICE_CASH_NOTE_REQUIRED", "Alasan \"Lainnya\" wajib diberi keterangan.");
    }
    let day = await ensureCashDay(tx, ctx.tenantId, date);
    let officeDiscrepancyId: string | null = null;
    if (difference !== 0) {
      const disc = await formDiscrepancy(tx, ctx, {
        tenantId: ctx.tenantId,
        source: "office_cash",
        businessDate: date,
        amount: difference,
        employeeId: ctx.employeeId,
        userId: ctx.userId,
        reason: data.officeCashReason ?? null,
        reasonNote: data.officeCashNote,
        sourceLabel: "Kas kantor",
      });
      officeDiscrepancyId = disc.id;
      // Saldo sistem disamakan dengan uang di laci (selisih tetap di alur Selisih).
      await postOfficeCash(tx, ctx, {
        tenantId: ctx.tenantId,
        businessDate: date,
        kind: "adjustment",
        direction: difference > 0 ? "in" : "out",
        amount: Math.abs(difference),
        sourceObjectType: "discrepancy",
        sourceObjectId: disc.id,
        description: `Selisih hitung fisik kas kantor ${formatTanggal(date, { weekday: false })}`,
      });
    }
    const exceptions = await tx.select().from(cashCloseExceptions).where(and(eq(cashCloseExceptions.cashDayId, day.id), eq(cashCloseExceptions.status, "approved")));
    for (const e of exceptions) {
      if (!e.dueAt) await tx.update(cashCloseExceptions).set({ dueAt: new Date(ctx.now.getTime() + rules.followUpHours * 3_600_000), updatedAt: ctx.now }).where(eq(cashCloseExceptions.id, e.id));
    }
    const lastReceived = await lastReceivedAt(tx, ctx.tenantId, date);
    const late = isAfterCutoff(ctx.now, date, rules.cashCloseTime);
    const closeStartedAt = day.closeStartedAt ?? ctx.now;
    const discs = await discrepanciesOn(tx, ctx.tenantId, date);
    const unmatched = await unmatchedTransfers(tx, ctx.tenantId, date);
    const lateSync = await lateSyncCount(tx, ctx.tenantId, date);
    [day] = (await tx
      .update(cashDays)
      .set({
        status: "closed",
        closedAt: ctx.now,
        closedBy: ctx.userId,
        closedLate: late,
        closeStartedAt,
        lastDepositReceivedAt: lastReceived,
        officeCashSystem: system,
        officeCashPhysical: data.officeCashPhysical,
        officeCashDifference: difference,
        officeCashReason: difference !== 0 ? `${label("discrepancy_reason", data.officeCashReason!)}${data.officeCashNote ? ` — ${data.officeCashNote}` : ""}` : null,
        officeDiscrepancyId,
        blockersSnapshot: exceptions.map((e) => ({ exceptionId: e.id, depositId: e.depositId, outletId: e.outletId, sourceType: e.sourceType, reason: e.reason })),
        updatedAt: ctx.now,
      })
      .where(eq(cashDays.id, day.id))
      .returning()) as [CashDayRow];
    const kpi02Minutes = lastReceived ? Math.max(0, Math.round((ctx.now.getTime() - lastReceived.getTime()) / 60_000)) : null;
    await auditRecord(tx, {
      ctx,
      objectType: "cash_day",
      objectId: day.id,
      action: "close",
      before: { status: "open" },
      after: { status: "closed", closedLate: late, officeCashSystem: system, officeCashThroughDate: cash.throughDate, officeCashLaterNet: cash.laterNet, officeCashPhysical: data.officeCashPhysical, difference, exceptions: exceptions.length, kpi02Minutes },
      reason: data.officeCashNote,
      rule: "US-M4-06, BR-14",
      businessDate: date,
    });
    await emit(
      tx,
      "cash_day.closed",
      {
        cashDayId: day.id,
        closedBy: ctx.userId!,
        late,
        exceptionCount: exceptions.length,
        businessDate: date,
        closedAt: ctx.now.toISOString(),
        closeStartedAt: closeStartedAt.toISOString(),
        lastDepositReceivedAt: lastReceived?.toISOString() ?? null,
        kpi02Minutes,
        officeCashSystem: system,
        officeCashPhysical: data.officeCashPhysical,
        officeCashDifference: difference,
        discrepancyCount: discs.length + (officeDiscrepancyId ? 1 : 0),
        unmatchedTransferCount: unmatched.length,
        lateSyncCount: lateSync,
      },
      { ctx, businessDate: date, objectType: "cash_day", objectId: day.id },
    );
    await notify(tx, {
      event: "cash_day.closed",
      tenantId: ctx.tenantId,
      title: `Kas ${formatTanggal(date, { weekday: false })} ditutup${late ? " (terlambat)" : ""}`,
      body: `Ditutup ${formatTanggalJam(ctx.now)}${kpi02Minutes !== null ? `, ${kpi02Minutes} menit setelah setoran terakhir diterima` : ""}. ${discs.length ? `${discs.length} selisih.` : "Tanpa selisih setoran."}${exceptions.length ? ` ${exceptions.length} setoran tertunda (pengecualian).` : ""} Ringkasan H+0 menyusul.`,
      objectType: "cash_day",
      objectId: day.id,
      link: `/kas/tutup?tanggal=${date}`,
      now: ctx.now,
    });
    return day;
  });
}

/** Riwayat hari kas (KPI-02). */
export async function listCashDays(ctx: ActorContext, filter: { from?: string | null; to?: string | null } = {}, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m4.cash_day.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const to = filter.to ?? ctxBusinessDate(ctx);
  const from = filter.from ?? addDays(to, -30);
  const rows = await tx
    .select()
    .from(cashDays)
    .where(and(eq(cashDays.tenantId, ctx.tenantId), gte(cashDays.businessDate, from), lte(cashDays.businessDate, to)))
    .orderBy(desc(cashDays.businessDate));
  const names = await userNames(tx, rows.map((r) => r.closedBy));
  return rows.map((r) => ({
    ...r,
    closedByName: r.closedBy ? (names.get(r.closedBy)?.name ?? null) : null,
    kpi02Minutes: r.closedAt && r.lastDepositReceivedAt ? Math.max(0, Math.round((r.closedAt.getTime() - r.lastDepositReceivedAt.getTime()) / 60_000)) : null,
    closeDurationMinutes: r.closedAt && r.closeStartedAt ? Math.max(0, Math.round((r.closedAt.getTime() - r.closeStartedAt.getTime()) / 60_000)) : null,
  }));
}

/**
 * Job: setoran tertunda (pengecualian disetujui) yang belum diterima lewat N jam setelah tutup kas → Selisih
 * (sumber "setoran tertunda", sebesar seharusnya) + notifikasi (US-M4-06 KP-2).
 */
export async function runPendingDepositDueCheck(now: Date = new Date(), opts: { db?: Db } = {}): Promise<{ converted: number }> {
  return withTx(
    async (tx) => {
      const due = await tx.select().from(cashCloseExceptions).where(and(eq(cashCloseExceptions.status, "approved"), lte(cashCloseExceptions.dueAt, now)));
      let converted = 0;
      for (const e of due) {
        const ctx = systemContext({ tenantId: e.tenantId, now });
        const dep = e.depositId ? (await tx.select().from(deposits).where(eq(deposits.id, e.depositId)).limit(1))[0] : undefined;
        if (dep && (dep.status === "received" || dep.status === "closed")) {
          await resolveExceptionsForDeposit(tx, ctx, dep.id);
          continue;
        }
        let amount = 0;
        let sourceLabel = label("deposit_source_type", e.sourceType);
        if (dep) {
          const f = await depositFigures(tx, dep);
          const claimedCash = f.expenses.filter((x) => x.fundingSource === "cash_on_hand" && x.status !== "rejected").reduce((s, x) => s + x.amount, 0);
          amount = f.expectedCash - claimedCash;
          sourceLabel = `${(await depositSourceInfo(tx, dep)).label} · ${dep.number}`;
        }
        let discrepancyId: string | null = null;
        if (amount > 0) {
          const disc = await formDiscrepancy(tx, ctx, {
            tenantId: e.tenantId,
            source: "pending_deposit",
            businessDate: e.businessDate,
            amount: -amount,
            depositId: dep?.id ?? null,
            employeeId: e.employeeId ?? dep?.depositorEmployeeId ?? null,
            userId: dep?.depositorUserId ?? null,
            truckId: dep?.truckId ?? null,
            outletId: e.outletId ?? dep?.outletId ?? null,
            shiftId: dep?.shiftId ?? null,
            sourceLabel,
          });
          discrepancyId = disc.id;
        }
        await tx.update(cashCloseExceptions).set({ status: "expired", convertedDiscrepancyId: discrepancyId, updatedAt: now }).where(eq(cashCloseExceptions.id, e.id));
        await auditRecord(tx, { ctx, objectType: "cash_close_exception", objectId: e.id, action: "expire", before: { status: "approved" }, after: { status: "expired", discrepancyId }, rule: "PTB-21, US-M4-06 KP-2", businessDate: e.businessDate });
        await notify(tx, {
          event: "cash_close_exception.overdue",
          tenantId: e.tenantId,
          title: `Setoran tertunda ${sourceLabel} lewat batas — menjadi selisih${amount ? ` ${formatRupiah(-amount, { signed: true })}` : ""}`,
          body: `Pengecualian tutup kas ${formatTanggal(e.businessDate, { weekday: false })}: kas belum diterima. Terima setoran lalu jelaskan selisihnya (US-M4-03).`,
          objectType: "cash_close_exception",
          objectId: e.id,
          valueAmount: amount ? -amount : null,
          link: discrepancyId ? `/kas/selisih?id=${discrepancyId}` : `/kas/tutup?tanggal=${e.businessDate}`,
          groupKey: `cash_close_exception.overdue:${e.id}`,
          now,
        });
        converted++;
      }
      return { converted };
    },
    { db: opts.db },
  );
}

