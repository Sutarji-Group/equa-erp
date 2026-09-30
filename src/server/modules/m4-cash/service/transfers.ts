/**
 * M4 — transfer masuk & pencocokan mutasi bank (US-M4-04; PTB-04, PTB-16, PTB-23; NFR-22).
 *
 * - Transfer tercatat dibuat dari event sumber (satu per objek sumber — indeks unik): pembayaran rit transfer (M3),
 *   pelunasan transfer (M3 sopir / M5 kantor / M7 mitra toko), QRIS per shift depot & toko (M6/M7, PTB-04), QRIS yang
 *   tersinkron setelah shift ditutup (per transaksi), setor bank dengan slip sopir/outlet (PTB-23), setor kas kantor ke
 *   bank (US-M4-05), pembayaran digital (Tahap 2).
 * - Pencocokan manual (M): Admin Keuangan mencatat referensi mutasi (tanggal, jumlah, keterangan) → Cocok.
 * - Impor mutasi (S): CSV/Excel → usulan pasangan (jumlah sama, tanggal ± N hari) → dikonfirmasi; mutasi tanpa pasangan
 *   → daftar tindak lanjut.
 * - > PAR-39 hari tanpa mutasi → Tidak ditemukan + notifikasi pemilik & Admin Keuangan + `transfer.not_found` (M5).
 * - Hasil pencocokan → `transfer.matched` (masukan rekonsiliasi bank M11).
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";

import {
  bankAccounts,
  bankDeposits,
  bankStatementImports,
  bankStatementLines,
  customers,
  deposits,
  incomingTransfers,
  outlets,
  tripPayments,
  trucks,
  users,
  employees,
} from "@/db/schema";
import { label, type EnumValue } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { daysBetween, formatTanggal, toBusinessDate, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Db, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { markActionedForObject, notify } from "@/server/core/notifications";
import { authorize, runService } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";

import { confirmMatchesSchema, importStatementSchema, markStatementLineSchema, matchTransferSchema } from "../schemas";
import { cashRules, type DiscrepancyReason } from "./common";
import { receiveDepositCore } from "./deposits";
import { parseStatement, StatementFormatError } from "./statement-parse";

export type IncomingTransferRow = typeof incomingTransfers.$inferSelect;
export type StatementLineRow = typeof bankStatementLines.$inferSelect;
type SourceKind = EnumValue<"transfer_source_kind">;

// =====================================================================================================================
// Pencatatan dari sumber (idempoten per objek sumber)
// =====================================================================================================================

export type RecordTransferInput = {
  tenantId: string;
  sourceKind: SourceKind;
  sourceObjectType: string;
  sourceObjectId: string;
  amount: number;
  transferDate: BusinessDate;
  businessDate: BusinessDate;
  customerId?: string | null;
  outletId?: string | null;
  shiftId?: string | null;
  proofAttachmentId?: string | null;
  bankAccountId?: string | null;
  reference?: string | null;
  sourceUserId?: string | null;
  truckId?: string | null;
  notes?: string | null;
  createdBy?: string | null;
};

/** Catat transfer masuk (sekali per objek sumber; event terulang tidak menggandakan). */
export async function recordIncomingTransfer(tx: Tx, input: RecordTransferInput): Promise<{ transfer: IncomingTransferRow; created: boolean }> {
  const existing = await transferForSource(tx, input.sourceObjectType, input.sourceObjectId);
  if (existing) return { transfer: existing, created: false };
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new DomainError("TRANSFER_AMOUNT", "Jumlah transfer harus lebih dari nol.");
  const [row] = await tx
    .insert(incomingTransfers)
    .values({
      tenantId: input.tenantId,
      sourceKind: input.sourceKind,
      sourceObjectType: input.sourceObjectType,
      sourceObjectId: input.sourceObjectId,
      amount: input.amount,
      transferDate: input.transferDate,
      businessDate: input.businessDate,
      customerId: input.customerId ?? null,
      outletId: input.outletId ?? null,
      shiftId: input.shiftId ?? null,
      proofAttachmentId: input.proofAttachmentId ?? null,
      bankAccountId: input.bankAccountId ?? null,
      reference: input.reference ?? null,
      sourceUserId: input.sourceUserId ?? null,
      truckId: input.truckId ?? null,
      notes: input.notes ?? null,
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { transfer: row, created: true };
  return { transfer: (await transferForSource(tx, input.sourceObjectType, input.sourceObjectId))!, created: false };
}

export async function transferForSource(tx: Tx, sourceObjectType: string, sourceObjectId: string): Promise<IncomingTransferRow | null> {
  return (await tx.select().from(incomingTransfers).where(and(eq(incomingTransfers.sourceObjectType, sourceObjectType), eq(incomingTransfers.sourceObjectId, sourceObjectId))).limit(1))[0] ?? null;
}

/** Transaksi sumber dibalik sebelum dicocokkan → transfer Dibatalkan (tidak menjadi "Tidak ditemukan"). */
export async function cancelTransferForSource(tx: Tx, ctx: ActorContext, sourceObjectType: string, sourceObjectId: string, reason: string): Promise<IncomingTransferRow | null> {
  const t = await transferForSource(tx, sourceObjectType, sourceObjectId);
  if (!t || (t.status !== "unmatched" && t.status !== "not_found")) return null;
  const [row] = await tx.update(incomingTransfers).set({ status: "cancelled", cancelledAt: ctx.now, cancelReason: reason, updatedAt: ctx.now }).where(eq(incomingTransfers.id, t.id)).returning();
  await auditRecord(tx, { ctx, objectType: "incoming_transfer", objectId: t.id, action: "cancel", before: { status: t.status }, after: { status: "cancelled" }, reason, rule: "BR-38", businessDate: t.businessDate });
  await markActionedForObject(tx, { objectType: "incoming_transfer", objectId: t.id, now: ctx.now });
  return row!;
}

/** Setoran setor bank dengan slip (sopir PTB-23 / outlet sebagian & akhir shift) → transfer untuk dicocokkan. */
export async function recordSlipDepositTransfer(tx: Tx, depositId: string): Promise<IncomingTransferRow | null> {
  const dep = (await tx.select().from(deposits).where(eq(deposits.id, depositId)).limit(1))[0];
  if (!dep || dep.method !== "bank_slip" || dep.status !== "submitted") return null;
  const amount = dep.expectedNet || dep.expectedCash;
  if (amount <= 0) return null;
  const snap = (dep.summarySnapshot ?? {}) as { bankAccountId?: string | null };
  const { transfer } = await recordIncomingTransfer(tx, {
    tenantId: dep.tenantId,
    sourceKind: "bank_deposit_slip",
    sourceObjectType: "deposit",
    sourceObjectId: dep.id,
    amount,
    transferDate: dep.submittedAt ? toBusinessDate(dep.submittedAt) : dep.businessDate,
    businessDate: dep.businessDate,
    outletId: dep.outletId,
    shiftId: dep.shiftId,
    proofAttachmentId: dep.bankSlipAttachmentId,
    bankAccountId: snap.bankAccountId ?? null,
    reference: dep.number,
    sourceUserId: dep.depositorUserId,
    truckId: dep.truckId,
    notes: dep.isPartial ? `Setor sebagian ${dep.number}` : `Setoran ${dep.number} lewat setor bank`,
    createdBy: dep.depositorUserId,
  });
  if (!dep.slipTransferId) await tx.update(deposits).set({ slipTransferId: transfer.id, updatedAt: new Date() }).where(eq(deposits.id, dep.id));
  return transfer;
}

/** Job: setoran slip yang belum punya transfer (mis. serah setoran akhir shift lewat slip tanpa event) → dicatat. */
export async function sweepSlipDeposits(now: Date = new Date(), opts: { db?: Db } = {}): Promise<{ created: number; at: string }> {
  return withTx(
    async (tx) => {
      const rows = await tx
        .select({ id: deposits.id })
        .from(deposits)
        .where(and(eq(deposits.method, "bank_slip"), eq(deposits.status, "submitted"), isNull(deposits.slipTransferId)))
        .limit(500);
      let created = 0;
      for (const r of rows) if (await recordSlipDepositTransfer(tx, r.id)) created++;
      return { created, at: now.toISOString() };
    },
    { db: opts.db },
  );
}

// =====================================================================================================================
// Daftar (US-M4-04 KP-1)
// =====================================================================================================================

export type TransferListRow = IncomingTransferRow & {
  customerName: string | null;
  outletLabel: string | null;
  sourceUserName: string | null;
  truckCode: string | null;
  bankLabel: string | null;
  ageDays: number;
  matchedByName: string | null;
};

export async function listIncomingTransfers(
  ctx: ActorContext,
  filter: { status?: IncomingTransferRow["status"] | "open" | "all" | null; from?: string | null; to?: string | null; sourceKind?: SourceKind | null; id?: string | null } = {},
  opts: { tx?: Tx } = {},
): Promise<TransferListRow[]> {
  await authorize(ctx, "m4.incoming_transfer.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const conds = [eq(incomingTransfers.tenantId, ctx.tenantId)];
  if (filter.id) conds.push(eq(incomingTransfers.id, filter.id));
  const status = filter.status ?? "open";
  if (status === "open") conds.push(inArray(incomingTransfers.status, ["unmatched", "not_found"]));
  else if (status !== "all") conds.push(eq(incomingTransfers.status, status));
  if (filter.from) conds.push(gte(incomingTransfers.transferDate, filter.from));
  if (filter.to) conds.push(lte(incomingTransfers.transferDate, filter.to));
  if (filter.sourceKind) conds.push(eq(incomingTransfers.sourceKind, filter.sourceKind));
  const rows = await tx
    .select({ t: incomingTransfers, customerName: customers.name, outletCode: outlets.code, outletName: outlets.name, truckCode: trucks.code, bankName: bankAccounts.bankName, bankNumber: bankAccounts.accountNumber })
    .from(incomingTransfers)
    .leftJoin(customers, eq(customers.id, incomingTransfers.customerId))
    .leftJoin(outlets, eq(outlets.id, incomingTransfers.outletId))
    .leftJoin(trucks, eq(trucks.id, incomingTransfers.truckId))
    .leftJoin(bankAccounts, eq(bankAccounts.id, incomingTransfers.bankAccountId))
    .where(and(...conds))
    .orderBy(asc(incomingTransfers.transferDate), asc(incomingTransfers.createdAt))
    .limit(1000);
  const userIds = [...new Set(rows.flatMap((r) => [r.t.sourceUserId, r.t.matchedBy]).filter((x): x is string => !!x))];
  const names = userIds.length
    ? new Map((await tx.select({ id: users.id, name: employees.fullName }).from(users).leftJoin(employees, eq(employees.id, users.employeeId)).where(inArray(users.id, userIds))).map((u) => [u.id, u.name]))
    : new Map<string, string | null>();
  return rows.map(({ t, customerName, outletCode, outletName, truckCode, bankName, bankNumber }) => ({
    ...t,
    customerName: customerName ?? null,
    outletLabel: outletCode ? `${outletCode} — ${outletName}` : null,
    sourceUserName: t.sourceUserId ? (names.get(t.sourceUserId) ?? null) : null,
    truckCode: truckCode ?? null,
    bankLabel: bankName ? `${bankName} ${bankNumber}` : null,
    ageDays: Math.max(0, daysBetween(t.transferDate, today)),
    matchedByName: t.matchedBy ? (names.get(t.matchedBy) ?? null) : null,
  }));
}

// =====================================================================================================================
// Pencocokan (US-M4-04 KP-2, US-M4-02 KP-7, US-M4-05 KP-1)
// =====================================================================================================================

type MatchRef = { date: BusinessDate; amount: number; note: string; line?: StatementLineRow | null; discrepancyReason?: DiscrepancyReason | null; discrepancyNote?: string | null };

async function matchCore(tx: Tx, ctx: ActorContext, transferId: string, ref: MatchRef): Promise<IncomingTransferRow> {
  const t = (await tx.select().from(incomingTransfers).where(eq(incomingTransfers.id, transferId)).for("update").limit(1))[0];
  if (!t || t.tenantId !== ctx.tenantId) throw new NotFoundError("Transfer masuk tidak ditemukan.");
  if (t.status === "matched") throw new DomainError("TRANSFER_MATCHED", "Transfer ini sudah cocok dengan mutasi.");
  if (t.status === "cancelled") throw new DomainError("TRANSFER_CANCELLED", "Transfer ini dibatalkan karena transaksi sumbernya dibalik.");
  if (ref.line) {
    if (ref.line.status === "matched") throw new DomainError("LINE_MATCHED", "Baris mutasi ini sudah dipasangkan dengan transfer lain.");
    if (t.bankAccountId && t.bankAccountId !== ref.line.bankAccountId) throw new DomainError("BANK_ACCOUNT_MISMATCH", "Rekening mutasi berbeda dengan rekening tujuan transfer.");
  }
  const isSlipDeposit = t.sourceKind === "bank_deposit_slip" && t.sourceObjectType === "deposit" && !!t.sourceObjectId;
  if (!isSlipDeposit && ref.amount !== t.amount) {
    throw new DomainError(
      "AMOUNT_MISMATCH",
      `Jumlah mutasi ${formatRupiah(ref.amount)} berbeda dengan transfer tercatat ${formatRupiah(t.amount)}. Periksa kembali mutasi; bila memang kurang, tindak lanjuti ke pelanggan/penyetor.`,
    );
  }
  const [row] = await tx
    .update(incomingTransfers)
    .set({
      status: "matched",
      matchedAt: ctx.now,
      matchedBy: ctx.userId,
      matchRefDate: ref.date,
      matchRefAmount: ref.amount,
      matchRefNote: ref.note,
      bankStatementLineId: ref.line?.id ?? t.bankStatementLineId,
      bankAccountId: t.bankAccountId ?? ref.line?.bankAccountId ?? null,
      updatedAt: ctx.now,
    })
    .where(eq(incomingTransfers.id, t.id))
    .returning();
  if (ref.line) {
    await tx.update(bankStatementLines).set({ status: "matched", matchedBy: ctx.userId, matchedAt: ctx.now, updatedAt: ctx.now }).where(eq(bankStatementLines.id, ref.line.id));
  }
  await auditRecord(tx, {
    ctx,
    objectType: "incoming_transfer",
    objectId: t.id,
    action: "match",
    before: { status: t.status },
    after: { status: "matched", matchRefDate: ref.date, matchRefAmount: ref.amount, statementLineId: ref.line?.id ?? null },
    reason: ref.note,
    rule: "US-M4-04 KP-2",
    businessDate: t.businessDate,
  });
  // Setor bank dengan slip: Diterima setelah mutasi cocok (7.4.6, US-M4-02 KP-7).
  if (isSlipDeposit) {
    await receiveDepositCore(tx, ctx, t.sourceObjectId!, {
      receivedAmount: ref.amount,
      via: "bank",
      discrepancyReason: ref.discrepancyReason ?? null,
      discrepancyNote: ref.discrepancyNote ?? null,
      close: true,
      transferId: t.id,
      bankAccountId: row!.bankAccountId,
    });
  }
  if (t.sourceObjectType === "bank_deposit" && t.sourceObjectId) {
    await tx
      .update(bankDeposits)
      .set({ status: "matched", matchedAt: ctx.now, matchedBy: ctx.userId, bankStatementLineId: ref.line?.id ?? null, updatedAt: ctx.now })
      .where(eq(bankDeposits.id, t.sourceObjectId));
    await cancelOpenBankDepositCorrections(tx, ctx, t.tenantId, t.sourceObjectId);
  }
  await emit(
    tx,
    "transfer.matched",
    {
      incomingTransferId: t.id,
      amount: ref.amount,
      sourceKind: t.sourceKind,
      bankAccountId: row!.bankAccountId,
      matchedAt: ctx.now.toISOString(),
      targetType: t.sourceObjectType,
      targetId: t.sourceObjectId,
      customerId: t.customerId,
    },
    { ctx, businessDate: ctxBusinessDate(ctx), objectType: "incoming_transfer", objectId: t.id },
  );
  await markActionedForObject(tx, { objectType: "incoming_transfer", objectId: t.id, now: ctx.now });
  return row!;
}

/**
 * Setor bank terbukti di mutasi → permintaan pembalik (`correction`, BR-38) yang masih menunggu keputusan pemilik
 * dibatalkan: uang sudah di bank, sehingga kas kantor tidak boleh dikembalikan (US-M4-04 KP-2, US-M4-05 KP-1).
 */
async function cancelOpenBankDepositCorrections(tx: Tx, ctx: ActorContext, tenantId: string, bankDepositId: string): Promise<void> {
  const open = (await approvals.listForObject(tx, "bank_deposit", bankDepositId)).filter((a) => a.type === "correction" && a.status === "submitted");
  for (const req of open) {
    await approvals.cancel(systemContext({ tenantId, now: ctx.now }), req.id, "Setor bank sudah cocok dengan mutasi rekening — pembalik tidak berlaku.", { tx });
    await notify(tx, {
      event: "approval.decided",
      tenantId,
      recipients: { userIds: [req.requesterUserId] },
      title: `Pembalik setor bank ${req.number} dibatalkan otomatis`,
      body: "Setor bank itu sudah cocok dengan mutasi rekening (uang terbukti masuk bank). Bila memang keliru, koreksi lewat jurnal manual Akuntansi.",
      objectType: "bank_deposit",
      objectId: bankDepositId,
      link: "/kas/kantor",
      now: ctx.now,
    });
  }
}

/** Cocokkan manual dengan referensi mutasi internet banking (US-M4-04 KP-2). */
export async function matchTransfer(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<IncomingTransferRow> {
  await authorize(ctx, "m4.incoming_transfer.match", { tx: opts.tx, objectType: "incoming_transfer" });
  const data = parseInput(matchTransferSchema, input, { refDate: "Tanggal mutasi", refAmount: "Jumlah mutasi", refNote: "Keterangan mutasi" });
  return runService(ctx, opts, async (tx) => {
    const line = data.statementLineId ? await loadLine(tx, ctx, data.statementLineId) : null;
    return matchCore(tx, ctx, data.transferId, {
      date: data.refDate,
      amount: data.refAmount,
      note: data.refNote,
      line,
      discrepancyReason: data.discrepancyReason ?? null,
      discrepancyNote: data.discrepancyNote,
    });
  });
}

async function loadLine(tx: Tx, ctx: ActorContext, id: string): Promise<StatementLineRow> {
  const row = (await tx.select({ l: bankStatementLines, tenantId: bankAccounts.tenantId }).from(bankStatementLines).innerJoin(bankAccounts, eq(bankAccounts.id, bankStatementLines.bankAccountId)).where(eq(bankStatementLines.id, id)).for("update").limit(1))[0];
  if (!row || row.tenantId !== ctx.tenantId) throw new NotFoundError("Baris mutasi tidak ditemukan.");
  return row.l;
}

// =====================================================================================================================
// Impor mutasi (US-M4-04 KP-3, S)
// =====================================================================================================================

export type MatchProposal = {
  line: StatementLineRow;
  transfer: IncomingTransferRow;
  dateDiff: number;
  /** Lebih dari satu transfer cocok (jumlah & tanggal) — periksa sebelum mengonfirmasi. */
  ambiguous: boolean;
};

export type ImportResult = {
  importId: string;
  inserted: number;
  duplicates: number;
  skipped: number;
  proposals: MatchProposal[];
  unpaired: StatementLineRow[];
};

/** Unggah berkas mutasi (CSV/Excel) → baris mutasi (tanpa impor ganda) + usulan pasangan. */
export async function importBankStatement(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<ImportResult> {
  await authorize(ctx, "m4.bank_statement.import", { tx: opts.tx });
  const data = parseInput(importStatementSchema, input, { bankAccountId: "Rekening", fileName: "Nama berkas" });
  const today = ctxBusinessDate(ctx);
  let parsed;
  try {
    parsed = await parseStatement(data.fileName, data.content, { year: Number(today.slice(0, 4)) });
  } catch (error) {
    throw new DomainError(
      "STATEMENT_UNREADABLE",
      error instanceof StatementFormatError ? error.message : "Berkas mutasi tidak dapat dibaca. Unduh ulang mutasi sebagai CSV atau .xlsx dari internet banking lalu unggah lagi.",
    );
  }
  if (!parsed.lines.length) throw new DomainError("STATEMENT_EMPTY", "Tidak ada baris mutasi yang terbaca. Periksa format berkas (Tanggal, Keterangan, Jumlah/Kredit).");
  return runService(ctx, opts, async (tx) => {
    const account = (await tx.select().from(bankAccounts).where(eq(bankAccounts.id, data.bankAccountId)).limit(1))[0];
    if (!account || account.tenantId !== ctx.tenantId) throw new NotFoundError("Rekening bank tidak ditemukan.");
    const [imp] = await tx
      .insert(bankStatementImports)
      .values({
        tenantId: ctx.tenantId,
        bankAccountId: account.id,
        fileAttachmentId: data.fileAttachmentId ?? null,
        originalFilename: data.fileName,
        periodStart: parsed.periodStart,
        periodEnd: parsed.periodEnd,
        lineCount: parsed.lines.length,
        createdBy: ctx.userId,
      })
      .returning();
    if (data.fileAttachmentId) await linkAttachment(tx, data.fileAttachmentId, { type: "bank_statement_import", id: imp!.id });
    const inserted = await tx
      .insert(bankStatementLines)
      .values(parsed.lines.map((l) => ({ importId: imp!.id, bankAccountId: account.id, lineDate: l.lineDate, description: l.description, amount: l.amount, balance: l.balance, reference: l.reference, rowHash: l.rowHash })))
      .onConflictDoNothing()
      .returning({ id: bankStatementLines.id });
    await auditRecord(tx, {
      ctx,
      objectType: "bank_statement_import",
      objectId: imp!.id,
      action: "import",
      after: { bankAccountId: account.id, fileName: data.fileName, lines: parsed.lines.length, inserted: inserted.length, skipped: parsed.skipped },
      rule: "US-M4-04 KP-3",
    });
    const { proposals, unpaired } = await proposeMatchesTx(tx, ctx, { bankAccountId: account.id });
    if (unpaired.length) {
      await notify(tx, {
        event: "bank_statement.unmatched",
        tenantId: ctx.tenantId,
        recipients: { userIds: ctx.userId ? [ctx.userId] : [] },
        title: `${unpaired.length} mutasi masuk tanpa pasangan transfer`,
        body: `Impor ${data.fileName}: tindak lanjuti mutasi yang tidak cocok dengan transfer tercatat.`,
        objectType: "bank_statement_import",
        objectId: imp!.id,
        link: "/kas/transfer?tampil=mutasi",
        now: ctx.now,
      });
    }
    return { importId: imp!.id, inserted: inserted.length, duplicates: parsed.lines.length - inserted.length, skipped: parsed.skipped, proposals, unpaired };
  });
}

async function proposeMatchesTx(tx: Tx, ctx: ActorContext, filter: { bankAccountId?: string | null }): Promise<{ proposals: MatchProposal[]; unpaired: StatementLineRow[] }> {
  const rules = await cashRules(tx, ctxBusinessDate(ctx), ctx.tenantId);
  const lineConds = [eq(bankAccounts.tenantId, ctx.tenantId), eq(bankStatementLines.status, "unmatched"), sql`${bankStatementLines.amount} > 0`];
  if (filter.bankAccountId) lineConds.push(eq(bankStatementLines.bankAccountId, filter.bankAccountId));
  const lines = (
    await tx
      .select({ l: bankStatementLines })
      .from(bankStatementLines)
      .innerJoin(bankAccounts, eq(bankAccounts.id, bankStatementLines.bankAccountId))
      .where(and(...lineConds))
      .orderBy(asc(bankStatementLines.lineDate), asc(bankStatementLines.createdAt))
  ).map((r) => r.l);
  if (!lines.length) return { proposals: [], unpaired: [] };
  const amounts = [...new Set(lines.map((l) => l.amount))];
  const candidates = await tx
    .select()
    .from(incomingTransfers)
    .where(and(eq(incomingTransfers.tenantId, ctx.tenantId), inArray(incomingTransfers.status, ["unmatched", "not_found"]), inArray(incomingTransfers.amount, amounts)));
  const used = new Set<string>();
  const proposals: MatchProposal[] = [];
  const unpaired: StatementLineRow[] = [];
  for (const line of lines) {
    const fits = candidates
      .filter((t) => !used.has(t.id) && t.amount === line.amount && (!t.bankAccountId || t.bankAccountId === line.bankAccountId))
      .map((t) => ({ t, diff: Math.abs(daysBetween(t.transferDate, line.lineDate)) }))
      .filter((x) => x.diff <= rules.statementMatchDays)
      .sort((a, b) => a.diff - b.diff || a.t.createdAt.getTime() - b.t.createdAt.getTime());
    const best = fits[0];
    if (!best) {
      unpaired.push(line);
      continue;
    }
    used.add(best.t.id);
    proposals.push({ line, transfer: best.t, dateDiff: best.diff, ambiguous: fits.filter((f) => f.diff === best.diff).length > 1 });
  }
  return { proposals, unpaired };
}

/** Usulan pasangan mutasi ↔ transfer (jumlah sama, tanggal ± N hari) untuk semua mutasi belum dicocokkan. */
export async function proposeStatementMatches(ctx: ActorContext, filter: { bankAccountId?: string | null } = {}, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m4.incoming_transfer.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  return proposeMatchesTx(tx, ctx, filter);
}

/** Konfirmasi pasangan usulan (US-M4-04 KP-3). */
export async function confirmStatementMatches(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<{ matched: number }> {
  await authorize(ctx, "m4.incoming_transfer.match", { tx: opts.tx });
  const data = parseInput(confirmMatchesSchema, input);
  return runService(ctx, opts, async (tx) => {
    let matched = 0;
    for (const pair of data.pairs) {
      const line = await loadLine(tx, ctx, pair.lineId);
      await matchCore(tx, ctx, pair.transferId, {
        date: line.lineDate,
        amount: line.amount,
        note: [line.description, line.reference].filter(Boolean).join(" · ") || `Mutasi ${formatTanggal(line.lineDate, { weekday: false })}`,
        line,
      });
      matched++;
    }
    return { matched };
  });
}

/** Mutasi tanpa pasangan → tindak lanjut / diabaikan (mis. bunga bank, transfer antar rekening) dengan catatan. */
export async function markStatementLine(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<StatementLineRow> {
  await authorize(ctx, "m4.incoming_transfer.match", { tx: opts.tx });
  const data = parseInput(markStatementLineSchema, input, { note: "Catatan" });
  return runService(ctx, opts, async (tx) => {
    const line = await loadLine(tx, ctx, data.lineId);
    if (line.status === "matched") throw new DomainError("LINE_MATCHED", "Mutasi ini sudah cocok dengan transfer.");
    const [row] = await tx.update(bankStatementLines).set({ status: data.status, followUpNote: data.note, matchedBy: ctx.userId, updatedAt: ctx.now }).where(eq(bankStatementLines.id, line.id)).returning();
    await auditRecord(tx, { ctx, objectType: "bank_statement_line", objectId: line.id, action: data.status, before: { status: line.status }, after: { status: data.status }, reason: data.note, rule: "US-M4-04 KP-3" });
    return row!;
  });
}

/** Mutasi masuk tanpa pasangan & yang ditindaklanjuti (daftar tindak lanjut). */
export async function listStatementLines(ctx: ActorContext, filter: { status?: StatementLineRow["status"] | "open" | "all" } = {}, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m4.incoming_transfer.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const status = filter.status ?? "open";
  const conds = [eq(bankAccounts.tenantId, ctx.tenantId)];
  if (status === "open") conds.push(inArray(bankStatementLines.status, ["unmatched", "follow_up"]));
  else if (status !== "all") conds.push(eq(bankStatementLines.status, status));
  return (
    await tx
      .select({ l: bankStatementLines, bankName: bankAccounts.bankName, accountNumber: bankAccounts.accountNumber })
      .from(bankStatementLines)
      .innerJoin(bankAccounts, eq(bankAccounts.id, bankStatementLines.bankAccountId))
      .where(and(...conds))
      .orderBy(desc(bankStatementLines.lineDate))
      .limit(1000)
  ).map((r) => ({ ...r.l, bankLabel: `${r.bankName} ${r.accountNumber}` }));
}

// =====================================================================================================================
// Tidak ditemukan (US-M4-04 KP-4) — job harian
// =====================================================================================================================

/** Transfer Belum dicocokkan > PAR-39 hari → Tidak ditemukan + notifikasi + `transfer.not_found` (M5 piutang sementara). */
export async function runTransferNotFoundCheck(now: Date = new Date(), opts: { db?: Db; tenantId?: string } = {}): Promise<{ flagged: number }> {
  return withTx(
    async (tx) => {
      const today = toBusinessDate(now);
      const conds = [eq(incomingTransfers.status, "unmatched")];
      if (opts.tenantId) conds.push(eq(incomingTransfers.tenantId, opts.tenantId));
      const open = await tx.select().from(incomingTransfers).where(and(...conds)).limit(2000);
      let flagged = 0;
      const rulesByTenant = new Map<string, number>();
      for (const t of open) {
        let days = rulesByTenant.get(t.tenantId);
        if (days === undefined) {
          days = (await cashRules(tx, today, t.tenantId)).transferNotFoundDays;
          rulesByTenant.set(t.tenantId, days);
        }
        if (daysBetween(t.transferDate, today) <= days) continue;
        const ctx = systemContext({ tenantId: t.tenantId, now });
        await tx.update(incomingTransfers).set({ status: "not_found", notFoundAt: now, updatedAt: now }).where(eq(incomingTransfers.id, t.id));
        await auditRecord(tx, { ctx, objectType: "incoming_transfer", objectId: t.id, action: "not_found", before: { status: "unmatched" }, after: { status: "not_found" }, rule: "US-M4-04 KP-4, PAR-39", businessDate: t.businessDate });
        const who = t.customerId ? (await tx.select({ name: customers.name }).from(customers).where(eq(customers.id, t.customerId)).limit(1))[0]?.name : null;
        await notify(tx, {
          event: "transfer.not_found",
          tenantId: t.tenantId,
          title: `Transfer ${formatRupiah(t.amount)} tidak ditemukan di mutasi`,
          body: `${label("transfer_source_kind", t.sourceKind)}${who ? ` — ${who}` : ""}, tercatat ${formatTanggal(t.transferDate, { weekday: false })} (> ${days} hari). Tindak lanjuti ke pelanggan/penyetor.`,
          objectType: "incoming_transfer",
          objectId: t.id,
          valueAmount: t.amount,
          link: `/kas/transfer?id=${t.id}`,
          groupKey: `transfer.not_found:${t.id}`,
          now,
        });
        const tripId =
          t.sourceObjectType === "trip_payment" && t.sourceObjectId
            ? ((await tx.select({ tripId: tripPayments.tripId }).from(tripPayments).where(eq(tripPayments.id, t.sourceObjectId)).limit(1))[0]?.tripId ?? null)
            : null;
        await emit(
          tx,
          "transfer.not_found",
          {
            incomingTransferId: t.id,
            amount: t.amount,
            sourceKind: t.sourceKind,
            customerId: t.customerId,
            sourceObjectType: t.sourceObjectType,
            sourceObjectId: t.sourceObjectId,
            transferDate: t.transferDate,
            businessDate: t.businessDate,
            tripId,
            outletId: t.outletId,
          },
          { ctx, tenantId: t.tenantId, businessDate: today, objectType: "incoming_transfer", objectId: t.id },
        );
        flagged++;
      }
      return { flagged };
    },
    { db: opts.db },
  );
}

// =====================================================================================================================
// Hasil harian (US-M4-04 KP-5) — masukan rekonsiliasi bank M11
// =====================================================================================================================

export async function dailyMatchingResults(ctx: ActorContext, filter: { from: BusinessDate; to: BusinessDate }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m4.incoming_transfer.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx
    .select({ t: incomingTransfers, bankName: bankAccounts.bankName, accountNumber: bankAccounts.accountNumber })
    .from(incomingTransfers)
    .leftJoin(bankAccounts, eq(bankAccounts.id, incomingTransfers.bankAccountId))
    .where(
      and(
        eq(incomingTransfers.tenantId, ctx.tenantId),
        or(
          and(eq(incomingTransfers.status, "matched"), sql`(${incomingTransfers.matchedAt} at time zone 'Asia/Jakarta')::date between ${filter.from}::date and ${filter.to}::date`),
          and(inArray(incomingTransfers.status, ["unmatched", "not_found"]), lte(incomingTransfers.transferDate, filter.to)),
        ),
      ),
    )
    .orderBy(asc(incomingTransfers.transferDate));
  return rows.map(({ t, bankName, accountNumber }) => ({
    matchedOn: t.matchedAt ? toBusinessDate(t.matchedAt) : null,
    transferDate: t.transferDate,
    sourceKind: t.sourceKind,
    amount: t.amount,
    status: t.status,
    bank: bankName ? `${bankName} ${accountNumber}` : null,
    matchRefDate: t.matchRefDate,
    matchRefAmount: t.matchRefAmount,
    matchRefNote: t.matchRefNote,
    reference: t.reference,
  }));
}

/** Transfer belum dicocokkan (untuk tutup kas & posisi kas). */
export async function unmatchedTransfers(tx: Tx, tenantId: string, upTo: BusinessDate): Promise<IncomingTransferRow[]> {
  return tx
    .select()
    .from(incomingTransfers)
    .where(and(eq(incomingTransfers.tenantId, tenantId), inArray(incomingTransfers.status, ["unmatched", "not_found"]), lte(incomingTransfers.transferDate, upTo)))
    .orderBy(asc(incomingTransfers.transferDate));
}
