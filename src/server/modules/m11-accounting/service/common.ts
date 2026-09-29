/**
 * M11 — pembantu bersama layanan akuntansi: periode, akun, cut-over, tenant pembukuan, penomoran jurnal, sisipan jurnal
 * terposting non-otomatis (pembalik, penyusutan, alokasi, saldo awal) dengan aturan yang SAMA dengan `postJournal`
 * (seimbang, akun aktif, periode terbuka pertama + asal periode, penomoran `J-YYMM-NNNNN`).
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";

import { accountingPeriods, accounts, bankAccounts, journalLines, journals, tenants } from "@/db/schema";
import type { JournalKind, ProfitCenter } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, firstDayOfMonth, isBusinessDate, lastDayOfMonth, monthOf, type BusinessDate } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { isTransaction, withTx, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError } from "@/server/core/errors";
import { isEnabled } from "@/server/core/flags";
import { resolveMapping, resolvePostingPeriod } from "@/server/core/ledger";
import { nextNumber } from "@/server/core/numbering";
import * as params from "@/server/core/params";

export type AccountRow = typeof accounts.$inferSelect;
export type JournalRow = typeof journals.$inferSelect;
export type JournalLineRow = typeof journalLines.$inferSelect;
export type PeriodRow = typeof accountingPeriods.$inferSelect;

export const OPEN_PERIOD_STATUSES = ["open", "reopened"] as const;

export function isOpenStatus(status: string): boolean {
  return status === "open" || status === "reopened";
}

/** 'YYYY-MM' → periode sebelum/berikutnya. */
export function shiftPeriod(period: string, months: number): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + months;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

export function periodStart(period: string): BusinessDate {
  return `${period}-01`;
}

export function periodEnd(period: string): BusinessDate {
  return lastDayOfMonth(`${period}-01`);
}

export function isPeriodLabel(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** Periode akuntansi (dibuat Terbuka bila belum ada). */
export async function ensurePeriod(tx: Tx, tenantId: string, period: string): Promise<PeriodRow> {
  const found = await tx
    .select()
    .from(accountingPeriods)
    .where(and(eq(accountingPeriods.tenantId, tenantId), eq(accountingPeriods.period, period)))
    .limit(1);
  if (found[0]) return found[0];
  await tx
    .insert(accountingPeriods)
    .values({ tenantId, period, startDate: periodStart(period), endDate: periodEnd(period), status: "open" })
    .onConflictDoNothing();
  const again = await tx
    .select()
    .from(accountingPeriods)
    .where(and(eq(accountingPeriods.tenantId, tenantId), eq(accountingPeriods.period, period)))
    .limit(1);
  return again[0]!;
}

export async function loadPeriod(tx: Tx, tenantId: string, periodId: string, opts: { forUpdate?: boolean } = {}): Promise<PeriodRow> {
  const q = tx.select().from(accountingPeriods).where(and(eq(accountingPeriods.id, periodId), eq(accountingPeriods.tenantId, tenantId)));
  const rows = opts.forUpdate ? await q.for("update").limit(1) : await q.limit(1);
  if (!rows[0]) throw new NotFoundError("Periode akuntansi tidak ditemukan.");
  return rows[0];
}

/** Tanggal cut-over akuntansi yang BERLAKU SAAT INI (sama dengan penjaga DB `equa_accounting_cutover_date`). */
export async function currentCutover(tx: Tx, today: BusinessDate): Promise<BusinessDate | null> {
  const value = await params.get(tx, "accounting.cutover_date", today);
  return value.date ?? null;
}

/** Tenant pembukuan EQUA (bukan tenant mitra RL-7 — laporan keuangan mitra di luar cakupan 7.11.8). */
export async function isAccountingTenant(tx: Tx, tenantId: string): Promise<boolean> {
  const rows = await tx.select({ kind: tenants.kind }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return rows[0]?.kind === "owner";
}

export async function m11Active(tx: Tx, tenantId: string): Promise<boolean> {
  return isEnabled(tx, "accounting.m11_active", { tenantId });
}

export async function accountsByCode(tx: Tx, tenantId: string, codes: readonly string[]): Promise<Map<string, AccountRow>> {
  if (codes.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.code, [...new Set(codes)])));
  return new Map(rows.map((a) => [a.code, a]));
}

export async function accountsById(tx: Tx, ids: readonly string[]): Promise<Map<string, AccountRow>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(accounts)
    .where(inArray(accounts.id, [...new Set(ids)]));
  return new Map(rows.map((a) => [a.id, a]));
}

