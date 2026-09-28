/**
 * `POST /api/sync/health` (US-M10-07 KP-1; docs/ARCHITECTURE.md §7): laporan kesehatan perangkat — jumlah antrean
 * belum terkirim menurut perangkat, versi aplikasi, baterai, sinkron terakhir — disimpan di `devices` untuk halaman
 * "Perangkat & sinkron". Riwayat (`device_usage_logs`) ditulis bila berubah berarti atau paling sering 30 menit sekali.
 *
 * Laporan juga membawa kejadian offline dari perangkat (PIN salah/terkunci saat tanpa sinyal, login offline) agar
 * tercatat dan admin sistem diberi tahu (US-M3-10 KP-1). Kejadian hanya diterima untuk pengguna yang PERNAH masuk PIN
 * di perangkat ini (ada baris `sessions`), waktu perangkatnya dibatasi ke [sesi pertama di perangkat, sekarang], dan
 * log akses memakai waktu SERVER (`occurred_at`) dengan waktu perangkat di `details.deviceTime` + penanda
 * `reportedByDevice` (perangkat tidak dapat menanam log bertanggal bebas).
 */
import "server-only";

import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { devices, deviceUsageLogs, employees, sessions, users } from "@/db/schema";
import { isUuid } from "@/lib/ids";
import { formatJam } from "@/lib/time";

import { logAccess } from "../access-log";
import { withTx } from "../db";
import { parseInput } from "../errors";
import { notify } from "../notifications/service";
import type { DeviceAuth } from "../auth/device-auth";
import { logDeviceUsage } from "../auth/devices";

const HEALTH_LOG_INTERVAL_MS = 30 * 60_000;

const eventSchema = z.object({
  type: z.enum(["pin_failed", "pin_locked", "offline_login", "lock", "unlock"]),
  userId: z.string().refine(isUuid),
  at: z.iso.datetime({ offset: true }),
  lockedUntil: z.iso.datetime({ offset: true }).optional(),
});

export const healthReportSchema = z.object({
  queueCount: z.number().int().min(0).max(100_000).optional(),
  /** Antrean per pengguna (userId → jumlah) — untuk "menunggu sinkron" per sopir (US-M3-09 KP-3). */
  queueByUser: z.record(z.string(), z.number().int().min(0)).optional(),
  appVersion: z.string().max(40).optional(),
  batteryPct: z.number().int().min(0).max(100).nullable().optional(),
  lastSyncAt: z.iso.datetime({ offset: true }).nullable().optional(),
  events: z.array(eventSchema).max(100).optional(),
});

export type HealthReport = z.input<typeof healthReportSchema>;

/** Simpan laporan kesehatan. `silent` = dipanggil dari push (galat diabaikan). */
export async function recordHealth(auth: DeviceAuth, body: unknown, options: { silent?: boolean } = {}): Promise<{ ok: true }> {
  let report: z.output<typeof healthReportSchema>;
  try {
    report = parseInput(healthReportSchema, body);
  } catch (error) {
    if (options.silent) return { ok: true };
    throw error;
  }
  const { device, now } = auth;
  await withTx(async (tx) => {
    await tx
      .update(devices)
      .set({
        reportedQueueCount: report.queueCount ?? device.reportedQueueCount,
        batteryPct: report.batteryPct === undefined ? device.batteryPct : report.batteryPct,
        appVersion: report.appVersion ?? device.appVersion,
        lastSeenAt: now,
        // Waktu sinkron terakhir dari perangkat tidak boleh melampaui waktu server.
        ...(report.lastSyncAt ? { lastSyncAt: new Date(Math.min(new Date(report.lastSyncAt).getTime(), now.getTime())) } : {}),
      })
      .where(eq(devices.id, device.id));

    const last = await tx
      .select({ occurredAt: deviceUsageLogs.occurredAt, queueCount: deviceUsageLogs.queueCount })
      .from(deviceUsageLogs)
      .where(and(eq(deviceUsageLogs.deviceId, device.id), eq(deviceUsageLogs.event, "health_report")))
      .orderBy(desc(deviceUsageLogs.occurredAt))
      .limit(1);
    const prev = last[0];
    const queueFlip = prev && report.queueCount !== undefined && (prev.queueCount ?? 0) > 0 !== report.queueCount > 0;
    if (!prev || queueFlip || now.getTime() - prev.occurredAt.getTime() >= HEALTH_LOG_INTERVAL_MS) {
      await logDeviceUsage(tx, {
        tenantId: device.tenantId,
        deviceId: device.id,
        userId: auth.user?.id ?? device.lastUserId,
        event: "health_report",
        occurredAt: now,
        appVersion: report.appVersion ?? null,
        queueCount: report.queueCount ?? null,
        batteryPct: report.batteryPct ?? null,
        details: report.queueByUser ? { queueByUser: report.queueByUser } : null,
      });
    }

    const firstSessionAt = new Map<string, Date | null>();
    for (const ev of report.events ?? []) {
      const userRow = await tx
        .select({ id: users.id, tenantId: users.tenantId, fullName: employees.fullName })
        .from(users)
        .innerJoin(employees, eq(employees.id, users.employeeId))
        .where(eq(users.id, ev.userId))
        .limit(1);
      const user = userRow[0];
      if (!user || user.tenantId !== device.tenantId) continue;
      // Hanya pengguna yang pernah masuk PIN di perangkat ini (verifier offline hanya ada setelah login daring).
      if (!firstSessionAt.has(user.id)) {
        const first = await tx
          .select({ createdAt: sessions.createdAt })
          .from(sessions)
          .where(and(eq(sessions.userId, user.id), eq(sessions.deviceId, device.id), eq(sessions.kind, "device")))
          .orderBy(asc(sessions.createdAt))
          .limit(1);
        firstSessionAt.set(user.id, first[0]?.createdAt ?? null);
      }
      const since = firstSessionAt.get(user.id);
      if (!since) continue;
      const reported = new Date(ev.at);
      const deviceAt = new Date(Math.min(Math.max(reported.getTime(), since.getTime()), now.getTime()));
      const details = { offline: true, reportedByDevice: true, deviceTime: ev.at, reportedAt: now.toISOString() };
      await logDeviceUsage(tx, {
        tenantId: device.tenantId,
        deviceId: device.id,
        userId: user.id,
        event: ev.type === "offline_login" ? "login" : ev.type,
        occurredAt: deviceAt,
        details,
      });
      if (ev.type === "pin_failed" || ev.type === "pin_locked") {
        await logAccess(tx, {
          event: ev.type,
          success: false,
          tenantId: device.tenantId,
          userId: user.id,
          deviceId: device.id,
          reason: ev.type === "pin_locked" ? "PIN salah berturut saat offline — dikunci di perangkat (PAR-36; dilaporkan perangkat)" : "PIN salah saat offline (dilaporkan perangkat)",
          details,
          occurredAt: now,
        });
      }
      if (ev.type === "pin_locked") {
        await notify(tx, {
          event: "device.pin_locked",
          tenantId: device.tenantId,
          title: `PIN ${user.fullName} terkunci (offline)`,
          body: `PIN salah berturut di perangkat ${device.deviceCode} saat tanpa sinyal${ev.lockedUntil ? `; terkunci sampai pukul ${formatJam(ev.lockedUntil)}` : ""}.`,
          objectType: "user",
          objectId: user.id,
          link: "/akses/pengguna",
          now,
        });
      }
    }
  });
  return { ok: true };
}
