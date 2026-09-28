/**
 * Event domain (docs/ARCHITECTURE.md §5, §8).
 *
 * - `emit(tx, type, payload, meta?)` — simpan ke `domain_events` (append-only) lalu jalankan handler terdaftar
 *   SECARA SINKRON DI TRANSAKSI YANG SAMA.
 * - `on(type, handler, { name, isolate })` — daftarkan handler (dipanggil dari `registerEvents()` modul, BUKAN di
 *   top-level berkas). Mengembalikan fungsi pelepas (berguna di uji). `onAny(handler)` untuk semua tipe.
 *   - `isolate: true` (BAWAAN; Bab 6.4 butir 3, R04, PTB-47): handler berjalan di SAVEPOINT (`withSavepoint`). Galat di
 *     dalamnya hanya membatalkan perubahan handler itu; pemancar TETAP commit, kegagalan dicatat sebagai `incidents`
 *     (+ notifikasi `incident.opened`) untuk ditindaklanjuti/diputar ulang (`queryEvents`, PTB-47). Contoh: bug jurnal
 *     M11 tidak boleh membuat transaksi lapangan tertolak final.
 *   - `isolate: false`: efek yang WAJIB atomik dengan sumbernya (jarang) — galat diteruskan → seluruh transaksi rollback.
 *   - `name` (dianjurkan `<modul>:<tujuan>`): registrasi ulang dengan nama sama MENGGANTI yang lama (uji yang memanggil
 *     `registerEvents()` + bootstrap tidak menggandakan handler).
 *
 * Contoh (modul M11):
 * ```ts
 * export function registerEvents() {
 *   on("trip.completed", async (event, tx) => { await postFromMapping(tx, {...}) });
 * }
 * ```
 * Registrasi seluruh modul terjadi otomatis sekali per proses (`ensureBootstrapped()`, dipanggil `emit`).
 */
import "server-only";

import { and, asc, eq, gt, gte, lt, type SQL } from "drizzle-orm";

import { domainEvents } from "@/db/schema";
import type { ActorSource } from "@/lib/labels";
import { isBusinessDate } from "@/lib/time";

import { incidents } from "@/db/schema";

import { ensureBootstrapped } from "./bootstrap";
import { ctxBusinessDate, type ActorContext } from "./context";
import { withSavepoint, type Tx } from "./db";
import { DomainError, toUserMessage } from "./errors";
import { notify } from "./notifications/service";
import { DOMAIN_EVENT_LABELS, isDomainEventType, type DomainEventMap, type DomainEventType } from "./events.types";

export * from "./events.types";

export type DomainEvent<T extends DomainEventType = DomainEventType> = {
  id: string;
  seq: number;
  type: T;
  payload: DomainEventMap[T];
  occurredAt: Date;
  businessDate: string | null;
  tenantId: string | null;
  actorUserId: string | null;
  source: ActorSource | null;
  objectType: string | null;
  objectId: string | null;
};

export type EventMeta = {
  /** Pelaku (mengisi tenant, tanggal bisnis, pengguna, sumber). */
  ctx?: ActorContext;
  tenantId?: string | null;
  businessDate?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  occurredAt?: Date;
};

export type EventHandler<T extends DomainEventType> = (event: DomainEvent<T>, tx: Tx) => Promise<void> | void;
type AnyHandler = (event: DomainEvent, tx: Tx) => Promise<void> | void;

type Registration = { name: string; handler: AnyHandler; isolate: boolean; named: boolean };

export type OnOptions = {
  /** Nama unik handler (dianjurkan `<modul>:<tujuan>`); nama sama → registrasi lama diganti. */
  name?: string;
  /** Jalankan di savepoint; galat tidak menggagalkan pemancar (bawaan true). */
  isolate?: boolean;
};

const handlers = new Map<DomainEventType, Registration[]>();
const anyHandlers: Registration[] = [];
const depthByTx = new WeakMap<object, number>();

