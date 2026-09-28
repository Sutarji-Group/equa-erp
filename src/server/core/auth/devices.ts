/**
 * Perangkat lapangan/POS terdaftar (docs/ARCHITECTURE.md §6; US-M10-02 KP-1/KP-6/KP-7; K24; BR-37).
 *
 * Siklus: Terdaftar (`registerDevice` → kode aktivasi 8 karakter, berlaku 24 jam) → Aktif (`activateDevice(code)` di
 * `/aktivasi-perangkat` → `{ deviceId, deviceSecret }`, secret hanya dikirim SEKALI; server menyimpan rekaman turunan,
 * bukan secret) → Diblokir (`blockDevice`) / Menunggu hapus data (`requestWipe`) → Data terhapus (kontak berikutnya).
 * Riwayat pemakaian per perangkat di `device_usage_logs`.
 *
 * Fungsi ber-`ctx` memeriksa izin M10 (`m10.device.*`); `activateDevice` dipanggil tanpa sesi (kode = bukti).
 */
import "server-only";

import { and, count, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";

import { accessLogs, devices, deviceUsageLogs, outlets, trucks, waterSources } from "@/db/schema";
import type { ActorSource } from "@/lib/labels";

import { logAccess } from "../access-log";
import { record as auditRecord } from "../audit";
import type { ActorContext } from "../context";
import { getDb, runInTx, withTx, type Tx } from "../db";
import { NotFoundError, parseInput, ValidationError } from "../errors";
import { authorize, runService } from "../rbac/authorize";
import { formatCode, hashCode, issueDeviceSecret, normalizeCode, randomCode } from "./crypto";
import { AuthError } from "./errors";
import { revokeDeviceSessions } from "./session";

export type DeviceRow = typeof devices.$inferSelect;

/** Masa berlaku kode aktivasi perangkat (docs/ARCHITECTURE.md §6). */
export const ACTIVATION_CODE_TTL_HOURS = 24;
/** Batas percobaan aktivasi gagal per alamat IP per 15 menit (anti tebak kode). */
export const ACTIVATION_MAX_FAILURES_PER_15_MIN = 10;

/** Sumber aksi perangkat: tablet/perangkat outlet → POS; lainnya → aplikasi lapangan. */
export function deviceSource(device: Pick<DeviceRow, "outletId" | "kind">): ActorSource {
  return device.outletId ? "pos" : "field";
}

export type FieldHome = "/sopir" | "/pos" | "/produksi";

/** Beranda aplikasi untuk perangkat (truk → /sopir, outlet → /pos, sumber air → /produksi). */
export function deviceHome(device: Pick<DeviceRow, "outletId" | "waterSourceId" | "truckId" | "kind">): FieldHome {
  if (device.outletId) return "/pos";
  if (device.waterSourceId) return "/produksi";
  if (!device.truckId && device.kind === "tablet") return "/pos";
  return "/sopir";
}

/** Info perangkat yang aman dikirim ke klien. */
export type PublicDevice = {
  id: string;
  code: string;
  name: string;
  kind: string;
  status: string;
  isSpare: boolean;
  truckId: string | null;
  outletId: string | null;
  waterSourceId: string | null;
  unitLabel: string | null;
  home: FieldHome;
  source: ActorSource;
};

export async function publicDevice(tx: Tx, device: DeviceRow): Promise<PublicDevice> {
  let unitLabel: string | null = null;
  if (device.truckId) {
    const t = await tx.select({ plate: trucks.plateNumber, code: trucks.code }).from(trucks).where(eq(trucks.id, device.truckId)).limit(1);
    unitLabel = t[0] ? `${t[0].code} · ${t[0].plate}` : null;
  } else if (device.outletId) {
    const o = await tx.select({ name: outlets.name }).from(outlets).where(eq(outlets.id, device.outletId)).limit(1);
    unitLabel = o[0]?.name ?? null;
  } else if (device.waterSourceId) {
    const s = await tx.select({ name: waterSources.name }).from(waterSources).where(eq(waterSources.id, device.waterSourceId)).limit(1);
    unitLabel = s[0]?.name ?? null;
  }
  return {
    id: device.id,
    code: device.deviceCode,
    name: device.name,
    kind: device.kind,
    status: device.status,
    isSpare: device.isSpare,
    truckId: device.truckId,
    outletId: device.outletId,
    waterSourceId: device.waterSourceId,
    unitLabel,
    home: deviceHome(device),
    source: deviceSource(device),
  };
}

/** Konteks pelaku "perangkat" (tanpa pengguna) untuk jejak audit aktivasi/penghapusan. */
export function deviceActorContext(device: Pick<DeviceRow, "id" | "tenantId" | "outletId" | "kind">, now: Date): ActorContext {
  return {
    userId: null,
    employeeId: null,
    roles: [],
    scope: { truckIds: [], outletIds: [], sourceIds: [], tenantIds: [] },
    tenantId: device.tenantId,
    deviceId: device.id,
    source: deviceSource(device),
    now,
  };
}

export async function getDevice(tx: Tx, deviceId: string): Promise<DeviceRow | null> {
  const rows = await tx.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  return rows[0] ?? null;
}

async function requireDevice(tx: Tx, ctx: ActorContext, deviceId: string): Promise<DeviceRow> {
  const device = await getDevice(tx, deviceId);
  if (!device || device.tenantId !== ctx.tenantId) throw new NotFoundError("Perangkat tidak ditemukan.");
  return device;
}

/** Catat riwayat pemakaian perangkat (US-M10-02 KP-7). `tenantId` = `devices.tenant_id` (NFR-30). */
export async function logDeviceUsage(
  tx: Tx,
  input: {
    tenantId: string;
    deviceId: string;
    userId?: string | null;
    event: string;
    occurredAt?: Date;
    appVersion?: string | null;
    queueCount?: number | null;
    batteryPct?: number | null;
    details?: Record<string, unknown> | null;
  },
): Promise<void> {
  await tx.insert(deviceUsageLogs).values({
    tenantId: input.tenantId,
    deviceId: input.deviceId,
    userId: input.userId ?? null,
    event: input.event,
    occurredAt: input.occurredAt ?? new Date(),
    appVersion: input.appVersion ?? null,
    queueCount: input.queueCount ?? null,
    batteryPct: input.batteryPct ?? null,
    details: input.details ?? null,
  });
}

function newActivationCode(now: Date): { code: string; hash: string; expiresAt: Date } {
  const code = randomCode();
  return { code, hash: hashCode("device-activation", code), expiresAt: new Date(now.getTime() + ACTIVATION_CODE_TTL_HOURS * 3_600_000) };
}

const uuidOrNull = z.uuid({ error: "ID tidak valid." }).nullable().optional();

export const registerDeviceSchema = z
  .object({
    deviceCode: z.string().trim().min(2, { error: "Kode perangkat minimal 2 karakter." }).max(60),
    name: z.string().trim().min(2, { error: "Nama perangkat minimal 2 karakter." }).max(120),
    kind: z.enum(["phone", "tablet"], { error: "Jenis perangkat harus ponsel atau tablet." }),
    isSpare: z.boolean().optional().default(false),
    holderEmployeeId: uuidOrNull,
    truckId: uuidOrNull,
    outletId: uuidOrNull,
    waterSourceId: uuidOrNull,
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .refine((v) => [v.truckId, v.outletId, v.waterSourceId].filter(Boolean).length <= 1, {
    error: "Perangkat hanya dapat ditugaskan ke satu unit: truk, outlet, atau sumber air.",
    path: ["truckId"],
  });

export type RegisterDeviceInput = z.input<typeof registerDeviceSchema>;

export type ActivationCodeResult = { code: string; displayCode: string; expiresAt: Date };

/** Daftarkan perangkat baru (admin sistem) → kode aktivasi 8 karakter berlaku 24 jam (hanya ditampilkan sekali). */
export async function registerDevice(
  ctx: ActorContext,
  input: RegisterDeviceInput,
  opts: { tx?: Tx } = {},
): Promise<{ device: DeviceRow } & ActivationCodeResult> {
  await authorize(ctx, "m10.device.register", { tx: opts.tx, objectType: "device" });
  const data = parseInput(registerDeviceSchema, input, {
    deviceCode: "Kode perangkat",
    name: "Nama perangkat",
    kind: "Jenis perangkat",
  });
  return runService(ctx, opts, async (tx) => {
    const dup = await tx.select({ id: devices.id }).from(devices).where(eq(devices.deviceCode, data.deviceCode)).limit(1);
    if (dup[0]) throw ValidationError.field("deviceCode", "Kode perangkat sudah terdaftar. Gunakan kode lain.");
    if (data.truckId) {
      const t = await tx.select({ id: trucks.id }).from(trucks).where(and(eq(trucks.id, data.truckId), eq(trucks.tenantId, ctx.tenantId))).limit(1);
      if (!t[0]) throw ValidationError.field("truckId", "Truk tidak ditemukan.");
    }
    if (data.outletId) {
      const o = await tx.select({ id: outlets.id }).from(outlets).where(and(eq(outlets.id, data.outletId), eq(outlets.tenantId, ctx.tenantId))).limit(1);
      if (!o[0]) throw ValidationError.field("outletId", "Outlet tidak ditemukan.");
    }
    if (data.waterSourceId) {
      const s = await tx
        .select({ id: waterSources.id })
        .from(waterSources)
        .where(and(eq(waterSources.id, data.waterSourceId), eq(waterSources.tenantId, ctx.tenantId)))
        .limit(1);
      if (!s[0]) throw ValidationError.field("waterSourceId", "Sumber air tidak ditemukan.");
    }
    const activation = newActivationCode(ctx.now);
    const [device] = await tx
      .insert(devices)
      .values({
        tenantId: ctx.tenantId,
        deviceCode: data.deviceCode,
        name: data.name,
        kind: data.kind,
        status: "registered",
        isSpare: data.isSpare,
        holderEmployeeId: data.holderEmployeeId ?? null,
        truckId: data.truckId ?? null,
        outletId: data.outletId ?? null,
        waterSourceId: data.waterSourceId ?? null,
        notes: data.notes ?? null,
        activationCodeHash: activation.hash,
        activationExpiresAt: activation.expiresAt,
        createdBy: ctx.userId,
      })
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "device",
      objectId: device!.id,
      action: "create",
      after: { deviceCode: device!.deviceCode, name: device!.name, kind: device!.kind, isSpare: device!.isSpare },
    });
    await logAccess(tx, {
      event: "device_registered",
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      deviceId: device!.id,
      objectType: "device",
      objectId: device!.id,
      occurredAt: ctx.now,
    });
    return { device: device!, code: activation.code, displayCode: formatCode(activation.code), expiresAt: activation.expiresAt };
  });
}

/**
 * Terbitkan kode aktivasi baru untuk perangkat yang sudah terdaftar (pasang ulang aplikasi, perangkat pengganti,
 * perangkat ditemukan kembali setelah diblokir/dihapus). Secret lama langsung tidak berlaku dan semua sesinya dicabut;
 * status kembali Terdaftar sampai kode dipakai.
 */
export async function issueActivationCode(ctx: ActorContext, deviceId: string, opts: { tx?: Tx; reason?: string } = {}): Promise<ActivationCodeResult> {
  await authorize(ctx, "m10.device.register", { tx: opts.tx, objectType: "device", objectId: deviceId });
  return runService(ctx, opts, async (tx) => {
    const device = await requireDevice(tx, ctx, deviceId);
    if (device.kind === "gps") throw ValidationError.field("deviceId", "Perangkat GPS tidak diaktifkan lewat kode.");
    if (device.status === "wipe_pending") {
      // Perintah hapus data harus dijalankan dulu pada kontak berikutnya perangkat lama (US-M10-02 KP-6).
      throw ValidationError.field(
        "deviceId",
        "Perintah hapus data perangkat ini belum dijalankan. Daftarkan perangkat pengganti sebagai perangkat baru.",
      );
    }
    const activation = newActivationCode(ctx.now);
    await tx
      .update(devices)
      .set({
        status: "registered",
        activationCodeHash: activation.hash,
        activationExpiresAt: activation.expiresAt,
        secretHash: null,
        updatedAt: ctx.now,
      })
      .where(eq(devices.id, device.id));
    await revokeDeviceSessions(tx, device.id, "replaced", ctx.now);
    await auditRecord(tx, {
      ctx,
      objectType: "device",
      objectId: device.id,
      action: "update",
      before: { status: device.status },
      after: { status: "registered" },
      reason: opts.reason ?? "Kode aktivasi baru diterbitkan",
    });
    await logAccess(tx, {
      event: "device_registered",
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      deviceId: device.id,
      objectType: "device",
      objectId: device.id,
      reason: "Kode aktivasi baru",
      occurredAt: ctx.now,
    });
    return { code: activation.code, displayCode: formatCode(activation.code), expiresAt: activation.expiresAt };
  });
}

export type ActivationMeta = { ip?: string | null; userAgent?: string | null; now?: Date; appVersion?: string | null };

export type ActivationResult = {
  deviceId: string;
  /** Secret perangkat — HANYA dikirim sekali; simpan di perangkat (WebCrypto non-extractable bila bisa). */
  deviceSecret: string;
  device: PublicDevice;
  serverTime: string;
  /** Batas bawah urutan nomor lokal perangkat per lingkup (aktivasi ulang melanjutkan, tidak mengulang). */
  deviceSeq: Record<string, number>;
};

async function recentActivationFailures(tx: Tx, ip: string | null | undefined, now: Date): Promise<number> {
  if (!ip) return 0;
  const since = new Date(now.getTime() - 15 * 60_000);
  const rows = await tx
    .select({ n: count() })
    .from(accessLogs)
    .where(and(eq(accessLogs.event, "device_rejected"), eq(accessLogs.success, false), eq(accessLogs.ip, ip), gte(accessLogs.occurredAt, since)));
  return Number(rows[0]?.n ?? 0);
}

/** Aktivasi perangkat dengan kode dari admin sistem (tanpa sesi). */
export async function activateDevice(rawCode: string, meta: ActivationMeta = {}): Promise<ActivationResult> {
  const now = meta.now ?? new Date();
  const code = normalizeCode(String(rawCode ?? ""));
  const db = getDb();
  const logBase = { ip: meta.ip ?? null, userAgent: meta.userAgent ?? null, occurredAt: now };

  if ((await recentActivationFailures(db, meta.ip, now)) >= ACTIVATION_MAX_FAILURES_PER_15_MIN) {
    throw new AuthError("ACTIVATION_RATE_LIMITED", "Terlalu banyak percobaan kode aktivasi. Tunggu 15 menit lalu coba lagi, atau hubungi admin sistem.");
  }

  const rows =
    code.length === 8
      ? await db.select().from(devices).where(eq(devices.activationCodeHash, hashCode("device-activation", code))).limit(1)
      : [];
  const device = rows[0];
  const invalid = !device || !device.activationExpiresAt || device.activationExpiresAt.getTime() <= now.getTime() || device.kind === "gps";
  // Perintah hapus data yang belum dijalankan / sudah dijalankan tidak boleh "hilang" karena kode lama yang beredar:
  // admin sistem wajib menerbitkan kode baru secara sadar (issueActivationCode) setelah hapus data dijalankan.
  if (!invalid && (device.status === "wipe_pending" || device.status === "wiped")) {
    await logAccess(db, { ...logBase, event: "device_rejected", success: false, tenantId: device.tenantId, deviceId: device.id, reason: `Kode lama ditolak (status ${device.status})` });
    throw new AuthError("ACTIVATION_INVALID", "Kode aktivasi ini tidak berlaku lagi. Minta kode baru ke admin sistem.");
  }
  if (invalid || device.status === "blocked") {
    await logAccess(db, {
      ...logBase,
      event: "device_rejected",
      success: false,
      tenantId: device?.tenantId ?? null,
      deviceId: device?.id ?? null,
      reason: !device ? "Kode aktivasi tidak dikenal" : device.status === "blocked" ? "Perangkat diblokir" : "Kode aktivasi kedaluwarsa",
    });
    if (device && !invalid && device.status === "blocked") {
      throw new AuthError("DEVICE_BLOCKED", "Perangkat ini diblokir admin sistem. Hubungi admin sistem.");
    }
    throw new AuthError("ACTIVATION_INVALID", "Kode aktivasi salah atau sudah kedaluwarsa. Periksa lagi, atau minta kode baru ke admin sistem.");
  }

  return withTx(async (tx) => {
    const { secret, record } = issueDeviceSecret(device.id);
    const [updated] = await tx
      .update(devices)
      .set({
        status: "active",
        secretHash: record,
        activatedAt: now,
        activationCodeHash: null,
        activationExpiresAt: null,
        blockedAt: null,
        blockedBy: null,
        blockedReason: null,
        lastSeenAt: now,
        appVersion: meta.appVersion ?? device.appVersion,
        updatedAt: now,
      })
      .where(eq(devices.id, device.id))
      .returning();
    await logAccess(tx, { ...logBase, event: "device_activated", tenantId: device.tenantId, deviceId: device.id, objectType: "device", objectId: device.id });
    await logDeviceUsage(tx, { tenantId: device.tenantId, deviceId: device.id, event: "activated", occurredAt: now, appVersion: meta.appVersion ?? null });
    await auditRecord(tx, {
      ctx: deviceActorContext(device, now),
      objectType: "device",
      objectId: device.id,
      action: "activate",
      before: { status: device.status },
      after: { status: "active" },
      reason: "Aktivasi perangkat dengan kode admin sistem",
    });
    const { deviceSeqFloors } = await import("../sync/registry");
    return {
      deviceId: device.id,
      deviceSecret: secret,
      device: await publicDevice(tx, updated!),
      serverTime: now.toISOString(),
      deviceSeq: await deviceSeqFloors(tx, device.id),
    };
  });
}

const reasonSchema = z.string().trim().min(5, { error: "Alasan wajib diisi (minimal 5 karakter)." }).max(500);

/** Blokir perangkat seketika (hilang/rusak/dicuri): tidak dapat login & tidak menerima data baru (US-M10-02 KP-6). */
export async function blockDevice(ctx: ActorContext, deviceId: string, reason: string, opts: { tx?: Tx } = {}): Promise<DeviceRow> {
  await authorize(ctx, "m10.device.block", { tx: opts.tx, objectType: "device", objectId: deviceId });
  const why = parseInput(reasonSchema, reason, { "": "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const device = await requireDevice(tx, ctx, deviceId);
    const [updated] = await tx
      .update(devices)
      .set({
        status: "blocked",
        blockedAt: ctx.now,
        blockedBy: ctx.userId,
        blockedReason: why,
        // Kode aktivasi yang masih beredar ikut gugur.
        activationCodeHash: null,
        activationExpiresAt: null,
        updatedAt: ctx.now,
      })
      .where(eq(devices.id, device.id))
      .returning();
    const revoked = await revokeDeviceSessions(tx, device.id, "device_blocked", ctx.now);
    await auditRecord(tx, { ctx, objectType: "device", objectId: device.id, action: "lock", before: { status: device.status }, after: { status: "blocked" }, reason: why });
    await logAccess(tx, {
      event: "device_blocked",
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      deviceId: device.id,
      reason: why,
      details: { sessionsRevoked: revoked },
      occurredAt: ctx.now,
    });
    await logDeviceUsage(tx, { tenantId: device.tenantId, deviceId: device.id, userId: ctx.userId, event: "blocked", occurredAt: ctx.now, details: { reason: why } });
    return updated!;
  });
}

/**
 * Perintahkan hapus data jarak jauh: status `wipe_pending`; respons berikutnya ke perangkat memerintahkan klien
 * menghapus IndexedDB lalu status menjadi `wiped` (lihat `device-auth.ts`). Antrean belum terkirim yang ikut hilang
 * dicatat sebagai kejadian & dilaporkan ke pemilik (US-M10-02 KP-6, US-M3-09 KP-5).
 */
export async function requestWipe(ctx: ActorContext, deviceId: string, reason: string, opts: { tx?: Tx } = {}): Promise<DeviceRow> {
  await authorize(ctx, "m10.device.wipe", { tx: opts.tx, objectType: "device", objectId: deviceId });
  const why = parseInput(reasonSchema, reason, { "": "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const device = await requireDevice(tx, ctx, deviceId);
    const [updated] = await tx
      .update(devices)
      .set({
        status: "wipe_pending",
        wipeRequestedAt: ctx.now,
        blockedReason: why,
        // Kode aktivasi lama gugur agar perintah hapus tidak tertimpa aktivasi ulang (US-M10-02 KP-6).
        activationCodeHash: null,
        activationExpiresAt: null,
        updatedAt: ctx.now,
      })
      .where(eq(devices.id, device.id))
      .returning();
    await revokeDeviceSessions(tx, device.id, "device_wipe", ctx.now);
    await auditRecord(tx, { ctx, objectType: "device", objectId: device.id, action: "update", before: { status: device.status }, after: { status: "wipe_pending" }, reason: why });
    await logAccess(tx, { event: "device_wipe_requested", tenantId: ctx.tenantId, userId: ctx.userId, deviceId: device.id, reason: why, occurredAt: ctx.now });
    await logDeviceUsage(tx, { tenantId: device.tenantId, deviceId: device.id, userId: ctx.userId, event: "wipe_requested", occurredAt: ctx.now, details: { reason: why } });
    return updated!;
  });
}

export type DeviceUsageRow = typeof deviceUsageLogs.$inferSelect;

/** Riwayat pemakaian perangkat, terbaru dulu (US-M10-02 KP-7). */
export async function listDeviceUsage(ctx: ActorContext, deviceId: string, opts: { tx?: Tx; limit?: number } = {}): Promise<DeviceUsageRow[]> {
  await authorize(ctx, "m10.device.read", { tx: opts.tx, objectType: "device", objectId: deviceId });
  return runInTx(opts.tx, async (tx) => {
    await requireDevice(tx, ctx, deviceId);
    return tx
      .select()
      .from(deviceUsageLogs)
      .where(eq(deviceUsageLogs.deviceId, deviceId))
      .orderBy(desc(deviceUsageLogs.occurredAt))
      .limit(Math.min(opts.limit ?? 100, 500));
  });
}
