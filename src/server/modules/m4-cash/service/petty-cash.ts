/**
 * M4 — kas kecil (US-M4-05 KP-2, S): pengisian dari kas kantor; pengeluaran berkategori + pusat laba + foto bukti;
 * pengisian/pengeluaran > PAR-43 perlu persetujuan pemilik (6.2a `petty_cash`, bila ditolak "tidak berlaku");
 * rekonsiliasi fisik mingguan dengan selisih beralasan (selisih mengikuti alur Selisih, saldo disesuaikan).
 * Semua mutasi memancarkan `petty_cash.recorded` (jurnal M11 dengan pusat laba).
 */
import "server-only";

import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import { pettyCashCounts, pettyCashTransactions } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, daysBetween, formatTanggal, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { authorize, runService } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";

import { pettyCashCountSchema, pettyCashSchema } from "../schemas";
import { assertCashDayOpen, assertNotFuture, cashRules, officeCashBalance, postOfficeCash } from "./common";
import { formDiscrepancy } from "./discrepancies";

export type PettyCashRow = typeof pettyCashTransactions.$inferSelect;

/** Saldo kas kecil = Σ pengisian − Σ pengeluaran (berlaku) + Σ selisih hitung fisik (penyesuaian). */
export async function pettyCashBalance(tx: Tx, tenantId: string, upTo: BusinessDate): Promise<number> {
  const [t] = await tx
    .select({ v: sql<string>`coalesce(sum(case when ${pettyCashTransactions.kind} = 'topup' then ${pettyCashTransactions.amount} else -${pettyCashTransactions.amount} end), 0)` })
    .from(pettyCashTransactions)
    .where(and(eq(pettyCashTransactions.tenantId, tenantId), eq(pettyCashTransactions.status, "approved"), lte(pettyCashTransactions.businessDate, upTo)));
  const [c] = await tx
    .select({ v: sql<string>`coalesce(sum(${pettyCashCounts.difference}), 0)` })
    .from(pettyCashCounts)
    .where(and(eq(pettyCashCounts.tenantId, tenantId), lte(pettyCashCounts.countDate, upTo)));
  return Number(t?.v ?? 0) + Number(c?.v ?? 0);
}

/** Terapkan transaksi kas kecil yang berlaku: pengisian mengurangi kas kantor; event jurnal M11. */
export async function applyPettyCash(tx: Tx, ctx: ActorContext, row: PettyCashRow): Promise<void> {
  let movementId: string | null = null;
  if (row.kind === "topup") {
    const mv = await postOfficeCash(tx, ctx, {
      tenantId: row.tenantId,
      businessDate: row.businessDate,
      kind: "petty_cash_topup",
      direction: "out",
      amount: row.amount,
      sourceObjectType: "petty_cash_transaction",
      sourceObjectId: row.id,
      description: `Pengisian kas kecil: ${row.description ?? ""}`.trim(),
    });
    movementId = mv?.id ?? null;
    if (movementId) await tx.update(pettyCashTransactions).set({ officeCashMovementId: movementId, updatedAt: ctx.now }).where(eq(pettyCashTransactions.id, row.id));
  }
  await emit(
    tx,
    "petty_cash.recorded",
    {
      pettyCashTransactionId: row.id,
      kind: row.kind,
      amount: row.amount,
      category: row.category,
      profitCenter: row.profitCenter,
      businessDate: row.businessDate,
      outletId: row.outletId,
      description: row.description,
      approvalId: row.approvalRequestId,
    },
    { ctx, tenantId: row.tenantId, businessDate: row.businessDate, objectType: "petty_cash_transaction", objectId: row.id },
  );
}