export async function requireAccountByCode(tx: Tx, tenantId: string, code: string): Promise<AccountRow> {
  const a = (await accountsByCode(tx, tenantId, [code])).get(code);
  if (!a) throw new DomainError("ACCOUNT_MISSING", `Akun ${code} belum ada di bagan akun. Tambahkan akunnya dulu.`);
  return a;
}

/** Akun buku rekening bank (M4 `bank_accounts.gl_account_id`), bila diatur. */
export async function bankGlAccountId(tx: Tx, bankAccountId: string | null | undefined): Promise<string | null> {
  if (!bankAccountId) return null;
  const rows = await tx.select({ gl: bankAccounts.glAccountId }).from(bankAccounts).where(eq(bankAccounts.id, bankAccountId)).limit(1);
  return rows[0]?.gl ?? null;
}

/** Akun dari pemetaan (sisi debit/kredit) — dipakai sebagai tabel pencarian akun khusus (alokasi, pelepasan, saldo awal). */
export async function mappingAccounts(
  tx: Tx,
  tenantId: string,
  eventKey: string,
  entryKey: string,
  date: BusinessDate,
): Promise<{ debitAccountId: string; creditAccountId: string; debitProfitCenter: ProfitCenter | null; creditProfitCenter: ProfitCenter | null }> {
  const mapping = await resolveMapping(tx, eventKey, entryKey, date, tenantId);
  if (!mapping) {
    throw new DomainError("MAPPING_MISSING", `Pemetaan akun ${eventKey} / ${entryKey} belum ada. Lengkapi di Akuntansi > Pemetaan jurnal otomatis.`);
  }
  return mapping;
}

export type PostedLineInput = {
  accountId: string;
  profitCenter: ProfitCenter;
  outletId?: string | null;
  truckId?: string | null;
  waterSourceId?: string | null;
  debit?: number;
  credit?: number;
  memo?: string | null;
};

export type InsertJournalInput = {
  tenantId: string;
  kind: JournalKind;
  date: BusinessDate;
  description: string;
  lines: PostedLineInput[];
  ctx?: ActorContext | null;
  sourceType?: string | null;
  sourceObject?: { type: string; id: string } | null;
  sourceEventId?: string | null;
  reversalOfId?: string | null;
  reversalReason?: string | null;
  attachmentId?: string | null;
  approvalRequestId?: string | null;
  requiresOwnerReview?: boolean;
  autoReverseOn?: BusinessDate | null;
  templateKey?: string | null;
  isRetroactive?: boolean;
  /**
   * `forward` (bawaan jurnal sistem): periode Ditutup/Dikunci → periode terbuka pertama + asal periode (FR-M11-10).
   * `strict` (jurnal manual): periode tanggal harus Terbuka — selain itu DITOLAK dengan pesan tindakan (US-M11-10 KP-3).
   */
  periodMode?: "forward" | "strict";
  /** Rujukan periode asal koreksi (jurnal manual di periode berikutnya). */
  originPeriod?: string | null;
  /** Status awal (bawaan `posted`). */
  status?: "posted" | "draft" | "submitted";
};

export function sumLines(lines: readonly { debit?: number; credit?: number }[]): { debit: number; credit: number } {
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    debit += l.debit ?? 0;
    credit += l.credit ?? 0;
  }
  return { debit, credit };
}

/** Validasi baris: rupiah bulat ≥ 0, salah satu sisi, minimal 2 baris, seimbang. */
export function assertBalancedLines(lines: readonly { debit?: number; credit?: number }[]): { debit: number; credit: number } {
  if (lines.length < 2) throw new DomainError("JOURNAL_LINES", "Jurnal minimal memiliki dua baris (debit dan kredit).");
  for (const [i, l] of lines.entries()) {
    const d = l.debit ?? 0;
    const c = l.credit ?? 0;
    if (!Number.isSafeInteger(d) || !Number.isSafeInteger(c) || d < 0 || c < 0) {
      throw new DomainError("JOURNAL_AMOUNT", `Baris ${i + 1}: nilai debit/kredit harus rupiah bulat dan tidak negatif.`);
    }
    if ((d > 0) === (c > 0)) throw new DomainError("JOURNAL_AMOUNT", `Baris ${i + 1}: isi salah satu dari debit atau kredit.`);
  }
  const totals = sumLines(lines);
  if (totals.debit !== totals.credit) {
    throw new DomainError("JOURNAL_UNBALANCED", `Jurnal tidak seimbang: debit ${formatRupiah(totals.debit)} ≠ kredit ${formatRupiah(totals.credit)}.`);
  }
  return totals;
}

