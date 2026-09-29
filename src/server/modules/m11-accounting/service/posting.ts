/**
 * M11 — mesin jurnal otomatis (US-M11-02).
 *
 * Handler event memanggil `processEvent` (lihat `auto-journals.ts` untuk perlakuan per peristiwa). Aturan:
 * 1. Tenant mitra (RL-7) tidak dibukukan di buku EQUA (7.11.8). Flag `accounting.m11_active` mati → dilewati; dibangkitkan
 *    retroaktif saat diaktifkan (PTB-47). Peristiwa sebelum tanggal cut-over → dilewati (tidak dimigrasi, BRD 10.3).
 * 2. Satu jurnal otomatis per event (`source_event_id`) — pemutaran ulang = `duplicate` (idempoten).
 * 3. Pemetaan hilang / akun nonaktif → DAFTAR TUNGGU (`journal_queue`, satu baris per event; dicoba ulang dari layar
 *    Jurnal atau otomatis setelah pemetaan dilengkapi) + notifikasi Admin Keuangan — tidak ada peristiwa yang hilang.
 * 4. Tanggal jurnal = tanggal bisnis peristiwa; periode Ditutup/Dikunci → periode terbuka pertama + "asal periode".
 * 5. Pembalik (void, pembalikan pelunasan, dsb.) membalik jurnal otomatis asal objek sumber (kind `reversal`); jurnal
 *    otomatis tidak pernah diubah (P-07 langkah 1).
 */
import "server-only";

import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { domainEvents, journalQueue, journals } from "@/db/schema";
import type { ProfitCenter } from "@/lib/labels";
import { toBusinessDate, type BusinessDate } from "@/lib/time";

import type { Tx } from "@/server/core/db";
import { DOMAIN_EVENT_LABELS, type DomainEvent } from "@/server/core/events";
import { outlets } from "@/db/schema";
import { postJournal, queueJournal, resolveMapping, type JournalQueueReason } from "@/server/core/ledger";

import { mappingMissingMessage } from "../constants";
import {
  accountsById,
  currentCutover,
  existingReversal,
  insertJournal,
  isAccountingTenant,
  loadLines,
  m11Active,
  swappedLines,
  type PostedLineInput,
} from "./common";

export type AutoEntry = {
  /** Kunci peristiwa pada pemetaan (bawaan: `spec.eventKey`). */
  eventKey?: string;
  entryKey: string;
  /** Rupiah; negatif = sisi ditukar (pembalik). Nol dilewati. */
  amount: number;
  /** Pusat laba sumber (aturan `from_source`). */
  profitCenter?: ProfitCenter | null;
  debitProfitCenter?: ProfitCenter | null;
  creditProfitCenter?: ProfitCenter | null;
  outletId?: string | null;
  debitOutletId?: string | null;
  creditOutletId?: string | null;
  truckId?: string | null;
  waterSourceId?: string | null;
  /** Akun pengganti (mis. akun buku rekening bank). */
  debitAccountId?: string | null;
  creditAccountId?: string | null;
  memo?: string | null;
};

export type AutoJournalSpec = {
  kind: "journal";
  eventKey: string;
  description: string;
  ref?: string | null;
  date: BusinessDate;
  sourceObject?: { type: string; id: string } | null;
  entries: AutoEntry[];
};

/** Balik jurnal otomatis objek sumber (seluruhnya). */
export type ReversalSpec = {
  kind: "reversal";
  description: string;
  reason: string;
  date: BusinessDate;
  sourceObject: { type: string; id: string };
  /** Batasi ke jurnal dari peristiwa ini (mis. hanya `pos_sale.recorded`). */
  sourceTypes?: string[];
};

export type SkipSpec = { kind: "skip"; reason: string };

export type EventJournalSpec = AutoJournalSpec | ReversalSpec | SkipSpec;

export type AutoResult =
  | { status: "posted"; journalIds: string[]; numbers: string[] }
  | { status: "duplicate"; journalIds: string[] }
  | { status: "queued"; queueId: string; reason: JournalQueueReason; message: string }
  | { status: "skipped"; reason: string };

export type ProcessOptions = {
  /** Baris antrean yang sedang dicoba ulang (ditandai terposting bila berhasil). */
  queueItemId?: string | null;
  /** Pembangkitan retroaktif (PTB-47) — jurnal diberi penanda dari run. */
  retroactive?: boolean;
  /** Tanggal hari ini (cut-over berlaku saat ini). */
  today?: BusinessDate;
};

type EventLike = Pick<DomainEvent, "id" | "type" | "tenantId" | "businessDate" | "occurredAt">;

/** Tanggal bisnis peristiwa (payload → envelope → waktu kejadian WIB). */
export function eventDate(event: EventLike, payloadDate?: string | null): BusinessDate {
  return payloadDate ?? event.businessDate ?? toBusinessDate(event.occurredAt);
}