/** Batas kedalaman event berantai (handler yang meng-emit event lain) — mencegah loop tak berujung. */
const MAX_EVENT_DEPTH = 16;

/** Daftarkan handler untuk satu tipe event. Mengembalikan fungsi pelepas. */
export function on<T extends DomainEventType>(type: T, handler: EventHandler<T>, opts: OnOptions = {}): () => void {
  if (!isDomainEventType(type)) throw new Error(`Tipe event tidak dikenal: ${type}. Tambahkan di events.types.ts.`);
  const list = handlers.get(type) ?? [];
  const reg: Registration = {
    name: opts.name ?? (handler.name || "anonim"),
    handler: handler as unknown as AnyHandler,
    isolate: opts.isolate ?? true,
    named: !!opts.name,
  };
  // Registrasi ulang bernama sama → ganti (mencegah handler ganda saat registerEvents() dipanggil dua kali).
  const existing = reg.named ? list.findIndex((r) => r.named && r.name === reg.name) : -1;
  if (existing >= 0) list.splice(existing, 1, reg);
  else list.push(reg);
  handlers.set(type, list);
  return () => {
    const current = handlers.get(type);
    if (!current) return;
    const idx = current.indexOf(reg);
    if (idx >= 0) current.splice(idx, 1);
  };
}

/** Daftarkan handler untuk semua tipe event (mis. pemantauan). Mengembalikan fungsi pelepas. */
export function onAny(handler: AnyHandler, opts: OnOptions = {}): () => void {
  const reg: Registration = { name: opts.name ?? (handler.name || "anonim"), handler, isolate: opts.isolate ?? true, named: !!opts.name };
  const existing = reg.named ? anyHandlers.findIndex((r) => r.named && r.name === reg.name) : -1;
  if (existing >= 0) anyHandlers.splice(existing, 1);
  anyHandlers.push(reg);
  return () => {
    const idx = anyHandlers.indexOf(reg);
    if (idx >= 0) anyHandlers.splice(idx, 1);
  };
}

/** Nama handler terdaftar untuk tipe event (diagnostik). */
export function listHandlers(type: DomainEventType): string[] {
  return [...(handlers.get(type) ?? []), ...anyHandlers].map((r) => r.name);
}

/** Simpan event dan jalankan handler-nya dalam transaksi `tx`. */
export async function emit<T extends DomainEventType>(
  tx: Tx,
  type: T,
  payload: DomainEventMap[T],
  meta: EventMeta = {},
): Promise<DomainEvent<T>> {
  if (!isDomainEventType(type)) throw new Error(`Tipe event tidak dikenal: ${type}. Tambahkan di events.types.ts.`);
  ensureBootstrapped();

  const ctx = meta.ctx;
  const businessDate = meta.businessDate ?? (ctx ? ctxBusinessDate(ctx) : null);
  const [row] = await tx
    .insert(domainEvents)
    .values({
      tenantId: meta.tenantId ?? ctx?.tenantId ?? null,
      type,
      payload: payload as unknown as Record<string, unknown>,
      // Waktu kejadian mengikuti waktu pelaku (ctx.now) agar uji deterministik & konsisten dengan audit.
      occurredAt: meta.occurredAt ?? ctx?.now ?? new Date(),
      businessDate: businessDate && isBusinessDate(businessDate) ? businessDate : null,
      actorUserId: ctx?.userId ?? null,
      source: ctx?.source ?? null,
      objectType: meta.objectType ?? null,
      objectId: meta.objectId ?? null,
    })
    .returning();

  const event: DomainEvent<T> = {
    id: row!.id,
    seq: row!.seq,
    type,
    payload,
    occurredAt: row!.occurredAt,
    businessDate: row!.businessDate,
    tenantId: row!.tenantId,
    actorUserId: row!.actorUserId,
    source: row!.source,
    objectType: row!.objectType,
    objectId: row!.objectId,
  };

  const depth = (depthByTx.get(tx) ?? 0) + 1;
  if (depth > MAX_EVENT_DEPTH) {
    throw new DomainError("EVENT_LOOP", `Rantai event terlalu dalam saat memproses "${DOMAIN_EVENT_LABELS[type]}". Hubungi admin sistem.`);
  }
  depthByTx.set(tx, depth);
  try {
    for (const reg of [...(handlers.get(type) ?? []), ...anyHandlers]) {
      if (!reg.isolate) {
        await reg.handler(event as unknown as DomainEvent, tx);
        continue;
      }
      try {
        await withSavepoint(tx, async (sp) => {
          depthByTx.set(sp, depth);
          try {
            await reg.handler(event as unknown as DomainEvent, sp);
          } finally {
            depthByTx.delete(sp);
          }
        });
      } catch (error) {
        await recordHandlerFailure(tx, event as unknown as DomainEvent, reg.name, error);
      }
    }
  } finally {
    if (depth === 1) depthByTx.delete(tx);
    else depthByTx.set(tx, depth - 1);
  }
  return event;
}

