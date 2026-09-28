/**
 * M4 — ganti rugi karyawan (BR-11; US-M4-03 KP-2/KP-3/KP-4; PTB-22): tercatat per kejadian saat selisih kurang
 * Ditolak pemilik dan flag `cash.restitution_active` aktif. Sistem TIDAK memotong gaji — hanya rekap bulanan per
 * karyawan untuk penggajian (ekspor Excel/PDF) dan pelunasan yang dicatat Admin Keuangan (setor tunai → kas kantor,
 * atau konfirmasi potongan dari penggajian). Saldo terlihat pemilik & karyawan bersangkutan (pull `m4.my_cash`).
 */
import "server-only";

import { and, asc, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";

import { discrepancies, employees, restitutionSettlements, restitutions } from "@/db/schema";
import { formatRupiah } from "@/lib/money";
import { firstDayOfMonth, lastDayOfMonth, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { markActionedForObject } from "@/server/core/notifications";
import { authorize, runService, sod } from "@/server/core/rbac";

import { reverseSettlementSchema, settleRestitutionSchema } from "../schemas";
import { assertCashDayOpen, cashRules, officeCashOf, postOfficeCash, userIdOfEmployee } from "./common";

export type RestitutionRow = typeof restitutions.$inferSelect;
export type RestitutionSettlementRow = typeof restitutionSettlements.$inferSelect;

function statusFor(amount: number, settled: number): RestitutionRow["status"] {
  if (settled <= 0) return "recorded";
  return settled >= amount ? "settled" : "partially_settled";
}

/** Pelunasan ganti rugi (US-M4-03 KP-3): setor tunai (kas kantor bertambah) atau konfirmasi potongan penggajian. */
export async function settleRestitution(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<{ restitution: RestitutionRow; settlement: RestitutionSettlementRow }> {
  await authorize(ctx, "m4.restitution.settle", { tx: opts.tx, objectType: "restitution" });
  const data = parseInput(settleRestitutionSchema, input, { amount: "Jumlah", method: "Cara pelunasan", settledOn: "Tanggal" });
  return runService(ctx, opts, async (tx) => {
    const rest = (await tx.select().from(restitutions).where(eq(restitutions.id, data.restitutionId)).for("update").limit(1))[0];
    if (!rest || rest.tenantId !== ctx.tenantId) throw new NotFoundError("Ganti rugi tidak ditemukan.");
    // SOD-01: karyawan yang bersangkutan tidak mencatat pelunasannya sendiri.
    sod.assertNotSelf(await userIdOfEmployee(tx, rest.employeeId), ctx.userId, "pelunasan ganti rugi", { objectType: "restitution", objectId: rest.id });
    const outstanding = rest.amount - rest.settledAmount;
    if (outstanding <= 0) throw new DomainError("RESTITUTION_SETTLED", "Ganti rugi ini sudah lunas.");
    if (data.amount > outstanding) throw new DomainError("OVER_SETTLEMENT", `Pelunasan ${formatRupiah(data.amount)} melebihi sisa ganti rugi ${formatRupiah(outstanding)}.`);
    const date = data.settledOn ?? ctxBusinessDate(ctx);
    if (data.method === "cash") await assertCashDayOpen(tx, ctx.tenantId, date, "pelunasan ganti rugi tunai");
    const [settlement] = await tx
      .insert(restitutionSettlements)
      .values({ restitutionId: rest.id, amount: data.amount, method: data.method, settledOn: date, reference: data.reference, createdBy: ctx.userId })
      .returning();
    if (data.method === "cash") {
      const mv = await postOfficeCash(tx, ctx, {
        tenantId: rest.tenantId,
        businessDate: date,
        kind: "restitution_payment",
        direction: "in",
        amount: data.amount,
        sourceObjectType: "restitution_settlement",
        sourceObjectId: settlement!.id,
        description: "Pelunasan ganti rugi karyawan (setor tunai)",
      });
      if (mv) await tx.update(restitutionSettlements).set({ officeCashMovementId: mv.id, updatedAt: ctx.now }).where(eq(restitutionSettlements.id, settlement!.id));
    }
    const settled = rest.settledAmount + data.amount;
    const status = statusFor(rest.amount, settled);
    const [updated] = await tx
      .update(restitutions)
      .set({ settledAmount: settled, status, settledAt: status === "settled" ? ctx.now : rest.settledAt, updatedAt: ctx.now })
      .where(eq(restitutions.id, rest.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "restitution", objectId: rest.id, action: "settle", before: { settledAmount: rest.settledAmount, status: rest.status }, after: { settledAmount: settled, status, method: data.method }, reason: data.reference, rule: "PTB-22", businessDate: date });
    await emit(
      tx,
      "restitution.settled",
      { restitutionId: rest.id, employeeId: rest.employeeId, amount: data.amount, method: data.method, settlementId: settlement!.id, settledOn: date, fullySettled: status === "settled" },
      { ctx, businessDate: date, objectType: "restitution", objectId: rest.id },
    );
    // Ganti rugi lunas → tindak lanjut selisihnya Selesai.
    if (status === "settled" && rest.discrepancyId) {
      const done = await tx
        .update(discrepancies)
        .set({ status: "done", doneAt: ctx.now, followUpNote: "Ganti rugi lunas", followedUpBy: ctx.userId, updatedAt: ctx.now })
        .where(and(eq(discrepancies.id, rest.discrepancyId), eq(discrepancies.status, "followed_up")))
        .returning({ id: discrepancies.id });
      if (done[0]) {
        await auditRecord(tx, { ctx, objectType: "discrepancy", objectId: rest.discrepancyId, action: "follow_up", before: { status: "followed_up" }, after: { status: "done" }, reason: "Ganti rugi lunas", rule: "US-M4-03 KP-3" });
        await markActionedForObject(tx, { objectType: "discrepancy", objectId: rest.discrepancyId, now: ctx.now });
      }
    }
    return { restitution: updated!, settlement: settlement! };
  });
}

/** Terapkan pembalik pelunasan (langsung ≤ PAR-21 atau lewat persetujuan koreksi). */
export async function applySettlementReversal(tx: Tx, ctx: ActorContext, settlementId: string, reason: string): Promise<RestitutionSettlementRow> {
  const s = (await tx.select().from(restitutionSettlements).where(eq(restitutionSettlements.id, settlementId)).for("update").limit(1))[0];
  if (!s || s.reversalOfId) throw new NotFoundError("Pelunasan ganti rugi tidak ditemukan.");
  const already = await tx.select({ id: restitutionSettlements.id }).from(restitutionSettlements).where(eq(restitutionSettlements.reversalOfId, s.id)).limit(1);
  if (already[0]) throw new DomainError("ALREADY_REVERSED", "Pelunasan ini sudah dibalik.");
  const rest = (await tx.select().from(restitutions).where(eq(restitutions.id, s.restitutionId)).for("update").limit(1))[0]!;
  const date = ctxBusinessDate(ctx);
  const [rev] = await tx
    .insert(restitutionSettlements)
    .values({ restitutionId: s.restitutionId, amount: -s.amount, method: s.method, settledOn: date, reference: `Pembalik: ${reason}`, reversalOfId: s.id, createdBy: ctx.userId })
    .returning();
  if (s.method === "cash") {
    const orig = (await officeCashOf(tx, "restitution_settlement", s.id))[0];
    await postOfficeCash(tx, ctx, {
      tenantId: rest.tenantId,
      businessDate: date,
      kind: "restitution_payment",
      direction: "out",
      amount: s.amount,
      sourceObjectType: "restitution_settlement",
      sourceObjectId: rev!.id,
      description: `Pembalik pelunasan ganti rugi: ${reason}`,
      reversalOfId: orig?.id ?? null,
    });
  }
  const settled = rest.settledAmount - s.amount;
  await tx.update(restitutions).set({ settledAmount: settled, status: statusFor(rest.amount, settled), settledAt: null, updatedAt: ctx.now }).where(eq(restitutions.id, rest.id));
  await auditRecord(tx, { ctx, objectType: "restitution", objectId: rest.id, action: "reverse", after: { settlementId: s.id, reversalId: rev!.id, amount: -s.amount }, reason, rule: "BR-38" });
  await emit(
    tx,
    "restitution.settlement_reversed",
    { settlementId: s.id, reversalId: rev!.id, restitutionId: rest.id, employeeId: rest.employeeId, amount: s.amount, method: s.method, reason },
    { ctx, tenantId: rest.tenantId, businessDate: date, objectType: "restitution", objectId: rest.id },
  );
  return rev!;
}

/** Balik pelunasan ganti rugi yang keliru (BR-38: > PAR-21 → persetujuan koreksi pemilik). */
export async function reverseRestitutionSettlement(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<{ status: "reversed" | "pending_approval"; approvalId?: string }> {
  await authorize(ctx, "m4.restitution.settle", { tx: opts.tx, objectType: "restitution_settlement" });
  const data = parseInput(reverseSettlementSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const s = (await tx.select({ s: restitutionSettlements, tenantId: restitutions.tenantId }).from(restitutionSettlements).innerJoin(restitutions, eq(restitutions.id, restitutionSettlements.restitutionId)).where(eq(restitutionSettlements.id, data.settlementId)).limit(1))[0];
    if (!s || s.tenantId !== ctx.tenantId || s.s.reversalOfId) throw new NotFoundError("Pelunasan ganti rugi tidak ditemukan.");
    const rules = await cashRules(tx, ctxBusinessDate(ctx), ctx.tenantId);
    if (s.s.amount > rules.correctionApprovalAbove) {
      const req = await approvals.submit(
        ctx,
        {
          type: "correction",
          objectType: "restitution_settlement",
          objectId: s.s.id,
          amount: s.s.amount,
          reason: `Pembalik pelunasan ganti rugi ${formatRupiah(s.s.amount)}: ${data.reason}`,
          payload: { link: "/kas/ganti-rugi", reason: data.reason },
        },
        { tx },
      );
      return { status: "pending_approval" as const, approvalId: req.id };
    }
    await applySettlementReversal(tx, ctx, s.s.id, data.reason);
    return { status: "reversed" as const };
  });
}

// =====================================================================================================================
// Daftar, saldo, rekap bulanan (US-M4-03 KP-3)
// =====================================================================================================================

export type RestitutionListRow = RestitutionRow & { employeeName: string; employeeNo: string; outstanding: number; settlements: RestitutionSettlementRow[] };

export async function listRestitutions(ctx: ActorContext, filter: { employeeId?: string | null; view?: "open" | "all" } = {}, opts: { tx?: Tx } = {}): Promise<RestitutionListRow[]> {
  await authorize(ctx, "m4.restitution.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const conds = [eq(restitutions.tenantId, ctx.tenantId)];
  if (filter.employeeId) conds.push(eq(restitutions.employeeId, filter.employeeId));
  if ((filter.view ?? "open") === "open") conds.push(ne(restitutions.status, "settled"));
  const rows = await tx
    .select({ r: restitutions, name: employees.fullName, no: employees.employeeNo })
    .from(restitutions)
    .innerJoin(employees, eq(employees.id, restitutions.employeeId))
    .where(and(...conds))
    .orderBy(desc(restitutions.businessDate))
    .limit(1000);
  const ids = rows.map((r) => r.r.id);
  const settlements = ids.length ? await tx.select().from(restitutionSettlements).where(inArray(restitutionSettlements.restitutionId, ids)).orderBy(asc(restitutionSettlements.createdAt)) : [];
  return rows.map(({ r, name, no }) => ({ ...r, employeeName: name, employeeNo: no, outstanding: r.amount - r.settledAmount, settlements: settlements.filter((s) => s.restitutionId === r.id) }));
}

export type RestitutionBalance = { employeeId: string; employeeName: string; employeeNo: string; recorded: number; settled: number; outstanding: number; count: number };

/** Saldo ganti rugi per karyawan (pemilik & Admin Keuangan). */
export async function restitutionBalances(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<RestitutionBalance[]> {
  await authorize(ctx, "m4.restitution.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  return balancesOf(tx, ctx.tenantId);
}

export async function balancesOf(tx: Tx, tenantId: string, employeeId?: string | null): Promise<RestitutionBalance[]> {
  const conds = [eq(restitutions.tenantId, tenantId)];
  if (employeeId) conds.push(eq(restitutions.employeeId, employeeId));
  const rows = await tx
    .select({
      employeeId: restitutions.employeeId,
      employeeName: employees.fullName,
      employeeNo: employees.employeeNo,
      recorded: sql<string>`sum(${restitutions.amount})`,
      settled: sql<string>`sum(${restitutions.settledAmount})`,
      count: sql<number>`count(*)::int`,
    })
    .from(restitutions)
    .innerJoin(employees, eq(employees.id, restitutions.employeeId))
    .where(and(...conds))
    .groupBy(restitutions.employeeId, employees.fullName, employees.employeeNo)
    .orderBy(asc(employees.fullName));
  return rows.map((r) => ({ employeeId: r.employeeId, employeeName: r.employeeName, employeeNo: r.employeeNo, recorded: Number(r.recorded), settled: Number(r.settled), outstanding: Number(r.recorded) - Number(r.settled), count: Number(r.count) }));
}

export type RestitutionRecapRow = {
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  month: string;
  incidents: number;
  recorded: number;
  settledCash: number;
  settledPayroll: number;
  outstandingEndOfMonth: number;
  details: string;
};

/** Rekap bulanan ganti rugi per karyawan untuk penggajian (US-M4-03 KP-3; diekspor Excel/PDF). */
export async function restitutionMonthlyRecap(ctx: ActorContext, filter: { month: string }, opts: { tx?: Tx } = {}): Promise<RestitutionRecapRow[]> {
  await authorize(ctx, "m4.restitution.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const from: BusinessDate = firstDayOfMonth(`${filter.month}-01`);
  const to: BusinessDate = lastDayOfMonth(from);
  const recs = await tx
    .select({ r: restitutions, name: employees.fullName, no: employees.employeeNo })
    .from(restitutions)
    .innerJoin(employees, eq(employees.id, restitutions.employeeId))
    .where(and(eq(restitutions.tenantId, ctx.tenantId), lte(restitutions.businessDate, to)));
  const ids = recs.map((r) => r.r.id);
  const setts = ids.length ? await tx.select().from(restitutionSettlements).where(and(inArray(restitutionSettlements.restitutionId, ids), lte(restitutionSettlements.settledOn, to))) : [];
  const byEmp = new Map<string, RestitutionRecapRow>();
  for (const { r, name, no } of recs) {
    const cur = byEmp.get(r.employeeId) ?? { employeeId: r.employeeId, employeeNo: no, employeeName: name, month: filter.month, incidents: 0, recorded: 0, settledCash: 0, settledPayroll: 0, outstandingEndOfMonth: 0, details: "" };
    const mySetts = setts.filter((s) => s.restitutionId === r.id);
    const settledToEnd = mySetts.reduce((s, x) => s + x.amount, 0);
    cur.outstandingEndOfMonth += r.amount - settledToEnd;
    if (r.businessDate >= from) {
      cur.incidents++;
      cur.recorded += r.amount;
      cur.details += `${cur.details ? "; " : ""}${r.businessDate} ${formatRupiah(r.amount)}`;
    }
    for (const s of mySetts.filter((x) => x.settledOn >= from)) {
      if (s.method === "cash") cur.settledCash += s.amount;
      else cur.settledPayroll += s.amount;
    }
    byEmp.set(r.employeeId, cur);
  }
  return [...byEmp.values()].filter((r) => r.incidents || r.settledCash || r.settledPayroll || r.outstandingEndOfMonth).sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}