async function outletLine(tx: Tx, outletId: string): Promise<ProfitCenter | null> {
  const rows = await tx.select({ kind: outlets.kind }).from(outlets).where(eq(outlets.id, outletId)).limit(1);
  if (!rows[0]) return null;
  return rows[0].kind === "store" ? "L4" : "L3";
}

/** Catat/perbarui antrean untuk event ini (satu baris menunggu per event). */
async function queueForEvent(
  tx: Tx,
  event: EventLike,
  spec: { date: BusinessDate; sourceObject?: { type: string; id: string } | null; payload: Record<string, unknown> },
  reason: JournalQueueReason,
  message: string,
  opts: ProcessOptions,
): Promise<AutoResult> {
  const tenantId = event.tenantId!;
  const existing = opts.queueItemId
    ? [{ id: opts.queueItemId }]
    : await tx
        .select({ id: journalQueue.id })
        .from(journalQueue)
        .where(and(eq(journalQueue.domainEventId, event.id), eq(journalQueue.status, "pending")))
        .limit(1);
  if (existing[0]) {
    const [row] = await tx.select().from(journalQueue).where(eq(journalQueue.id, existing[0].id)).limit(1);
    await tx
      .update(journalQueue)
      .set({ reason, message, attempts: (row?.attempts ?? 0) + 1, updatedAt: new Date() })
      .where(eq(journalQueue.id, existing[0].id));
    return { status: "queued", queueId: existing[0].id, reason, message };
  }
  const queueId = await queueJournal(tx, {
    tenantId,
    eventKey: event.type,
    domainEventId: event.id,
    sourceObject: spec.sourceObject ?? null,
    payload: spec.payload,
    journalDate: spec.date,
    reason,
    message,
    now: event.occurredAt,
  });
  return { status: "queued", queueId, reason, message };
}

async function resolveQueueItem(tx: Tx, queueItemId: string | null | undefined, journalId: string | null): Promise<void> {
  if (!queueItemId) return;
  await tx
    .update(journalQueue)
    .set({ status: "resolved", resolvedJournalId: journalId, resolvedAt: new Date(), updatedAt: new Date() })
    .where(eq(journalQueue.id, queueItemId));
}

/** Tandai antrean event ini terselesaikan (mis. peristiwa ternyata tidak perlu jurnal). */
async function resolvePendingFor(tx: Tx, eventId: string, journalId: string | null, queueItemId?: string | null): Promise<void> {
  if (queueItemId) return resolveQueueItem(tx, queueItemId, journalId);
  await tx
    .update(journalQueue)
    .set({ status: "resolved", resolvedJournalId: journalId, resolvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(journalQueue.domainEventId, eventId), eq(journalQueue.status, "pending")));
}

/** Pra-syarat umum: tenant pembukuan, M11 aktif, setelah cut-over. `null` = lanjut. */
async function gate(tx: Tx, event: EventLike, date: BusinessDate, opts: ProcessOptions): Promise<AutoResult | null> {
  const tenantId = event.tenantId;
  if (!tenantId) return { status: "skipped", reason: "no_tenant" };
  if (!(await isAccountingTenant(tx, tenantId))) return { status: "skipped", reason: "partner_tenant" };
  if (!(await m11Active(tx, tenantId))) return { status: "skipped", reason: "m11_inactive" };
  const today = opts.today ?? toBusinessDate(new Date());
  const cutover = await currentCutover(tx, today > date ? today : date);
  if (cutover && date < cutover) return { status: "skipped", reason: "before_cutover" };
  return null;
}

