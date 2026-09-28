/**
 * Pembantu uji M9 (bukan berkas uji): data sumber ditulis langsung (rit Selesai/Gagal, transaksi POS, faktur &
 * pelunasan, setoran, neraca air, jurnal) pada TANGGAL TETAP agar angka laporan deterministik; alur nyata (sinkron M3/M6
 * + tutup kas M4) dipakai uji terbit H+0.
 */
import { eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import {
  customerPayments,
  invoices,
  orders,
  outlets,
  paymentAllocations,
  posSaleLines,
  posSales,
  shifts,
  tripExpenses,
  trips,
  truckFills,
} from "@/db/schema";
import { EQUA_TENANT_ID, outletId, productId, userIdByUsername } from "@/db/seed";
import { addDays } from "@/lib/time";
import { newId } from "@/lib/ids";
import { wibToUtc } from "@/lib/time";
import { withNow, type ActorContext } from "@/server/core/context";
import { withTx } from "@/server/core/db";
import { postJournal, type JournalLineInput } from "@/server/core/ledger";
import * as m9 from "@/server/modules/m9-reports";

import { seededContext } from "../helpers/context";
import { uniqueSeq } from "../helpers/db-fixtures";
import { createCustomer, createOpenShift, createOrder, createScheduledTrip, createTruck } from "../helpers/fixtures";

export const at = (date: string, time = "15:00") => wibToUtc(date, time);
export const owner = (now?: Date): ActorContext => seededContext("pemilik", now ? { now } : {});
export const finance = (now?: Date): ActorContext => seededContext("keuangan1", now ? { now } : {});
export const accountant = (now?: Date): ActorContext => seededContext("akuntan", now ? { now } : {});
export const dispatcher = (now?: Date): ActorContext => seededContext("dispatcher1", now ? { now } : {});
export const admin = (now?: Date): ActorContext => seededContext("admin1", now ? { now } : {});
export const onDate = (ctx: ActorContext, date: string, time = "21:30") => withNow(ctx, at(date, time));

export type TripOpts = {
  date: string;
  price?: number;
  internal?: boolean;
  status?: "assigned" | "completed" | "failed" | "departed";
  truckId?: string;
  failReason?: "customer_absent" | "customer_refused" | "location_inaccessible" | "truck_broken" | "other";
  driverEmployeeId?: string | null;
  driverUserId?: string | null;
  completedTime?: string;
  lateSync?: boolean;
  recordedByOffice?: boolean;
  published?: boolean;
  destinationOutletId?: string | null;
};

/** Rit (terbit) pada tanggal jadwal, opsional Selesai/Gagal pada tanggal yang sama. */
export async function makeTrip(db: Db, o: TripOpts): Promise<{ id: string; orderId: string; truckId: string; customerId: string; number: string }> {
  const cust = await createCustomer(db, { segment: "hotel" });
  const truckId = o.truckId ?? (await createTruck(db)).id;
  const order = await createOrder(db, { customerId: cust.id, addressId: cust.addressId!, date: o.date, pricePerTrip: o.price ?? 250_000 });
  const trip = await createScheduledTrip(db, { order, truckId, date: o.date, driverEmployeeId: o.driverEmployeeId ?? null });
  const status = o.status ?? "completed";
  const doneAt = at(o.date, o.completedTime ?? "10:00");
  await db
    .update(trips)
    .set({
      status,
      isInternal: !!o.internal,
      destinationOutletId: o.destinationOutletId ?? (o.internal ? outletId("D01") : null),
      publishedAt: o.published === false ? null : at(o.date, "05:00"),
      departedAt: status === "assigned" ? null : at(o.date, "08:00"),
      completedAt: status === "completed" ? doneAt : null,
      failedAt: status === "failed" ? doneAt : null,
      failReason: status === "failed" ? (o.failReason ?? "customer_absent") : null,
      completionBusinessDate: status === "completed" || status === "failed" ? o.date : null,
      deliveredVolumeL: status === "completed" ? 5000 : null,
      driverUserId: o.driverUserId ?? null,
      lateSync: !!o.lateSync,
      recordedByOffice: !!o.recordedByOffice,
    })
    .where(eq(trips.id, trip.id));
  if (o.internal) await db.update(orders).set({ isInternal: true, internalOutletId: outletId("D01") }).where(eq(orders.id, order.id));
  return { id: trip.id, orderId: order.id, truckId, customerId: cust.id, number: trip.number };
}

const shiftCache = new WeakMap<Db, Map<string, string>>();

/** Transaksi POS (dihitung) pada outlet & tanggal; `gallons` > 0 → baris isi ulang bergalon 19 L. */
export async function makeSale(
  db: Db,
  o: { outletCode?: string; outletId?: string; date: string; total: number; gallons?: number; status?: "valid" | "voided" | "void_pending" | "pending_approval"; lateSync?: boolean; recordedByOffice?: boolean; operatorUserId?: string },
): Promise<string> {
  const oid = o.outletId ?? outletId(o.outletCode ?? "D01");
  const key = `${oid}|${o.date}`;
  const cache = shiftCache.get(db) ?? new Map<string, string>();
  shiftCache.set(db, cache);
  let shiftId = cache.get(key);
  if (!shiftId) {
    shiftId = (await createOpenShift(db, { outletId: oid, date: o.date, operatorUserId: o.operatorUserId ?? userIdByUsername("depot01"), openedAt: at(o.date, "06:00") })).shiftId;
    await db.update(shifts).set({ status: "closed", closedAt: at(o.date, "20:00") }).where(eq(shifts.id, shiftId));
    cache.set(key, shiftId);
  }
  const n = uniqueSeq();
  const id = newId();
  await db.insert(posSales).values({
    id,
    tenantId: EQUA_TENANT_ID,
    outletId: oid,
    shiftId,
    number: `UJ-${n}`,
    localNumber: `L-${n}`,
    deviceSeq: n,
    operatorUserId: o.operatorUserId ?? userIdByUsername("depot01"),
    priceKind: "standard",
    businessDate: o.date,
    soldAt: at(o.date, "09:00"),
    subtotal: o.total,
    total: o.total,
    paymentMethod: "cash",
    status: o.status ?? "valid",
    lateSync: !!o.lateSync,
    recordedByOffice: !!o.recordedByOffice,
    voidRequestedAt: o.status === "voided" || o.status === "void_pending" ? at(o.date, "11:00") : null,
  });
  await db.insert(posSaleLines).values({
    posSaleId: id,
    tenantId: EQUA_TENANT_ID,
    outletId: oid,
    businessDate: o.date,
    lineNo: 1,
    productId: productId("ISI-ULANG"),
    quantity: o.gallons && o.gallons > 0 ? o.gallons : 1,
    unitPrice: o.gallons && o.gallons > 0 ? Math.round(o.total / o.gallons) : o.total,
    lineTotal: o.total,
    gallonSizeL: o.gallons && o.gallons > 0 ? 19 : null,
  });
  return id;
}

/** Outlet toko uji baru (tanpa data demo). */
export async function makeStoreOutlet(db: Db): Promise<string> {
  const id = newId();
  const code = `TX${uniqueSeq()}`.slice(0, 8);
  await db.insert(outlets).values({ id, tenantId: EQUA_TENANT_ID, code, name: `Toko uji ${code}`, kind: "store", address: "Jl. Uji", isActive: true });
  return id;
}

/** Faktur terbuka (tanpa alokasi) untuk pelanggan baru. */
export async function makeInvoice(db: Db, o: { issueDate: string; dueDate: string; amount: number; kind?: "delivery" | "underpayment" | "store_sale" | "monthly" | "opening_balance"; customerId?: string }): Promise<{ id: string; customerId: string }> {
  const customerId = o.customerId ?? (await createCustomer(db, { segment: "hotel", creditStatus: "credit", creditLimit: 10_000_000 })).id;
  const [row] = await db
    .insert(invoices)
    .values({
      tenantId: EQUA_TENANT_ID,
      number: `F-UJ-${uniqueSeq()}`,
      kind: o.kind ?? "delivery",
      customerId,
      issueDate: o.issueDate,
      dueDate: o.dueDate,
      amount: o.amount,
      outstandingAmount: o.amount,
    })
    .returning({ id: invoices.id });
  return { id: row!.id, customerId };
}

/** Pelunasan dialokasikan ke faktur pada waktu tertentu (sisa faktur ikut diperbarui seperti M5). */
export async function payInvoice(db: Db, o: { invoiceId: string; customerId: string; amount: number; date: string }): Promise<void> {
  const [pay] = await db
    .insert(customerPayments)
    .values({ tenantId: EQUA_TENANT_ID, customerId: o.customerId, channel: "office", method: "cash", amount: o.amount, businessDate: o.date })
    .returning({ id: customerPayments.id });
  await db.insert(paymentAllocations).values({ invoiceId: o.invoiceId, customerPaymentId: pay!.id, amount: o.amount, allocatedAt: at(o.date, "11:00") });
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, o.invoiceId));
  const paid = inv!.paidAmount + o.amount;
  await db
    .update(invoices)
    .set({ paidAmount: paid, outstandingAmount: inv!.amount - paid - inv!.creditedAmount - inv!.writtenOffAmount, status: paid >= inv!.amount ? "paid" : "partial" })
    .where(eq(invoices.id, o.invoiceId));
}

