/**
 * M10 — pemantauan & insiden (US-M10-07 KP-2; NFR-28, NFR-31, NFR-02).
 *
 * - `raiseIncident(tx, …)` — API publik untuk modul lain (mis. M12 perangkat GPS mati): catat insiden (tanpa duplikat
 *   untuk kejadian & objek yang masih terbuka) + notifikasi tim IT `incident.opened` (kritis, tanggap ≤ 30 menit).
 * - `acknowledgeIncident` / `resolveIncident` — admin sistem mencatat waktu tanggap & pulih; target dari parameter
 *   `monitoring.incident_targets` (bawaan 30 menit / 4 jam) → penanda terlampaui.
 * - Job 5 menit `m10.monitor.health`: (1) sinkron gagal massal (> N perangkat berantrean tidak sinkron > M menit pada jam
 *   layanan PAR-07; parameter `monitoring.mass_sync_failure`), (2) layanan tidak dapat diakses (jeda denyut pemantauan
 *   > `monitoring.service_down` menit pada jam layanan), (3) HITUNGAN perangkat GPS tanpa posisi > PAR-25 menit —
 *   insiden & peringatan GPS mati dibuat M12 (pemilik deteksi, B-42), job ini tidak menggandakannya.
 */
import "server-only";

import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";

import { devices, incidents, jobRuns } from "@/db/schema";
import type { EnumValue } from "@/lib/labels";
import { formatJam, formatTanggalJam, toBusinessDate } from "@/lib/time";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Db, type Tx } from "@/server/core/db";
import { ConflictError, NotFoundError, parseInput } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";

import { userNames, withinWindow } from "./shared";

export type IncidentRow = typeof incidents.$inferSelect;
export type IncidentKind = EnumValue<"incident_kind">;
export type IncidentSeverity = EnumValue<"incident_severity">;

export type RaiseIncidentInput = {
  tenantId: string | null;
  kind: IncidentKind;
  severity?: IncidentSeverity;
  title: string;
  description?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  detectedAt?: Date;
  /** Bawaan true: tidak membuat insiden baru bila kejadian & objek yang sama masih terbuka/ditanggapi. */
  dedupe?: boolean;
  /** Kode notifikasi tambahan (mis. `sync.mass_failure`) selain `incident.opened`. */
  alsoNotify?: string;
  now?: Date;
};

/**
 * Catat insiden (dipanggil modul lain di transaksinya — mis. M12 saat perangkat GPS mati). Mengembalikan baris insiden
 * dan `created` = false bila insiden yang sama masih terbuka (tanpa notifikasi ulang).
 */
export async function raiseIncident(tx: Tx, input: RaiseIncidentInput): Promise<{ incident: IncidentRow; created: boolean }> {
  const now = input.now ?? new Date();
  if (input.dedupe !== false) {
    const open = await tx
      .select()
      .from(incidents)
      .where(
        and(
          eq(incidents.kind, input.kind),
          inArray(incidents.status, ["open", "acknowledged"]),
          input.objectType ? eq(incidents.objectType, input.objectType) : isNull(incidents.objectType),
          input.objectId ? eq(incidents.objectId, input.objectId) : isNull(incidents.objectId),
          input.tenantId ? eq(incidents.tenantId, input.tenantId) : isNull(incidents.tenantId),
        ),
      )
      .limit(1);
    if (open[0]) return { incident: open[0], created: false };
  }
  const [row] = await tx
    .insert(incidents)
    .values({
      tenantId: input.tenantId,
      kind: input.kind,
      severity: input.severity ?? "critical",
      status: "open",
      title: input.title,
      description: input.description ?? null,
      objectType: input.objectType ?? null,
      objectId: input.objectId ?? null,
      detectedAt: input.detectedAt ?? now,
    })
    .returning();
  if (input.tenantId) {
    const ctx = systemContext({ tenantId: input.tenantId, now });
    await auditRecord(tx, { ctx, objectType: "incident", objectId: row!.id, action: "create", after: { kind: input.kind, severity: row!.severity, title: input.title }, rule: "NFR-28" });
    await notify(tx, {
      event: "incident.opened",
      tenantId: input.tenantId,
      title: `Insiden: ${input.title}`,
      body: input.description ?? null,
      objectType: "incident",
      objectId: row!.id,
      link: "/akses/sinkron#insiden",
      groupKey: `incident:${input.kind}:${input.objectId ?? "-"}`,
      now,
    });
    if (input.alsoNotify) {
      await notify(tx, {
        event: input.alsoNotify,
        tenantId: input.tenantId,
        title: input.title,
        body: input.description ?? null,
        objectType: "incident",
        objectId: row!.id,
        link: "/akses/sinkron#insiden",
        now,
      });
    }
  }
  return { incident: row!, created: true };
}