/**
 * Handler terisolasi gagal: pemancar tetap commit; kegagalan dicatat sebagai insiden (+ notifikasi admin sistem) agar
 * dapat diperbaiki lalu diputar ulang dari `domain_events` (PTB-47).
 */
async function recordHandlerFailure(tx: Tx, event: DomainEvent, handlerName: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[equa] handler event ${event.type} (${handlerName}) gagal — pemancar tetap commit:`, error);
  const [row] = await tx
    .insert(incidents)
    .values({
      tenantId: event.tenantId,
      kind: "other",
      severity: "major",
      title: `Pemrosesan lanjutan "${DOMAIN_EVENT_LABELS[event.type]}" gagal (${handlerName})`,
      description: `Transaksi sumber tetap tersimpan. Perbaiki penyebabnya lalu proses ulang event #${event.seq}. Galat: ${
        error instanceof DomainError ? toUserMessage(error) : message
      }`.slice(0, 2000),
      objectType: "domain_event",
      objectId: event.id,
      detectedAt: event.occurredAt,
    })
    .returning({ id: incidents.id });
  if (!event.tenantId) return;
  await notify(tx, {
    event: "incident.opened",
    tenantId: event.tenantId,
    title: `Pemrosesan lanjutan gagal: ${DOMAIN_EVENT_LABELS[event.type]}`,
    body: `Handler ${handlerName} gagal; transaksi sumber tetap tersimpan. Tindak lanjuti insiden.`,
    objectType: "incident",
    objectId: row!.id,
    link: "/akses/sinkron",
    groupKey: `event_handler:${handlerName}`,
  });
}

export type EventQuery = {
  type?: DomainEventType;
  tenantId?: string;
  objectType?: string;
  objectId?: string;
  from?: Date;
  to?: Date;
  /** Ambil event dengan seq > nilai ini (pemutaran ulang/retroaktif, PTB-47). */
  afterSeq?: number;
  limit?: number;
};

/** Baca event tersimpan (urut seq naik) — mis. M11 membangkitkan jurnal retroaktif (PTB-47). */
export async function queryEvents(tx: Tx, filter: EventQuery = {}) {
  const where: SQL[] = [];
  if (filter.type) where.push(eq(domainEvents.type, filter.type));
  if (filter.tenantId) where.push(eq(domainEvents.tenantId, filter.tenantId));
  if (filter.objectType) where.push(eq(domainEvents.objectType, filter.objectType));
  if (filter.objectId) where.push(eq(domainEvents.objectId, filter.objectId));
  if (filter.from) where.push(gte(domainEvents.occurredAt, filter.from));
  if (filter.to) where.push(lt(domainEvents.occurredAt, filter.to));
  if (filter.afterSeq !== undefined) where.push(gt(domainEvents.seq, filter.afterSeq));
  return tx
    .select()
    .from(domainEvents)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(domainEvents.seq))
    .limit(Math.min(filter.limit ?? 500, 5000));
}
