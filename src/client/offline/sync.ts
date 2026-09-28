/**
 * Worker sinkron lapangan (docs/ARCHITECTURE.md §7; US-M3-09 KP-2; PAR-30 ≤ 5 menit).
 *
 * Urutan satu putaran `syncNow()`:
 * 1. Unggah lampiran yang menunggu (`POST /api/sync/upload`, idempoten per ID lampiran).
 * 2. Kirim perintah antrean SEMUA pengguna di perangkat dalam batch ≤ 50 (`POST /api/sync/push`) + laporan kesehatan
 *    (jumlah antrean, versi, baterai, kejadian login offline). Hasil per item: terkirim / ditolak (pesan) /
 *    konflik / perlu login / dicoba ulang dengan backoff.
 * 3. Tarik data referensi pengguna aktif (`GET /api/sync/pull`) → `refs`.
 *
 * Pemicu (`startSyncWorker`): kejadian `online`, interval 60 detik, perubahan antrean, tab kembali terlihat, dan
 * tombol "Kirim sekarang" (`syncNow({ force: true })`).
 */
import { activeSession, clearAuthEvents, SYNC_REQUEST_EVENT, takeAuthEvents } from "./auth";
import { APP_VERSION, deviceFetch, FieldApiError, isOnline, loadDevice, OFFLINE_MESSAGE } from "./api";
import { fieldDb, getMeta, PENDING_STATUSES, setMeta, type OutboxItem } from "./db";
import { seedDeviceSeqFloors } from "./numbering";
import { OUTBOX_CHANGED_EVENT, pendingByUser } from "./outbox";
import type { PullResponse, PushResult } from "./types";

export const PUSH_BATCH_SIZE = 50;
export const SYNC_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export type SyncState = {
  syncing: boolean;
  lastSyncAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  offline: boolean;
};

export type SyncSummary = {
  skipped?: "offline" | "no_device" | "busy";
  uploaded: number;
  sent: number;
  rejected: number;
  retry: number;
  pulled: boolean;
};

const META_STATE = "syncState";

export async function getSyncState(): Promise<SyncState> {
  return (await getMeta<SyncState>(META_STATE)) ?? { syncing: false, lastSyncAt: null, lastAttemptAt: null, lastError: null, offline: false };
}

async function patchState(patch: Partial<SyncState>): Promise<void> {
  await setMeta(META_STATE, { ...(await getSyncState()), ...patch });
}

function backoff(attempts: number, now: number): number {
  return now + Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** Math.max(0, attempts - 1));
}

async function uploadAttachments(): Promise<number> {
  const db = fieldDb();
  const pending = await db.attachments.where("status").equals("pending").toArray();
  let uploaded = 0;
  for (const att of pending.slice(0, 20)) {
    const form = new FormData();
    form.set("file", att.blob, `${att.id}.${att.contentType.includes("png") ? "png" : "jpg"}`);
    form.set("attachmentId", att.id);
    form.set("userId", att.userId);
    form.set("kind", att.kind);
    form.set("capturedAt", att.capturedAt);
    if (att.lat != null) form.set("lat", String(att.lat));
    if (att.lng != null) form.set("lng", String(att.lng));
    if (att.commandId) form.set("commandId", att.commandId);
    try {
      await deviceFetch("/api/sync/upload", { form });
      await db.attachments.update(att.id, { status: "uploaded", uploadedAt: Date.now(), message: null });
      uploaded++;
    } catch (error) {
      if (error instanceof FieldApiError && (error.network || error.code === "SESSION_REQUIRED")) {
        if (error.network) throw error;
        continue;
      }
      const message = error instanceof Error ? error.message : "Unggah gagal.";
      await db.attachments.update(att.id, { status: "failed", attempts: att.attempts + 1, message });
      if (att.commandId) {
        await db.outbox.update(att.commandId, { status: "rejected", message: `Foto/lampiran gagal diunggah: ${message}` });
      }
    }
  }
  return uploaded;
}

