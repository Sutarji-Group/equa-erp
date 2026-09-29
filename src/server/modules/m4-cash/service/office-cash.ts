/**
 * M4 — kas kantor, rekening bank PT & setor ke bank (US-M4-01 KP-3, US-M4-05 KP-1/KP-3).
 *
 * Kas kantor = saldo awal + setoran diterima − setor ke bank − pengisian kas kecil − penggantian pengeluaran rit
 * (± pelunasan ganti rugi tunai, pembayaran pemasok tunai, koreksi). Mutasi append-only (`office_cash_movements`);
 * koreksi = baris pembalik beralasan (> PAR-21 persetujuan pemilik, BR-38). Setiap mutasi memancarkan event untuk
 * jurnal M11 (`office_cash.moved`, `bank_deposit.recorded`/`.reversed`).
 */
import "server-only";

import { and, asc, desc, eq, gte, isNull, lte, ne } from "drizzle-orm";

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
import * as m11 from "@/server/modules/m11-accounting";

import { bankAccountSchema, bankDepositSchema, deactivateBankAccountSchema, openingBalanceSchema, reverseBankDepositSchema, setBankGlAccountSchema } from "../schemas";
import { assertCashDayOpen, assertNotFuture, cashRules, officeCashBalance, officeCashOf, openCashDate, postOfficeCash } from "./common";
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

/**
 * B-53: akun buku rekening wajib milik rekening itu sendiri — akun kas/bank detail aktif (M11) yang tidak dipakai
 * rekening lain (aktif maupun nonaktif: riwayat saldo per rekening tidak boleh tercampur).
 */
async function assertGlAccountFree(tx: Tx, tenantId: string, glAccountId: string, exceptBankAccountId: string | null): Promise<void> {
  const acc = await m11.assertBankGlAccount(tx, tenantId, glAccountId);
  const conds = [eq(bankAccounts.tenantId, tenantId), eq(bankAccounts.glAccountId, glAccountId)];
  if (exceptBankAccountId) conds.push(ne(bankAccounts.id, exceptBankAccountId));
  const [other] = await tx.select({ bankName: bankAccounts.bankName, accountNumber: bankAccounts.accountNumber }).from(bankAccounts).where(and(...conds)).limit(1);
  if (other) {
    throw new ConflictError(
      "BANK_GL_SHARED",
      `Akun buku ${acc.code} ${acc.name} sudah dipakai rekening ${other.bankName} ${other.accountNumber}. Setiap rekening wajib punya akun buku sendiri — pilih akun lain atau biarkan kosong agar akun baru dibuat.`,
    );
  }
}

