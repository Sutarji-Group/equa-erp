/**
 * Posting jurnal (PRD 7.11.4, US-M11-02, FR-M11-10) — dipakai M11 lewat handler event. M11 memperluas (manual,
 * akrual, penyusutan, alokasi), tetapi SEMUA posting melewati `postJournal` agar aturan berikut seragam:
 *
 * 1. Debit = kredit (tiap baris hanya salah satu, rupiah bulat > 0) — tidak seimbang DITOLAK.
 * 2. Akun harus ada, aktif, dan dapat diposting — bila tidak, jurnal masuk `journal_queue` (tidak hilang diam-diam) +
 *    notifikasi Admin Keuangan (US-M11-02 KP-3).
 * 3. Periode tanggal bisnis Ditutup/Dikunci → diposting ke PERIODE TERBUKA PERTAMA sesudahnya dengan penanda
 *    `origin_period` ("asal periode …", FR-M11-10). Periode yang belum ada dibuat (Terbuka).
 * 4. Satu jurnal otomatis per event domain (`source_event_id`) — posting ulang = `duplicate`.
 * 5. Flag `accounting.m11_active` mati → jurnal otomatis dilewati (dibangkitkan retroaktif kelak, PTB-47).
 * 6. Sebelum tanggal cut-over akuntansi (`accounting.cutover_date`) hanya jurnal saldo awal yang diterima.
 *
 * `postFromMapping(tx, { eventType, entries })` membangun baris dari `event_account_mappings` (resolveMapping);
 * pemetaan hilang → antrean `mapping_missing`.
 */
import "server-only";

import { and, asc, desc, eq, gt, inArray, lte } from "drizzle-orm";

import { accountingPeriods, accounts, eventAccountMappings, journalLines, journalQueue, journals, outlets } from "@/db/schema";
import type { JournalKind, ProfitCenter } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { isBusinessDate, lastDayOfMonth, monthOf, type BusinessDate } from "@/lib/time";

import { EQUA_TENANT_ID, type ActorContext } from "./context";
import type { Tx } from "./db";
import { DomainError } from "./errors";
import { isEnabled } from "./flags";
import { notify } from "./notifications/service";
import { nextNumber } from "./numbering";
import { get as getParam } from "./params-read";

export type JournalQueueReason = "mapping_missing" | "account_inactive" | "unbalanced" | "period_unavailable" | "other";

export type JournalLineInput = {
  accountCode?: string;
  accountId?: string;
  /** Kosong → pusat laba bawaan akun → SHARED. */
  profitCenter?: ProfitCenter | null;
  outletId?: string | null;
  truckId?: string | null;
  waterSourceId?: string | null;
  debit?: number;
  credit?: number;
  memo?: string | null;
};

export type PostJournalInput = {
  tenantId?: string;
  /** Tanggal bisnis peristiwa (Bab 5.3). */
  date: BusinessDate;
  /** Modul/peristiwa sumber, mis. `trip.completed`. */
  source: string;
  sourceEventId?: string | null;
  sourceObject?: { type: string; id: string } | null;
  /** Nomor rujukan (nomor rit/shift/nota/faktur) — ditambahkan ke keterangan. */
  ref?: string | null;
  description: string;
  kind?: JournalKind;
  lines: JournalLineInput[];
  ctx?: ActorContext;
  attachmentId?: string | null;
  /** Data tambahan untuk antrean bila gagal. */
  payload?: Record<string, unknown>;
};

export type PostJournalResult =
  | { status: "posted"; journalId: string; number: string; periodId: string; period: string; originPeriod: string | null }
  | { status: "duplicate"; journalId: string; number: string }
  | { status: "queued"; queueId: string; reason: JournalQueueReason; message: string }
  | { status: "skipped"; reason: "m11_inactive" | "empty" };