async function healthReport() {
  let batteryPct: number | null = null;
  try {
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number }> };
    if (nav.getBattery) batteryPct = Math.round((await nav.getBattery()).level * 100);
  } catch {
    batteryPct = null;
  }
  const byUser = await pendingByUser();
  const events = await takeAuthEvents();
  const state = await getSyncState();
  return {
    report: {
      queueCount: Object.values(byUser).reduce((a, b) => a + b, 0),
      queueByUser: byUser,
      appVersion: APP_VERSION,
      batteryPct,
      lastSyncAt: state.lastSyncAt ? new Date(state.lastSyncAt).toISOString() : null,
      events,
    },
    eventCount: events.length,
  };
}

function applyResult(item: OutboxItem, r: PushResult, now: number): Partial<OutboxItem> {
  const base = { lastAttemptAt: now, attempts: item.attempts + 1, code: r.code ?? null, message: r.message ?? null, objectType: r.objectType ?? null, objectId: r.objectId ?? null, result: r.result };
  const final = r.status === "duplicate" ? (r.originalStatus ?? "applied") : r.status;
  switch (final) {
    case "applied":
      return { ...base, status: "sent", sentAt: now, nextAttemptAt: null };
    case "conflict":
      return { ...base, status: "conflict", sentAt: now, nextAttemptAt: null };
    case "rejected":
      return { ...base, status: "rejected", nextAttemptAt: null };
    default:
      if (r.code === "SESSION_REQUIRED") return { ...base, status: "needs_login", nextAttemptAt: null };
      return { ...base, status: "queued", nextAttemptAt: backoff(item.attempts + 1, now) };
  }
}

async function pushQueue(force: boolean): Promise<Pick<SyncSummary, "sent" | "rejected" | "retry">> {
  const db = fieldDb();
  const session = await activeSession();
  const summary = { sent: 0, rejected: 0, retry: 0 };
  let healthSent = false;
  for (let round = 0; round < 20; round++) {
    const now = Date.now();
    const candidates = (await db.outbox.where("status").equals("queued").toArray())
      .filter((i) => force || !i.nextAttemptAt || i.nextAttemptAt <= now)
      .sort((a, b) => a.createdAt - b.createdAt);
    const ready: OutboxItem[] = [];
    for (const item of candidates) {
      if (item.attachmentIds.length) {
        const atts = await db.attachments.bulkGet(item.attachmentIds);
        if (atts.some((a) => !a || a.status !== "uploaded")) continue;
      }
      ready.push(item);
      if (ready.length >= PUSH_BATCH_SIZE) break;
    }
    if (ready.length === 0 && healthSent) break;
    const health = healthSent ? null : await healthReport();
    await db.outbox.bulkUpdate(ready.map((i) => ({ key: i.id, changes: { status: "sending" as const } })));
    let res: { results: PushResult[] };
    try {
      res = await deviceFetch<{ results: PushResult[] }>("/api/sync/push", {
        json: {
          commands: ready.map((i) => ({
            id: i.id,
            type: i.type,
            payload: i.payload,
            userId: i.userId,
            sessionId: i.sessionId ?? null,
            sig: i.sig ?? null,
            reboundFrom: i.reboundFrom ?? null,
            deviceTime: i.deviceTime,
            businessDate: i.businessDate,
            attachmentIds: i.attachmentIds,
            attachmentHashes: i.attachmentHashes ?? [],
          })),
          sentAt: new Date().toISOString(),
          ...(health ? { health: health.report } : {}),
        },
        session,
      });
    } catch (error) {
      await db.outbox.bulkUpdate(ready.map((i) => ({ key: i.id, changes: { status: "queued" as const } })));
      throw error;
    }
    if (health) {
      healthSent = true;
      if (health.eventCount) await clearAuthEvents(health.eventCount);
    }
    const byId = new Map(res.results.map((r) => [r.id, r]));
    const done = Date.now();
    for (const item of ready) {
      const r = byId.get(item.id) ?? ({ id: item.id, status: "retry" } as PushResult);
      const changes = applyResult(item, r, done);
      await db.outbox.update(item.id, changes);
      if (changes.status === "sent" || changes.status === "conflict") summary.sent++;
      else if (changes.status === "rejected") summary.rejected++;
      else summary.retry++;
    }
    if (ready.length < PUSH_BATCH_SIZE) break;
  }
  return summary;
}

