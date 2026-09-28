/**
 * M11 — saldo awal & cut-over akuntansi (US-M11-09, NFR-34, NFR-36, PTB-44, PTB-47):
 * - Cut-over hanya tanggal 1 (parameter `accounting.cutover_date`, ditetapkan pemilik); transaksi sebelum tanggal itu
 *   tidak dimigrasi; jurnal bertanggal sebelum cut-over DITOLAK kecuali jurnal saldo awal (penjaga DB EQ006).
 * - Jurnal saldo awal per kelompok (kas & bank, piutang per faktur M5, utang per nota M7, persediaan toko & bahan depot,
 *   aset tetap, ekuitas) → Draf → Ditandatangani pemilik per kelompok (`data_signoffs`) → disahkan akuntan → Terposting.
 *   Selisih debit–kredit tiap kelompok diseimbangkan ke akun ekuitas penyeimbang (pemetaan `m11.opening_balance`).
 * - Penyesuaian saldo awal ≤ PAR-62 bulan setelah cut-over: jurnal "penyesuaian saldo awal" + persetujuan pemilik +
 *   catatan akuntan; setelahnya koreksi mengikuti jurnal biasa.
 */
import "server-only";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import {
  dataSignoffs,
  invoices,
  journals,
  manualJournalDetails,
  officeCashMovements,
  openingBalanceBatches,
  openingBalanceLines,
  outlets,
  purchaseReceipts,
  stockLedger,
  products,
} from "@/db/schema";
import { enumValues, label, type DataSignoffGroup, type EnumValue, type ProfitCenter } from "@/lib/labels";
import { formatRupiah, zRupiahNonNegative } from "@/lib/money";
import { addDays, isBusinessDate, monthOf, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import type { ApprovalRow } from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";

import { ASSET_CATEGORY_ACCOUNT } from "../constants";
import { accountsByCode, assertBalancedLines, assertPostableAccounts, currentCutover, insertJournal, loadJournal, mappingAccounts, shiftPeriod, sumLines } from "./common";
import { importedAssetsForOpening } from "./assets";
import { journalLineSchema, postManual } from "./manual";

type Group = EnumValue<"opening_batch_group">;
type BatchRow = typeof openingBalanceBatches.$inferSelect;
type LineRow = typeof openingBalanceLines.$inferSelect;

export const OPENING_GROUPS: Group[] = ["cash_bank", "receivables", "payables", "inventory", "fixed_assets", "equity"];

const SIGNOFF_GROUP: Record<Group, DataSignoffGroup> = {
  cash_bank: "opening_cash_bank",
  receivables: "opening_receivables",
  payables: "opening_payables",
  inventory: "stock_opening",
  fixed_assets: "fixed_assets",
  equity: "opening_equity",
};

async function requireCutover(tx: Tx, ctx: ActorContext): Promise<BusinessDate> {
  const cut = await currentCutover(tx, ctxBusinessDate(ctx));
  if (!cut) throw new DomainError("CUTOVER_REQUIRED", "Tanggal cut-over akuntansi belum ditetapkan pemilik (hanya tanggal 1).");
  return cut;
}

/** Batch terbaru per kelompok (batch lama yang digantikan tetap tersimpan sebagai riwayat). */
async function latestBatches(tx: Tx, tenantId: string): Promise<Map<Group, BatchRow>> {
  const rows = await tx.select().from(openingBalanceBatches).where(eq(openingBalanceBatches.tenantId, tenantId)).orderBy(desc(openingBalanceBatches.createdAt));
  const out = new Map<Group, BatchRow>();
  for (const r of rows) if (!out.has(r.group)) out.set(r.group, r);
  return out;
}

async function batchLines(tx: Tx, batchIds: readonly string[]): Promise<Map<string, LineRow[]>> {
  const out = new Map<string, LineRow[]>();
  if (!batchIds.length) return out;
  const rows = await tx.select().from(openingBalanceLines).where(inArray(openingBalanceLines.batchId, [...batchIds])).orderBy(asc(openingBalanceLines.createdAt));
  for (const r of rows) out.set(r.batchId, [...(out.get(r.batchId) ?? []), r]);
  return out;
}

export async function openingOverview(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.opening_balance.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const cutover = await currentCutover(tx, ctxBusinessDate(ctx));
  const latest = await latestBatches(tx, ctx.tenantId);
  const lines = await batchLines(
    tx,
    [...latest.values()].map((b) => b.id),
  );
  const { max_months_after_cutover } = await params.get(tx, "PAR-62", ctxBusinessDate(ctx));
  const adjustmentDeadline = cutover ? addDays(`${shiftPeriod(monthOf(cutover), max_months_after_cutover)}-01`, -1) : null;
  const adjustments = await tx.select().from(journals).where(and(eq(journals.tenantId, ctx.tenantId), eq(journals.kind, "opening_adjustment"))).orderBy(desc(journals.createdAt)).limit(50);
  return {
    cutover,
    adjustmentDeadline,
    groups: OPENING_GROUPS.map((g) => {
      const b = latest.get(g) ?? null;
      const ls = b ? (lines.get(b.id) ?? []) : [];
      const t = sumLines(ls);
      return { group: g, label: label("opening_batch_group", g), batch: b, lines: ls, debit: t.debit, credit: t.credit };
    }),
    adjustments,
  };
}

const cutoverSchema = z
  .object({
    date: z
      .string()
      .refine(isBusinessDate, { error: "Tanggal harus YYYY-MM-DD." })
      .refine((d) => d.endsWith("-01"), { error: "Tanggal cut-over akuntansi hanya boleh tanggal 1 (NFR-36)." }),
    reason: z.string().trim().min(5, { error: "Alasan wajib diisi (minimal 5 karakter)." }),
  })
  .strict();

/** Pemilik menetapkan tanggal cut-over (parameter berjejak 6.2b; hanya tanggal 1). Ditolak bila saldo awal sudah terposting. */
export async function setCutoverDate(ctx: ActorContext, input: z.input<typeof cutoverSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.opening_balance.sign", { tx: opts.tx });
  const data = parseInput(cutoverSchema, input, { date: "Tanggal cut-over", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const posted = await tx.select({ id: openingBalanceBatches.id }).from(openingBalanceBatches).where(and(eq(openingBalanceBatches.tenantId, ctx.tenantId), eq(openingBalanceBatches.status, "posted"))).limit(1);
    if (posted[0]) throw new DomainError("OPENING_POSTED", "Saldo awal sudah terposting — tanggal cut-over tidak dapat diubah.");
    return params.set(ctx, "accounting.cutover_date", { date: data.date }, ctxBusinessDate(ctx), data.reason, { tx });
  });
}

export type OpeningLineInput = z.input<typeof openingLineSchema>;

const openingLineSchema = journalLineSchema
  .extend({
    description: z.string().trim().max(200).nullable().optional(),
    referenceType: z.string().trim().max(40).nullable().optional(),
    referenceId: z.uuid().nullable().optional(),
  })
  .omit({ memo: true });

/** Usulan baris saldo awal per kelompok dari data modul (M4 kas, M5 faktur saldo awal, M7 nota, M6/M7 stok, aset impor). */
export async function prefillOpeningGroup(ctx: ActorContext, input: { group: Group }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.opening_balance.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const cutover = await currentCutover(tx, ctxBusinessDate(ctx));
  const codes = ["1-1101", "1-1401", "2-1101", "1-1501", "1-1502", ...Object.values(ASSET_CATEGORY_ACCOUNT)];
  const byCode = await accountsByCode(tx, ctx.tenantId, codes);
  const id = (c: string) => byCode.get(c)?.id ?? null;
  const out: (OpeningLineInput & { accountCode: string })[] = [];
  if (input.group === "cash_bank") {
    const [o] = await tx.select().from(officeCashMovements).where(and(eq(officeCashMovements.tenantId, ctx.tenantId), eq(officeCashMovements.kind, "opening_balance"))).limit(1);
    if (o && id("1-1101")) out.push({ accountCode: "1-1101", accountId: id("1-1101")!, profitCenter: "SHARED", debit: o.amount, credit: 0, description: "Kas kantor (hitung fisik cut-over, M4)", referenceType: "office_cash_movement", referenceId: o.id });
  } else if (input.group === "receivables") {
    const rows = await tx.select().from(invoices).where(and(eq(invoices.tenantId, ctx.tenantId), eq(invoices.isOpeningBalance, true)));
    for (const r of rows) if (id("1-1401") && r.amount > 0) out.push({ accountCode: "1-1401", accountId: id("1-1401")!, profitCenter: "SHARED", debit: r.amount, credit: 0, description: `Piutang faktur ${r.number}`, referenceType: "invoice", referenceId: r.id });
  } else if (input.group === "payables") {
    const rows = await tx.select().from(purchaseReceipts).where(and(eq(purchaseReceipts.tenantId, ctx.tenantId), eq(purchaseReceipts.isOpeningPayable, true)));
    for (const r of rows) if (id("2-1101") && r.totalAmount > 0) out.push({ accountCode: "2-1101", accountId: id("2-1101")!, profitCenter: "L4", outletId: r.outletId, debit: 0, credit: r.totalAmount, description: `Utang nota ${r.supplierNoteNumber ?? r.number ?? ""}`.trim(), referenceType: "purchase_receipt", referenceId: r.id });
  } else if (input.group === "inventory") {
    const rows = await tx
      .select({ outletId: stockLedger.outletId, kind: outlets.kind, value: sql<string>`coalesce(sum(${stockLedger.quantity} * coalesce(${stockLedger.unitCost}, 0)), 0)` })
      .from(stockLedger)
      .innerJoin(outlets, eq(outlets.id, stockLedger.outletId))
      .innerJoin(products, eq(products.id, stockLedger.productId))
      .where(and(eq(stockLedger.tenantId, ctx.tenantId), eq(stockLedger.kind, "opening")))
      .groupBy(stockLedger.outletId, outlets.kind);
    for (const r of rows) {
      const code = r.kind === "store" ? "1-1501" : "1-1502";
      const value = Math.round(Number(r.value));
      if (id(code) && value > 0) out.push({ accountCode: code, accountId: id(code)!, profitCenter: (r.kind === "store" ? "L4" : "L3") as ProfitCenter, outletId: r.outletId, debit: value, credit: 0, description: "Persediaan opname cut-over", referenceType: "outlet", referenceId: r.outletId });
    }
  } else if (input.group === "fixed_assets") {
    for (const { asset, openingAccumulated } of await importedAssetsForOpening(tx, ctx.tenantId)) {
      if (asset.assetAccountId) out.push({ accountCode: ASSET_CATEGORY_ACCOUNT[asset.category], accountId: asset.assetAccountId, profitCenter: asset.profitCenter, outletId: asset.outletId, debit: asset.acquisitionCost, credit: 0, description: `Aset ${asset.code} ${asset.name}`, referenceType: "fixed_asset", referenceId: asset.id });
      if (openingAccumulated > 0 && asset.accumulatedAccountId) out.push({ accountCode: "akumulasi", accountId: asset.accumulatedAccountId, profitCenter: asset.profitCenter, outletId: asset.outletId, debit: 0, credit: openingAccumulated, description: `Akumulasi penyusutan ${asset.code}`, referenceType: "fixed_asset", referenceId: asset.id });
    }
  }
  return { cutover, group: input.group, lines: out };
}

const batchSchema = z
  .object({
    group: z.enum(enumValues("opening_batch_group")),
    lines: z.array(openingLineSchema).min(1, { error: "Isi minimal satu baris saldo awal." }).max(500),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

/** Simpan draf saldo awal kelompok (Admin Keuangan). Draf baru menggantikan draf/tanda tangan sebelumnya (wajib ditandatangani ulang). */
export async function saveOpeningBatch(ctx: ActorContext, input: z.input<typeof batchSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.opening_balance.create", { tx: opts.tx });
  const data = parseInput(batchSchema, input, { lines: "Baris saldo awal" });
  return runService(ctx, opts, async (tx) => {
    const cutover = await requireCutover(tx, ctx);
    const current = (await latestBatches(tx, ctx.tenantId)).get(data.group);
    if (current?.status === "posted") throw new DomainError("OPENING_POSTED", "Saldo awal kelompok ini sudah terposting — gunakan penyesuaian saldo awal (persetujuan pemilik).");
    const lines = data.lines.map((l) => ({ ...l, debit: l.debit ?? 0, credit: l.credit ?? 0 }));
    for (const [i, l] of lines.entries()) {
      if ((l.debit > 0) === (l.credit > 0)) throw new DomainError("JOURNAL_AMOUNT", `Baris ${i + 1}: isi salah satu dari debit atau kredit.`);
    }
    await assertPostableAccounts(
      tx,
      ctx.tenantId,
      lines.map((l) => l.accountId),
    );
    const [batch] = await tx.insert(openingBalanceBatches).values({ tenantId: ctx.tenantId, group: data.group, cutoverDate: cutover, status: "draft", notes: data.notes ?? null, createdBy: ctx.userId }).returning();
    await tx.insert(openingBalanceLines).values(
      lines.map((l) => ({
        batchId: batch!.id,
        accountId: l.accountId,
        profitCenter: l.profitCenter,
        outletId: l.outletId ?? null,
        debit: l.debit,
        credit: l.credit,
        description: l.description ?? null,
        referenceType: l.referenceType ?? null,
        referenceId: l.referenceId ?? null,
      })),
    );
    const t = sumLines(lines);
    await auditRecord(tx, { ctx, objectType: "opening_balance_batch", objectId: batch!.id, action: "create", after: { group: data.group, cutover, lines: lines.length, debit: t.debit, credit: t.credit, supersedes: current?.id ?? null }, rule: "US-M11-09 KP-2" });
    await notify(tx, {
      event: "initial_data.signoff_pending",
      tenantId: ctx.tenantId,
      title: `Saldo awal ${label("opening_batch_group", data.group)} menunggu tanda tangan`,
      body: `Debit ${formatRupiah(t.debit)} · kredit ${formatRupiah(t.credit)} (${lines.length} baris). Tinjau & tanda tangani di Akuntansi > Saldo awal.`,
      recipients: { roles: ["owner"] },
      objectType: "opening_balance_batch",
      objectId: batch!.id,
      link: "/akuntansi/saldo-awal",
      now: ctx.now,
    });
    return batch!;
  });
}

const signSchema = z.object({ batchId: z.uuid(), note: z.string().trim().max(300).nullable().optional() }).strict();

/** Pemilik menandatangani saldo awal satu kelompok (NFR-34). */
export async function signOpeningBatch(ctx: ActorContext, input: z.input<typeof signSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.opening_balance.sign", { tx: opts.tx });
  const data = parseInput(signSchema, input);
  return runService(ctx, opts, async (tx) => {
    const [b] = await tx.select().from(openingBalanceBatches).where(and(eq(openingBalanceBatches.id, data.batchId), eq(openingBalanceBatches.tenantId, ctx.tenantId))).for("update").limit(1);
    if (!b) throw new NotFoundError("Saldo awal tidak ditemukan.");
    if ((await latestBatches(tx, ctx.tenantId)).get(b.group)?.id !== b.id) throw new DomainError("BATCH_SUPERSEDED", "Draf ini sudah digantikan draf yang lebih baru.");
    if (b.status !== "draft") throw new DomainError("BATCH_STATUS", `Saldo awal ini berstatus ${label("opening_batch_status", b.status)}.`);
    const lines = (await batchLines(tx, [b.id])).get(b.id) ?? [];
    const t = sumLines(lines);
    const [signoff] = await tx
      .insert(dataSignoffs)
      .values({
        tenantId: ctx.tenantId,
        group: SIGNOFF_GROUP[b.group],
        title: `Saldo awal ${label("opening_batch_group", b.group)} per ${b.cutoverDate}`,
        summary: { batchId: b.id, lines: lines.length, debit: t.debit, credit: t.credit },
        status: "signed",
        signedBy: ctx.userId,
        signedAt: ctx.now,
        notes: data.note ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    const [row] = await tx.update(openingBalanceBatches).set({ status: "signed", signoffId: signoff!.id, updatedAt: new Date() }).where(eq(openingBalanceBatches.id, b.id)).returning();
    await auditRecord(tx, { ctx, objectType: "opening_balance_batch", objectId: b.id, action: "sign", after: { group: b.group, debit: t.debit, credit: t.credit, signoffId: signoff!.id }, reason: data.note ?? null, rule: "NFR-34" });
    return row!;
  });
}

const attestSchema = z.object({ note: z.string().trim().min(5, { error: "Catatan pengesahan wajib diisi." }) }).strict();

/** Akuntan mengesahkan seluruh saldo awal yang sudah ditandatangani (sebelum posting). */
export async function attestOpeningBalances(ctx: ActorContext, input: z.input<typeof attestSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.opening_balance.attest", { tx: opts.tx });
  const data = parseInput(attestSchema, input, { note: "Catatan" });
  return runService(ctx, opts, async (tx) => {
    const latest = [...(await latestBatches(tx, ctx.tenantId)).values()];
    const drafts = latest.filter((b) => b.status === "draft");
    if (drafts.length) throw new DomainError("NOT_SIGNED", `Kelompok ${drafts.map((d) => label("opening_batch_group", d.group)).join(", ")} belum ditandatangani pemilik.`);
    const signed = latest.filter((b) => b.status === "signed");
    if (!signed.length) throw new DomainError("NOTHING_TO_ATTEST", "Belum ada saldo awal bertanda tangan untuk disahkan.");
    for (const b of signed) {
      await tx.update(openingBalanceBatches).set({ accountantApprovedBy: ctx.userId, accountantApprovedAt: ctx.now, updatedAt: new Date() }).where(eq(openingBalanceBatches.id, b.id));
      if (b.signoffId) await tx.update(dataSignoffs).set({ accountantSignedBy: ctx.userId, accountantSignedAt: ctx.now, updatedAt: new Date() }).where(eq(dataSignoffs.id, b.signoffId));
    }
    await auditRecord(tx, { ctx, objectType: "opening_balance", objectId: ctx.tenantId, action: "attest", after: { groups: signed.map((b) => b.group) }, reason: data.note, rule: "US-M11-09 KP-2" });
    return { attested: signed.length };
  });
}

/** Posting saldo awal (Admin Keuangan): semua kelompok bertanda tangan pemilik & disahkan akuntan → jurnal saldo awal per kelompok. */
export async function postOpeningBalances(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.opening_balance.create", { tx: opts.tx });
  return runService(ctx, opts, async (tx) => {
    const cutover = await requireCutover(tx, ctx);
    const latest = [...(await latestBatches(tx, ctx.tenantId)).values()];
    const pending = latest.filter((b) => b.status !== "posted");
    if (!pending.length) throw new DomainError("NOTHING_TO_POST", "Tidak ada saldo awal yang menunggu posting.");
    const notReady = pending.filter((b) => b.status !== "signed" || !b.accountantApprovedAt);
    if (notReady.length) {
      throw new DomainError(
        "OPENING_NOT_READY",
        `Belum dapat diposting: ${notReady.map((b) => `${label("opening_batch_group", b.group)} (${b.status !== "signed" ? "belum ditandatangani pemilik" : "belum disahkan akuntan"})`).join(", ")}.`,
      );
    }
    const equity = await mappingAccounts(tx, ctx.tenantId, "m11.opening_balance", "equity_balancing", cutover);
    const lines = await batchLines(
      tx,
      pending.map((b) => b.id),
    );
    const posted: string[] = [];
    for (const b of pending) {
      const ls = lines.get(b.id) ?? [];
      const t = sumLines(ls);
      const jl = ls.map((l) => ({ accountId: l.accountId, profitCenter: l.profitCenter, outletId: l.outletId, debit: l.debit, credit: l.credit, memo: l.description }));
      const diff = t.debit - t.credit;
      if (diff > 0) jl.push({ accountId: equity.creditAccountId, profitCenter: "SHARED", outletId: null, debit: 0, credit: diff, memo: "Ekuitas penyeimbang saldo awal" });
      if (diff < 0) jl.push({ accountId: equity.debitAccountId, profitCenter: "SHARED", outletId: null, debit: -diff, credit: 0, memo: "Ekuitas penyeimbang saldo awal" });
      assertBalancedLines(jl);
      const { journal } = await insertJournal(tx, {
        tenantId: ctx.tenantId,
        kind: "opening_balance",
        date: cutover,
        description: `Saldo awal ${label("opening_batch_group", b.group)} per ${cutover}`,
        lines: jl,
        ctx,
        sourceType: "m11.opening_balance",
        sourceObject: { type: "opening_balance_batch", id: b.id },
        periodMode: "strict",
      });
      await tx.update(openingBalanceBatches).set({ status: "posted", journalId: journal.id, updatedAt: new Date() }).where(eq(openingBalanceBatches.id, b.id));
      await auditRecord(tx, { ctx, objectType: "opening_balance_batch", objectId: b.id, action: "post", after: { journal: journal.number, debit: t.debit, credit: t.credit, balancing: diff }, rule: "US-M11-09 KP-2" });
      posted.push(journal.id);
    }
    return { posted: posted.length, journalIds: posted };
  });
}

const adjustmentSchema = z
  .object({
    lines: z.array(journalLineSchema).min(2).max(50),
    reason: z.string().trim().min(5, { error: "Alasan penyesuaian wajib diisi." }),
    accountantNote: z.string().trim().min(5, { error: "Catatan akuntan wajib diisi (PTB-44)." }),
    attachmentId: z.uuid().nullable().optional(),
    amount: zRupiahNonNegative.optional(),
  })
  .strict();

/**
 * Ajukan penyesuaian saldo awal (≤ PAR-62 bulan setelah cut-over): jurnal "penyesuaian saldo awal" + persetujuan pemilik
 * + catatan akuntan. Setelah batas waktu → DITOLAK (koreksi lewat jurnal biasa).
 */
export async function requestOpeningAdjustment(ctx: ActorContext, input: z.input<typeof adjustmentSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.opening_balance.create", { tx: opts.tx });
  const data = parseInput(adjustmentSchema, input, { reason: "Alasan", accountantNote: "Catatan akuntan" });
  return runService(ctx, opts, async (tx) => {
    const cutover = await requireCutover(tx, ctx);
    const today = ctxBusinessDate(ctx);
    const { max_months_after_cutover } = await params.get(tx, "PAR-62", today);
    const deadline = addDays(`${shiftPeriod(monthOf(cutover), max_months_after_cutover)}-01`, -1);
    if (today > deadline) {
      throw new DomainError("ADJUSTMENT_WINDOW_CLOSED", `Penyesuaian saldo awal hanya sampai ${deadline} (${max_months_after_cutover} bulan setelah cut-over, PTB-44). Catat koreksi sebagai jurnal manual biasa.`);
    }
    const lines = data.lines.map((l) => ({ ...l, debit: l.debit ?? 0, credit: l.credit ?? 0 }));
    const { journal } = await insertJournal(tx, {
      tenantId: ctx.tenantId,
      kind: "opening_adjustment",
      status: "submitted",
      date: today,
      description: `Penyesuaian saldo awal: ${data.reason}`,
      lines: lines.map((l) => ({ accountId: l.accountId, profitCenter: l.profitCenter, outletId: l.outletId ?? null, debit: l.debit, credit: l.credit, memo: l.memo ?? null })),
      ctx,
      attachmentId: data.attachmentId ?? null,
      sourceType: "m11.opening_balance",
    });
    if (data.attachmentId) await linkAttachment(tx, data.attachmentId, { type: "journal", id: journal.id });
    await tx.insert(manualJournalDetails).values({ tenantId: ctx.tenantId, journalId: journal.id, accountantNote: data.accountantNote });
    const req = await approvals.submit(
      ctx,
      {
        type: "opening_balance_adjustment",
        objectType: "opening_adjustment_journal",
        objectId: journal.id,
        amount: journal.totalDebit,
        reason: `${journal.number}: ${data.reason}. Catatan akuntan: ${data.accountantNote}`,
        payload: { number: journal.number, link: `/akuntansi/jurnal/${journal.id}` },
      },
      { tx },
    );
    await tx.update(journals).set({ approvalRequestId: req.id, updatedAt: new Date() }).where(eq(journals.id, journal.id));
    await auditRecord(tx, { ctx, objectType: "journal", objectId: journal.id, action: "submit", after: { number: journal.number, kind: "opening_adjustment", approval: req.number, deadline }, reason: data.reason, rule: "US-M11-09 KP-3, PTB-44" });
    return { journal, approvalId: req.id };
  });
}

export async function onOpeningAdjustmentApproved(tx: Tx, request: ApprovalRow, ctx: ActorContext): Promise<Record<string, unknown>> {
  const j = await loadJournal(tx, request.tenantId, request.objectId, { forUpdate: true });
  if (j.status !== "submitted") return { skipped: true };
  const posted = await postManual(tx, ctx, j, { requiresOwnerReview: false, periodMode: "forward", approvalId: request.id });
  return { journalId: posted.id, number: posted.number };
}

export async function onOpeningAdjustmentRejected(tx: Tx, request: ApprovalRow, ctx: ActorContext, reason: string | null): Promise<Record<string, unknown>> {
  const j = await loadJournal(tx, request.tenantId, request.objectId, { forUpdate: true });
  if (j.status !== "submitted") return { skipped: true };
  await tx.update(journals).set({ status: "rejected", updatedAt: new Date() }).where(eq(journals.id, j.id));
  await auditRecord(tx, { ctx, objectType: "journal", objectId: j.id, action: "reject", after: { status: "rejected" }, reason, rule: "US-M11-09 KP-3" });
  return { journalId: j.id, status: "rejected" };
}

/** Saldo awal sudah terposting (prasyarat periode cut-over). */
export async function openingPosted(tx: Tx, tenantId: string): Promise<boolean> {
  const rows = await tx.select({ id: openingBalanceBatches.id }).from(openingBalanceBatches).where(and(eq(openingBalanceBatches.tenantId, tenantId), eq(openingBalanceBatches.status, "posted"))).limit(1);
  return rows.length > 0;
}