function assertLines(lines: JournalLineInput[]): { debit: number; credit: number } {
  if (lines.length < 2) throw new DomainError("JOURNAL_LINES", "Jurnal minimal memiliki dua baris (debit dan kredit).");
  let debit = 0;
  let credit = 0;
  for (const [i, line] of lines.entries()) {
    const d = line.debit ?? 0;
    const c = line.credit ?? 0;
    if (!Number.isSafeInteger(d) || !Number.isSafeInteger(c) || d < 0 || c < 0) {
      throw new DomainError("JOURNAL_AMOUNT", `Baris ${i + 1}: nilai debit/kredit harus rupiah bulat dan tidak negatif.`);
    }
    if ((d > 0) === (c > 0)) throw new DomainError("JOURNAL_AMOUNT", `Baris ${i + 1}: isi salah satu dari debit atau kredit.`);
    if (!line.accountCode && !line.accountId) throw new DomainError("JOURNAL_ACCOUNT", `Baris ${i + 1}: akun wajib diisi.`);
    debit += d;
    credit += c;
  }
  if (debit !== credit) {
    throw new DomainError("JOURNAL_UNBALANCED", `Jurnal tidak seimbang: debit ${formatRupiah(debit)} ≠ kredit ${formatRupiah(credit)}.`);
  }
  return { debit, credit };
}

