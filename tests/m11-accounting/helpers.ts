/**
 * Pembantu uji modul M11 (bukan berkas uji): konteks peran akuntansi, peristiwa sintetis lewat `emit` (jalur handler
 * yang sama dengan produksi), pembacaan jurnal/baris dengan kode akun, lampiran bukti, periode, dan jurnal manual
 * siap-posting.
 */
import { and, asc, eq, inArray } from "drizzle-orm";

import type { Db } from "@/db/client";
import { accountingPeriods, accounts, journalLines, journalQueue, journals, notifications, outlets, stockCounts } from "@/db/schema";
import { EQUA_TENANT_ID, accountId, truckId } from "@/db/seed";
import { newId } from "@/lib/ids";
import type { ProfitCenter } from "@/lib/labels";
import { lastDayOfMonth, toBusinessDate, wibToUtc } from "@/lib/time";
import type { ActorContext } from "@/server/core/context";
import { withTx } from "@/server/core/db";
import { emit, type DomainEventMap, type DomainEventType } from "@/server/core/events";
import { put } from "@/server/core/storage";
import * as m11 from "@/server/modules/m11-accounting";

import { seededContext } from "../helpers/context";

export const PDF = Buffer.from("%PDF-1.4\n%bukti uji\n");

export const TODAY = toBusinessDate(new Date());
export const THIS_PERIOD = TODAY.slice(0, 7);

/** Waktu kantor pada tanggal bisnis (WIB). */
export function at(date: string, time = "10:00"): Date {
  return wibToUtc(date, time);
}

const ctxAt = (username: string) => (now?: Date | string) =>
  seededContext(username, now ? { now: typeof now === "string" ? at(now) : now } : {});

export const finance = ctxAt("keuangan1");
export const finance2 = ctxAt("keuangan2");
export const owner = ctxAt("pemilik");
export const accountant = ctxAt("akuntan");
export const dispatcher = ctxAt("dispatcher1");
export const sysadmin = ctxAt("admin1");

export const acc = (code: string) => accountId(code);

/** Terbitkan peristiwa domain (handler M11 menjurnal tepat sebelum COMMIT). */
export async function emitEvent<T extends DomainEventType>(type: T, payload: DomainEventMap[T], opts: { businessDate?: string; tenantId?: string } = {}) {
  return withTx((tx) => emit(tx, type, payload, { businessDate: opts.businessDate ?? TODAY, tenantId: opts.tenantId ?? EQUA_TENANT_ID }));
}

/** Payload rit Selesai (air truk). */
export function tripPayload(over: Partial<DomainEventMap["trip.completed"]> = {}): DomainEventMap["trip.completed"] {
  return {
    tripId: newId(),
    orderId: newId(),
    customerId: newId(),
    truckId: truckId("T1"),
    driverUserId: null,
    isInternal: false,
    volumeL: 5000,
    price: 250_000,
    paymentMethod: "cash",
    cashReceived: 250_000,
    transferAmount: 0,
    creditAmount: 0,
    underpaymentAmount: 0,
    completedAt: new Date().toISOString(),
    recordedByOffice: false,
    lateSync: false,
    tripNumber: `R-UJI-${Math.floor(Math.random() * 1e6)}`,
    ...over,
  };
}

export type LineView = { code: string; profitCenter: ProfitCenter; outletId: string | null; debit: number; credit: number };

/** Baris jurnal dengan kode akun, urut nomor baris. */
export async function linesOf(db: Db, journalId: string): Promise<LineView[]> {
  const rows = await db
    .select({ code: accounts.code, profitCenter: journalLines.profitCenter, outletId: journalLines.outletId, debit: journalLines.debit, credit: journalLines.credit })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(eq(journalLines.journalId, journalId))
    .orderBy(asc(journalLines.lineNo));
  return rows;
}

/** Jurnal untuk objek sumber (urut dibuat). */
export async function journalsOfSource(db: Db, type: string, id: string) {
  return db
    .select()
    .from(journals)
    .where(and(eq(journals.sourceObjectType, type), eq(journals.sourceObjectId, id)))
    .orderBy(asc(journals.createdAt));
}

export async function journalOfEvent(db: Db, eventId: string) {
  return (await db.select().from(journals).where(eq(journals.sourceEventId, eventId)))[0] ?? null;
}

export async function queueOfEvent(db: Db, eventId: string) {
  return (await db.select().from(journalQueue).where(eq(journalQueue.domainEventId, eventId)))[0] ?? null;
}

