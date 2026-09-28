/**
 * M8 — pembantu internal layanan produksi (tidak diekspor lewat index.ts kecuali disebut): aturan parameter, konteks
 * tulis perintah lapangan, sumber air perangkat + lingkup operator (US-M8-02 KP-5), rencana sumber per rit, dan
 * notifikasi sekali-kirim.
 */
import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { customerAddresses, notifications, waterSources } from "@/db/schema";
import { haversineMeters } from "@/lib/geo";
import type { BusinessDate } from "@/lib/time";

import type { DeviceRow } from "@/server/core/auth";
import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, NotFoundError } from "@/server/core/errors";
import { notify, type NotifyInput } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { assertSourceScope } from "@/server/core/rbac";
import type { AttachmentRow } from "@/server/core/storage";
import { fieldMetaValues, type SyncMeta } from "@/server/core/sync";

export type WaterSourceRow = typeof waterSources.$inferSelect;

// =====================================================================================================================
// Parameter
// =====================================================================================================================

export type M8Rules = {
  /** PAR-15 */
  standardVolumeL: number;
  /** PAR-18 */
  lossMaxPct: number;
  /** PAR-19 */
  utilizationHighPct: number;
  /** PAR-38 */
  maxPhotoKb: number;
  /** PAR-68 */
  deviationPct: number;
  deviationWindowDays: number;
  /** PAR-69 */
  supplyTolerancePct: number;
  /** PAR-70 */
  qualityFrequencyDays: number | null;
  /** PAR-85 */
  utilizationStreakDays: number;
  morningDeadline: string;
  eveningDeadline: string;
  lossAverageDays: number;
  utilizationExportMonths: number;
  qualityReminderDaysBefore: number;
  operatorHistoryDays: number;
};

/** Ambang aturan M8 dari parameter (tanggal bisnis wajib; tidak ada angka aturan di kode). */
export async function m8Rules(tx: Tx, date: BusinessDate, tenantId?: string): Promise<M8Rules> {
  const scope = tenantId ? { tenantId } : undefined;
  const [vol, loss, util, photo, dev, supply, quality, streak, rules] = await Promise.all([
    params.get(tx, "PAR-15", date, scope),
    params.get(tx, "PAR-18", date, scope),
    params.get(tx, "PAR-19", date, scope),
    params.get(tx, "PAR-38", date, scope),
    params.get(tx, "PAR-68", date, scope),
    params.get(tx, "PAR-69", date, scope),
    params.get(tx, "PAR-70", date, scope),
    params.get(tx, "PAR-85", date, scope),
    params.get(tx, "m8.production_rules", date, scope),
  ]);
  return {
    standardVolumeL: vol.liters,
    lossMaxPct: loss.max_percent,
    utilizationHighPct: util.percent_gt,
    maxPhotoKb: photo.max_kb,
    deviationPct: dev.percent_gt,
    deviationWindowDays: dev.window_days,
    supplyTolerancePct: supply.percent,
    qualityFrequencyDays: quality.configured ? quality.frequency_days : null,
    utilizationStreakDays: streak.consecutive_days,
    morningDeadline: rules.morning_deadline,
    eveningDeadline: rules.evening_deadline,
    lossAverageDays: rules.loss_average_days,
    utilizationExportMonths: rules.utilization_export_months,
    qualityReminderDaysBefore: rules.quality_reminder_days_before,
    operatorHistoryDays: rules.operator_history_days,
  };
}

// =====================================================================================================================
// Konteks tulis perintah lapangan
// =====================================================================================================================

/**
 * Konteks tulis satu aksi lapangan operator produksi (dari perintah sinkron). Waktu transaksi = waktu PERANGKAT; tanggal
 * bisnis = tanggal WIB perangkat (Bab 5.3). Perangkat cadangan (BRD 10.5) ditandai lewat `device.isSpare`.
 */
export type M8FieldMeta = {
  tx: Tx;
  device: DeviceRow;
  deviceTime: Date;
  businessDate: BusinessDate;
  commandId: string;
  receivedAt: Date;
  lateSync: boolean;
  attachments: AttachmentRow[];
  fieldValues: ReturnType<typeof fieldMetaValues>;
};

export function fromSyncMeta(meta: SyncMeta): M8FieldMeta {
  return {
    tx: meta.tx,
    device: meta.device,
    deviceTime: meta.command.deviceTime,
    businessDate: meta.command.businessDate,
    commandId: meta.command.id,
    receivedAt: meta.receivedAt,
    lateSync: meta.lateSync,
    attachments: meta.attachments,
    fieldValues: fieldMetaValues(meta),
  };
}