/** Akun aktif & dapat diposting (bukan akun induk). */
export async function assertPostableAccounts(tx: Tx, tenantId: string, accountIds: readonly string[]): Promise<Map<string, AccountRow>> {
  const map = await accountsById(tx, accountIds);
  for (const id of accountIds) {
    const a = map.get(id);
    if (!a || a.tenantId !== tenantId) throw new DomainError("ACCOUNT_MISSING", "Akun tidak ditemukan di bagan akun.");
    if (!a.isActive) throw new DomainError("ACCOUNT_INACTIVE", `Akun ${a.code} ${a.name} nonaktif — pilih akun lain.`);
    if (!a.isPostable) throw new DomainError("ACCOUNT_HEADER", `Akun ${a.code} ${a.name} adalah akun induk dan tidak dapat diposting.`);
  }
  return map;
}

/** Periode posting (lihat `periodMode`). */
export async function postingPeriodFor(
  tx: Tx,
  tenantId: string,
  date: BusinessDate,
  mode: "forward" | "strict",
): Promise<{ periodId: string; period: string; startDate: string; originPeriod: string | null }> {
  if (mode === "forward") return resolvePostingPeriod(tx, tenantId, date);
  const row = await ensurePeriod(tx, tenantId, monthOf(date));
  if (!isOpenStatus(row.status)) {
    throw new DomainError(
      "PERIOD_NOT_OPEN",
      `Periode ${row.period} sudah ${row.status === "locked" ? "dikunci" : "ditutup"}. Catat koreksinya di periode terbuka berikutnya dengan rujukan periode asal.`,
    );
  }
  return { periodId: row.id, period: row.period, startDate: row.startDate, originPeriod: null };
}

/**
 * Sisipkan jurnal (bawaan: terposting) dengan aturan seragam. Dipakai M11 untuk jurnal non-otomatis (manual terposting,
 * pembalik, penyusutan, alokasi, saldo awal). Jurnal otomatis dari event memakai `postJournal` inti.
 */
export async function insertJournal(tx: Tx, input: InsertJournalInput): Promise<{ journal: JournalRow; number: string }> {
  if (!isBusinessDate(input.date)) throw new DomainError("INVALID_DATE", `Tanggal jurnal tidak valid: ${input.date}.`);
  const totals = assertBalancedLines(input.lines);
  await assertPostableAccounts(
    tx,
    input.tenantId,
    input.lines.map((l) => l.accountId),
  );
  const status = input.status ?? "posted";
  const today = input.ctx ? ctxBusinessDate(input.ctx) : input.date;
  const cutover = await currentCutover(tx, today > input.date ? today : input.date);
  if (cutover && input.date < cutover && input.kind !== "opening_balance") {
    throw new DomainError("BEFORE_CUTOVER", `Tanggal ${input.date} sebelum cut-over akuntansi ${cutover}. Hanya jurnal saldo awal yang boleh bertanggal sebelum cut-over.`);
  }
  const posting =
    status === "posted"
      ? await postingPeriodFor(tx, input.tenantId, input.date, input.periodMode ?? "forward")
      : { periodId: (await ensurePeriod(tx, input.tenantId, monthOf(input.date))).id, period: monthOf(input.date), startDate: firstDayOfMonth(input.date), originPeriod: null };
  const number = await nextNumber(tx, "journal", posting.startDate, { tenantId: input.tenantId });
  const now = input.ctx?.now ?? new Date();
  const [journal] = await tx
    .insert(journals)
    .values({
      tenantId: input.tenantId,
      number,
      kind: input.kind,
      status,
      journalDate: input.date,
      periodId: posting.periodId,
      originPeriod: input.originPeriod ?? posting.originPeriod,
      description: input.description,
      sourceType: input.sourceType ?? null,
      sourceObjectType: input.sourceObject?.type ?? null,
      sourceObjectId: input.sourceObject?.id ?? null,
      sourceEventId: input.sourceEventId ?? null,
      totalDebit: totals.debit,
      totalCredit: totals.credit,
      attachmentId: input.attachmentId ?? null,
      approvalRequestId: input.approvalRequestId ?? null,
      requiresOwnerReview: input.requiresOwnerReview ?? false,
      reversalOfId: input.reversalOfId ?? null,
      reversalReason: input.reversalReason ?? null,
      autoReverseOn: input.autoReverseOn ?? null,
      templateKey: input.templateKey ?? null,
      isRetroactive: input.isRetroactive ?? false,
      postedAt: status === "posted" ? now : null,
      postedBy: status === "posted" ? (input.ctx?.userId ?? null) : null,
      createdBy: input.ctx?.userId ?? null,
    })
    .returning();
  await tx.insert(journalLines).values(
    input.lines.map((l, i) => ({
      journalId: journal!.id,
      lineNo: i + 1,
      accountId: l.accountId,
      profitCenter: l.profitCenter,
      outletId: l.outletId ?? null,
      truckId: l.truckId ?? null,
      waterSourceId: l.waterSourceId ?? null,
      debit: l.debit ?? 0,
      credit: l.credit ?? 0,
      description: l.memo ?? null,
    })),
  );
  return { journal: journal!, number };
}