/** Jalankan spesifikasi jurnal untuk satu event (idempoten). */
export async function executeSpec(tx: Tx, event: EventLike, spec: EventJournalSpec, opts: ProcessOptions = {}): Promise<AutoResult> {
  if (spec.kind === "skip") {
    await resolvePendingFor(tx, event.id, null, opts.queueItemId);
    return { status: "skipped", reason: spec.reason };
  }
  const gated = await gate(tx, event, spec.date, opts);
  if (gated) return gated;
  if (spec.kind === "reversal") return executeReversal(tx, event, spec, opts);

  const tenantId = event.tenantId!;
  const dup = await tx
    .select({ id: journals.id })
    .from(journals)
    .where(and(eq(journals.sourceEventId, event.id), eq(journals.kind, "auto")))
    .limit(1);
  if (dup[0]) {
    await resolvePendingFor(tx, event.id, dup[0].id, opts.queueItemId);
    return { status: "duplicate", journalIds: [dup[0].id] };
  }

  const entries = spec.entries.filter((e) => e.amount !== 0);
  for (const e of entries) {
    if (!Number.isSafeInteger(e.amount)) throw new Error(`Nilai jurnal ${spec.eventKey}/${e.entryKey} bukan rupiah bulat: ${e.amount}`);
  }
  if (entries.length === 0) {
    await resolvePendingFor(tx, event.id, null, opts.queueItemId);
    return { status: "skipped", reason: "empty" };
  }
  const queuePayload = { description: spec.description, ref: spec.ref ?? null, entries: entries as unknown as Record<string, unknown>[] };
  const lines: PostedLineInput[] = [];
  for (const entry of entries) {
    const eventKey = entry.eventKey ?? spec.eventKey;
    // Pemetaan yang berlaku pada tanggal peristiwa; bila saat itu belum ada (peristiwa menunggu di daftar tunggu lalu
    // pemetaan dilengkapi — berlaku ke depan), pakai pemetaan yang berlaku hari ini agar antrean dapat diselesaikan.
    const mapping =
      (await resolveMapping(tx, eventKey, entry.entryKey, spec.date, tenantId)) ??
      (opts.today && opts.today > spec.date ? await resolveMapping(tx, eventKey, entry.entryKey, opts.today, tenantId) : null);
    if (!mapping) {
      return queueForEvent(tx, event, { date: spec.date, sourceObject: spec.sourceObject, payload: queuePayload }, "mapping_missing", mappingMissingMessage(eventKey, entry.entryKey), opts);
    }
    const derivedOutlet = entry.outletId ?? entry.debitOutletId ?? entry.creditOutletId ?? null;
    const outletPc = mapping.profitCenterRule === "from_outlet" && derivedOutlet ? await outletLine(tx, derivedOutlet) : null;
    const derived = mapping.profitCenterRule === "from_outlet" ? outletPc : mapping.profitCenterRule === "from_source" ? (entry.profitCenter ?? null) : null;
    const sidePc = (mappingPc: ProfitCenter | null, explicit: ProfitCenter | null | undefined): ProfitCenter => {
      if (explicit) return explicit;
      if (mapping.profitCenterRule === "from_outlet" && derived && mappingPc !== "SHARED") return derived;
      if (mappingPc === null) return derived ?? entry.profitCenter ?? "SHARED";
      return mappingPc;
    };
    const debitPc = sidePc(mapping.debitProfitCenter, entry.debitProfitCenter);
    const creditPc = sidePc(mapping.creditProfitCenter, entry.creditProfitCenter);
    const debitAccountId = entry.debitAccountId ?? mapping.debitAccountId;
    const creditAccountId = entry.creditAccountId ?? mapping.creditAccountId;
    const amount = Math.abs(entry.amount);
    const swap = entry.amount < 0;
    const common = { truckId: entry.truckId ?? null, waterSourceId: entry.waterSourceId ?? null, memo: entry.memo ?? mapping.description };
    const dOutlet = entry.debitOutletId ?? entry.outletId ?? null;
    const cOutlet = entry.creditOutletId ?? entry.outletId ?? null;
    const debitSide = { accountId: debitAccountId, profitCenter: debitPc, outletId: dOutlet };
    const creditSide = { accountId: creditAccountId, profitCenter: creditPc, outletId: cOutlet };
    const [drSide, crSide] = swap ? [creditSide, debitSide] : [debitSide, creditSide];
    lines.push({ ...drSide, ...common, debit: amount }, { ...crSide, ...common, credit: amount });
  }

  const accounts = await accountsById(
    tx,
    lines.map((l) => l.accountId),
  );
  for (const l of lines) {
    const a = accounts.get(l.accountId);
    if (!a || a.tenantId !== tenantId) {
      return queueForEvent(tx, event, { date: spec.date, sourceObject: spec.sourceObject, payload: queuePayload }, "mapping_missing", `Akun pada pemetaan ${eventName(spec.eventKey)} tidak ditemukan di bagan akun. Perbarui pemetaan di Akuntansi > Pemetaan jurnal otomatis.`, opts);
    }
    if (!a.isActive || !a.isPostable) {
      return queueForEvent(tx, event, { date: spec.date, sourceObject: spec.sourceObject, payload: queuePayload }, "account_inactive", `Akun ${a.code} ${a.name} nonaktif atau akun induk — perbarui pemetaan ${eventName(spec.eventKey)} di Akuntansi > Pemetaan jurnal otomatis.`, opts);
    }
  }

  const result = await postJournal(tx, {
    tenantId,
    date: spec.date,
    source: event.type,
    sourceEventId: event.id,
    sourceObject: spec.sourceObject ?? null,
    ref: spec.ref ?? null,
    description: spec.description,
    kind: "auto",
    lines: lines.map((l) => ({
      accountId: l.accountId,
      profitCenter: l.profitCenter,
      outletId: l.outletId ?? null,
      truckId: l.truckId ?? null,
      waterSourceId: l.waterSourceId ?? null,
      debit: l.debit,
      credit: l.credit,
      memo: l.memo ?? null,
    })),
    payload: { eventType: event.type },
  });
  if (result.status === "posted") {
    await resolvePendingFor(tx, event.id, result.journalId, opts.queueItemId);
    return { status: "posted", journalIds: [result.journalId], numbers: [result.number] };
  }
  if (result.status === "duplicate") {
    await resolvePendingFor(tx, event.id, result.journalId, opts.queueItemId);
    return { status: "duplicate", journalIds: [result.journalId] };
  }
  if (result.status === "queued") return { status: "queued", queueId: result.queueId, reason: result.reason, message: result.message };
  return { status: "skipped", reason: result.reason };
}