export type IncidentView = IncidentRow & {
  responseMinutes: number | null;
  recoveryMinutes: number | null;
  responseBreached: boolean;
  recoveryBreached: boolean;
  acknowledgedByName: string | null;
  resolvedByName: string | null;
};

function minutesBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));
}

/** Hitung waktu tanggap & pulih terhadap target NFR-31. */
export function incidentMetrics(row: IncidentRow, targets: { response_minutes: number; recovery_hours: number }, now: Date) {
  const responseMinutes = row.acknowledgedAt ? minutesBetween(row.detectedAt, row.acknowledgedAt) : null;
  const recoveryMinutes = row.resolvedAt ? minutesBetween(row.detectedAt, row.resolvedAt) : null;
  const elapsed = minutesBetween(row.detectedAt, now);
  return {
    responseMinutes,
    recoveryMinutes,
    responseBreached: (responseMinutes ?? (row.status === "open" ? elapsed : 0)) > targets.response_minutes,
    recoveryBreached: (recoveryMinutes ?? (row.status !== "resolved" ? elapsed : 0)) > targets.recovery_hours * 60,
  };
}

/** Daftar insiden tenant (terbaru dulu) dengan metrik tanggap/pulih. */
export async function listIncidents(ctx: ActorContext, filter: { status?: IncidentRow["status"] | "active"; limit?: number } = {}, opts: { tx?: Tx } = {}): Promise<{ items: IncidentView[]; targets: { response_minutes: number; recovery_hours: number } }> {
  await authorize(ctx, "m10.incident.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const targets = await params.get(tx, "monitoring.incident_targets", ctxBusinessDate(ctx));
  const where = [or(eq(incidents.tenantId, ctx.tenantId), isNull(incidents.tenantId))!];
  if (filter.status === "active") where.push(inArray(incidents.status, ["open", "acknowledged"]));
  else if (filter.status) where.push(eq(incidents.status, filter.status));
  const rows = await tx
    .select()
    .from(incidents)
    .where(and(...where))
    .orderBy(desc(incidents.detectedAt))
    .limit(Math.min(filter.limit ?? 100, 500));
  const names = await userNames(tx, rows.flatMap((r) => [r.acknowledgedBy, r.resolvedBy]));
  return {
    targets,
    items: rows.map((r) => ({
      ...r,
      ...incidentMetrics(r, targets, ctx.now),
      acknowledgedByName: r.acknowledgedBy ? (names.get(r.acknowledgedBy) ?? null) : null,
      resolvedByName: r.resolvedBy ? (names.get(r.resolvedBy) ?? null) : null,
    })),
  };
}

async function loadIncident(tx: Tx, ctx: ActorContext, id: string): Promise<IncidentRow> {
  const rows = await tx.select().from(incidents).where(eq(incidents.id, id)).for("update").limit(1);
  const row = rows[0];
  if (!row || (row.tenantId && row.tenantId !== ctx.tenantId)) throw new NotFoundError("Insiden tidak ditemukan.");
  return row;
}

/** Tim IT menanggapi insiden (waktu tanggap tercatat, NFR-31). */
export async function acknowledgeIncident(ctx: ActorContext, input: { incidentId: string; note?: string | null }, opts: { tx?: Tx } = {}): Promise<IncidentRow> {
  await authorize(ctx, "m10.incident.update", { tx: opts.tx, objectType: "incident", objectId: input.incidentId });
  return runService(ctx, opts, async (tx) => {
    const row = await loadIncident(tx, ctx, input.incidentId);
    if (row.status !== "open") throw new ConflictError("INCIDENT_NOT_OPEN", "Insiden ini sudah ditanggapi atau pulih.");
    const [updated] = await tx
      .update(incidents)
      .set({ status: "acknowledged", acknowledgedAt: ctx.now, acknowledgedBy: ctx.userId, updatedAt: ctx.now })
      .where(eq(incidents.id, row.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "incident", objectId: row.id, action: "update", before: { status: "open" }, after: { status: "acknowledged" }, reason: input.note ?? null });
    return updated!;
  });
}

const resolveSchema = z.object({
  incidentId: z.uuid(),
  resolution: z.string().trim().min(5, { error: "Tuliskan penyebab & pemulihannya (minimal 5 karakter)." }).max(2000),
});

/** Tim IT mencatat insiden pulih (waktu pulih tercatat, NFR-31). */
export async function resolveIncident(ctx: ActorContext, input: z.input<typeof resolveSchema>, opts: { tx?: Tx } = {}): Promise<IncidentRow> {
  await authorize(ctx, "m10.incident.update", { tx: opts.tx, objectType: "incident", objectId: input.incidentId });
  const data = parseInput(resolveSchema, input, { resolution: "Pemulihan" });
  return runService(ctx, opts, async (tx) => {
    const row = await loadIncident(tx, ctx, data.incidentId);
    if (row.status === "resolved") throw new ConflictError("INCIDENT_RESOLVED", "Insiden ini sudah tercatat pulih.");
    const [updated] = await tx
      .update(incidents)
      .set({
        status: "resolved",
        acknowledgedAt: row.acknowledgedAt ?? ctx.now,
        acknowledgedBy: row.acknowledgedBy ?? ctx.userId,
        resolvedAt: ctx.now,
        resolvedBy: ctx.userId,
        resolution: data.resolution,
        updatedAt: ctx.now,
      })
      .where(eq(incidents.id, row.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "incident", objectId: row.id, action: "close", before: { status: row.status }, after: { status: "resolved" }, reason: data.resolution });
    return updated!;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Pemeriksaan otomatis (job 5 menit)
// ---------------------------------------------------------------------------------------------------------------------

export const MONITOR_JOB_KEY = "m10.monitor.health";

export type MonitorResult = {
  inServiceHours: boolean;
  massSyncFailure: { failing: number; threshold: number; incident: string | null };
  serviceGap: { minutes: number | null; incident: string | null };
  gpsDead: { devices: number; incidentsCreated: number };
};

/** Perangkat lapangan/POS yang "gagal sinkron": ada antrean menurut laporan perangkat & tidak sinkron > M menit. */
export async function failingSyncDevices(tx: Tx, tenantId: string, now: Date, minutesGt: number) {
  const cutoff = new Date(now.getTime() - minutesGt * 60_000);
  const rows = await tx
    .select({ id: devices.id, code: devices.deviceCode, lastSyncAt: devices.lastSyncAt, queue: devices.reportedQueueCount })
    .from(devices)
    .where(and(eq(devices.tenantId, tenantId), inArray(devices.kind, ["phone", "tablet"]), eq(devices.status, "active")));
  return rows.filter((r) => (r.queue ?? 0) > 0 && (!r.lastSyncAt || r.lastSyncAt < cutoff));
}

/** Jalankan tiga pemeriksaan pemantauan (dipanggil job; aman diulang — insiden terbuka tidak digandakan). */
export async function runMonitoring(now: Date = new Date(), db?: Db): Promise<MonitorResult[]> {
  const database = db ?? getDb();
  const today = toBusinessDate(now);
  const hours = await params.get(database, "PAR-07", today);
  const inServiceHours = withinWindow(hours.start, hours.end, now);
  const mass = await params.get(database, "monitoring.mass_sync_failure", today);
  const down = await params.get(database, "monitoring.service_down", today);
  const gps = await params.get(database, "PAR-25", today);

  // Denyut sebelumnya (slot job terakhir yang berhasil selain slot ini).
  const lastRuns = await database
    .select({ startedAt: jobRuns.startedAt })
    .from(jobRuns)
    .where(and(eq(jobRuns.jobKey, MONITOR_JOB_KEY), eq(jobRuns.status, "succeeded"), lt(jobRuns.startedAt, new Date(now.getTime() - 60_000))))
    .orderBy(desc(jobRuns.startedAt))
    .limit(1);
  const gapMinutes = lastRuns[0] ? Math.round((now.getTime() - lastRuns[0].startedAt.getTime()) / 60_000) : null;

  return withTx(
    async (tx) => {
      const tenants = await tx.selectDistinct({ tenantId: devices.tenantId }).from(devices);
      const out: MonitorResult[] = [];
      for (const { tenantId } of tenants) {
        const result: MonitorResult = {
          inServiceHours,
          massSyncFailure: { failing: 0, threshold: mass.devices_gt, incident: null },
          serviceGap: { minutes: gapMinutes, incident: null },
          gpsDead: { devices: 0, incidentsCreated: 0 },
        };
        if (inServiceHours) {
          const failing = await failingSyncDevices(tx, tenantId, now, mass.minutes_gt);
          result.massSyncFailure.failing = failing.length;
          if (failing.length > mass.devices_gt) {
            const r = await raiseIncident(tx, {
              tenantId,
              kind: "mass_sync_failure",
              title: `Sinkron gagal massal: ${failing.length} perangkat tidak sinkron > ${mass.minutes_gt} menit`,
              description: `Perangkat: ${failing.map((f) => f.code).join(", ")}. Periksa layanan sinkron & jaringan.`,
              objectType: "monitor",
              objectId: "mass_sync_failure",
              alsoNotify: "sync.mass_failure",
              now,
            });
            result.massSyncFailure.incident = r.incident.id;
          }
          if (gapMinutes !== null && gapMinutes > down.minutes_gt) {
            const since = new Date(now.getTime() - gapMinutes * 60_000);
            const r = await raiseIncident(tx, {
              tenantId,
              kind: "service_down",
              title: `Layanan tidak dapat diakses ±${gapMinutes} menit`,
              description: `Tidak ada denyut pemantauan sejak ${formatTanggalJam(since)} sampai ${formatJam(now)} pada jam layanan. Catat penyebab & pemulihannya.`,
              objectType: "monitor",
              objectId: `service_down:${toBusinessDate(since)}`,
              alsoNotify: "sync.mass_failure",
              detectedAt: since,
              now,
            });
            result.serviceGap.incident = r.incident.id;
          }
          const cutoff = new Date(now.getTime() - gps.minutes * 60_000);
          const gpsRows = await tx
            .select({ id: devices.id, code: devices.deviceCode, last: devices.gpsLastPositionAt, state: devices.gpsState })
            .from(devices)
            .where(and(eq(devices.tenantId, tenantId), eq(devices.kind, "gps"), eq(devices.status, "active"), eq(devices.isSpare, false)));
          const dead = gpsRows.filter((g) => g.state === "dead" || g.state === "unplugged" || !g.last || g.last < cutoff);
          // B-42: GPS mati/dicabut DIMILIKI M12 (`m12` deteksi perangkat: jam layanan, truk beroperasi, gangguan vendor
          // sistemik tanpa peringatan per truk) — M12 yang membuat kejadian armada, peringatan `gps.device_dead`, dan
          // insiden `gps_device_dead` (raiseIncident). Job M10 hanya MENGHITUNG untuk ringkasan pemantauan agar tidak
          // menggandakan insiden/peringatan (`incident.opened`) untuk perangkat yang sama.
          result.gpsDead.devices = dead.length;
        }
        out.push(result);
      }
      return out;
    },
    { db: database },
  );
}
