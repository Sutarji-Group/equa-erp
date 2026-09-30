/**
 * Worker sinkron lapangan (docs/ARCHITECTURE.md §7; US-M3-09 KP-2; PAR-30 ≤ 5 menit).
 *
 * Urutan satu putaran `syncNow()`:
 * 1. Unggah lampiran yang menunggu (`POST /api/sync/upload`, idempoten per ID lampiran).
 * 2. Kirim perintah antrean SEMUA pengguna di perangkat dalam batch ≤ 50 (`POST /api/sync/push`) + laporan kesehatan
 *    (jumlah antrean, versi, baterai, kejadian login offline). Hasil per item: terkirim / ditolak (pesan) /
 *    konflik / perlu login / dicoba ulang dengan backoff.
 * 3. Tarik data referensi pengguna aktif (`GET /api/sync/pull`, BERSYARAT — D-14 butir 3) → `refs`: kursor per
 *    penyedia dikirim (`cursors`), penyedia yang tidak berubah dijawab "tidak berubah" tanpa isi, koleksi yang tumbuh
 *    (penjualan shift, rit) datang sebagai delta (`applyPullPatch`). Pull dapat dilewati (`pull: "auto"`) bila tidak
 *    ada yang terkirim dan pull terakhir belum jatuh tempo (jeda idle PAR-30, maks. 5 menit).
 * 4. Pangkas penyimpanan ponsel (`pruneOutbox`): Blob lampiran terkirim & riwayat antrean terkirim yang lama.
 *
 * Galat unggah lampiran: hanya penolakan final atas BERKAS itu (`isFinalUploadError`) yang menolak perintahnya
 * (`ATTACHMENT_FAILED`, dapat "Kirim ulang" lewat `retryOutboxItem`); galat server/perangkat/sesi bersifat sementara.
 *
 * Pemicu (`startSyncWorker`, penjadwal adaptif `./scheduler.ts` — D-14 butir 2): antrean kosong → pull latar tiap
 * 5 menit (≤ PAR-30) selama aplikasi terlihat; ada antrean → push tiap 60 dtk (coba ulang); perubahan antrean → push
 * segera lalu pull bila terkirim; kembali online/terlihat → segera; tombol "Kirim sekarang" (`syncNow({ force: true })`).
 */
import { activeSession, clearAuthEvents, SYNC_REQUEST_EVENT, takeAuthEvents } from "./auth";
import { APP_VERSION, deviceFetch, FieldApiError, isOnline, loadDevice, OFFLINE_MESSAGE } from "./api";
import { fieldDb, getMeta, PENDING_STATUSES, setMeta, type OutboxItem } from "./db";
import { seedDeviceSeqFloors } from "./numbering";
import { ATTACHMENT_FAILED_CODE, OUTBOX_CHANGED_EVENT, pendingByUser, pruneOutbox } from "./outbox";
import { syncMaxMinutesOf } from "./params";
import { applyPullResponse, pullQueryString } from "./pull";
import { BUSY_SYNC_INTERVAL_MS, createSyncScheduler, idleIntervalFor, type PullMode, type SyncScheduler } from "./scheduler";
import type { PullResponse, PushResult } from "./types";

export const PUSH_BATCH_SIZE = 50;
/** Jeda putaran saat antrean berisi (push/coba ulang). Pull latar saat antrean kosong: `idleIntervalFor(PAR-30)`. */
export const SYNC_INTERVAL_MS = BUSY_SYNC_INTERVAL_MS;
const MAX_BACKOFF_MS = 5 * 60_000;
/** Toleransi jatuh tempo pull "auto" (timer peramban dapat terlambat/lebih awal beberapa detik). */
const PULL_DUE_SLACK_MS = 5_000;

export type SyncState = {
  syncing: boolean;
  lastSyncAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  offline: boolean;
  /** Pull berhasil terakhir (ms epoch) — dasar jadwal pull latar (D-14 butir 2). */
  lastPullAt?: number | null;
};

export type SyncSummary = {
  skipped?: "offline" | "no_device" | "busy";
  uploaded: number;
  sent: number;
  rejected: number;
  retry: number;
  pulled: boolean;
};