/** Catat pengisian/pengeluaran kas kecil (US-M4-05 KP-2). */
export async function recordPettyCash(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<PettyCashRow> {
  await authorize(ctx, "m4.petty_cash.create", { tx: opts.tx });
  const data = parseInput(pettyCashSchema, input, { kind: "Jenis", amount: "Jumlah", category: "Kategori", profitCenter: "Pusat laba", description: "Uraian", receiptAttachmentId: "Foto bukti" });
  if (data.kind === "expense") {
    if (!data.category) throw new DomainError("CATEGORY_REQUIRED", "Pilih kategori pengeluaran kas kecil.");
    if (!data.profitCenter) throw new DomainError("PROFIT_CENTER_REQUIRED", "Pilih pusat laba pengeluaran.");
    if (!data.receiptAttachmentId) throw new DomainError("RECEIPT_REQUIRED", "Foto bukti pengeluaran wajib dilampirkan.");
  }
  return runService(ctx, opts, async (tx) => {
    const today = ctxBusinessDate(ctx);
    const date = data.businessDate ?? today;
    assertNotFuture(date, today);
    await assertCashDayOpen(tx, ctx.tenantId, date, "kas kecil");
    const rules = await cashRules(tx, date, ctx.tenantId);
    if (data.kind === "topup") {
      const office = await officeCashBalance(tx, ctx.tenantId, date);
      if (data.amount > office) throw new DomainError("INSUFFICIENT_OFFICE_CASH", `Pengisian ${formatRupiah(data.amount)} melebihi saldo kas kantor (${formatRupiah(office)}).`);
    } else {
      const petty = await pettyCashBalance(tx, ctx.tenantId, date);
      if (data.amount > petty) throw new DomainError("INSUFFICIENT_PETTY_CASH", `Pengeluaran ${formatRupiah(data.amount)} melebihi saldo kas kecil (${formatRupiah(petty)}). Isi kas kecil dulu.`);
    }
    const needsApproval = data.amount > rules.pettyCashApprovalAbove;
    const [row] = await tx
      .insert(pettyCashTransactions)
      .values({
        tenantId: ctx.tenantId,
        businessDate: date,
        kind: data.kind,
        amount: data.amount,
        category: data.kind === "expense" ? (data.category ?? null) : null,
        profitCenter: data.kind === "expense" ? (data.profitCenter ?? null) : null,
        outletId: data.outletId ?? null,
        description: data.description,
        receiptAttachmentId: data.receiptAttachmentId ?? null,
        status: needsApproval ? "pending_approval" : "approved",
        createdBy: ctx.userId,
      })
      .returning();
    let tr = row!;
    if (data.receiptAttachmentId) await linkAttachment(tx, data.receiptAttachmentId, { type: "petty_cash_transaction", id: tr.id });
    await auditRecord(tx, {
      ctx,
      objectType: "petty_cash_transaction",
      objectId: tr.id,
      action: "create",
      after: { kind: tr.kind, amount: tr.amount, category: tr.category, profitCenter: tr.profitCenter, status: tr.status },
      reason: data.description,
      rule: needsApproval ? "PAR-43, 6.2a" : "US-M4-05 KP-2",
      businessDate: date,
    });
    if (needsApproval) {
      const req = await approvals.submit(
        ctx,
        {
          type: "petty_cash",
          objectType: "petty_cash_transaction",
          objectId: tr.id,
          amount: tr.amount,
          reason: `${label("petty_cash_kind", tr.kind)} kas kecil ${formatRupiah(tr.amount)}${tr.category ? ` (${label("petty_cash_category", tr.category as never)})` : ""}: ${tr.description}`,
          businessDate: date,
          payload: { link: "/kas/kas-kecil", kind: tr.kind, category: tr.category, profitCenter: tr.profitCenter },
        },
        { tx },
      );
      [tr] = (await tx.update(pettyCashTransactions).set({ approvalRequestId: req.id, updatedAt: ctx.now }).where(eq(pettyCashTransactions.id, tr.id)).returning()) as [PettyCashRow];
    } else {
      await applyPettyCash(tx, ctx, tr);
    }
    return tr;
  });
}

/** Keputusan persetujuan kas kecil (handler `petty_cash`). */
export async function decidePettyCash(tx: Tx, ctx: ActorContext, id: string, approved: boolean): Promise<Record<string, unknown>> {
  const row = (await tx.select().from(pettyCashTransactions).where(eq(pettyCashTransactions.id, id)).for("update").limit(1))[0];
  if (!row) throw new NotFoundError("Transaksi kas kecil tidak ditemukan.");
  if (row.status !== "pending_approval") return { status: row.status };
  if (approved) {
    const date = ctxBusinessDate(ctx);
    // Transaksi berlaku pada hari keputusan bila hari pengajuannya sudah ditutup.
    const [updated] = await tx.update(pettyCashTransactions).set({ status: "approved", updatedAt: ctx.now }).where(eq(pettyCashTransactions.id, row.id)).returning();
    await auditRecord(tx, { ctx, objectType: "petty_cash_transaction", objectId: row.id, action: "approve", before: { status: "pending_approval" }, after: { status: "approved" }, rule: "6.2a", businessDate: row.businessDate });
    await applyPettyCash(tx, ctx, updated!);
    return { status: "approved", appliedOn: date };
  }
  await tx.update(pettyCashTransactions).set({ status: "rejected", updatedAt: ctx.now }).where(eq(pettyCashTransactions.id, row.id));
  await auditRecord(tx, { ctx, objectType: "petty_cash_transaction", objectId: row.id, action: "reject", before: { status: "pending_approval" }, after: { status: "rejected" }, rule: "6.2a", businessDate: row.businessDate });
  return { status: "rejected" };
}

/** Rekonsiliasi fisik kas kecil (mingguan): selisih ≠ 0 wajib alasan → objek Selisih + saldo disesuaikan. */
export async function countPettyCash(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m4.petty_cash.count", { tx: opts.tx });
  const data = parseInput(pettyCashCountSchema, input, { physicalAmount: "Hitung fisik", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const today = ctxBusinessDate(ctx);
    const date = data.countDate ?? today;
    assertNotFuture(date, today);
    await assertCashDayOpen(tx, ctx.tenantId, date, "hitung fisik kas kecil");
    const systemBalance = await pettyCashBalance(tx, ctx.tenantId, date);
    const difference = data.physicalAmount - systemBalance;
    if (difference !== 0 && (!data.reason || data.reason.length < 3)) {
      throw new DomainError("REASON_REQUIRED", `Hitung fisik berselisih ${formatRupiah(difference, { signed: true })} dari saldo sistem ${formatRupiah(systemBalance)} — isi alasan selisih.`);
    }
    const [row] = await tx
      .insert(pettyCashCounts)
      .values({ tenantId: ctx.tenantId, countDate: date, systemBalance, physicalAmount: data.physicalAmount, difference, reason: data.reason, createdBy: ctx.userId })
      .returning();
    let discrepancyId: string | null = null;
    if (difference !== 0) {
      const disc = await formDiscrepancy(tx, ctx, {
        tenantId: ctx.tenantId,
        source: "petty_cash",
        businessDate: date,
        amount: difference,
        employeeId: ctx.employeeId,
        userId: ctx.userId,
        reason: "other",
        reasonNote: data.reason,
        sourceLabel: "Kas kecil",
      });
      discrepancyId = disc.id;
      await tx.update(pettyCashCounts).set({ discrepancyId, updatedAt: ctx.now }).where(eq(pettyCashCounts.id, row!.id));
      await emit(
        tx,
        "petty_cash.recorded",
        { pettyCashTransactionId: row!.id, kind: "adjustment", amount: difference, businessDate: date, description: `Selisih hitung fisik: ${data.reason}` },
        { ctx, businessDate: date, objectType: "petty_cash_count", objectId: row!.id },
      );
    }
    await auditRecord(tx, { ctx, objectType: "petty_cash_count", objectId: row!.id, action: "count", after: { systemBalance, physicalAmount: data.physicalAmount, difference }, reason: data.reason, rule: "US-M4-05 KP-2", businessDate: date });
    return { ...row!, discrepancyId };
  });
}

export async function getPettyCash(ctx: ActorContext, filter: { from?: string | null; to?: string | null } = {}, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m4.petty_cash.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const to = filter.to ?? today;
  const from = filter.from ?? addDays(to, -30);
  const rules = await cashRules(tx, today, ctx.tenantId);
  const [balance, rows, counts, pending] = await Promise.all([
    pettyCashBalance(tx, ctx.tenantId, today),
    tx.select().from(pettyCashTransactions).where(and(eq(pettyCashTransactions.tenantId, ctx.tenantId), gte(pettyCashTransactions.businessDate, from), lte(pettyCashTransactions.businessDate, to))).orderBy(desc(pettyCashTransactions.businessDate), desc(pettyCashTransactions.createdAt)),
    tx.select().from(pettyCashCounts).where(eq(pettyCashCounts.tenantId, ctx.tenantId)).orderBy(desc(pettyCashCounts.countDate), desc(pettyCashCounts.createdAt)).limit(20),
    tx.select().from(pettyCashTransactions).where(and(eq(pettyCashTransactions.tenantId, ctx.tenantId), inArray(pettyCashTransactions.status, ["pending_approval"]))),
  ]);
  const lastCount = counts[0] ?? null;
  const daysSinceCount = lastCount ? daysBetween(lastCount.countDate, today) : null;
  return {
    balance,
    rows,
    counts,
    pending,
    approvalAbove: rules.pettyCashApprovalAbove,
    countEveryDays: rules.pettyCashCountDays,
    lastCount,
    /** Rekonsiliasi fisik mingguan terlewat. */
    countOverdue: daysSinceCount === null || daysSinceCount >= rules.pettyCashCountDays,
    from,
    to,
    lastCountText: lastCount ? formatTanggal(lastCount.countDate, { weekday: false }) : null,
  };
}