function nextMonth(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

async function ensurePeriod(tx: Tx, tenantId: string, period: string) {
  const existing = await tx
    .select()
    .from(accountingPeriods)
    .where(and(eq(accountingPeriods.tenantId, tenantId), eq(accountingPeriods.period, period)))
    .limit(1);
  if (existing[0]) return existing[0];
  const start = `${period}-01`;
  const [row] = await tx
    .insert(accountingPeriods)
    .values({ tenantId, period, startDate: start, endDate: lastDayOfMonth(start), status: "open" })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const again = await tx
    .select()
    .from(accountingPeriods)
    .where(and(eq(accountingPeriods.tenantId, tenantId), eq(accountingPeriods.period, period)))
    .limit(1);
  return again[0]!;
}

const OPEN_STATUSES = new Set(["open", "reopened"]);

/**
 * Periode posting untuk tanggal bisnis: periode bulan itu bila Terbuka/Dibuka kembali; bila Ditutup/Dikunci →
 * periode terbuka pertama sesudahnya (dibuat bila belum ada) dengan `originPeriod` = bulan asal (FR-M11-10).
 */
export async function resolvePostingPeriod(
  tx: Tx,
  tenantId: string,
  date: BusinessDate,
): Promise<{ periodId: string; period: string; startDate: string; originPeriod: string | null }> {
  const target = monthOf(date);
  let row = await ensurePeriod(tx, tenantId, target);
  if (OPEN_STATUSES.has(row.status)) return { periodId: row.id, period: row.period, startDate: row.startDate, originPeriod: null };
  const later = await tx
    .select()
    .from(accountingPeriods)
    .where(and(eq(accountingPeriods.tenantId, tenantId), gt(accountingPeriods.period, target), inArray(accountingPeriods.status, ["open", "reopened"])))
    .orderBy(asc(accountingPeriods.period))
    .limit(1);
  if (later[0]) return { periodId: later[0].id, period: later[0].period, startDate: later[0].startDate, originPeriod: target };
  let candidate = nextMonth(target);
  for (let guard = 0; guard < 120; guard++) {
    row = await ensurePeriod(tx, tenantId, candidate);
    if (OPEN_STATUSES.has(row.status)) return { periodId: row.id, period: row.period, startDate: row.startDate, originPeriod: target };
    candidate = nextMonth(candidate);
  }
  throw new DomainError("PERIOD_UNAVAILABLE", "Tidak ada periode akuntansi terbuka untuk memposting jurnal ini.");
}

export type QueueJournalInput = {
  tenantId?: string;
  eventKey: string;
  domainEventId?: string | null;
  sourceObject?: { type: string; id: string } | null;
  payload: Record<string, unknown>;
  journalDate: BusinessDate;
  reason: JournalQueueReason;
  message: string;
  now?: Date;
};

/** Masukkan ke antrean jurnal + beri tahu Admin Keuangan (US-M11-02 KP-3). */
export async function queueJournal(tx: Tx, input: QueueJournalInput): Promise<string> {
  const tenantId = input.tenantId ?? EQUA_TENANT_ID;
  const [row] = await tx
    .insert(journalQueue)
    .values({
      tenantId,
      eventKey: input.eventKey,
      domainEventId: input.domainEventId ?? null,
      sourceObjectType: input.sourceObject?.type ?? null,
      sourceObjectId: input.sourceObject?.id ?? null,
      payload: input.payload,
      journalDate: input.journalDate,
      reason: input.reason,
      message: input.message,
    })
    .returning({ id: journalQueue.id });
  await notify(tx, {
    event: "journal.queued",
    tenantId,
    title: "Jurnal otomatis belum terposting",
    body: `${input.eventKey}: ${input.message}`,
    objectType: "journal_queue",
    objectId: row!.id,
    groupKey: `journal.queued:${input.eventKey}`,
    link: "/akuntansi/jurnal?antrean=1",
    now: input.now,
  });
  return row!.id;
}

/** Posting jurnal (lihat aturan di kepala berkas). */
export async function postJournal(tx: Tx, input: PostJournalInput): Promise<PostJournalResult> {
  if (!isBusinessDate(input.date)) throw new DomainError("INVALID_DATE", `Tanggal jurnal tidak valid: ${input.date}.`);
  const totals = assertLines(input.lines);
  const tenantId = input.tenantId ?? input.ctx?.tenantId ?? EQUA_TENANT_ID;
  const kind: JournalKind = input.kind ?? "auto";
  const now = input.ctx?.now ?? new Date();
  const queuePayload = { ...(input.payload ?? {}), description: input.description, ref: input.ref ?? null, lines: input.lines };
  const queue = (reason: JournalQueueReason, message: string) =>
    queueJournal(tx, {
      tenantId,
      eventKey: input.source,
      domainEventId: input.sourceEventId ?? null,
      sourceObject: input.sourceObject ?? null,
      payload: queuePayload,
      journalDate: input.date,
      reason,
      message,
      now,
    }).then((queueId) => ({ status: "queued" as const, queueId, reason, message }));

  if (kind === "auto" && !(await isEnabled(tx, "accounting.m11_active", { tenantId }))) {
    return { status: "skipped", reason: "m11_inactive" };
  }

  if (input.sourceEventId && kind === "auto") {
    const dup = await tx
      .select({ id: journals.id, number: journals.number })
      .from(journals)
      .where(and(eq(journals.sourceEventId, input.sourceEventId), eq(journals.kind, "auto")))
      .limit(1);
    if (dup[0]) return { status: "duplicate", journalId: dup[0].id, number: dup[0].number };
  }

  const { date: cutover } = await getParam(tx, "accounting.cutover_date", input.date);
  if (cutover && input.date < cutover && kind !== "opening_balance") {
    return queue("period_unavailable", `Tanggal ${input.date} sebelum cut-over akuntansi ${cutover}; hanya jurnal saldo awal yang diterima.`);
  }

  // Akun
  const codes = input.lines.filter((l) => !l.accountId && l.accountCode).map((l) => l.accountCode!);
  const ids = input.lines.filter((l) => l.accountId).map((l) => l.accountId!);
  const found = await tx
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.tenantId, tenantId),
        codes.length && ids.length
          ? undefined
          : codes.length
            ? inArray(accounts.code, codes)
            : inArray(accounts.id, ids),
      ),
    );
  const byCode = new Map(found.map((a) => [a.code, a]));
  const byId = new Map(found.map((a) => [a.id, a]));
  const resolved = [];
  for (const line of input.lines) {
    const account = line.accountId ? byId.get(line.accountId) : byCode.get(line.accountCode!);
    if (!account) return queue("mapping_missing", `Akun ${line.accountCode ?? line.accountId} tidak ditemukan di bagan akun.`);
    if (!account.isActive || !account.isPostable) {
      return queue("account_inactive", `Akun ${account.code} ${account.name} nonaktif atau akun induk (tidak dapat diposting).`);
    }
    resolved.push({ line, account });
  }

  const posting = await resolvePostingPeriod(tx, tenantId, input.date);
  const number = await nextNumber(tx, "journal", posting.startDate);
  const description = input.ref ? `${input.description} (${input.ref})` : input.description;
  const [journal] = await tx
    .insert(journals)
    .values({
      tenantId,
      number,
      kind,
      status: "posted",
      journalDate: input.date,
      periodId: posting.periodId,
      originPeriod: posting.originPeriod,
      description,
      sourceType: input.source,
      sourceObjectType: input.sourceObject?.type ?? null,
      sourceObjectId: input.sourceObject?.id ?? null,
      sourceEventId: input.sourceEventId ?? null,
      totalDebit: totals.debit,
      totalCredit: totals.credit,
      attachmentId: input.attachmentId ?? null,
      postedAt: now,
      postedBy: input.ctx?.userId ?? null,
      createdBy: input.ctx?.userId ?? null,
    })
    .returning({ id: journals.id });
  await tx.insert(journalLines).values(
    resolved.map(({ line, account }, i) => ({
      journalId: journal!.id,
      lineNo: i + 1,
      accountId: account.id,
      profitCenter: line.profitCenter ?? account.profitCenter ?? "SHARED",
      outletId: line.outletId ?? null,
      truckId: line.truckId ?? null,
      waterSourceId: line.waterSourceId ?? null,
      debit: line.debit ?? 0,
      credit: line.credit ?? 0,
      description: line.memo ?? null,
    })),
  );
  return { status: "posted", journalId: journal!.id, number, periodId: posting.periodId, period: posting.period, originPeriod: posting.originPeriod };
}