async function pullReferences(): Promise<boolean> {
  const session = await activeSession();
  if (!session) return false;
  const db = fieldDb();
  const cursorKey = `pullCursor:${session.userId}`;
  const since = await getMeta<string>(cursorKey);
  let res: PullResponse;
  try {
    res = await deviceFetch<PullResponse>(`/api/sync/pull${since ? `?since=${encodeURIComponent(since)}` : ""}`, { session });
  } catch (error) {
    if (error instanceof FieldApiError && error.code === "SESSION_EXPIRED") {
      await db.credentials.update(session.userId, { sessionExpiresAt: new Date(0).toISOString() });
      return false;
    }
    throw error;
  }
  const now = Date.now();
  await db.transaction("rw", db.refs, db.device, db.meta, async () => {
    for (const [key, data] of Object.entries(res.data)) await db.refs.put({ userId: session.userId, key, data, updatedAt: now });
    await db.device.update("device", { device: res.device, params: res.params, minVersion: res.minVersion, updateRequired: res.updateRequired });
    await db.meta.put({ key: cursorKey, value: res.cursor });
  });
  await seedDeviceSeqFloors(res.deviceSeq);
  return true;
}

let running: Promise<SyncSummary> | null = null;

/** Satu putaran sinkron (single-flight per tab). */
export function syncNow(opts: { force?: boolean } = {}): Promise<SyncSummary> {
  if (running) return running;
  running = (async (): Promise<SyncSummary> => {
    const empty: SyncSummary = { uploaded: 0, sent: 0, rejected: 0, retry: 0, pulled: false };
    if (!isOnline()) {
      await patchState({ offline: true, syncing: false });
      return { ...empty, skipped: "offline" };
    }
    if (!(await loadDevice())) return { ...empty, skipped: "no_device" };
    const started = Date.now();
    await patchState({ syncing: true, lastAttemptAt: started, offline: false });
    try {
      const uploaded = await uploadAttachments();
      const pushed = await pushQueue(!!opts.force);
      const pulled = await pullReferences();
      await patchState({ syncing: false, lastSyncAt: Date.now(), lastError: null, offline: false });
      return { uploaded, ...pushed, pulled };
    } catch (error) {
      const offline = error instanceof FieldApiError && error.network;
      await patchState({
        syncing: false,
        offline,
        lastError: offline ? OFFLINE_MESSAGE : error instanceof Error ? error.message : "Sinkron gagal. Akan dicoba lagi.",
      }).catch(() => undefined);
      return { ...empty };
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Mulai worker sinkron (panggil sekali di layout lapangan). Mengembalikan fungsi penghenti. */
export function startSyncWorker(opts: { intervalMs?: number } = {}): () => void {
  if (typeof window === "undefined") return () => undefined;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const run = () => void syncNow();
  const soon = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(run, 500);
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") run();
  };
  const onOffline = () => void patchState({ offline: true, syncing: false });
  window.addEventListener("online", run);
  window.addEventListener("offline", onOffline);
  window.addEventListener(OUTBOX_CHANGED_EVENT, soon);
  window.addEventListener(SYNC_REQUEST_EVENT, soon);
  document.addEventListener("visibilitychange", onVisible);
  const timer = setInterval(run, opts.intervalMs ?? SYNC_INTERVAL_MS);
  // Item "sending" yang tertinggal (tab ditutup saat mengirim) kembali ke antrean, lalu kirim.
  void fieldDb()
    .outbox.where("status")
    .equals("sending")
    .modify({ status: "queued" })
    .catch(() => undefined)
    .finally(run);
  return () => {
    window.removeEventListener("online", run);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener(OUTBOX_CHANGED_EVENT, soon);
    window.removeEventListener(SYNC_REQUEST_EVENT, soon);
    document.removeEventListener("visibilitychange", onVisible);
    clearInterval(timer);
    if (debounce) clearTimeout(debounce);
  };
}

export { PENDING_STATUSES };
