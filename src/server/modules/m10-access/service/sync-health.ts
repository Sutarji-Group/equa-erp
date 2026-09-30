/**
 * M10 — halaman "Perangkat & sinkron" (US-M10-07 KP-1; NFR-08; US-M3-09 KP-3) & versi minimal aplikasi (KP-4, NFR-32).
 *
 * - `listSyncHealth(ctx)` — per perangkat lapangan/POS: pengguna terakhir, sinkron terakhir, jumlah item belum terkirim
 *   menurut laporan perangkat (juga per pengguna), versi aplikasi (+ di bawah versi minimal), daya baterai. Admin sistem
 *   & Admin Keuangan melihat semua; Dispatcher hanya perangkat truk.
 * - `listSyncConflicts(ctx)` — perintah lapangan berstatus konflik (lapangan tidak ditimpa kantor, Bab 6.4 butir 3).
 * - `getAppVersionPolicy` / `setMinAppVersion` — versi minimal diatur admin sistem (berjejak); perangkat di bawahnya
 *   diminta memperbarui sebelum melanjutkan (`updateRequired` di pull/status perangkat).
 */
import "server-only";

import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { deviceUsageLogs, devices, parameters, syncCommands } from "@/db/schema";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { parseInput } from "@/server/core/errors";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";
import { compareVersions } from "@/server/core/sync";

import { decorateDevices, type DeviceListItem } from "./devices";
import { userNames } from "./shared";

export type SyncHealthItem = DeviceListItem & {
  queueByUser: { userId: string; name: string; count: number }[];
  belowMinVersion: boolean;
  /** Ada antrean dan sinkron terakhir lebih lama dari PAR-30 (sinkron ≤ N menit). */
  stale: boolean;
  minutesSinceSync: number | null;
};

export type SyncHealthView = {
  items: SyncHealthItem[];
  minVersion: string;
  syncMaxMinutes: number;
  totals: { devices: number; pending: number; stale: number; belowMinVersion: number };
  scope: "all" | "trucks";
};

