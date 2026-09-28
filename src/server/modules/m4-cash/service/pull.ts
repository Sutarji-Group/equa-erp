/**
 * M4 — data referensi lapangan milik karyawan sendiri (pull `m4.my_cash`): hasil penerimaan setoran & keputusan
 * selisih (US-M4-02 KP-8, US-M6-02 KP-5) serta saldo ganti rugi karyawan bersangkutan (US-M4-03 KP-3). Hanya data
 * pengguna itu sendiri (lingkup karyawan), tidak pernah data orang lain.
 */
import "server-only";

import { and, desc, eq, gte, max, or } from "drizzle-orm";

import { deposits, discrepancies, restitutions } from "@/db/schema";
import { addDays, toBusinessDate } from "@/lib/time";

import type { MyCashReference } from "@/client/m4-cash/contract";
import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";

export type { MyCashReference } from "@/client/m4-cash/contract";

const HISTORY_DAYS = 30;

export async function buildMyCash(tx: Tx, ctx: ActorContext, since: Date | null, now: Date): Promise<MyCashReference | undefined> {
  const employeeId = ctx.employeeId;
  const userId = ctx.userId;
  if (!userId) return undefined;
  const from = addDays(toBusinessDate(now), -HISTORY_DAYS);
  const depositWhere = and(eq(deposits.tenantId, ctx.tenantId), gte(deposits.businessDate, from), employeeId ? or(eq(deposits.depositorUserId, userId), eq(deposits.depositorEmployeeId, employeeId)) : eq(deposits.depositorUserId, userId));
  if (since) {
    const stamps = await Promise.all([
      tx.select({ m: max(deposits.updatedAt) }).from(deposits).where(depositWhere),
      employeeId ? tx.select({ m: max(restitutions.updatedAt) }).from(restitutions).where(eq(restitutions.employeeId, employeeId)) : Promise.resolve([{ m: null }]),
      employeeId ? tx.select({ m: max(discrepancies.updatedAt) }).from(discrepancies).where(eq(discrepancies.employeeId, employeeId)) : Promise.resolve([{ m: null }]),
    ]);
    const last = Math.max(...stamps.map((s) => (s[0]?.m ? new Date(s[0].m).getTime() : 0)));
    if (last > 0 && last <= since.getTime()) return undefined;
  }
  const deps = await tx.select().from(deposits).where(depositWhere).orderBy(desc(deposits.businessDate)).limit(60);
  const discs = deps.length && employeeId ? await tx.select().from(discrepancies).where(eq(discrepancies.employeeId, employeeId)) : [];
  const rests = employeeId ? await tx.select().from(restitutions).where(eq(restitutions.employeeId, employeeId)).orderBy(desc(restitutions.businessDate)) : [];
  const settled = rests.reduce((s, r) => s + r.settledAmount, 0);
  const recorded = rests.reduce((s, r) => s + r.amount, 0);
  return {
    employeeId,
    restitution: {
      outstanding: recorded - settled,
      recorded,
      settled,
      items: rests.map((r) => ({ id: r.id, businessDate: r.businessDate, amount: r.amount, settledAmount: r.settledAmount, status: r.status, reason: r.reason })),
    },
    deposits: deps.map((d) => {
      const disc = discs.find((x) => x.depositId === d.id);
      return {
        id: d.id,
        number: d.number,
        businessDate: d.businessDate,
        sourceType: d.sourceType,
        status: d.status,
        expectedNet: d.expectedNet,
        receivedAmount: d.receivedAmount,
        discrepancyAmount: d.discrepancyAmount,
        discrepancyReason: d.discrepancyReason,
        receivedAt: d.receivedAt?.toISOString() ?? null,
        closedAt: d.closedAt?.toISOString() ?? null,
        decision: disc?.decision ?? null,
        decisionReason: disc?.decisionReason ?? null,
      };
    }),
  };
}
