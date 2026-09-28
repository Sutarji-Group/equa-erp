/**
 * Registri sinkron lapangan (docs/ARCHITECTURE.md §7): handler perintah outbox (`registerSyncHandler`) dan penyedia
 * data referensi pull (`registerPullProvider`). Modul mendaftar HANYA di dalam `registerSync()` berkas
 * `src/server/modules/<modul>/sync.ts` (dipanggil `ensureBootstrapped`).
 *
 * ```ts
 * import { z } from "zod";
 * import { substituteDriverConditions } from "@/server/core/auth";
 * import { fieldMetaValues, registerPullProvider, registerSyncHandler } from "@/server/core/sync";
 *
 * export function registerSync(): void {
 *   registerSyncHandler("m3.trip.depart", {
 *     permission: "m3.trip.depart",
 *     // WAJIB untuk izin bersyarat (CONDITIONAL_GRANTS — kernet pengganti US-M2-11): tanpa ini kernet SELALU ditolak.
 *     conditions: async (ctx, payload, { tx }) => substituteDriverConditions(tx, ctx, (await loadTrip(tx, payload.tripId)).truckId, ctxBusinessDate(ctx)),
 *     schema: z.object({ tripId: z.uuid(), lat: z.number(), lng: z.number() }),
 *     labels: { tripId: "Rit" },
 *     handle: async (ctx, payload, meta) => {
 *       await assertTruckScope(meta.tx, ctx, trip.truckId);
 *       … tulis dengan { ...fieldMetaValues(meta) } (device_id, device_time, synced_at, sync_command_id, late_sync,
 *         clock_skew_flagged) …
 *       return { objectType: "trip", objectId: trip.id };   // atau { status: "conflict", message: "…" }
 *     },
 *   });
 *   registerPullProvider("m3.trips_today", async ({ ctx, tx, since }) => ({ trips: … }));
 * }
 * ```
 *
 * Kontrak hasil (lihat push.ts): kembalikan `status: "conflict"` bila perintah lapangan bertabrakan dengan perubahan
 * kantor (tetap diterapkan — "lapangan tidak pernah ditimpa kantor"); lempar `DomainError` untuk penolakan FINAL
 * (disimpan, tidak diulang — pakai hanya bila data memang tidak boleh masuk); galat lain (bug/infrastruktur) → `retry`.
 * Pelanggaran unik tabel bisnis → `rejected` `DUPLICATE_DATA`.
 */
import "server-only";

import type { ZodType, z } from "zod";

import type { RoleCode } from "@/lib/labels";

import { ensureBootstrapped } from "../bootstrap";
import type { AttachmentRow } from "../storage";
import type { ActorContext } from "../context";
import type { Tx } from "../db";
import type { FieldLabels } from "../errors";
import type { AuthorizeConditions } from "../rbac/authorize";
import type { DeviceRow } from "../auth/devices";

/** Perintah outbox dari klien (sudah divalidasi bentuknya). */
export type SyncCommandInput = {
  /** UUID v7 dibuat di perangkat — kunci idempotensi (`sync_commands.id`). */
  id: string;
  type: string;
  payload: unknown;
  userId: string;
  /** Sesi PIN pemilik perintah di perangkat ini (diikat saat dicatat; terverifikasi tanda tangan). */
  sessionId: string | null;
  /** Tanda tangan HMAC perintah (`src/lib/sync-signature.ts`). */
  sig: string | null;
  /** Sesi asal bila perintah diikat ulang setelah login ulang pemiliknya. */
  reboundFrom: string | null;
  deviceTime: Date;
  /** `deviceTime` persis seperti dikirim (bagian dari string yang ditandatangani). */
  deviceTimeRaw: string;
  /** Tanggal bisnis WIB dari perangkat saat dicatat (Bab 5.3) — sudah divalidasi = tanggal WIB `deviceTime`. */
  businessDate: string;
  attachmentIds: string[];
  /** SHA-256 hex isi lampiran (sejajar `attachmentIds`), ikut ditandatangani. */
  attachmentHashes: string[];
};

export type SyncMeta = {
  /** Transaksi perintah ini — hasil handler & baris `sync_commands` di-commit bersama (idempotensi). */
  tx: Tx;
  command: SyncCommandInput;
  device: DeviceRow;
  /** Waktu server saat diterima. */
  receivedAt: Date;
  /** Selisih jam perangkat vs server (ms; positif = jam perangkat lebih cepat). */
  clockSkewMs: number | null;
  /** Selisih > PAR-42 → tandai `clock_skew_flagged` pada baris transaksi. */
  clockSkewFlagged: boolean;
  /**
   * Bab 5.3 "terlambat sinkron": diterima pada hari WIB setelah tanggal bisnisnya, atau hari kas tanggal itu sudah
   * ditutup. Modul WAJIB menyimpannya (`late_sync`) — pakai `fieldMetaValues(ctx, meta)`.
   */
  lateSync: boolean;
  /** Lampiran yang sudah diunggah (`/api/sync/upload`) sesuai `attachmentIds`. */
  attachments: AttachmentRow[];
};

export type SyncHandlerResult = void | {
  /** `conflict` = diterapkan tetapi bertabrakan dengan perubahan kantor (tetap sah, tampil ke Admin Keuangan). */
  status?: "applied" | "conflict";
  message?: string;
  objectType?: string;
  objectId?: string;
  /** Data hasil untuk klien (disimpan di `sync_commands.result`). */
  result?: Record<string, unknown>;
};