/** Jurnal terposting (M11 aktif) lewat buku besar inti — sumber laporan bulanan (US-M9-02). */
export async function postJ(o: {
  date: string;
  lines: [string, number, number, { pc?: "L1" | "L2" | "L3" | "L4" | "L5" | "SHARED"; waterSourceId?: string }?][];
  kind?: "auto" | "manual";
  sourceObject?: { type: string; id: string } | null;
  description?: string;
}): Promise<{ journalId: string; periodId: string; period: string; originPeriod: string | null }> {
  const lines: JournalLineInput[] = o.lines.map(([accountCode, debit, credit, extra]) => ({
    accountCode,
    debit: debit || undefined,
    credit: credit || undefined,
    profitCenter: extra?.pc ?? null,
    waterSourceId: extra?.waterSourceId ?? null,
  }));
  const res = await withTx((tx) =>
    postJournal(tx, { tenantId: EQUA_TENANT_ID, date: o.date, source: o.kind === "manual" ? "manual" : "uji.m9", description: o.description ?? "Jurnal uji M9", kind: o.kind ?? "auto", sourceObject: o.sourceObject ?? null, lines }),
  );
  if (res.status !== "posted") throw new Error(`Jurnal uji tidak terposting: ${JSON.stringify(res)}`);
  return res;
}