export type ResolvedMapping = {
  id: string;
  eventKey: string;
  entryKey: string;
  description: string;
  debitAccountId: string;
  creditAccountId: string;
  debitProfitCenter: ProfitCenter | null;
  creditProfitCenter: ProfitCenter | null;
  profitCenterRule: string;
  effectiveFrom: string;
};

/** Pemetaan peristiwa → akun yang berlaku pada tanggal (terbaru `effective_from` ≤ tanggal, aktif). */
export async function resolveMapping(
  tx: Tx,
  eventKey: string,
  entryKey: string,
  date: BusinessDate,
  tenantId: string = EQUA_TENANT_ID,
): Promise<ResolvedMapping | null> {
  const rows = await tx
    .select()
    .from(eventAccountMappings)
    .where(
      and(
        eq(eventAccountMappings.tenantId, tenantId),
        eq(eventAccountMappings.eventKey, eventKey),
        eq(eventAccountMappings.entryKey, entryKey),
        eq(eventAccountMappings.isActive, true),
        lte(eventAccountMappings.effectiveFrom, date),
      ),
    )
    .orderBy(desc(eventAccountMappings.effectiveFrom))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    eventKey: r.eventKey,
    entryKey: r.entryKey,
    description: r.description,
    debitAccountId: r.debitAccountId,
    creditAccountId: r.creditAccountId,
    debitProfitCenter: r.debitProfitCenter,
    creditProfitCenter: r.creditProfitCenter,
    profitCenterRule: r.profitCenterRule,
    effectiveFrom: r.effectiveFrom,
  };
}

export type MappingEntry = {
  entryKey: string;
  /** Rupiah; negatif = sisi debit/kredit ditukar (mis. penyesuaian stok bertambah). Nol dilewati. */
  amount: number;
  /** Pusat laba sumber (aturan `from_source`) atau penentu untuk kedua sisi. */
  profitCenter?: ProfitCenter | null;
  debitProfitCenter?: ProfitCenter | null;
  creditProfitCenter?: ProfitCenter | null;
  outletId?: string | null;
  truckId?: string | null;
  waterSourceId?: string | null;
  memo?: string | null;
};

