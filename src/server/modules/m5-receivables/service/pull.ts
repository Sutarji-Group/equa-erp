/**
 * M5 — data sinkron untuk aplikasi sopir (US-M5-01 KP-3 "tampil di aplikasi sopir (data sinkron)"): status kredit,
 * saldo piutang & eksposur pelanggan rit hari ini pada truk pelaku. Pull `m5.customer_credit` (peran sopir/kernet);
 * `undefined` bila tidak ada perubahan sejak kursor.
 */
import "server-only";

import { and, eq, inArray, isNull, max } from "drizzle-orm";

import { customers, invoices, trips, unbilledCharges } from "@/db/schema";
import type { CreditStatus } from "@/lib/labels";

import { ctxBusinessDate } from "@/server/core/context";
import type { PullContext } from "@/server/core/sync";

import { computeExposure } from "./balance";

export type CustomerCreditRef = {
  customerId: string;
  name: string;
  creditStatus: CreditStatus;
  creditLimit: number;
  /** Saldo piutang = faktur terbuka + belum ditagih. */
  balance: number;
  /** Eksposur (BR-06). */
  exposure: number;
  remaining: number;
  overdue: number;
  onHold: boolean;
};

export type CustomerCreditPull = { date: string; generatedAt: string; customers: CustomerCreditRef[] };

export async function customerCreditPull(pc: PullContext): Promise<CustomerCreditPull | undefined> {
  const { ctx, tx, since } = pc;
  const date = ctxBusinessDate(ctx);
  const truckIds = ctx.scope.truckIds;
  if (!truckIds.length) return { date, generatedAt: pc.now.toISOString(), customers: [] };
  const rows = await tx
    .selectDistinct({ id: trips.customerId })
    .from(trips)
    .where(and(inArray(trips.truckId, truckIds), eq(trips.scheduledDate, date), eq(trips.isInternal, false), isNull(trips.withdrawnAt)));
  const ids = rows.map((r) => r.id);
  if (since && ids.length) {
    const stamps = await Promise.all([
      tx.select({ m: max(invoices.updatedAt) }).from(invoices).where(inArray(invoices.customerId, ids)),
      tx.select({ m: max(customers.updatedAt) }).from(customers).where(inArray(customers.id, ids)),
      tx.select({ m: max(unbilledCharges.updatedAt) }).from(unbilledCharges).where(inArray(unbilledCharges.customerId, ids)),
      tx.select({ m: max(trips.updatedAt) }).from(trips).where(and(inArray(trips.truckId, truckIds), eq(trips.scheduledDate, date))),
    ]);
    const latest = stamps.map((s) => s[0]?.m).filter((d): d is Date => d instanceof Date);
    if (latest.every((d) => d <= since)) return undefined;
  }
  const out: CustomerCreditRef[] = [];
  for (const id of ids) {
    const [c] = await tx.select({ name: customers.name }).from(customers).where(eq(customers.id, id)).limit(1);
    const e = await computeExposure(tx, id, { asOf: date });
    out.push({ customerId: id, name: c?.name ?? "", creditStatus: e.creditStatus, creditLimit: e.creditLimit, balance: e.balance, exposure: e.exposure, remaining: e.remaining, overdue: e.overdue, onHold: e.creditStatus === "on_hold" });
  }
  return { date, generatedAt: pc.now.toISOString(), customers: out.sort((a, b) => a.name.localeCompare(b.name, "id")) };
}
