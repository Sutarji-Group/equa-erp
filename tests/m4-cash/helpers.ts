/**
 * Pembantu uji modul M4 (bukan berkas uji): hari sopir nyata lewat perintah sinkron M3 (rit Selesai tunai/transfer,
 * pengeluaran, Setor) dan shift depot nyata lewat perintah sinkron M6 (buka, jual, tutup), sehingga setoran M4 lahir
 * dari jalur yang sama dengan produksi. Waktu kantor dikendalikan lewat `ctx.now`.
 */
import { and, eq } from "drizzle-orm";
import { expect } from "vitest";

import type { Db } from "@/db/client";
import { deposits, notifications, shifts } from "@/db/schema";
import { newId } from "@/lib/ids";
import { wibToUtc } from "@/lib/time";
import { withNow, type ActorContext } from "@/server/core/context";

import { seededContext } from "../helpers/context";
import { PRICE, completeCash, completePayload, departArrive, driverWorld, expectApplied, type World } from "../m3-driver/helpers";
import { closeVia, isi, openShiftVia, posFor, sellVia, type Pos } from "../m6-pos/helpers";

export { PRICE, driverWorld, expectApplied, departArrive, completeCash, type World };

export const manifest = (o: Partial<Record<"completedTripIds" | "failedTripIds" | "collectionIds" | "expenseIds", string[]>> = {}) => ({
  completedTripIds: [],
  failedTripIds: [],
  collectionIds: [],
  expenseIds: [],
  ...o,
});

/** Waktu kantor pada tanggal bisnis (WIB). */
export function at(date: string, time = "15:00"): Date {
  return wibToUtc(date, time);
}

export const finance = (now?: Date): ActorContext => seededContext("keuangan1", now ? { now } : {});
export const finance2 = (now?: Date): ActorContext => seededContext("keuangan2", now ? { now } : {});
export const owner = (now?: Date): ActorContext => seededContext("pemilik", now ? { now } : {});
export const at15 = (ctx: ActorContext, date: string) => withNow(ctx, at(date));

export type DriverDay = World & { depositId: string; tripIds: string[]; expenseIds: string[] };

/**
 * Sopir menyelesaikan `trips` rit tunai (harga PRICE), opsional pengeluaran rit, lalu Setor (Diajukan).
 * `transferTrips` rit dibayar transfer (dengan bukti).
 */
export async function driverDay(
  db: Db,
  opts: {
    trips?: number;
    transferTrips?: number;
    expenses?: { kind: "fuel" | "toll" | "parking" | "other"; amount: number; fundingSource: "cash_on_hand" | "personal" }[];
    submit?: boolean;
  } = {},
): Promise<DriverDay> {
  const w = await driverWorld(db);
  const tripIds: string[] = [];
  const manifestTrips: string[] = [];
  for (let i = 0; i < (opts.trips ?? 1); i++) {
    const t = await w.addTrip();
    await departArrive(w, t.id);
    expectApplied(await completeCash(w, t.id));
    tripIds.push(t.id);
    manifestTrips.push(t.id);
  }
  for (let i = 0; i < (opts.transferTrips ?? 0); i++) {
    const t = await w.addTrip({ paymentMethod: "cash" });
    await departArrive(w, t.id);
    expectApplied(await w.send(w.sopir, "m3.trip.complete", completePayload(t.id, { payment: { method: "transfer", transferAmount: PRICE } }), { attach: [{ kind: "delivery_photo" }, { kind: "signature" }, { kind: "transfer_proof" }] }));
    tripIds.push(t.id);
    manifestTrips.push(t.id);
  }
  const expenseIds: string[] = [];
  for (const e of opts.expenses ?? []) {
    const expenseId = newId();
    expectApplied(await w.send(w.sopir, "m3.trip_expense.create", { expenseId, tripId: tripIds[0] ?? null, kind: e.kind, amount: e.amount, fundingSource: e.fundingSource }, { attach: [{ kind: "receipt_note" }] }));
    expenseIds.push(expenseId);
  }
  if (opts.submit !== false) {
    expectApplied(await w.send(w.sopir, "m3.deposit.submit", { method: "physical", manifest: manifest({ completedTripIds: manifestTrips, expenseIds }) }));
  }
  const dep = (await db.select().from(deposits).where(and(eq(deposits.depositorUserId, w.driver.userId), eq(deposits.businessDate, w.date))))[0];
  return { ...w, depositId: dep?.id ?? "", tripIds, expenseIds };
}

export type DepotDay = { pos: Pos; shiftId: string; depositId: string; date: string; cashSales: number };

/** Shift depot nyata: buka (kas awal 200.000), `sales` transaksi isi ulang tunai, tutup dengan hitung fisik pas. */
export async function depotDay(db: Db, code: string, opts: { sales?: number; qris?: number; close?: boolean; counted?: number | null; reason?: string | null } = {}): Promise<DepotDay> {
  const pos = await posFor(code);
  const { shiftId, res } = await openShiftVia(pos, { counted: 200_000 });
  expectApplied(res);
  const saleIds: string[] = [];
  const n = opts.sales ?? 4;
  for (let i = 0; i < n; i++) {
    const s = await sellVia(pos, shiftId, [isi(2)], { method: "cash", cashReceived: 10_000 });
    expectApplied(s.res);
    saleIds.push(s.saleId);
  }
  for (let i = 0; i < (opts.qris ?? 0); i++) {
    const s = await sellVia(pos, shiftId, [isi(3)], { method: "qris", qrisReference: `QR-${i}` });
    expectApplied(s.res);
    saleIds.push(s.saleId);
  }
  const cashSales = n * 10_000;
  let depositId = "";
  const date = (await db.select({ d: shifts.businessDate }).from(shifts).where(eq(shifts.id, shiftId)))[0]!.d;
  if (opts.close !== false) {
    const counted = opts.counted ?? 200_000 + cashSales;
    expectApplied(await closeVia(pos, shiftId, { counted, reason: opts.reason ?? null, saleIds }));
    depositId = (await db.select({ id: shifts.depositId }).from(shifts).where(eq(shifts.id, shiftId)))[0]!.id!;
  }
  return { pos, shiftId, depositId, date, cashSales };
}

export async function notificationsOf(db: Db, event: string, objectId?: string) {
  const rows = await db.select().from(notifications).where(eq(notifications.event, event));
  return objectId ? rows.filter((r) => r.objectId === objectId) : rows;
}

export async function depositRow(db: Db, id: string) {
  return (await db.select().from(deposits).where(eq(deposits.id, id)))[0]!;
}

export function expectDomainError(p: Promise<unknown>, re: RegExp) {
  return expect(p).rejects.toThrow(re);
}