/** Jeda pull latar saat antrean kosong dari parameter perangkat (PAR-30; maks. 5 menit). */
export async function idlePullIntervalMs(): Promise<number> {
  try {
    return idleIntervalFor(syncMaxMinutesOf((await loadDevice())?.params));
  } catch {
    return idleIntervalFor(null);
  }
}

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

/** Galat per PENGGUNA (sesi PIN): lewati lampiran pengguna itu tanpa menandai gagal; lanjutkan pengguna lain. */
const USER_SESSION_CODES = new Set(["SESSION_REQUIRED", "SESSION_EXPIRED"]);

/**
 * Penolakan FINAL atas lampiran itu sendiri: server menolak berkasnya (galat `VALIDATION` berisian — jenis, ukuran,
 * ID bentrok) atau akun pemiliknya sudah tidak aktif. SEMUA galat lain bersifat sementara (NFR-07, Bab 6.4): server
 * ≥ 500 (`INTERNAL`, penyimpanan berkas), perangkat perlu aktivasi ulang/diblokir sementara (`DEVICE_*`), token/jam
 * ponsel, sesi, dan galat tak dikenal — lampiran tetap `pending` dan perintahnya tetap di antrean.
 */
export function isFinalUploadError(error: unknown): boolean {
  if (!(error instanceof FieldApiError) || error.network) return false;
  if (error.code === "ACCOUNT_INACTIVE") return true;
  return error.code === "VALIDATION" && error.status === 400 && error.issues.length > 0;
}