export type SyncHandlerDef<S extends ZodType = ZodType> = {
  /** Izin yang diperiksa (salah satu bila array); `null` = setiap pengguna lapangan yang masuk. */
  permission: string | readonly string[] | null;
  /**
   * Kondisi izin bersyarat (`CONDITIONAL_GRANTS`, mis. `substitute_driver` untuk kernet pengganti US-M2-11), dihitung
   * dari payload di dalam transaksi SEBELUM pemeriksaan izin. Tanpa ini peran berizin bersyarat selalu ditolak.
   */
  conditions?: (ctx: ActorContext, payload: z.output<S>, meta: SyncMeta) => Promise<AuthorizeConditions> | AuthorizeConditions;
  schema: S;
  /** Label isian untuk pesan validasi Indonesia. */
  labels?: FieldLabels;
  description?: string;
  handle: (ctx: ActorContext, payload: z.output<S>, meta: SyncMeta) => Promise<SyncHandlerResult> | SyncHandlerResult;
};

type AnyHandler = SyncHandlerDef<ZodType>;

const handlers = new Map<string, AnyHandler>();

/** Daftarkan handler perintah sinkron. Nama baku `<modul>.<objek>.<aksi>` (mis. `m3.trip.depart`). */
export function registerSyncHandler<S extends ZodType>(type: string, def: SyncHandlerDef<S>): () => void {
  if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(type)) {
    throw new Error(`Nama perintah sinkron tidak valid: "${type}" (pakai <modul>.<objek>.<aksi>, huruf kecil).`);
  }
  if (handlers.has(type)) throw new Error(`Handler sinkron "${type}" sudah terdaftar.`);
  handlers.set(type, def as unknown as AnyHandler);
  return () => {
    if (handlers.get(type) === (def as unknown as AnyHandler)) handlers.delete(type);
  };
}

export function getSyncHandler(type: string): AnyHandler | undefined {
  return handlers.get(type);
}

export function listSyncHandlerTypes(): string[] {
  ensureBootstrapped();
  return [...handlers.keys()].sort();
}

/**
 * Nilai kolom `fieldMeta()` (src/db/schema/_columns) untuk baris transaksi yang dibuat perintah sinkron:
 * `{ deviceId, deviceTime, syncedAt, syncCommandId, lateSync, clockSkewFlagged }`.
 */
export function fieldMetaValues(meta: SyncMeta) {
  return {
    deviceId: meta.device.id,
    deviceTime: meta.command.deviceTime,
    syncedAt: meta.receivedAt,
    syncCommandId: meta.command.id,
    lateSync: meta.lateSync,
    clockSkewFlagged: meta.clockSkewFlagged,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Penyedia pull
// ---------------------------------------------------------------------------------------------------------------------

export type PullContext = {
  /** Pelaku lapangan (lingkup truk harian untuk sopir/kernet sudah diterapkan). */
  ctx: ActorContext;
  device: DeviceRow;
  /** Kursor pull sebelumnya (null = unduh penuh). */
  since: Date | null;
  now: Date;
  tx: Tx;
};

export type PullProviderDef = {
  /** Hanya untuk pelaku dengan salah satu peran ini (kosong = semua pengguna lapangan). */
  roles?: readonly RoleCode[];
  fetch: (pc: PullContext) => Promise<unknown> | unknown;
};

const providers = new Map<string, PullProviderDef>();

/**
 * Daftarkan penyedia data referensi offline (rit hari ini, harga, katalog, resep, stok, template struk…). Hasil
 * disajikan di `GET /api/sync/pull` sebagai `data[key]` dan disimpan klien per pengguna (`useReference(key)`).
 * Kembalikan `undefined` bila tidak ada perubahan sejak `since`.
 */
export function registerPullProvider(key: string, fn: PullProviderDef["fetch"] | PullProviderDef): () => void {
  if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(key)) throw new Error(`Kunci pull tidak valid: "${key}" (pakai <modul>.<nama>).`);
  if (providers.has(key)) throw new Error(`Penyedia pull "${key}" sudah terdaftar.`);
  const def: PullProviderDef = typeof fn === "function" ? { fetch: fn } : fn;
  providers.set(key, def);
  return () => {
    if (providers.get(key) === def) providers.delete(key);
  };
}

export function listPullProviders(): [string, PullProviderDef][] {
  ensureBootstrapped();
  return [...providers.entries()].sort(([a], [b]) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------------------------------------------------
// Urutan nomor lokal perangkat (device_seq) — batas bawah dari server
// ---------------------------------------------------------------------------------------------------------------------

type DeviceSeqSource = (tx: Tx, deviceId: string) => Promise<number>;

const seqSources = new Map<string, DeviceSeqSource>();

/**
 * Daftarkan sumber urutan perangkat untuk lingkup nomor lokal (mis. `pos_sale` → `max(pos_sales.device_seq)` untuk
 * perangkat itu). Nilainya dikirim ke perangkat saat aktivasi & pull (`deviceSeq`) sebagai batas bawah
 * `nextDeviceSeq(scope)` — hapus data + aktivasi ulang tidak mengulang nomor lokal. Core mendaftarkan `pos_sale`,
 * `purchase_receipt`, `internal_transfer`; modul menambah lingkupnya sendiri (`<modul>.<dok>`).
 */
export function registerDeviceSeqScope(scope: string, source: DeviceSeqSource): () => void {
  seqSources.set(scope, source);
  return () => {
    if (seqSources.get(scope) === source) seqSources.delete(scope);
  };
}

/** Urutan terbesar yang sudah tercatat server per lingkup untuk perangkat ini. */
export async function deviceSeqFloors(tx: Tx, deviceId: string): Promise<Record<string, number>> {
  ensureBootstrapped();
  const out: Record<string, number> = {};
  for (const [scope, source] of seqSources) {
    try {
      out[scope] = Number(await source(tx, deviceId)) || 0;
    } catch (error) {
      console.error(`[equa] sumber urutan perangkat ${scope} gagal:`, error);
    }
  }
  return out;
}
