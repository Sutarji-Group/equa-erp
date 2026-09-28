/**
 * M4 — kas kantor, rekening bank PT & setor ke bank (US-M4-01 KP-3, US-M4-05 KP-1/KP-3).
 *
 * Kas kantor = saldo awal + setoran diterima − setor ke bank − pengisian kas kecil − penggantian pengeluaran rit
 * (± pelunasan ganti rugi tunai, pembayaran pemasok tunai, koreksi). Mutasi append-only (`office_cash_movements`);
 * koreksi = baris pembalik beralasan (> PAR-21 persetujuan pemilik, BR-38). Setiap mutasi memancarkan event untuk
 * jurnal M11 (`office_cash.moved`, `bank_deposit.recorded`/`.reversed`).
 */
import "server-only";

import { and, asc, desc, eq, gte, isNull, lte } from "drizzle-orm";

import { bankAccounts, bankDeposits, officeCashMovements, supplierPayments } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, formatTanggal, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { ConflictError, DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { authorize, runService } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";

import { bankAccountSchema, bankDepositSchema, deactivateBankAccountSchema, openingBalanceSchema, reverseBankDepositSchema } from "../schemas";
import { assertCashDayOpen, assertNotFuture, cashRules, officeCashBalance, postOfficeCash } from "./common";
import { cancelTransferForSource, recordIncomingTransfer } from "./transfers";

export type BankAccountRow = typeof bankAccounts.$inferSelect;
export type BankDepositRow = typeof bankDeposits.$inferSelect;

// =====================================================================================================================
// Rekening bank PT
// =====================================================================================================================

export async function listBankAccounts(ctx: ActorContext, opts: { tx?: Tx; includeInactive?: boolean } = {}): Promise<BankAccountRow[]> {
  await authorize(ctx, "m4.office_cash.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx.select().from(bankAccounts).where(eq(bankAccounts.tenantId, ctx.tenantId)).orderBy(asc(bankAccounts.bankName));
  return opts.includeInactive ? rows : rows.filter((r) => r.isActive);
}

export async function createBankAccount(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<BankAccountRow> {
  await authorize(ctx, "m4.bank_account.update", { tx: opts.tx });
  const data = parseInput(bankAccountSchema, input, { bankName: "Nama bank", accountNumber: "Nomor rekening", accountName: "Nama pemilik rekening" });
  return runService(ctx, opts, async (tx) => {
    const dup = await tx.select({ id: bankAccounts.id }).from(bankAccounts).where(and(eq(bankAccounts.tenantId, ctx.tenantId), eq(bankAccounts.accountNumber, data.accountNumber))).limit(1);
    if (dup[0]) throw new ConflictError("BANK_ACCOUNT_EXISTS", "Nomor rekening ini sudah terdaftar.");
    const [row] = await tx.insert(bankAccounts).values({ tenantId: ctx.tenantId, ...data, createdBy: ctx.userId }).returning();
    await auditRecord(tx, { ctx, objectType: "bank_account", objectId: row!.id, action: "create", after: data });
    return row!;
  });
}

export async function deactivateBankAccount(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<BankAccountRow> {
  await authorize(ctx, "m4.bank_account.update", { tx: opts.tx });
  const data = parseInput(deactivateBankAccountSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const acc = (await tx.select().from(bankAccounts).where(eq(bankAccounts.id, data.bankAccountId)).limit(1))[0];
    if (!acc || acc.tenantId !== ctx.tenantId) throw new NotFoundError("Rekening bank tidak ditemukan.");
    const [row] = await tx.update(bankAccounts).set({ isActive: false, deactivatedAt: ctx.now, deactivationReason: data.reason, updatedAt: ctx.now }).where(eq(bankAccounts.id, acc.id)).returning();
    await auditRecord(tx, { ctx, objectType: "bank_account", objectId: acc.id, action: "deactivate", before: { isActive: true }, after: { isActive: false }, reason: data.reason });
    return row!;
  });
}

// =====================================================================================================================
// Kas kantor — posisi & mutasi
// =====================================================================================================================

export type OfficeCashDay = {
  date: BusinessDate;
  opening: number;
  depositsReceived: number;
  bankDeposits: number;
  pettyCashTopups: number;
  expenseReimbursements: number;
  otherIn: number;
  otherOut: number;
  closing: number;
  movements: (typeof officeCashMovements.$inferSelect)[];
};

/** Kas kantor satu hari (US-M4-01 KP-3): saldo awal + setoran − setor bank − kas kecil − penggantian ± lainnya. */
export async function officeCashDay(tx: Tx, tenantId: string, date: BusinessDate): Promise<OfficeCashDay> {
  const opening = await officeCashBalance(tx, tenantId, addDays(date, -1));
  const movements = await tx
    .select()
    .from(officeCashMovements)
    .where(and(eq(officeCashMovements.tenantId, tenantId), eq(officeCashMovements.businessDate, date)))
    .orderBy(asc(officeCashMovements.createdAt));
  const sum = (pred: (m: (typeof movements)[number]) => boolean) => movements.filter(pred).reduce((s, m) => s + m.amount, 0);
  const sign = (m: (typeof movements)[number]) => (m.direction === "in" ? m.amount : -m.amount);
  const depositsReceived = movements.filter((m) => m.kind === "deposit_received").reduce((s, m) => s + sign(m), 0);
  const bankDep = -movements.filter((m) => m.kind === "bank_deposit").reduce((s, m) => s + sign(m), 0);
  const petty = -movements.filter((m) => m.kind === "petty_cash_topup").reduce((s, m) => s + sign(m), 0);
  const reimb = -movements.filter((m) => m.kind === "expense_reimbursement").reduce((s, m) => s + sign(m), 0);
  const known = new Set(["deposit_received", "bank_deposit", "petty_cash_topup", "expense_reimbursement"]);
  const otherIn = sum((m) => !known.has(m.kind) && m.direction === "in");
  const otherOut = sum((m) => !known.has(m.kind) && m.direction === "out");
  const closing = opening + depositsReceived - bankDep - petty - reimb + otherIn - otherOut;
  return { date, opening, depositsReceived, bankDeposits: bankDep, pettyCashTopups: petty, expenseReimbursements: reimb, otherIn, otherOut, closing, movements };
}

export async function getOfficeCash(ctx: ActorContext, filter: { date?: string | null } = {}, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m4.office_cash.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const date = filter.date ?? ctxBusinessDate(ctx);
  const [day, accounts, deposits, hasOpening] = await Promise.all([
    officeCashDay(tx, ctx.tenantId, date),
    tx.select().from(bankAccounts).where(eq(bankAccounts.tenantId, ctx.tenantId)).orderBy(asc(bankAccounts.bankName)),
    tx
      .select({ d: bankDeposits, bankName: bankAccounts.bankName, accountNumber: bankAccounts.accountNumber })
      .from(bankDeposits)
      .innerJoin(bankAccounts, eq(bankAccounts.id, bankDeposits.bankAccountId))
      .where(and(eq(bankDeposits.tenantId, ctx.tenantId), gte(bankDeposits.businessDate, addDays(date, -30)), lte(bankDeposits.businessDate, date)))
      .orderBy(desc(bankDeposits.businessDate), desc(bankDeposits.createdAt)),
    tx.select({ id: officeCashMovements.id }).from(officeCashMovements).where(and(eq(officeCashMovements.tenantId, ctx.tenantId), eq(officeCashMovements.kind, "opening_balance"))).limit(1),
  ]);
  const reversed = new Set(deposits.map((r) => r.d.reversalOfId).filter((x): x is string => !!x));
  return {
    date,
    day,
    accounts,
    bankDeposits: deposits.map((r) => ({ ...r.d, bankLabel: `${r.bankName} ${r.accountNumber}`, reversed: reversed.has(r.d.id) })),
    hasOpeningBalance: hasOpening.length > 0,
  };
}

/** Riwayat mutasi kas kantor (rentang). */
export async function listOfficeCashMovements(ctx: ActorContext, filter: { from: BusinessDate; to: BusinessDate }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m4.office_cash.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx
    .select()
    .from(officeCashMovements)
    .where(and(eq(officeCashMovements.tenantId, ctx.tenantId), gte(officeCashMovements.businessDate, filter.from), lte(officeCashMovements.businessDate, filter.to)))
    .orderBy(asc(officeCashMovements.businessDate), asc(officeCashMovements.createdAt));
  let running = await officeCashBalance(tx, ctx.tenantId, addDays(filter.from, -1));
  return rows.map((m) => {
    running += m.direction === "in" ? m.amount : -m.amount;
    return { ...m, kindLabel: label("office_cash_kind", m.kind), balanceAfter: running };
  });
}

/** Saldo awal kas kantor saat cut-over (sekali; hasil hitung fisik). */
export async function recordOfficeCashOpening(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m4.office_cash.count", { tx: opts.tx });
  const data = parseInput(openingBalanceSchema, input, { amount: "Saldo awal", note: "Keterangan" });
  return runService(ctx, opts, async (tx) => {
    const today = ctxBusinessDate(ctx);
    const date = data.businessDate ?? today;
    assertNotFuture(date, today);
    await assertCashDayOpen(tx, ctx.tenantId, date, "saldo awal kas kantor");
    const exists = await tx.select({ id: officeCashMovements.id }).from(officeCashMovements).where(and(eq(officeCashMovements.tenantId, ctx.tenantId), eq(officeCashMovements.kind, "opening_balance"))).limit(1);
    if (exists[0]) throw new DomainError("OPENING_EXISTS", "Saldo awal kas kantor sudah pernah dicatat. Koreksi lewat selisih kas saat tutup kas.");
    const [row] = await tx
      .insert(officeCashMovements)
      .values({ tenantId: ctx.tenantId, businessDate: date, kind: "opening_balance", direction: "in", amount: data.amount, description: data.note, createdBy: ctx.userId })
      .returning();
    await auditRecord(tx, { ctx, objectType: "office_cash_movement", objectId: row!.id, action: "create", after: { kind: "opening_balance", amount: data.amount, businessDate: date }, reason: data.note, businessDate: date });
    await emit(tx, "office_cash.moved", { movementId: row!.id, direction: "in", kind: "opening_balance", amount: data.amount, businessDate: date }, { ctx, businessDate: date, objectType: "office_cash_movement", objectId: row!.id });
    return row!;
  });
}

// =====================================================================================================================
// Setor ke bank (US-M4-05 KP-1)
// =====================================================================================================================

/** Setor kas kantor ke rekening PT dengan foto slip: mengurangi kas kantor; dicocokkan dengan mutasi (US-M4-04). */
export async function recordBankDeposit(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<BankDepositRow> {
  await authorize(ctx, "m4.bank_deposit.create", { tx: opts.tx });
  const data = parseInput(bankDepositSchema, input, { bankAccountId: "Rekening", amount: "Jumlah", slipAttachmentId: "Foto slip", businessDate: "Tanggal" });
  return runService(ctx, opts, async (tx) => {
    const today = ctxBusinessDate(ctx);
    const date = data.businessDate ?? today;
    assertNotFuture(date, today);
    await assertCashDayOpen(tx, ctx.tenantId, date, "setor ke bank");
    const acc = (await tx.select().from(bankAccounts).where(eq(bankAccounts.id, data.bankAccountId)).limit(1))[0];
    if (!acc || acc.tenantId !== ctx.tenantId || !acc.isActive) throw new NotFoundError("Rekening bank tidak ditemukan atau nonaktif.");
    const balance = await officeCashBalance(tx, ctx.tenantId, date);
    if (data.amount > balance) {
      throw new DomainError("INSUFFICIENT_OFFICE_CASH", `Setor ${formatRupiah(data.amount)} melebihi saldo kas kantor menurut sistem (${formatRupiah(balance)}). Periksa jumlahnya.`);
    }
    const [row] = await tx
      .insert(bankDeposits)
      .values({ tenantId: ctx.tenantId, bankAccountId: acc.id, amount: data.amount, businessDate: date, slipAttachmentId: data.slipAttachmentId, notes: data.notes, createdBy: ctx.userId })
      .returning();
    await linkAttachment(tx, data.slipAttachmentId, { type: "bank_deposit", id: row!.id });
    await postOfficeCash(tx, ctx, {
      tenantId: ctx.tenantId,
      businessDate: date,
      kind: "bank_deposit",
      direction: "out",
      amount: data.amount,
      sourceObjectType: "bank_deposit",
      sourceObjectId: row!.id,
      description: `Setor ke ${acc.bankName} ${acc.accountNumber}`,
    });
    // Dicocokkan dengan mutasi di daftar transfer masuk (kind setor bank dengan slip).
    await recordIncomingTransfer(tx, {
      tenantId: ctx.tenantId,
      sourceKind: "bank_deposit_slip",
      sourceObjectType: "bank_deposit",
      sourceObjectId: row!.id,
      amount: data.amount,
      transferDate: date,
      businessDate: date,
      bankAccountId: acc.id,
      proofAttachmentId: data.slipAttachmentId,
      reference: data.notes ?? null,
      sourceUserId: ctx.userId,
      notes: "Setor kas kantor ke bank",
      createdBy: ctx.userId,
    });
    await auditRecord(tx, { ctx, objectType: "bank_deposit", objectId: row!.id, action: "create", after: { amount: data.amount, bankAccountId: acc.id, businessDate: date }, reason: data.notes, rule: "US-M4-05 KP-1", businessDate: date });
    await emit(tx, "bank_deposit.recorded", { bankDepositId: row!.id, amount: data.amount, bankAccountId: acc.id, sourceType: "office" }, { ctx, businessDate: date, objectType: "bank_deposit", objectId: row!.id });
    return row!;
  });
}

/** Terapkan pembalik setor bank (dipanggil langsung ≤ PAR-21 atau oleh handler persetujuan koreksi). */
export async function applyBankDepositReversal(tx: Tx, ctx: ActorContext, bankDepositId: string, reason: string): Promise<BankDepositRow> {
  const orig = (await tx.select().from(bankDeposits).where(eq(bankDeposits.id, bankDepositId)).for("update").limit(1))[0];
  if (!orig) throw new NotFoundError("Setor bank tidak ditemukan.");
  const already = await tx.select({ id: bankDeposits.id }).from(bankDeposits).where(eq(bankDeposits.reversalOfId, orig.id)).limit(1);
  if (already[0]) throw new DomainError("ALREADY_REVERSED", "Setor bank ini sudah dibalik.");
  const date = ctxBusinessDate(ctx);
  const [rev] = await tx
    .insert(bankDeposits)
    .values({ tenantId: orig.tenantId, bankAccountId: orig.bankAccountId, amount: -orig.amount, businessDate: date, notes: `Pembalik: ${reason}`, reversalOfId: orig.id, createdBy: ctx.userId })
    .returning();
  const out = (await tx.select().from(officeCashMovements).where(and(eq(officeCashMovements.kind, "bank_deposit"), eq(officeCashMovements.sourceObjectType, "bank_deposit"), eq(officeCashMovements.sourceObjectId, orig.id), isNull(officeCashMovements.reversalOfId))).limit(1))[0];
  await postOfficeCash(tx, ctx, {
    tenantId: orig.tenantId,
    businessDate: date,
    kind: "adjustment",
    direction: "in",
    amount: orig.amount,
    sourceObjectType: "bank_deposit",
    sourceObjectId: rev!.id,
    description: `Pembalik setor bank: ${reason}`,
    reversalOfId: out?.id ?? null,
  });
  await cancelTransferForSource(tx, ctx, "bank_deposit", orig.id, reason);
  await auditRecord(tx, { ctx, objectType: "bank_deposit", objectId: orig.id, action: "reverse", after: { reversalId: rev!.id, amount: -orig.amount }, reason, rule: "BR-38", businessDate: orig.businessDate });
  await emit(
    tx,
    "bank_deposit.reversed",
    { bankDepositId: orig.id, reversalId: rev!.id, amount: orig.amount, bankAccountId: orig.bankAccountId, sourceType: "office", reason },
    { ctx, tenantId: orig.tenantId, businessDate: date, objectType: "bank_deposit", objectId: orig.id },
  );
  return rev!;
}

/**
 * Balik setor bank yang keliru (belum dicocokkan): ≤ PAR-21 langsung, > PAR-21 → persetujuan koreksi pemilik (BR-38).
 */
export async function reverseBankDeposit(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<{ status: "reversed" | "pending_approval"; approvalId?: string }> {
  await authorize(ctx, "m4.bank_deposit.reverse", { tx: opts.tx, objectType: "bank_deposit" });
  const data = parseInput(reverseBankDepositSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const orig = (await tx.select().from(bankDeposits).where(eq(bankDeposits.id, data.bankDepositId)).limit(1))[0];
    if (!orig || orig.tenantId !== ctx.tenantId || orig.reversalOfId) throw new NotFoundError("Setor bank tidak ditemukan.");
    if (orig.status === "matched") throw new DomainError("BANK_DEPOSIT_MATCHED", "Setor bank sudah cocok dengan mutasi — tidak dapat dibalik. Koreksi lewat jurnal M11.");
    await assertCashDayOpen(tx, ctx.tenantId, ctxBusinessDate(ctx), "pembalik setor bank");
    const rules = await cashRules(tx, ctxBusinessDate(ctx), ctx.tenantId);
    if (orig.amount > rules.correctionApprovalAbove) {
      const req = await approvals.submit(
        ctx,
        {
          type: "correction",
          objectType: "bank_deposit",
          objectId: orig.id,
          amount: orig.amount,
          reason: `Pembalik setor bank ${formatRupiah(orig.amount)} (${formatTanggal(orig.businessDate, { weekday: false })}): ${data.reason}`,
          payload: { link: "/kas/kantor", reason: data.reason },
        },
        { tx },
      );
      return { status: "pending_approval" as const, approvalId: req.id };
    }
    await applyBankDepositReversal(tx, ctx, orig.id, data.reason);
    return { status: "reversed" as const };
  });
}

// =====================================================================================================================
// Pembayaran pemasok (M7 → kas kantor; B-21)
// =====================================================================================================================

/** `supplier_payment.recorded` tunai → mutasi kas kantor keluar (pembalik → masuk) + isi `supplier_payments.office_cash_movement_id`. */
export async function applySupplierPaymentToOfficeCash(
  tx: Tx,
  ctx: ActorContext,
  p: { supplierPaymentId: string; amount: number; method: "cash" | "transfer"; businessDate: string; reversalOfId?: string | null; supplierName?: string | null },
): Promise<string | null> {
  if (p.method !== "cash" || p.amount === 0) return null;
  const reversal = p.amount < 0 || !!p.reversalOfId;
  const origMovement = reversal && p.reversalOfId
    ? (await tx.select({ id: officeCashMovements.id }).from(officeCashMovements).where(and(eq(officeCashMovements.sourceObjectType, "supplier_payment"), eq(officeCashMovements.sourceObjectId, p.reversalOfId), isNull(officeCashMovements.reversalOfId))).limit(1))[0]
    : undefined;
  const mv = await postOfficeCash(tx, ctx, {
    tenantId: ctx.tenantId,
    businessDate: p.businessDate,
    kind: "supplier_payment",
    direction: reversal ? "in" : "out",
    amount: Math.abs(p.amount),
    sourceObjectType: "supplier_payment",
    sourceObjectId: p.supplierPaymentId,
    description: `${reversal ? "Pembalik pembayaran" : "Pembayaran"} pemasok${p.supplierName ? ` ${p.supplierName}` : ""}`,
    reversalOfId: origMovement?.id ?? null,
  });
  if (mv) await tx.update(supplierPayments).set({ officeCashMovementId: mv.id }).where(and(eq(supplierPayments.id, p.supplierPaymentId), isNull(supplierPayments.officeCashMovementId)));
  return mv?.id ?? null;
}