/** Rekening bank baru + akun bukunya sendiri (dipilih, atau dibuat otomatis `1-12NN` di bagan akun M11) — B-53. */
export async function createBankAccount(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<BankAccountRow> {
  await authorize(ctx, "m4.bank_account.update", { tx: opts.tx });
  const data = parseInput(bankAccountSchema, input, { bankName: "Nama bank", accountNumber: "Nomor rekening", accountName: "Nama pemilik rekening", glAccountId: "Akun buku" });
  return runService(ctx, opts, async (tx) => {
    const dup = await tx.select({ id: bankAccounts.id }).from(bankAccounts).where(and(eq(bankAccounts.tenantId, ctx.tenantId), eq(bankAccounts.accountNumber, data.accountNumber))).limit(1);
    if (dup[0]) throw new ConflictError("BANK_ACCOUNT_EXISTS", "Nomor rekening ini sudah terdaftar.");
    let glAccountId = data.glAccountId ?? null;
    let glCreated: string | null = null;
    if (glAccountId) await assertGlAccountFree(tx, ctx.tenantId, glAccountId, null);
    else {
      const gl = await m11.createBankGlAccount(tx, ctx, { bankName: data.bankName, accountNumber: data.accountNumber });
      glAccountId = gl.id;
      glCreated = `${gl.code} ${gl.name}`;
    }
    const [row] = await tx.insert(bankAccounts).values({ tenantId: ctx.tenantId, ...data, glAccountId, createdBy: ctx.userId }).returning();
    await auditRecord(tx, { ctx, objectType: "bank_account", objectId: row!.id, action: "create", after: { ...data, glAccountId, glAccountCreated: glCreated }, rule: "US-M4-05 KP-1, B-53" });
    return row!;
  });
}

/**
 * B-53: tetapkan akun buku rekening lama yang kosong / dipakai bersama (migrasi data sebelum aturan satu akun per
 * rekening). Kosongkan `glAccountId` → akun buku baru dibuat otomatis. Berjejak (nilai lama/baru + alasan).
 */
export async function setBankAccountGlAccount(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<BankAccountRow> {
  await authorize(ctx, "m4.bank_account.update", { tx: opts.tx });
  const data = parseInput(setBankGlAccountSchema, input, { glAccountId: "Akun buku", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const acc = (await tx.select().from(bankAccounts).where(eq(bankAccounts.id, data.bankAccountId)).limit(1))[0];
    if (!acc || acc.tenantId !== ctx.tenantId) throw new NotFoundError("Rekening bank tidak ditemukan.");
    let glAccountId = data.glAccountId ?? null;
    if (glAccountId && glAccountId === acc.glAccountId) throw new DomainError("BANK_GL_UNCHANGED", "Akun buku rekening ini sudah akun tersebut.");
    if (glAccountId) await assertGlAccountFree(tx, ctx.tenantId, glAccountId, acc.id);
    else glAccountId = (await m11.createBankGlAccount(tx, ctx, { bankName: acc.bankName, accountNumber: acc.accountNumber })).id;
    const [row] = await tx.update(bankAccounts).set({ glAccountId, updatedAt: ctx.now }).where(eq(bankAccounts.id, acc.id)).returning();
    await auditRecord(tx, { ctx, objectType: "bank_account", objectId: acc.id, action: "set_gl_account", before: { glAccountId: acc.glAccountId }, after: { glAccountId }, reason: data.reason, rule: "B-53" });
    return row!;
  });
}

/** Pilihan akun buku rekening & rekening yang perlu diperbaiki (layar Kas kantor, B-53). */
export async function bankGlChoices(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<{ options: m11.BankGlOption[]; needing: Awaited<ReturnType<typeof bankAccountsNeedingGl>> }> {
  await authorize(ctx, "m4.office_cash.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  return { options: await m11.bankGlAccountOptions(tx, ctx.tenantId), needing: await bankAccountsNeedingGl(tx, ctx.tenantId) };
}

/** Rekening bank tanpa akun buku sendiri (kosong / dipakai bersama) — ditampilkan sebagai tugas perbaikan (B-53). */
export async function bankAccountsNeedingGl(tx: Tx, tenantId: string): Promise<{ id: string; label: string; reason: "missing" | "shared" }[]> {
  const rows = await tx.select().from(bankAccounts).where(eq(bankAccounts.tenantId, tenantId)).orderBy(asc(bankAccounts.createdAt));
  const seen = new Map<string, number>();
  for (const r of rows) if (r.glAccountId) seen.set(r.glAccountId, (seen.get(r.glAccountId) ?? 0) + 1);
  return rows
    .filter((r) => r.isActive && (!r.glAccountId || (seen.get(r.glAccountId) ?? 0) > 1))
    .map((r) => ({ id: r.id, label: `${r.bankName} ${r.accountNumber}`, reason: r.glAccountId ? ("shared" as const) : ("missing" as const) }));
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
  // Hari kas yang sudah ditutup terkunci → mutasi masuk hari kas terbuka berikutnya (US-M4-06 KP-7).
  const cashDate = await openCashDate(tx, ctx.tenantId, p.businessDate);
  const mv = await postOfficeCash(tx, ctx, {
    tenantId: ctx.tenantId,
    businessDate: cashDate.date,
    kind: "supplier_payment",
    direction: reversal ? "in" : "out",
    amount: Math.abs(p.amount),
    sourceObjectType: "supplier_payment",
    sourceObjectId: p.supplierPaymentId,
    description: `${reversal ? "Pembalik pembayaran" : "Pembayaran"} pemasok${p.supplierName ? ` ${p.supplierName}` : ""}${cashDate.shifted ? " (setelah kas ditutup)" : ""}`,
    reversalOfId: origMovement?.id ?? null,
  });
  if (mv) await tx.update(supplierPayments).set({ officeCashMovementId: mv.id }).where(and(eq(supplierPayments.id, p.supplierPaymentId), isNull(supplierPayments.officeCashMovementId)));
  return mv?.id ?? null;
}

// =====================================================================================================================
// Pelunasan & pengembalian uang muka tunai kantor (M5 → kas kantor; integrasi M4 + M5)
// =====================================================================================================================

/**
 * Pelunasan tunai kantor (M5 `collection.recorded` kanal `office`; PRD US-M5-02 KP-1 "tunai kantor → kas kantor M4")
 * → mutasi kas kantor masuk. Pembaliknya (`payment.reversed`, BR-38) → mutasi keluar yang merujuk mutasi asal.
 * Idempoten: satu mutasi per pelunasan (indeks unik sumber) dan satu pembalik per mutasi asal.
 */
export async function applyCustomerCashToOfficeCash(
  tx: Tx,
  ctx: ActorContext,
  p: { customerPaymentId: string; amount: number; businessDate: string; reversalId?: string | null; reason?: string | null; customerName?: string | null },
): Promise<string | null> {
  if (!Number.isInteger(p.amount) || p.amount <= 0) return null;
  const reversal = !!p.reversalId;
  let reversalOfId: string | null = null;
  if (reversal) {
    const orig = (await officeCashOf(tx, "customer_payment", p.customerPaymentId)).find((m) => m.kind === "customer_payment" && m.direction === "in");
    // Pelunasan asal tidak pernah masuk kas kantor → tidak ada kas yang dibalik.
    if (!orig) return null;
    const done = await tx.select({ id: officeCashMovements.id }).from(officeCashMovements).where(eq(officeCashMovements.reversalOfId, orig.id)).limit(1);
    if (done[0]) return null;
    reversalOfId = orig.id;
  }
  // Hari kas yang sudah ditutup terkunci → mutasi masuk hari kas terbuka berikutnya (US-M4-06 KP-7).
  const cashDate = await openCashDate(tx, ctx.tenantId, p.businessDate);
  const who = p.customerName ? ` ${p.customerName}` : "";
  const mv = await postOfficeCash(tx, ctx, {
    tenantId: ctx.tenantId,
    businessDate: cashDate.date,
    kind: "customer_payment",
    direction: reversal ? "out" : "in",
    amount: p.amount,
    sourceObjectType: "customer_payment",
    sourceObjectId: reversal ? p.reversalId! : p.customerPaymentId,
    description: `${reversal ? "Pembalik pelunasan" : "Pelunasan"} tunai kantor${who}${reversal && p.reason ? ` — ${p.reason}` : ""}${cashDate.shifted ? " (setelah kas ditutup)" : ""}`,
    reversalOfId,
  });
  return mv?.id ?? null;
}

/**
 * Pengembalian uang muka pelanggan secara tunai (M5 `customer_advance.refunded`, persetujuan pemilik `customer_refund`)
 * → mutasi kas kantor keluar. Kunci sumber = permintaan persetujuan (satu uang muka dapat dikembalikan bertahap).
 */
export async function applyAdvanceRefundToOfficeCash(
  tx: Tx,
  ctx: ActorContext,
  p: { sourceObjectType: string; sourceObjectId: string; amount: number; businessDate: string; customerName?: string | null },
): Promise<string | null> {
  if (!Number.isInteger(p.amount) || p.amount <= 0) return null;
  const cashDate = await openCashDate(tx, ctx.tenantId, p.businessDate);
  const mv = await postOfficeCash(tx, ctx, {
    tenantId: ctx.tenantId,
    businessDate: cashDate.date,
    kind: "advance_refund",
    direction: "out",
    amount: p.amount,
    sourceObjectType: p.sourceObjectType,
    sourceObjectId: p.sourceObjectId,
    description: `Pengembalian uang muka pelanggan${p.customerName ? ` ${p.customerName}` : ""} (tunai)${cashDate.shifted ? " (setelah kas ditutup)" : ""}`,
  });
  return mv?.id ?? null;
}


