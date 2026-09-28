/**
 * Registri sinkron lapangan (docs/ARCHITECTURE.md §7): handler perintah outbox (`registerSyncHandler`) dan penyedia
 * data referensi pull (`registerPullProvider`). Modul mendaftar HANYA di dalam `registerSync()` berkas
 * `src/server/modules/<modul>/sync.ts` (dipanggil `ensureBootstrapped`).
 *
 * ```ts
 * import { z } from "zod";
 * import { registerPullProvider, registerSyncHandler } from "@/server/core/sync";
 *
 * export function registerSync(): void {
 *   registerSyncHandler("m3.trip.depart", {
 *     permission: "m3.trip.depart",
 *     schema: z.object({ tripId: z.uuid(), lat: z.number(), lng: z.number() }),
 *     labels: { tripId: "Rit" },
 *     handle: async (ctx, payload, { tx, command, clockSkewFlagged }) => {
 *       await assertTruckScope(tx, ctx, trip.truckId);
 *       … tulis dengan fieldMeta: deviceId: ctx.deviceId, deviceTime: ctx.deviceTime, syncedAt: ctx.now,
 *         syncCommandId: command.id, clockSkewFlagged …
 *       return { objectType: "trip", objectId: trip.id };   // atau { status: "conflict", message: "…" }
 *     },
 *   });
 *   registerPullProvider("m3.trips_today", async ({ ctx, tx, since }) => ({ trips: … }));
 * }
 * ```
 */
import "server-only";

import type { ZodType, z } from "zod";

import type { RoleCode } from "@/lib/labels";

import type { AttachmentRow } from "../storage";
import type { ActorContext } from "../context";
import type { Tx } from "../db";
import type { FieldLabels } from "../errors";
import type { DeviceRow } from "../auth/devices";

/** Perintah outbox dari klien (sudah divalidasi bentuknya). */
export type SyncCommandInput = {
  /** UUID v7 dibuat di perangkat — kunci idempotensi (`sync_commands.id`). */
  id: string;
  type: string;
  payload: unknown;
  userId: string;
  deviceTime: Date;
  /** Tanggal bisnis WIB dari perangkat saat dicatat (Bab 5.3). */
  businessDate: string;
  attachmentIds: string[];
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
  return [...handlers.keys()].sort();
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
  return [...providers.entries()].sort(([a], [b]) => a.localeCompare(b));
}