export async function notificationsOf(db: Db, event: string, objectId?: string) {
  const rows = await db.select().from(notifications).where(eq(notifications.event, event));
  return objectId ? rows.filter((r) => r.objectId === objectId) : rows;
}

/** Periode akuntansi (dibuat bila belum ada) dengan status tertentu. */
export async function setPeriod(db: Db, period: string, status: "open" | "closed" | "locked" | "reopened" = "open") {
  const [found] = await db.select().from(accountingPeriods).where(and(eq(accountingPeriods.tenantId, EQUA_TENANT_ID), eq(accountingPeriods.period, period)));
  if (found) {
    const [row] = await db.update(accountingPeriods).set({ status, updatedAt: new Date() }).where(eq(accountingPeriods.id, found.id)).returning();
    return row!;
  }
  const [row] = await db
    .insert(accountingPeriods)
    .values({ tenantId: EQUA_TENANT_ID, period, startDate: `${period}-01`, endDate: lastDayOfMonth(`${period}-01`), status })
    .returning();
  return row!;
}

export async function periodRow(db: Db, period: string) {
  return (await db.select().from(accountingPeriods).where(and(eq(accountingPeriods.tenantId, EQUA_TENANT_ID), eq(accountingPeriods.period, period))))[0] ?? null;
}

/** Lampiran bukti PDF (diunggah Admin Keuangan). */
export async function evidence(ctx: ActorContext = finance()): Promise<string> {
  const row = await withTx((tx) => put(tx, ctx, { blob: PDF, contentType: "application/pdf", kind: "journal_evidence", originalName: "bukti.pdf" }));
  return row.id;
}

/** Baris jurnal dua sisi sederhana. */
export function pair(debitCode: string, creditCode: string, amount: number, pc: { debit?: ProfitCenter; credit?: ProfitCenter; outletId?: string | null } = {}) {
  return [
    { accountId: acc(debitCode), profitCenter: pc.debit ?? "SHARED", outletId: pc.outletId ?? null, debit: amount, credit: 0 },
    { accountId: acc(creditCode), profitCenter: pc.credit ?? "SHARED", outletId: null, debit: 0, credit: amount },
  ] as const;
}

/** Draf jurnal manual + lampiran, lalu ajukan (≤ PAR-20 → terposting; > PAR-20 → Diajukan). */
export async function manualJournal(
  ctx: ActorContext,
  input: Omit<m11.ManualJournalInput, "lines" | "attachmentId"> & { lines: ReturnType<typeof pair> | m11.ManualJournalInput["lines"]; attach?: boolean },
) {
  const { attach, lines, ...rest } = input;
  const attachmentId = attach === false ? null : await evidence(ctx);
  const draft = await m11.createManualJournal(ctx, { ...rest, lines: [...lines], attachmentId });
  const submitted = await m11.submitManualJournal(ctx, { journalId: draft.id });
  return { draft, submitted };
}

export async function journalById(db: Db, id: string) {
  return (await db.select().from(journals).where(eq(journals.id, id)))[0]!;
}

export async function journalsByIds(db: Db, ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(journals).where(inArray(journals.id, ids));
}

/** 'YYYY-MM' ± n bulan. */
export function shiftMonth(period: string, n: number): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/** Selesaikan rekonsiliasi bank & kas periode yang diwajibkan (saldo rekening/fisik = buku + item penyesuai). */
export async function settleReconciliations(periodId: string, ctx: ActorContext = finance()) {
  const view = await m11.reconciliationOverview(ctx, { periodId });
  for (const b of view.bank.filter((x) => x.required && !x.zero)) {
    const items = b.autoItems.reduce((s, i) => s + i.amount, 0);
    await m11.saveBankReconciliation(ctx, { periodId, bankAccountId: b.bankAccountId, statementBalance: b.bookBalance + items });
  }
  for (const c of view.cash.filter((x) => x.required && !x.zero)) {
    await m11.saveCashReconciliation(ctx, { periodId, kind: c.kind, outletId: c.outletId, physicalBalance: c.systemBalance });
  }
  return m11.reconciliationOverview(ctx, { periodId });
}

/** Opname bulanan toko periode selesai (disetujui) — simulasi hasil M7. */
export async function storeCountsDone(db: Db, period: string) {
  const stores = await db.select({ id: outlets.id }).from(outlets).where(and(eq(outlets.tenantId, EQUA_TENANT_ID), eq(outlets.kind, "store")));
  for (const s of stores) {
    await db.insert(stockCounts).values({ tenantId: EQUA_TENANT_ID, outletId: s.id, kind: "monthly_store", periodLabel: period, status: "approved", startedAt: new Date(), decidedAt: new Date() });
  }
}