/** Balik semua jurnal otomatis objek sumber yang belum dibalik (idempoten per jurnal asal). */
async function executeReversal(tx: Tx, event: EventLike, spec: ReversalSpec, opts: ProcessOptions): Promise<AutoResult> {
  const tenantId = event.tenantId!;
  const already = await tx
    .select({ id: journals.id })
    .from(journals)
    .where(and(eq(journals.sourceEventId, event.id), eq(journals.kind, "reversal")));
  if (already.length) {
    await resolvePendingFor(tx, event.id, already[0]!.id, opts.queueItemId);
    return { status: "duplicate", journalIds: already.map((r) => r.id) };
  }
  const conds = [
    eq(journals.tenantId, tenantId),
    eq(journals.sourceObjectType, spec.sourceObject.type),
    eq(journals.sourceObjectId, spec.sourceObject.id),
    eq(journals.status, "posted"),
    eq(journals.kind, "auto"),
    isNull(journals.reversalOfId),
  ];
  if (spec.sourceTypes?.length) conds.push(inArray(journals.sourceType, spec.sourceTypes));
  const originals = await tx.select().from(journals).where(and(...conds)).orderBy(desc(journals.createdAt));
  const pendingOriginal = await tx
    .select({ id: journalQueue.id })
    .from(journalQueue)
    .where(
      and(
        eq(journalQueue.tenantId, tenantId),
        eq(journalQueue.sourceObjectType, spec.sourceObject.type),
        eq(journalQueue.sourceObjectId, spec.sourceObject.id),
        eq(journalQueue.status, "pending"),
      ),
    )
    .limit(5);
  const otherPending = pendingOriginal.filter((q) => q.id !== opts.queueItemId);
  if (!originals.length) {
    if (otherPending.length) {
      return queueForEvent(
        tx,
        event,
        { date: spec.date, sourceObject: spec.sourceObject, payload: { description: spec.description, reason: spec.reason } },
        "other",
        "Jurnal asal masih di daftar tunggu; pembalik diproses setelah jurnal asal terposting.",
        opts,
      );
    }
    await resolvePendingFor(tx, event.id, null, opts.queueItemId);
    return { status: "skipped", reason: "no_original_journal" };
  }
  const ids: string[] = [];
  const numbers: string[] = [];
  for (const orig of originals) {
    if (await existingReversal(tx, orig.id)) continue;
    const lines = await loadLines(tx, orig.id);
    const { journal, number } = await insertJournal(tx, {
      tenantId,
      kind: "reversal",
      date: spec.date < orig.journalDate ? orig.journalDate : spec.date,
      description: `${spec.description} — pembalik ${orig.number}`,
      lines: swappedLines(lines),
      sourceType: event.type,
      sourceObject: spec.sourceObject,
      sourceEventId: event.id,
      reversalOfId: orig.id,
      reversalReason: spec.reason,
      isRetroactive: opts.retroactive ?? false,
      periodMode: "forward",
    });
    ids.push(journal.id);
    numbers.push(number);
  }
  await resolvePendingFor(tx, event.id, ids[0] ?? null, opts.queueItemId);
  return ids.length ? { status: "posted", journalIds: ids, numbers } : { status: "duplicate", journalIds: originals.map((o) => o.id) };
}

/** Muat event tersimpan (untuk coba ulang antrean & retroaktif). */
export async function loadDomainEvent(tx: Tx, id: string): Promise<DomainEvent | null> {
  const rows = await tx.select().from(domainEvents).where(eq(domainEvents.id, id)).limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    seq: r.seq,
    type: r.type as DomainEvent["type"],
    payload: r.payload as unknown as DomainEvent["payload"],
    occurredAt: r.occurredAt,
    businessDate: r.businessDate,
    tenantId: r.tenantId,
    actorUserId: r.actorUserId,
    source: r.source,
    objectType: r.objectType,
    objectId: r.objectId,
  };
}

/** Nama peristiwa untuk pesan pengguna (label katalog event; kunci teknis hanya di payload). */
function eventName(eventKey: string): string {
  const label = (DOMAIN_EVENT_LABELS as Record<string, string>)[eventKey];
  return label ? `"${label}"` : "peristiwa ini";
}