/** Lampiran perintah dengan jenis tertentu (sudah diverifikasi pemilik & hash oleh inti sinkron). */
export function attachmentOfKind(meta: Pick<M8FieldMeta, "attachments">, kind: string): AttachmentRow | null {
  return meta.attachments.find((a) => a.kind === kind) ?? null;
}

// =====================================================================================================================
// Sumber air perangkat + lingkup operator
// =====================================================================================================================

export async function loadSource(tx: Tx, sourceId: string): Promise<WaterSourceRow> {
  const rows = await tx.select().from(waterSources).where(eq(waterSources.id, sourceId)).limit(1);
  if (!rows[0]) throw new NotFoundError("Sumber air tidak ditemukan.");
  return rows[0];
}

/**
 * Sumber air tempat operator mencatat: sumber yang terdaftar pada ponsel sumber (BRD 10.5). Operator hanya mencatat di
 * sumber yang ditugaskan kepadanya (lingkup `water_source`, US-M8-02 KP-5 / US-M10-01 KP-3) — di luar itu DITOLAK.
 */
export async function resolveOperatorSource(tx: Tx, ctx: ActorContext, device: Pick<DeviceRow, "waterSourceId" | "tenantId">): Promise<WaterSourceRow> {
  if (!device.waterSourceId) {
    throw new DomainError(
      "DEVICE_WITHOUT_SOURCE",
      "Ponsel ini belum terdaftar untuk sumber air mana pun. Minta admin sistem mendaftarkan ponsel ke sumber air Anda.",
    );
  }
  const source = await loadSource(tx, device.waterSourceId);
  if (source.tenantId !== ctx.tenantId) throw new NotFoundError("Sumber air tidak ditemukan.");
  await assertSourceScope(tx, ctx, source.id);
  if (!source.isActive) throw new DomainError("SOURCE_INACTIVE", `Sumber air ${source.name} sedang nonaktif. Hubungi pemilik.`);
  return source;
}

// =====================================================================================================================
// Sumber rencana per alamat rit
// =====================================================================================================================

/**
 * Sumber air rencana pengisian untuk alamat rit: sumber acuan alamat (M1, `reference_water_source_id`) atau, bila
 * kosong, sumber aktif terdekat (garis lurus) — konvensi zona tarif M1 ("sumber acuan, bawaan terdekat").
 */
export async function plannedSourceByAddress(tx: Tx, tenantId: string, addressIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (addressIds.length === 0) return out;
  const sources = await tx
    .select({ id: waterSources.id, lat: waterSources.lat, lng: waterSources.lng })
    .from(waterSources)
    .where(and(eq(waterSources.tenantId, tenantId), eq(waterSources.isActive, true)));
  const addrs = await tx
    .select({ id: customerAddresses.id, ref: customerAddresses.referenceWaterSourceId, lat: customerAddresses.lat, lng: customerAddresses.lng })
    .from(customerAddresses)
    .where(inArray(customerAddresses.id, [...new Set(addressIds)]));
  for (const a of addrs) {
    if (a.ref) {
      out.set(a.id, a.ref);
      continue;
    }
    let best: { id: string; d: number } | null = null;
    if (a.lat !== null && a.lng !== null) {
      for (const s of sources) {
        const d = haversineMeters({ lat: a.lat, lng: a.lng }, { lat: s.lat, lng: s.lng });
        if (!best || d < best.d) best = { id: s.id, d };
      }
    }
    if (best) out.set(a.id, best.id);
    else if (sources[0]) out.set(a.id, sources[0].id);
  }
  return out;
}

// =====================================================================================================================
// Notifikasi sekali-kirim (idempoten per `groupKey`)
// =====================================================================================================================

/** Kirim notifikasi hanya bila belum pernah ada notifikasi berkode sama dengan `groupKey` sama (job/rekomputasi ulang). */
export async function notifyOnce(tx: Tx, input: NotifyInput & { groupKey: string }): Promise<boolean> {
  const existing = await tx
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.event, input.event), eq(notifications.groupKey, input.groupKey), eq(notifications.tenantId, input.tenantId)))
    .limit(1);
  if (existing[0]) return false;
  await notify(tx, input);
  return true;
}

/** Bulatkan persen 2 desimal (kolom numeric(7,2)). */
export function pct2(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  const v = Math.round((numerator / denominator) * 10_000) / 100;
  return Math.max(-99_999.99, Math.min(99_999.99, v));
}

export function liter(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `${Math.round(n).toLocaleString("id-ID")} L`;
}