export type PostFromMappingInput = Omit<PostJournalInput, "lines" | "kind"> & {
  /** Kunci event pada pemetaan (bawaan: `source`). */
  eventType?: string;
  entries: MappingEntry[];
};

async function outletProfitCenter(tx: Tx, outletId: string): Promise<ProfitCenter | null> {
  const rows = await tx.select({ kind: outlets.kind }).from(outlets).where(eq(outlets.id, outletId)).limit(1);
  if (!rows[0]) return null;
  return rows[0].kind === "store" ? "L4" : "L3";
}

/** Bangun jurnal otomatis dari pemetaan akun; pemetaan hilang → antrean. */
export async function postFromMapping(tx: Tx, input: PostFromMappingInput): Promise<PostJournalResult> {
  const eventType = input.eventType ?? input.source;
  const tenantId = input.tenantId ?? input.ctx?.tenantId ?? EQUA_TENANT_ID;
  const lines: JournalLineInput[] = [];
  for (const entry of input.entries) {
    if (!Number.isSafeInteger(entry.amount)) throw new DomainError("JOURNAL_AMOUNT", "Nilai jurnal harus rupiah bulat.");
    if (entry.amount === 0) continue;
    const mapping = await resolveMapping(tx, eventType, entry.entryKey, input.date, tenantId);
    if (!mapping) {
      if (!(await isEnabled(tx, "accounting.m11_active", { tenantId }))) return { status: "skipped", reason: "m11_inactive" };
      const message = `Pemetaan akun untuk ${eventType} / ${entry.entryKey} belum ada.`;
      const queueId = await queueJournal(tx, {
        tenantId,
        eventKey: eventType,
        domainEventId: input.sourceEventId ?? null,
        sourceObject: input.sourceObject ?? null,
        payload: { ...(input.payload ?? {}), entries: input.entries, description: input.description },
        journalDate: input.date,
        reason: "mapping_missing",
        message,
        now: input.ctx?.now,
      });
      return { status: "queued", queueId, reason: "mapping_missing", message };
    }
    const outletPc = entry.outletId && mapping.profitCenterRule === "from_outlet" ? await outletProfitCenter(tx, entry.outletId) : null;
    const derived = mapping.profitCenterRule === "from_outlet" ? outletPc : mapping.profitCenterRule === "from_source" ? (entry.profitCenter ?? null) : null;
    const sidePc = (mappingPc: ProfitCenter | null, explicit: ProfitCenter | null | undefined): ProfitCenter | null => {
      if (explicit) return explicit;
      // from_outlet: sisi lini operasi (bukan SHARED) mengikuti jenis outlet (depot L3 / toko L4).
      if (mapping.profitCenterRule === "from_outlet" && derived && mappingPc !== "SHARED") return derived;
      if (mappingPc === null) return derived ?? entry.profitCenter ?? null;
      return mappingPc;
    };
    const debitPc = sidePc(mapping.debitProfitCenter, entry.debitProfitCenter);
    const creditPc = sidePc(mapping.creditProfitCenter, entry.creditProfitCenter);
    const amount = Math.abs(entry.amount);
    const swap = entry.amount < 0;
    const dims = { outletId: entry.outletId ?? null, truckId: entry.truckId ?? null, waterSourceId: entry.waterSourceId ?? null, memo: entry.memo ?? mapping.description };
    lines.push(
      { accountId: swap ? mapping.creditAccountId : mapping.debitAccountId, profitCenter: swap ? creditPc : debitPc, debit: amount, ...dims },
      { accountId: swap ? mapping.debitAccountId : mapping.creditAccountId, profitCenter: swap ? debitPc : creditPc, credit: amount, ...dims },
    );
  }
  if (lines.length === 0) return { status: "skipped", reason: "empty" };
  return postJournal(tx, { ...input, tenantId, kind: "auto", lines });
}