export async function loadJournal(tx: Tx, tenantId: string, id: string, opts: { forUpdate?: boolean } = {}): Promise<JournalRow> {
  const q = tx.select().from(journals).where(and(eq(journals.id, id), eq(journals.tenantId, tenantId)));
  const rows = opts.forUpdate ? await q.for("update").limit(1) : await q.limit(1);
  if (!rows[0]) throw new NotFoundError("Jurnal tidak ditemukan.");
  return rows[0];
}

export async function loadLines(tx: Tx, journalId: string): Promise<JournalLineRow[]> {
  return tx.select().from(journalLines).where(eq(journalLines.journalId, journalId)).orderBy(asc(journalLines.lineNo));
}

/** Pembalik yang sudah ada untuk jurnal ini (satu pembalik per jurnal). */
export async function existingReversal(tx: Tx, journalId: string): Promise<JournalRow | null> {
  const rows = await tx.select().from(journals).where(eq(journals.reversalOfId, journalId)).limit(1);
  return rows[0] ?? null;
}

/** Baris pembalik = baris asal dengan debit/kredit ditukar. */
export function swappedLines(lines: readonly JournalLineRow[]): PostedLineInput[] {
  return lines.map((l) => ({
    accountId: l.accountId,
    profitCenter: l.profitCenter,
    outletId: l.outletId,
    truckId: l.truckId,
    waterSourceId: l.waterSourceId,
    debit: l.credit,
    credit: l.debit,
    memo: l.description,
  }));
}

/** Periode-periode (urut naik) dalam rentang tanggal. */
export function periodsBetween(from: BusinessDate, to: BusinessDate): string[] {
  const out: string[] = [];
  let p = monthOf(from);
  const last = monthOf(to);
  for (let guard = 0; guard < 600 && p <= last; guard++) {
    out.push(p);
    p = shiftPeriod(p, 1);
  }
  return out;
}

/** Periode terbaru s.d. tanggal (untuk daftar). */
export async function listPeriodRows(tx: Tx, tenantId: string, opts: { from?: string; to?: string } = {}): Promise<PeriodRow[]> {
  const conds = [eq(accountingPeriods.tenantId, tenantId)];
  if (opts.from) conds.push(gte(accountingPeriods.period, opts.from));
  if (opts.to) conds.push(lte(accountingPeriods.period, opts.to));
  return tx.select().from(accountingPeriods).where(and(...conds)).orderBy(desc(accountingPeriods.period));
}

export function dayBefore(date: BusinessDate): BusinessDate {
  return addDays(date, -1);
}

/**
 * Jalankan pekerjaan terjadwal M11 dalam SATU transaksi. `db` dari runner job (`/api/cron/tick`, `runJobNow`) adalah
 * koneksi biasa, bukan transaksi: tanpa pembungkus ini setiap perintah ter-COMMIT sendiri sehingga kepala jurnal
 * terposting diperiksa seimbang (EQ004) sebelum barisnya disisipkan dan job gagal (mis. pembalik akrual tanggal 1,
 * penyusutan bulanan, proses ulang daftar tunggu). Transaksi yang sudah terbuka dipakai langsung.
 */
export function inJobTx<T>(db: Tx | undefined, run: (tx: Tx) => Promise<T>): Promise<T> {
  return db && isTransaction(db) ? run(db) : withTx(run, { db });
}