/** Pengisian truk historis (liter pengisian M8 — pembagi biaya air per liter). */
export async function makeFill(db: Db, o: { sourceId: string; truckId: string; date: string; volumeL: number }): Promise<void> {
  await db.insert(truckFills).values({ tenantId: EQUA_TENANT_ID, waterSourceId: o.sourceId, truckId: o.truckId, businessDate: o.date, volumeL: o.volumeL, filledAt: at(o.date, "07:00"), status: "unlinked" });
}

/** Pengeluaran rit diterima (M3) — biaya yang sudah tercatat saat M11 belum aktif. */
export async function makeTripExpense(db: Db, o: { truckId: string; date: string; amount: number; tripId?: string | null }): Promise<void> {
  await db.insert(tripExpenses).values({ tenantId: EQUA_TENANT_ID, truckId: o.truckId, tripId: o.tripId ?? null, businessDate: o.date, kind: "fuel", amount: o.amount, fundingSource: "cash_on_hand", status: "accepted" });
}

/**
 * Periode paralel truk baru mulai `start`: lembar pencocokan `days` hari cocok (0 nota = 0 rit), lalu Admin Keuangan
 * mengajukan tarik nota kertas lebih awal pada hari ke-(days+1) → persetujuan `paper_withdrawal_early` (PAR-84).
 */
export async function earlyWithdrawalRequest(db: Db, o: { start: string; days?: number; truckId?: string }): Promise<{ withdrawalId: string; approvalId: string; truckId: string; withdrawnDate: string }> {
  const truckId = o.truckId ?? (await createTruck(db)).id;
  const days = o.days ?? 5;
  const w = await m9.startParallelPeriod(finance(at(o.start, "07:00")), { unitType: "truck", truckId, parallelStartDate: o.start });
  for (let i = 0; i < days; i++) {
    const d = addDays(o.start, i);
    await m9.recordParallelCheck(finance(at(d, "20:00")), { unitType: "truck", truckId, businessDate: d, paperCount: 0, paperAmount: 0 });
  }
  const withdrawnDate = addDays(o.start, days);
  const res = await m9.withdrawPaper(finance(at(withdrawnDate, "08:00")), { withdrawalId: w.id, withdrawnDate });
  if (res.status !== "pending_approval") throw new Error("Pengajuan tarik lebih awal tidak terbentuk");
  return { withdrawalId: w.id, approvalId: res.approvalId!, truckId, withdrawnDate };
}