/** Kesehatan perangkat & sinkron (admin sistem, Admin Keuangan: semua; Dispatcher: perangkat truk). */
export async function listSyncHealth(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<SyncHealthView> {
  await authorize(ctx, "m10.sync_health.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const onlyTrucks = ctx.roles.includes("dispatcher") && !ctx.roles.some((r) => r === "system_admin" || r === "finance_admin" || r === "owner");
  const rows = await tx
    .select()
    .from(devices)
    .where(and(eq(devices.tenantId, ctx.tenantId), inArray(devices.kind, ["phone", "tablet"])))
    .orderBy(devices.deviceCode);
  const visible = onlyTrucks ? rows.filter((r) => !!r.truckId) : rows;
  const decorated = await decorateDevices(tx, visible);
  const { version: minVersion } = await params.get(tx, "app.min_supported_version", today);
  const { sync_max_minutes: syncMaxMinutes } = await params.get(tx, "PAR-30", today);

  const ids = visible.map((r) => r.id);
  const reports = ids.length
    ? await tx
        .select({ deviceId: deviceUsageLogs.deviceId, details: deviceUsageLogs.details, occurredAt: deviceUsageLogs.occurredAt })
        .from(deviceUsageLogs)
        .where(and(inArray(deviceUsageLogs.deviceId, ids), eq(deviceUsageLogs.event, "health_report")))
        .orderBy(desc(deviceUsageLogs.occurredAt))
    : [];
  const latestByDevice = new Map<string, Record<string, number>>();
  for (const r of reports) {
    if (latestByDevice.has(r.deviceId)) continue;
    const q = (r.details as { queueByUser?: Record<string, number> } | null)?.queueByUser;
    latestByDevice.set(r.deviceId, q ?? {});
  }
  const names = await userNames(tx, [...latestByDevice.values()].flatMap((q) => Object.keys(q)));

  const items: SyncHealthItem[] = decorated.map((d) => {
    const minutesSinceSync = d.lastSyncAt ? Math.floor((ctx.now.getTime() - d.lastSyncAt.getTime()) / 60_000) : null;
    const queue = d.reportedQueueCount ?? 0;
    return {
      ...d,
      queueByUser: Object.entries(latestByDevice.get(d.id) ?? {})
        .filter(([, n]) => n > 0)
        .map(([userId, count]) => ({ userId, name: names.get(userId) ?? "—", count })),
      belowMinVersion: !!d.appVersion && compareVersions(d.appVersion, minVersion) < 0,
      stale: queue > 0 && (minutesSinceSync === null || minutesSinceSync > syncMaxMinutes),
      minutesSinceSync,
    };
  });
  return {
    items,
    minVersion,
    syncMaxMinutes,
    scope: onlyTrucks ? "trucks" : "all",
    totals: {
      devices: items.length,
      pending: items.reduce((n, i) => n + (i.reportedQueueCount ?? 0), 0),
      stale: items.filter((i) => i.stale).length,
      belowMinVersion: items.filter((i) => i.belowMinVersion).length,
    },
  };
}

/** Perintah lapangan berstatus konflik 14 hari terakhir (Admin Keuangan, Dispatcher, admin sistem). */
export async function listSyncConflicts(ctx: ActorContext, opts: { tx?: Tx; days?: number } = {}) {
  await authorize(ctx, "m10.sync_conflict.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const since = new Date(ctx.now.getTime() - (opts.days ?? 14) * 86_400_000);
  const rows = await tx
    .select()
    .from(syncCommands)
    .where(and(eq(syncCommands.tenantId, ctx.tenantId), eq(syncCommands.status, "conflict"), gte(syncCommands.receivedAt, since)))
    .orderBy(desc(syncCommands.receivedAt))
    .limit(100);
  const names = await userNames(tx, rows.map((r) => r.userId));
  return rows.map((r) => ({ ...r, userName: r.userId ? (names.get(r.userId) ?? null) : null }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Versi minimal aplikasi (KP-4, NFR-32)
// ---------------------------------------------------------------------------------------------------------------------

export async function getAppVersionPolicy(tx: Tx, businessDate: string) {
  const r = await params.resolve(tx, "app.min_supported_version", businessDate);
  return { minVersion: r.value.version, effectiveFrom: r.effectiveFrom, source: r.source };
}

const minVersionSchema = z.object({
  version: z.string().trim().regex(/^\d+\.\d+\.\d+$/, { error: "Versi harus berformat X.Y.Z (mis. 0.2.0)." }),
  reason: z.string().trim().min(5, { error: "Alasan wajib diisi (minimal 5 karakter), mis. catatan rilis." }).max(500),
});

/**
 * Tetapkan versi minimal aplikasi lapangan/POS mulai hari ini (admin sistem, NFR-32). Riwayat tersimpan di tabel
 * parameter (tidak menimpa hari lain); berjejak audit. Pengguna dengan versi di bawahnya diminta memperbarui.
 */
export async function setMinAppVersion(ctx: ActorContext, input: z.input<typeof minVersionSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m10.app_version.update", { tx: opts.tx, objectType: "parameter", objectId: "app.min_supported_version" });
  const data = parseInput(minVersionSchema, input, { version: "Versi", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const today = ctxBusinessDate(ctx);
    const previous = await params.resolve(tx, "app.min_supported_version", today);
    const meta = params.paramMeta("app.min_supported_version");
    const same = await tx
      .select({ id: parameters.id })
      .from(parameters)
      .where(and(eq(parameters.key, "app.min_supported_version"), eq(parameters.effectiveFrom, today), isNull(parameters.tenantId), isNull(parameters.outletId)))
      .limit(1);
    const value = { version: data.version };
    const [row] = same[0]
      ? await tx.update(parameters).set({ value, reason: data.reason, createdBy: ctx.userId, updatedAt: ctx.now }).where(eq(parameters.id, same[0].id)).returning()
      : await tx
          .insert(parameters)
          .values({
            key: "app.min_supported_version",
            name: meta.name,
            value,
            unit: meta.unit,
            reference: meta.reference,
            description: meta.description ?? null,
            effectiveFrom: today,
            reason: data.reason,
            createdBy: ctx.userId,
          })
          .returning();
    params.invalidateParamCaches(); // v1.0.1: cache pembacaan parameter (params.cached) tidak memakai nilai lama
    await auditRecord(tx, {
      ctx,
      objectType: "parameter",
      objectId: "app.min_supported_version",
      action: "set",
      before: { value: previous.value },
      after: { value, effectiveFrom: today },
      reason: data.reason,
      rule: "NFR-32",
    });
    return row!;
  });
}