async function uploadAttachments(force: boolean): Promise<number> {
  const db = fieldDb();
  const now = Date.now();
  const pending = (await db.attachments.where("status").equals("pending").toArray()).filter((a) => force || !a.nextAttemptAt || a.nextAttemptAt <= now);
  const skipUsers = new Set<string>();
  let uploaded = 0;
  for (const att of pending.slice(0, 20)) {
    if (skipUsers.has(att.userId)) continue;
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
      await db.attachments.update(att.id, { status: "uploaded", uploadedAt: Date.now(), message: null, nextAttemptAt: null });
      uploaded++;
    } catch (error) {
      if (error instanceof FieldApiError && error.network) throw error;
      if (error instanceof FieldApiError && USER_SESSION_CODES.has(error.code)) {
        skipUsers.add(att.userId);
        continue;
      }
      const message = error instanceof Error ? error.message : "Unggah gagal.";
      if (isFinalUploadError(error)) {
        await db.attachments.update(att.id, { status: "failed", attempts: att.attempts + 1, message, nextAttemptAt: null });
        if (att.commandId) {
          await db.outbox.update(att.commandId, { status: "rejected", code: ATTACHMENT_FAILED_CODE, message: `Foto/lampiran gagal diunggah: ${message}`, reviewedAt: null });
        }
        continue;
      }
      // Sementara: lampiran tetap menunggu (backoff), putaran dihentikan — perintah tetap `queued` (tidak ditolak).
      await db.attachments.update(att.id, { attempts: att.attempts + 1, message, nextAttemptAt: backoff(att.attempts + 1, Date.now()) });
      throw error;
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
  const stored = await db.refs.where("userId").equals(session.userId).toArray();
  let res: PullResponse;
  try {
    res = await deviceFetch<PullResponse>(`/api/sync/pull?${pullQueryString(stored)}`, { session });
  } catch (error) {
    if (error instanceof FieldApiError && error.code === "SESSION_EXPIRED") {
      await db.credentials.update(session.userId, { sessionExpiresAt: new Date(0).toISOString() });
      return false;
    }
    throw error;
  }
  const { failed } = await applyPullResponse(session.userId, res);
  if (failed.length) {
    // Delta tidak dapat diterapkan (data lokal tidak cocok dengan kursor) → tarik penuh kunci itu sekali lagi.
    const retry = await deviceFetch<PullResponse>(`/api/sync/pull?${pullQueryString([], failed)}`, { session });
    await applyPullResponse(session.userId, retry);
  }
  // Kursor waktu protokol lama (v1) tidak dipakai lagi.
  await db.meta.delete(`pullCursor:${session.userId}`).catch(() => undefined);
  await seedDeviceSeqFloors(res.deviceSeq);
  return true;
}

/** Keputusan pull satu putaran (D-14 butir 2): segera setelah ada yang terkirim, atau bila jeda idle terlewati. */
async function shouldPull(mode: PullMode, delivered: number): Promise<boolean> {
  if (mode !== "auto") return mode;
  if (delivered > 0) return true;
  const last = (await getSyncState()).lastPullAt ?? null;
  return last === null || Date.now() - last >= (await idlePullIntervalMs()) - PULL_DUE_SLACK_MS;
}

let running: Promise<SyncSummary> | null = null;

/**
 * Satu putaran sinkron (single-flight per tab). `pull`: `true` (bawaan) selalu menarik data; `"auto"` hanya bila ada
 * yang terkirim/diunggah di putaran ini atau pull terakhir sudah melewati jeda idle; `false` tanpa pull.
 */
export function syncNow(opts: { force?: boolean; pull?: PullMode } = {}): Promise<SyncSummary> {
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
      const uploaded = await uploadAttachments(!!opts.force);
      const pushed = await pushQueue(!!opts.force);
      const pullMode: PullMode = opts.force ? true : (opts.pull ?? true);
      const pulled = (await shouldPull(pullMode, uploaded + pushed.sent + pushed.rejected)) ? await pullReferences() : false;
      // NFR-17: pangkas Blob lampiran terkirim & riwayat antrean lama (galat pemangkasan tidak menggagalkan sinkron).
      await pruneOutbox().catch(() => undefined);
      const done = Date.now();
      await patchState({ syncing: false, lastSyncAt: done, lastError: null, offline: false, ...(pulled ? { lastPullAt: done } : {}) });
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

/** Jumlah item antrean yang masih harus dikirim (semua pengguna di perangkat, termasuk menunggu coba ulang). */
async function pendingTotal(): Promise<number> {
  const db = fieldDb();
  let n = 0;
  for (const status of ["queued", "sending"] as const) n += await db.outbox.where("status").equals(status).count();
  return n;
}

/**
 * Mulai worker sinkron (panggil sekali di layout lapangan). Penjadwal adaptif (`createSyncScheduler`): pull latar tiap
 * 5 menit bila antrean kosong (≤ PAR-30), push 60 dtk bila ada antrean, segera saat antrean berubah / online / aplikasi
 * terlihat lagi. `intervalMs` (uji) mengganti jeda idle. Mengembalikan fungsi penghenti.
 */
export function startSyncWorker(opts: { intervalMs?: number } = {}): () => void {
  if (typeof window === "undefined") return () => undefined;
  const scheduler: SyncScheduler = createSyncScheduler({
    run: ({ pull }) => syncNow({ pull }),
    pendingCount: pendingTotal,
    lastPullAt: async () => (await getSyncState()).lastPullAt ?? null,
    idleIntervalMs: opts.intervalMs ? () => opts.intervalMs! : idlePullIntervalMs,
    isVisible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
  });
  const onOnline = () => scheduler.trigger("online");
  const onChange = () => scheduler.trigger("outbox");
  const onVisible = () => {
    if (document.visibilityState === "visible") scheduler.trigger("visible");
  };
  const onOffline = () => void patchState({ offline: true, syncing: false });
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  window.addEventListener(OUTBOX_CHANGED_EVENT, onChange);
  window.addEventListener(SYNC_REQUEST_EVENT, onChange);
  document.addEventListener("visibilitychange", onVisible);
  // Item "sending" yang tertinggal (tab ditutup saat mengirim) kembali ke antrean, lalu mulai (push + pull).
  void fieldDb()
    .outbox.where("status")
    .equals("sending")
    .modify({ status: "queued" })
    .catch(() => undefined)
    .finally(() => scheduler.start());
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener(OUTBOX_CHANGED_EVENT, onChange);
    window.removeEventListener(SYNC_REQUEST_EVENT, onChange);
    document.removeEventListener("visibilitychange", onVisible);
    scheduler.stop();
  };
}

export { PENDING_STATUSES };
