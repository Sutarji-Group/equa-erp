/**
 * M10 — perangkat terdaftar (US-M10-02 KP-1/KP-2/KP-6/KP-7; K24; 7.10.6 perangkat cadangan).
 *
 * Membungkus layanan inti perangkat (`@/server/core/auth`: registerDevice → kode aktivasi 8 karakter ditampilkan
 * SEKALI, blockDevice, requestWipe, issueActivationCode) dan menambah:
 * - `listDevices` / `getDeviceDetail` — daftar & riwayat pemakaian (pengguna & waktu, login gagal, sinkron terakhir,
 *   versi aplikasi) + pemegang AKTUAL per sesi (perangkat cadangan boleh dipakai selain pemegang terdaftar);
 * - `updateDeviceAssignment` — tetapkan ke truk/outlet/sumber air, pemegang, cadangan (berjejak; pindah unit memutus
 *   sesi agar pengguna masuk ulang dengan lingkup baru).
 */
import "server-only";

import { and, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";

import { accessLogs, devices, employees, incidents, outlets, sessions, trucks, users, waterSources } from "@/db/schema";
import { record as auditRecord } from "@/server/core/audit";
import { listDeviceUsage, revokeDeviceSessions, type DeviceRow } from "@/server/core/auth";
import type { ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { authorize, runService } from "@/server/core/rbac";

import { employeeNames, userNames } from "./shared";

export type DeviceListItem = DeviceRow & {
  unitLabel: string | null;
  unitKind: "truck" | "outlet" | "water_source" | null;
  holderName: string | null;
  lastUserName: string | null;
};

async function unitLabels(tx: Tx, rows: DeviceRow[]): Promise<Map<string, { label: string; kind: DeviceListItem["unitKind"] }>> {
  const out = new Map<string, { label: string; kind: DeviceListItem["unitKind"] }>();
  const truckIds = [...new Set(rows.map((r) => r.truckId).filter((x): x is string => !!x))];
  const outletIds = [...new Set(rows.map((r) => r.outletId).filter((x): x is string => !!x))];
  const sourceIds = [...new Set(rows.map((r) => r.waterSourceId).filter((x): x is string => !!x))];
  const t = truckIds.length ? await tx.select({ id: trucks.id, code: trucks.code, plate: trucks.plateNumber }).from(trucks).where(inArray(trucks.id, truckIds)) : [];
  const o = outletIds.length ? await tx.select({ id: outlets.id, name: outlets.name }).from(outlets).where(inArray(outlets.id, outletIds)) : [];
  const s = sourceIds.length ? await tx.select({ id: waterSources.id, name: waterSources.name }).from(waterSources).where(inArray(waterSources.id, sourceIds)) : [];
  for (const r of rows) {
    if (r.truckId) {
      const x = t.find((y) => y.id === r.truckId);
      out.set(r.id, { label: x ? `Truk ${x.code} · ${x.plate}` : "Truk", kind: "truck" });
    } else if (r.outletId) out.set(r.id, { label: o.find((y) => y.id === r.outletId)?.name ?? "Outlet", kind: "outlet" });
    else if (r.waterSourceId) out.set(r.id, { label: s.find((y) => y.id === r.waterSourceId)?.name ?? "Sumber air", kind: "water_source" });
  }
  return out;
}

/** Hias baris perangkat dengan label unit, nama pemegang & pengguna terakhir. */
export async function decorateDevices(tx: Tx, rows: DeviceRow[]): Promise<DeviceListItem[]> {
  const units = await unitLabels(tx, rows);
  const holders = await employeeNames(tx, rows.map((r) => r.holderEmployeeId));
  const lastUsers = await userNames(tx, rows.map((r) => r.lastUserId));
  return rows.map((r) => ({
    ...r,
    unitLabel: units.get(r.id)?.label ?? null,
    unitKind: units.get(r.id)?.kind ?? null,
    holderName: r.holderEmployeeId ? (holders.get(r.holderEmployeeId) ?? null) : null,
    lastUserName: r.lastUserId ? (lastUsers.get(r.lastUserId) ?? null) : null,
  }));
}

export type DeviceFilter = { status?: DeviceRow["status"]; kind?: DeviceRow["kind"]; q?: string };

/** Daftar perangkat tenant (pemilik, admin sistem). */
export async function listDevices(ctx: ActorContext, filter: DeviceFilter = {}, opts: { tx?: Tx } = {}): Promise<DeviceListItem[]> {
  await authorize(ctx, "m10.device.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx.select().from(devices).where(eq(devices.tenantId, ctx.tenantId)).orderBy(devices.kind, devices.deviceCode);
  const q = filter.q?.trim().toLowerCase();
  const filtered = rows.filter(
    (r) => (!filter.status || r.status === filter.status) && (!filter.kind || r.kind === filter.kind) && (!q || `${r.deviceCode} ${r.name}`.toLowerCase().includes(q)),
  );
  return decorateDevices(tx, filtered);
}

export type DeviceSessionItem = {
  id: string;
  userId: string;
  userName: string;
  isHolder: boolean;
  createdAt: Date;
  lastActiveAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
};

export type DeviceDetail = {
  device: DeviceListItem;
  usage: (Awaited<ReturnType<typeof listDeviceUsage>>[number] & { userName: string | null })[];
  failedLogins: (typeof accessLogs.$inferSelect & { userName: string | null })[];
  sessions: DeviceSessionItem[];
  incidents: (typeof incidents.$inferSelect)[];
};

/** Rincian perangkat: riwayat pemakaian, login gagal, sesi (pemegang aktual per sesi), insiden terkait. */
export async function getDeviceDetail(ctx: ActorContext, deviceId: string, opts: { tx?: Tx } = {}): Promise<DeviceDetail> {
  await authorize(ctx, "m10.device.read", { tx: opts.tx, objectType: "device", objectId: deviceId });
  const tx = opts.tx ?? getDb();
  const rows = await tx.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  const row = rows[0];
  if (!row || row.tenantId !== ctx.tenantId) throw new NotFoundError("Perangkat tidak ditemukan.");
  const [device] = await decorateDevices(tx, [row]);
  const usage = await listDeviceUsage(ctx, deviceId, { tx, limit: 100 });
  const failed = await tx
    .select()
    .from(accessLogs)
    .where(and(eq(accessLogs.deviceId, deviceId), or(eq(accessLogs.success, false), inArray(accessLogs.event, ["pin_failed", "pin_locked", "device_rejected"]))))
    .orderBy(desc(accessLogs.occurredAt))
    .limit(50);
  const sessionRows = await tx.select().from(sessions).where(eq(sessions.deviceId, deviceId)).orderBy(desc(sessions.createdAt)).limit(50);
  const names = await userNames(tx, [...usage.map((u) => u.userId), ...failed.map((f) => f.userId), ...sessionRows.map((s) => s.userId)]);
  const holderUser = row.holderEmployeeId
    ? (await tx.select({ id: users.id }).from(users).where(eq(users.employeeId, row.holderEmployeeId)).limit(1))[0]?.id
    : undefined;
  const incidentRows = await tx
    .select()
    .from(incidents)
    .where(and(eq(incidents.objectType, "device"), eq(incidents.objectId, deviceId)))
    .orderBy(desc(incidents.detectedAt))
    .limit(20);
  return {
    device: device!,
    usage: usage.map((u) => ({ ...u, userName: u.userId ? (names.get(u.userId) ?? null) : null })),
    failedLogins: failed.map((f) => ({ ...f, userName: f.userId ? (names.get(f.userId) ?? null) : null })),
    sessions: sessionRows.map((s) => ({
      id: s.id,
      userId: s.userId,
      userName: names.get(s.userId) ?? "—",
      isHolder: !!holderUser && holderUser === s.userId,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      expiresAt: s.expiresAt,
      revokedAt: s.revokedAt,
      revokeReason: s.revokeReason,
    })),
    incidents: incidentRows,
  };
}

const uuidOrNull = z.uuid({ error: "ID tidak valid." }).nullable().optional();

export const deviceAssignmentSchema = z
  .object({
    deviceId: z.uuid(),
    name: z.string().trim().min(2, { error: "Nama perangkat minimal 2 karakter." }).max(120).optional(),
    truckId: uuidOrNull,
    outletId: uuidOrNull,
    waterSourceId: uuidOrNull,
    holderEmployeeId: uuidOrNull,
    isSpare: z.boolean().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    reason: z.string().trim().min(5, { error: "Alasan perubahan wajib diisi (minimal 5 karakter)." }).max(500),
  })
  .refine((v) => [v.truckId, v.outletId, v.waterSourceId].filter(Boolean).length <= 1, {
    error: "Perangkat hanya dapat ditugaskan ke satu unit: truk, outlet, atau sumber air.",
    path: ["truckId"],
  });

/** Tetapkan unit, pemegang, dan status cadangan perangkat (admin sistem). */
export async function updateDeviceAssignment(ctx: ActorContext, input: z.input<typeof deviceAssignmentSchema>, opts: { tx?: Tx } = {}): Promise<DeviceRow> {
  await authorize(ctx, "m10.device.update", { tx: opts.tx, objectType: "device", objectId: input.deviceId });
  const data = parseInput(deviceAssignmentSchema, input, { name: "Nama perangkat", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const rows = await tx.select().from(devices).where(eq(devices.id, data.deviceId)).limit(1);
    const device = rows[0];
    if (!device || device.tenantId !== ctx.tenantId) throw new NotFoundError("Perangkat tidak ditemukan.");
    if (device.kind === "gps" && (data.outletId || data.waterSourceId)) throw ValidationError.field("outletId", "Perangkat GPS hanya dapat dipasang di truk.");
    if (data.truckId) {
      const t = await tx.select({ id: trucks.id }).from(trucks).where(and(eq(trucks.id, data.truckId), eq(trucks.tenantId, ctx.tenantId))).limit(1);
      if (!t[0]) throw ValidationError.field("truckId", "Truk tidak ditemukan.");
    }
    if (data.outletId) {
      const o = await tx.select({ id: outlets.id }).from(outlets).where(and(eq(outlets.id, data.outletId), eq(outlets.tenantId, ctx.tenantId))).limit(1);
      if (!o[0]) throw ValidationError.field("outletId", "Outlet tidak ditemukan.");
    }
    if (data.waterSourceId) {
      const s = await tx.select({ id: waterSources.id }).from(waterSources).where(and(eq(waterSources.id, data.waterSourceId), eq(waterSources.tenantId, ctx.tenantId))).limit(1);
      if (!s[0]) throw ValidationError.field("waterSourceId", "Sumber air tidak ditemukan.");
    }
    if (data.holderEmployeeId) {
      const e = await tx
        .select({ id: employees.id, isActive: employees.isActive, exitDate: employees.exitDate })
        .from(employees)
        .where(and(eq(employees.id, data.holderEmployeeId), eq(employees.tenantId, ctx.tenantId)))
        .limit(1);
      if (!e[0] || !e[0].isActive) throw ValidationError.field("holderEmployeeId", "Pemegang harus karyawan aktif.");
    }
    const unitProvided = data.truckId !== undefined || data.outletId !== undefined || data.waterSourceId !== undefined;
    const next = {
      name: data.name ?? device.name,
      truckId: unitProvided ? (data.truckId ?? null) : device.truckId,
      outletId: unitProvided ? (data.outletId ?? null) : device.outletId,
      waterSourceId: unitProvided ? (data.waterSourceId ?? null) : device.waterSourceId,
      holderEmployeeId: data.holderEmployeeId !== undefined ? (data.holderEmployeeId ?? null) : device.holderEmployeeId,
      isSpare: data.isSpare ?? device.isSpare,
      notes: data.notes !== undefined ? (data.notes ?? null) : device.notes,
    };
    const before = {
      name: device.name,
      truckId: device.truckId,
      outletId: device.outletId,
      waterSourceId: device.waterSourceId,
      holderEmployeeId: device.holderEmployeeId,
      isSpare: device.isSpare,
      notes: device.notes,
    };
    const [updated] = await tx
      .update(devices)
      .set({ ...next, updatedAt: ctx.now })
      .where(eq(devices.id, device.id))
      .returning();
    const unitChanged = next.truckId !== device.truckId || next.outletId !== device.outletId || next.waterSourceId !== device.waterSourceId;
    const revoked = unitChanged ? await revokeDeviceSessions(tx, device.id, "admin", ctx.now) : 0;
    await auditRecord(tx, {
      ctx,
      objectType: "device",
      objectId: device.id,
      action: "update",
      before,
      after: next,
      reason: revoked > 0 ? `${data.reason} (unit berubah; ${revoked} sesi diputus)` : data.reason,
    });
    return updated!;
  });
}
