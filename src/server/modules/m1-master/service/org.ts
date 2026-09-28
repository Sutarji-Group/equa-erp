/**
 * M1 — depot & toko (outlet), sumber air + meter, pool/garasi, karyawan (US-M1-04; FR-M1-03, FR-M1-04, PTB-34, BR-37).
 *
 * Semua entitas dinonaktifkan, bukan dihapus; semua perubahan berjejak. Tanggal keluar karyawan memancarkan
 * `employee.exited` saat diisi/diubah dan sekali lagi saat tercapai (job harian menonaktifkan karyawan) — M10
 * menonaktifkan akun & mencabut sesi bila tanggal keluar ≤ hari ini (BR-37); job harian M10 menangani sisanya.
 */
import "server-only";

import { and, asc, count, eq, isNotNull, lte, ne } from "drizzle-orm";
import { z } from "zod";

import {
  attachments,
  customerAddresses,
  customers,
  employees,
  outlets,
  poolLocations,
  tenants,
  trucks,
  waterMeters,
  waterSources,
} from "@/db/schema";
import { ROLE_CODES, enumValues, label } from "@/lib/labels";
import { isBusinessDate, toBusinessDate, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { getDb } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { assertTenantScope, authorize, authorizeAny, runService } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";
import { normalizeWaNumber } from "@/server/core/wa";

import { autoZoneColumns, mapAddressToZone } from "./zones";

const reasonSchema = z.string().trim().min(3, { error: "Alasan wajib diisi (minimal 3 karakter)." });
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);
const radius = z.number().int().min(10, { error: "Radius geofence minimal 10 m." }).max(5000, { error: "Radius geofence maksimal 5.000 m." });

function changed<T extends Record<string, unknown>>(before: T, after: T, keys: string[]) {
  const diff = keys.filter((k) => before[k] !== after[k]);
  return {
    diff,
    before: Object.fromEntries(diff.map((k) => [k, before[k]])),
    after: Object.fromEntries(diff.map((k) => [k, after[k]])),
  };
}

// =====================================================================================================================
// Outlet (depot & toko) — US-M1-04 KP-1
// =====================================================================================================================

const outletSchema = z.object({
  tenantId: z.uuid().optional(),
  code: z
    .string()
    .trim()
    .min(2, { error: "Kode outlet wajib diisi (mis. D11)." })
    .max(10)
    .regex(/^[A-Za-z0-9]+$/, { error: "Kode outlet hanya huruf dan angka." })
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().min(3, { error: "Nama outlet wajib diisi." }).max(120),
  kind: z.enum(enumValues("outlet_kind")),
  address: z.string().trim().max(300).nullable().optional(),
  lat: lat.nullable().optional(),
  lng: lng.nullable().optional(),
  geofenceRadiusM: radius.nullable().optional(),
  storageCapacityL: z.number().int().min(0).max(1_000_000).nullable().optional(),
  defaultOperatorEmployeeId: z.uuid().nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
});
export type OutletInput = z.input<typeof outletSchema>;
type OutletRow = typeof outlets.$inferSelect;

const OUTLET_LABELS = { code: "Kode outlet", name: "Nama", kind: "Jenis", storageCapacityL: "Kapasitas simpan", geofenceRadiusM: "Radius geofence" };

async function loadOutlet(tx: Tx, ctx: ActorContext | null, id: string): Promise<OutletRow> {
  const rows = await tx.select().from(outlets).where(eq(outlets.id, id)).limit(1);
  if (!rows[0]) throw new NotFoundError("Outlet tidak ditemukan.");
  if (ctx) assertTenantScope(ctx, rows[0].tenantId);
  return rows[0];
}

async function assertOperator(tx: Tx, tenantId: string, employeeId: string): Promise<void> {
  const rows = await tx.select().from(employees).where(eq(employees.id, employeeId)).limit(1);
  if (!rows[0] || rows[0].tenantId !== tenantId) throw ValidationError.field("defaultOperatorEmployeeId", "Karyawan tidak dikenal untuk tenant outlet ini.");
  if (!rows[0].isActive) throw new DomainError("EMPLOYEE_INACTIVE", `${rows[0].fullName} tidak aktif.`);
}

/** Buat outlet (depot/toko). Depot baru otomatis mendapat pelanggan internal untuk pesanan pasokan (PTB-01). */
export async function createOutlet(ctx: ActorContext, input: OutletInput, opts: { tx?: Tx } = {}): Promise<OutletRow> {
  await authorize(ctx, "m1.outlet.create", { tx: opts.tx });
  const data = parseInput(outletSchema, input, OUTLET_LABELS);
  const tenantId = data.tenantId ?? ctx.tenantId;
  assertTenantScope(ctx, tenantId);
  if ((data.lat == null) !== (data.lng == null)) throw ValidationError.field("lat", "Isi lintang dan bujur sekaligus.");
  return runService(ctx, opts, async (tx) => {
    const t = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!t[0]) throw ValidationError.field("tenantId", "Tenant tidak dikenal.");
    const dup = await tx.select({ id: outlets.id }).from(outlets).where(and(eq(outlets.tenantId, tenantId), eq(outlets.code, data.code))).limit(1);
    if (dup[0]) throw new DomainError("OUTLET_DUPLICATE", `Kode outlet ${data.code} sudah dipakai.`);
    if (data.defaultOperatorEmployeeId) await assertOperator(tx, tenantId, data.defaultOperatorEmployeeId);
    const [row] = await tx
      .insert(outlets)
      .values({
        tenantId,
        code: data.code,
        name: data.name,
        kind: data.kind,
        address: data.address ?? null,
        lat: data.lat ?? null,
        lng: data.lng ?? null,
        geofenceRadiusM: data.geofenceRadiusM ?? null,
        storageCapacityL: data.storageCapacityL ?? null,
        defaultOperatorEmployeeId: data.defaultOperatorEmployeeId ?? null,
        phone: data.phone ?? null,
        activatedOn: ctxBusinessDate(ctx),
      })
      .returning();
    await auditRecord(tx, { ctx, objectType: "outlet", objectId: row!.id, action: "create", after: row });
    if (row!.kind === "depot") await ensureInternalCustomer(tx, ctx, row!);
    return row!;
  });
}

/** Pelanggan internal depot (PTB-01) + alamat di koordinat depot (zona otomatis). Idempoten. */
export async function ensureInternalCustomer(tx: Tx, ctx: ActorContext, outlet: OutletRow): Promise<void> {
  const existing = await tx.select({ id: customers.id }).from(customers).where(eq(customers.internalOutletId, outlet.id)).limit(1);
  if (existing[0]) return;
  const [{ n }] = (await tx.select({ n: count() }).from(customers).where(isNotNull(customers.internalOutletId))) as [{ n: number }];
  const wa = normalizeWaNumber(outlet.phone) ?? `62814${String(90_000_000 + Number(n) + 1).padStart(8, "0")}`;
  const [customer] = await tx
    .insert(customers)
    .values({
      tenantId: outlet.tenantId,
      code: `INT-${outlet.code}`,
      name: `${outlet.name} (internal)`,
      segment: "third_party_depot",
      waPhone: wa,
      notes: "Pelanggan internal untuk pesanan pasokan depot sendiri (PTB-01) — tanpa pencatatan uang.",
      creditStatus: "cash",
      creditLimit: 0,
      internalOutletId: outlet.id,
      createdBy: ctx.userId,
    })
    .returning();
  let zoneCols: Record<string, unknown> = { coordinateStatus: "unlocked" as const };
  if (outlet.lat !== null && outlet.lng !== null) {
    try {
      const mapping = await mapAddressToZone(tx, { lat: outlet.lat, lng: outlet.lng, tenantId: outlet.tenantId, date: ctxBusinessDate(ctx) });
      zoneCols = { lat: outlet.lat, lng: outlet.lng, coordinateStatus: "locked" as const, coordinateSource: "map" as const, coordinateLockedAt: ctx.now, ...autoZoneColumns(mapping, ctx.now, false, null) };
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
    }
  }
  await tx.insert(customerAddresses).values({
    customerId: customer!.id,
    label: "Depot",
    addressText: outlet.address ?? outlet.name,
    createdBy: ctx.userId,
    ...zoneCols,
  });
  await auditRecord(tx, { ctx, objectType: "customer", objectId: customer!.id, action: "create", after: customer, reason: "Pelanggan internal depot baru (PTB-01).", rule: "PTB-01" });
}

/** Ubah outlet (pemilik). */
export async function updateOutlet(ctx: ActorContext, outletId: string, input: Partial<OutletInput>, opts: { tx?: Tx } = {}): Promise<OutletRow> {
  await authorize(ctx, "m1.outlet.update", { tx: opts.tx, objectType: "outlet", objectId: outletId });
  return runService(ctx, opts, async (tx) => {
    const before = await loadOutlet(tx, ctx, outletId);
    const data = parseInput(
      outletSchema,
      {
        code: before.code,
        name: before.name,
        kind: before.kind,
        address: before.address,
        lat: before.lat,
        lng: before.lng,
        geofenceRadiusM: before.geofenceRadiusM,
        storageCapacityL: before.storageCapacityL,
        defaultOperatorEmployeeId: before.defaultOperatorEmployeeId,
        phone: before.phone,
        ...input,
        tenantId: before.tenantId,
      },
      OUTLET_LABELS,
    );
    if (data.kind !== before.kind) throw ValidationError.field("kind", "Jenis outlet tidak dapat diubah.");
    if (data.code !== before.code) throw ValidationError.field("code", "Kode outlet tidak dapat diubah (dipakai nomor transaksi POS).");
    if (data.defaultOperatorEmployeeId) await assertOperator(tx, before.tenantId, data.defaultOperatorEmployeeId);
    const patch = {
      name: data.name,
      address: data.address ?? null,
      lat: data.lat ?? null,
      lng: data.lng ?? null,
      geofenceRadiusM: data.geofenceRadiusM ?? null,
      storageCapacityL: data.storageCapacityL ?? null,
      defaultOperatorEmployeeId: data.defaultOperatorEmployeeId ?? null,
      phone: data.phone ?? null,
    };
    const [after] = await tx.update(outlets).set(patch).where(eq(outlets.id, outletId)).returning();
    const d = changed(before as Record<string, unknown>, after as Record<string, unknown>, Object.keys(patch));
    if (d.diff.length) await auditRecord(tx, { ctx, objectType: "outlet", objectId: outletId, action: "update", before: d.before, after: d.after });
    return after!;
  });
}

/** Nonaktifkan / aktifkan kembali outlet beralasan (US-M1-04 KP-4). */
export async function setOutletActive(ctx: ActorContext, outletId: string, input: { active: boolean; reason: string }, opts: { tx?: Tx } = {}): Promise<OutletRow> {
  await authorize(ctx, "m1.outlet.deactivate", { tx: opts.tx, objectType: "outlet", objectId: outletId });
  const data = parseInput(z.object({ active: z.boolean(), reason: reasonSchema }), input);
  return runService(ctx, opts, async (tx) => {
    const before = await loadOutlet(tx, ctx, outletId);
    if (before.isActive === data.active) throw new DomainError("NO_CHANGE", `Outlet sudah ${data.active ? "aktif" : "nonaktif"}.`);
    const [after] = await tx
      .update(outlets)
      .set({ isActive: data.active, deactivatedAt: data.active ? null : ctx.now, deactivationReason: data.active ? null : data.reason })
      .where(eq(outlets.id, outletId))
      .returning();
    await auditRecord(tx, { ctx, objectType: "outlet", objectId: outletId, action: data.active ? "activate" : "deactivate", before: { isActive: before.isActive }, after: { isActive: data.active }, reason: data.reason });
    return after!;
  });
}

/** Daftar outlet (depot & toko) + operator default. */
export async function listOutlets(ctx: ActorContext, opts: { tx?: Tx; kind?: "depot" | "store" } = {}) {
  await authorize(ctx, "m1.outlet.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx
    .select({ o: outlets, operatorName: employees.fullName, tenantName: tenants.name })
    .from(outlets)
    .leftJoin(employees, eq(employees.id, outlets.defaultOperatorEmployeeId))
    .innerJoin(tenants, eq(tenants.id, outlets.tenantId))
    .where(opts.kind ? eq(outlets.kind, opts.kind) : undefined)
    .orderBy(asc(outlets.code));
  return rows.filter((r) => ctx.scope.tenantIds.includes(r.o.tenantId) || ctx.tenantId === r.o.tenantId).map((r) => ({ ...r.o, operatorName: r.operatorName, tenantName: r.tenantName }));
}

// =====================================================================================================================
// Sumber air & meter — US-M1-04 KP-2
// =====================================================================================================================

const sourceSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, { error: "Kode sumber air wajib diisi (mis. SA3)." })
    .max(10)
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().min(3, { error: "Nama sumber air wajib diisi." }).max(120),
  address: z.string().trim().max(300).nullable().optional(),
  lat,
  lng,
  geofenceRadiusM: radius.nullable().optional(),
  dailyCapacityL: z.number().int().min(1_000, { error: "Kapasitas harian minimal 1.000 L." }).max(10_000_000).optional(),
});
export type WaterSourceInput = z.input<typeof sourceSchema>;
type WaterSourceRow = typeof waterSources.$inferSelect;

async function loadSource(tx: Tx, ctx: ActorContext | null, id: string): Promise<WaterSourceRow> {
  const rows = await tx.select().from(waterSources).where(eq(waterSources.id, id)).limit(1);
  if (!rows[0]) throw new NotFoundError("Sumber air tidak ditemukan.");
  if (ctx) assertTenantScope(ctx, rows[0].tenantId);
  return rows[0];
}

/** Buat sumber air (pemilik): kapasitas harian bawaan 50.000 L (K1). */
export async function createWaterSource(ctx: ActorContext, input: WaterSourceInput, opts: { tx?: Tx } = {}): Promise<WaterSourceRow> {
  await authorize(ctx, "m1.water_source.create", { tx: opts.tx });
  const data = parseInput(sourceSchema, input, { code: "Kode", name: "Nama", dailyCapacityL: "Kapasitas harian" });
  return runService(ctx, opts, async (tx) => {
    const dup = await tx.select({ id: waterSources.id }).from(waterSources).where(and(eq(waterSources.tenantId, ctx.tenantId), eq(waterSources.code, data.code))).limit(1);
    if (dup[0]) throw new DomainError("SOURCE_DUPLICATE", `Kode sumber air ${data.code} sudah dipakai.`);
    const [row] = await tx
      .insert(waterSources)
      .values({
        tenantId: ctx.tenantId,
        code: data.code,
        name: data.name,
        address: data.address ?? null,
        lat: data.lat,
        lng: data.lng,
        geofenceRadiusM: data.geofenceRadiusM ?? null,
        dailyCapacityL: data.dailyCapacityL ?? 50_000,
        createdBy: ctx.userId,
      })
      .returning();
    await auditRecord(tx, { ctx, objectType: "water_source", objectId: row!.id, action: "create", after: row });
    return row!;
  });
}

/** Ubah sumber air (pemilik). Koordinat berubah tidak memetakan ulang alamat otomatis (jarak lama tetap). */
export async function updateWaterSource(ctx: ActorContext, sourceId: string, input: Partial<WaterSourceInput>, opts: { tx?: Tx } = {}): Promise<WaterSourceRow> {
  await authorize(ctx, "m1.water_source.update", { tx: opts.tx, objectType: "water_source", objectId: sourceId });
  return runService(ctx, opts, async (tx) => {
    const before = await loadSource(tx, ctx, sourceId);
    const data = parseInput(sourceSchema, { code: before.code, name: before.name, address: before.address, lat: before.lat, lng: before.lng, geofenceRadiusM: before.geofenceRadiusM, dailyCapacityL: before.dailyCapacityL, ...input });
    if (data.code !== before.code) throw ValidationError.field("code", "Kode sumber air tidak dapat diubah.");
    const patch = { name: data.name, address: data.address ?? null, lat: data.lat, lng: data.lng, geofenceRadiusM: data.geofenceRadiusM ?? null, dailyCapacityL: data.dailyCapacityL ?? before.dailyCapacityL };
    const [after] = await tx.update(waterSources).set(patch).where(eq(waterSources.id, sourceId)).returning();
    const d = changed(before as Record<string, unknown>, after as Record<string, unknown>, Object.keys(patch));
    if (d.diff.length) await auditRecord(tx, { ctx, objectType: "water_source", objectId: sourceId, action: "update", before: d.before, after: d.after });
    return after!;
  });
}

/** Nonaktifkan / aktifkan kembali sumber air beralasan. */
export async function setWaterSourceActive(ctx: ActorContext, sourceId: string, input: { active: boolean; reason: string }, opts: { tx?: Tx } = {}): Promise<WaterSourceRow> {
  await authorize(ctx, "m1.water_source.update", { tx: opts.tx, objectType: "water_source", objectId: sourceId });
  const data = parseInput(z.object({ active: z.boolean(), reason: reasonSchema }), input);
  return runService(ctx, opts, async (tx) => {
    const before = await loadSource(tx, ctx, sourceId);
    if (before.isActive === data.active) throw new DomainError("NO_CHANGE", `Sumber air sudah ${data.active ? "aktif" : "nonaktif"}.`);
    if (!data.active) {
      const [{ n }] = (await tx.select({ n: count() }).from(waterSources).where(and(eq(waterSources.tenantId, before.tenantId), eq(waterSources.isActive, true), ne(waterSources.id, sourceId)))) as [{ n: number }];
      if (Number(n) === 0) throw new DomainError("LAST_SOURCE", "Minimal satu sumber air aktif diperlukan untuk menghitung jarak zona.");
    }
    const [after] = await tx
      .update(waterSources)
      .set({ isActive: data.active, deactivatedAt: data.active ? null : ctx.now, deactivatedBy: data.active ? null : ctx.userId, deactivationReason: data.active ? null : data.reason })
      .where(eq(waterSources.id, sourceId))
      .returning();
    await auditRecord(tx, { ctx, objectType: "water_source", objectId: sourceId, action: data.active ? "activate" : "deactivate", before: { isActive: before.isActive }, after: { isActive: data.active }, reason: data.reason });
    return after!;
  });
}

const meterSchema = z.object({
  code: z.string().trim().min(2, { error: "Pengenal meter wajib diisi." }).max(30),
  name: z.string().trim().max(120).nullable().optional(),
  unit: z.enum(enumValues("meter_unit")).optional(),
  /** Angka awal saat cut-over (liter). */
  initialReadingL: z.number().int({ error: "Angka awal harus liter bulat." }).min(0),
  installedAt: z.string().refine(isBusinessDate, { error: "Tanggal pasang harus YYYY-MM-DD." }).nullable().optional(),
  initialPhotoAttachmentId: z.uuid().nullable().optional(),
  notes: z.string().trim().max(300).nullable().optional(),
});
export type WaterMeterInput = z.input<typeof meterSchema>;

/** Tambah meter pada sumber air (pengenal, satuan, angka awal cut-over, foto) — US-M1-04 KP-2. */
export async function addWaterMeter(ctx: ActorContext, sourceId: string, input: WaterMeterInput, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m1.water_source.update", { tx: opts.tx, objectType: "water_source", objectId: sourceId });
  const data = parseInput(meterSchema, input, { code: "Pengenal meter", initialReadingL: "Angka awal" });
  return runService(ctx, opts, async (tx) => {
    await loadSource(tx, ctx, sourceId);
    const dup = await tx.select({ id: waterMeters.id }).from(waterMeters).where(eq(waterMeters.code, data.code)).limit(1);
    if (dup[0]) throw new DomainError("METER_DUPLICATE", `Pengenal meter ${data.code} sudah dipakai.`);
    if (data.initialPhotoAttachmentId) {
      const a = await tx.select().from(attachments).where(eq(attachments.id, data.initialPhotoAttachmentId)).limit(1);
      if (!a[0] || !a[0].contentType.startsWith("image/")) throw ValidationError.field("initialPhotoAttachmentId", "Foto meter tidak ditemukan atau bukan gambar.");
    }
    const [row] = await tx
      .insert(waterMeters)
      .values({
        waterSourceId: sourceId,
        code: data.code,
        name: data.name ?? null,
        unit: data.unit ?? "liter",
        initialReadingL: data.initialReadingL,
        installedAt: data.installedAt ?? null,
        initialPhotoAttachmentId: data.initialPhotoAttachmentId ?? null,
        notes: data.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    if (data.initialPhotoAttachmentId) await linkAttachment(tx, data.initialPhotoAttachmentId, { type: "water_meter", id: row!.id });
    await auditRecord(tx, { ctx, objectType: "water_meter", objectId: row!.id, action: "create", after: row });
    return row!;
  });
}

/** Nonaktifkan meter (bukan dihapus). Penggantian/putaran meter dicatat M8. */
export async function deactivateWaterMeter(ctx: ActorContext, meterId: string, reason: string, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["m1.water_source.update", "m1.water_meter.update"], { tx: opts.tx, objectType: "water_meter", objectId: meterId });
  const cleanReason = parseInput(reasonSchema, reason);
  return runService(ctx, opts, async (tx) => {
    const rows = await tx.select().from(waterMeters).where(eq(waterMeters.id, meterId)).limit(1);
    if (!rows[0]) throw new NotFoundError("Meter tidak ditemukan.");
    await loadSource(tx, ctx, rows[0].waterSourceId);
    if (rows[0].status === "inactive") throw new DomainError("NO_CHANGE", "Meter sudah nonaktif.");
    const [after] = await tx.update(waterMeters).set({ status: "inactive", notes: [rows[0].notes, `Nonaktif: ${cleanReason}`].filter(Boolean).join(" · ") }).where(eq(waterMeters.id, meterId)).returning();
    await auditRecord(tx, { ctx, objectType: "water_meter", objectId: meterId, action: "deactivate", before: { status: rows[0].status }, after: { status: "inactive" }, reason: cleanReason });
    return after!;
  });
}

/** Daftar sumber air + meter. */
export async function listWaterSources(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m1.water_source.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const sources = await tx.select().from(waterSources).where(eq(waterSources.tenantId, ctx.tenantId)).orderBy(asc(waterSources.code));
  const meters = sources.length ? await tx.select().from(waterMeters).orderBy(asc(waterMeters.code)) : [];
  return sources.map((s) => ({ ...s, meters: meters.filter((m) => m.waterSourceId === s.id) }));
}

// =====================================================================================================================
// Pool/garasi — PTB-34
// =====================================================================================================================

const poolSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, { error: "Kode pool wajib diisi (mis. PL2)." })
    .max(10)
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().min(3, { error: "Nama pool wajib diisi." }).max(120),
  address: z.string().trim().max(300).nullable().optional(),
  lat,
  lng,
  geofenceRadiusM: radius.nullable().optional(),
});
export type PoolInput = z.input<typeof poolSchema>;

/** Buat pool/garasi (pemilik menetapkan = disetujui pemilik, 7.12.6). */
export async function createPool(ctx: ActorContext, input: PoolInput, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m1.pool_location.update", { tx: opts.tx });
  const data = parseInput(poolSchema, input, { code: "Kode", name: "Nama" });
  return runService(ctx, opts, async (tx) => {
    const dup = await tx.select({ id: poolLocations.id }).from(poolLocations).where(and(eq(poolLocations.tenantId, ctx.tenantId), eq(poolLocations.code, data.code))).limit(1);
    if (dup[0]) throw new DomainError("POOL_DUPLICATE", `Kode pool ${data.code} sudah dipakai.`);
    const [row] = await tx
      .insert(poolLocations)
      .values({ tenantId: ctx.tenantId, ...data, address: data.address ?? null, geofenceRadiusM: data.geofenceRadiusM ?? null, approvedBy: ctx.userId, approvedAt: ctx.now, createdBy: ctx.userId })
      .returning();
    await auditRecord(tx, { ctx, objectType: "pool_location", objectId: row!.id, action: "create", after: row, rule: "PTB-34" });
    return row!;
  });
}

/** Ubah pool/garasi. */
export async function updatePool(ctx: ActorContext, poolId: string, input: Partial<PoolInput>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m1.pool_location.update", { tx: opts.tx, objectType: "pool_location", objectId: poolId });
  return runService(ctx, opts, async (tx) => {
    const rows = await tx.select().from(poolLocations).where(eq(poolLocations.id, poolId)).limit(1);
    const before = rows[0];
    if (!before) throw new NotFoundError("Pool/garasi tidak ditemukan.");
    assertTenantScope(ctx, before.tenantId);
    const data = parseInput(poolSchema, { code: before.code, name: before.name, address: before.address, lat: before.lat, lng: before.lng, geofenceRadiusM: before.geofenceRadiusM, ...input });
    const patch = { name: data.name, address: data.address ?? null, lat: data.lat, lng: data.lng, geofenceRadiusM: data.geofenceRadiusM ?? null, approvedBy: ctx.userId, approvedAt: ctx.now };
    const [after] = await tx.update(poolLocations).set(patch).where(eq(poolLocations.id, poolId)).returning();
    const d = changed(before as Record<string, unknown>, after as Record<string, unknown>, ["name", "address", "lat", "lng", "geofenceRadiusM"]);
    if (d.diff.length) await auditRecord(tx, { ctx, objectType: "pool_location", objectId: poolId, action: "update", before: d.before, after: d.after });
    return after!;
  });
}

/** Nonaktifkan / aktifkan kembali pool beralasan (truk yang merujuk tetap tercatat). */
export async function setPoolActive(ctx: ActorContext, poolId: string, input: { active: boolean; reason: string }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m1.pool_location.update", { tx: opts.tx, objectType: "pool_location", objectId: poolId });
  const data = parseInput(z.object({ active: z.boolean(), reason: reasonSchema }), input);
  return runService(ctx, opts, async (tx) => {
    const rows = await tx.select().from(poolLocations).where(eq(poolLocations.id, poolId)).limit(1);
    const before = rows[0];
    if (!before) throw new NotFoundError("Pool/garasi tidak ditemukan.");
    assertTenantScope(ctx, before.tenantId);
    if (before.isActive === data.active) throw new DomainError("NO_CHANGE", `Pool sudah ${data.active ? "aktif" : "nonaktif"}.`);
    const [after] = await tx
      .update(poolLocations)
      .set({ isActive: data.active, deactivatedAt: data.active ? null : ctx.now, deactivatedBy: data.active ? null : ctx.userId, deactivationReason: data.active ? null : data.reason })
      .where(eq(poolLocations.id, poolId))
      .returning();
    await auditRecord(tx, { ctx, objectType: "pool_location", objectId: poolId, action: data.active ? "activate" : "deactivate", before: { isActive: before.isActive }, after: { isActive: data.active }, reason: data.reason });
    return after!;
  });
}

/** Daftar pool/garasi. */
export async function listPools(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m1.pool_location.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  return tx.select().from(poolLocations).where(eq(poolLocations.tenantId, ctx.tenantId)).orderBy(asc(poolLocations.code));
}

// =====================================================================================================================
// Karyawan — US-M1-04 KP-3 (BR-37)
// =====================================================================================================================

const roleSchema = z.enum(ROLE_CODES as unknown as [string, ...string[]]);
const employeeSchema = z.object({
  employeeNo: z.string().trim().min(2, { error: "Nomor karyawan wajib diisi (mis. EQ-050)." }).max(20),
  fullName: z.string().trim().min(3, { error: "Nama karyawan wajib diisi." }).max(120),
  nickname: z.string().trim().max(40).nullable().optional(),
  position: z.string().trim().min(2, { error: "Jabatan wajib diisi." }).max(80),
  phone: z.string().trim().max(30).nullable().optional(),
  workLocation: z.string().trim().max(120).nullable().optional(),
  primaryOutletId: z.uuid().nullable().optional(),
  intendedRoles: z.array(roleSchema).max(4).optional(),
  hireDate: z.string().refine(isBusinessDate, { error: "Tanggal masuk harus YYYY-MM-DD." }).nullable().optional(),
  exitDate: z.string().refine(isBusinessDate, { error: "Tanggal keluar harus YYYY-MM-DD." }).nullable().optional(),
});
export type EmployeeInput = z.input<typeof employeeSchema>;
type EmployeeRow = typeof employees.$inferSelect;

const EMP_LABELS = { employeeNo: "Nomor karyawan", fullName: "Nama", position: "Jabatan", hireDate: "Tanggal masuk", exitDate: "Tanggal keluar" };

async function loadEmployee(tx: Tx, ctx: ActorContext | null, id: string): Promise<EmployeeRow> {
  const rows = await tx.select().from(employees).where(eq(employees.id, id)).limit(1);
  if (!rows[0]) throw new NotFoundError("Karyawan tidak ditemukan.");
  if (ctx) assertTenantScope(ctx, rows[0].tenantId);
  return rows[0];
}

function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const n = normalizeWaNumber(phone);
  if (!n) throw ValidationError.field("phone", "Nomor telepon tidak valid. Contoh: 0812-3456-7890.");
  return n;
}

async function emitEmployeeExited(tx: Tx, ctx: ActorContext, emp: EmployeeRow, exitDate: string): Promise<void> {
  await emit(tx, "employee.exited", { employeeId: emp.id, exitDate, tenantId: emp.tenantId }, { ctx, tenantId: emp.tenantId, objectType: "employee", objectId: emp.id });
}

/** Lepas karyawan dari kru default truk (keluar/nonaktif) — berjejak (BR-37). */
async function releaseDefaultCrew(tx: Tx, ctx: ActorContext, employeeId: string, reason: string): Promise<void> {
  for (const col of ["defaultDriverEmployeeId", "defaultHelperEmployeeId"] as const) {
    const rows = await tx.update(trucks).set({ [col]: null }).where(eq(trucks[col], employeeId)).returning({ id: trucks.id, code: trucks.code });
    for (const r of rows) {
      await auditRecord(tx, { ctx, objectType: "truck", objectId: r.id, action: "update", before: { [col]: employeeId }, after: { [col]: null }, reason, rule: "BR-37" });
    }
  }
}

/** Tambah karyawan (admin sistem). Pengaitan ke akun & peran efektif di M10. */
export async function createEmployee(ctx: ActorContext, input: EmployeeInput, opts: { tx?: Tx } = {}): Promise<EmployeeRow> {
  await authorize(ctx, "m1.employee.create", { tx: opts.tx });
  const data = parseInput(employeeSchema, input, EMP_LABELS);
  if (data.exitDate && data.hireDate && data.exitDate < data.hireDate) throw ValidationError.field("exitDate", "Tanggal keluar tidak boleh sebelum tanggal masuk.");
  return runService(ctx, opts, async (tx) => {
    const dup = await tx.select({ id: employees.id }).from(employees).where(and(eq(employees.tenantId, ctx.tenantId), eq(employees.employeeNo, data.employeeNo))).limit(1);
    if (dup[0]) throw new DomainError("EMPLOYEE_DUPLICATE", `Nomor karyawan ${data.employeeNo} sudah dipakai.`);
    if (data.primaryOutletId) await loadOutlet(tx, ctx, data.primaryOutletId);
    const [row] = await tx
      .insert(employees)
      .values({
        tenantId: ctx.tenantId,
        employeeNo: data.employeeNo,
        fullName: data.fullName,
        nickname: data.nickname ?? null,
        position: data.position,
        phone: normalizePhone(data.phone),
        workLocation: data.workLocation ?? null,
        primaryOutletId: data.primaryOutletId ?? null,
        intendedRoles: (data.intendedRoles ?? []) as EmployeeRow["intendedRoles"],
        hireDate: data.hireDate ?? null,
        exitDate: data.exitDate ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    await auditRecord(tx, { ctx, objectType: "employee", objectId: row!.id, action: "create", after: row });
    if (row!.exitDate) await handleExitDateSet(tx, ctx, row!, row!.exitDate);
    return row!;
  });
}

async function handleExitDateSet(tx: Tx, ctx: ActorContext, emp: EmployeeRow, exitDate: string): Promise<void> {
  const today = ctxBusinessDate(ctx);
  if (exitDate <= today) {
    await deactivateOnExit(tx, ctx, emp, exitDate);
  } else {
    await emitEmployeeExited(tx, ctx, emp, exitDate);
  }
}

async function deactivateOnExit(tx: Tx, ctx: ActorContext, emp: EmployeeRow, exitDate: string): Promise<void> {
  if (emp.isActive) {
    await tx
      .update(employees)
      .set({ isActive: false, deactivatedAt: ctx.now, deactivationReason: `Tanggal keluar ${exitDate} tercapai (BR-37).` })
      .where(eq(employees.id, emp.id));
    await auditRecord(tx, { ctx, objectType: "employee", objectId: emp.id, action: "deactivate", before: { isActive: true }, after: { isActive: false, exitDate }, reason: "Tanggal keluar tercapai.", rule: "BR-37" });
  }
  await releaseDefaultCrew(tx, ctx, emp.id, `Karyawan keluar ${exitDate}.`);
  await emitEmployeeExited(tx, ctx, emp, exitDate);
}

/** Ubah karyawan termasuk tanggal masuk/keluar (tanggal keluar mencabut akses hari itu, BR-37). */
export async function updateEmployee(ctx: ActorContext, employeeId: string, input: Partial<EmployeeInput>, opts: { tx?: Tx } = {}): Promise<EmployeeRow> {
  await authorize(ctx, "m1.employee.update", { tx: opts.tx, objectType: "employee", objectId: employeeId });
  return runService(ctx, opts, async (tx) => {
    const before = await loadEmployee(tx, ctx, employeeId);
    if (before.anonymizedAt) throw new DomainError("EMPLOYEE_ANONYMIZED", "Data karyawan sudah dianonimkan.");
    const data = parseInput(
      employeeSchema,
      {
        employeeNo: before.employeeNo,
        fullName: before.fullName,
        nickname: before.nickname,
        position: before.position,
        phone: before.phone,
        workLocation: before.workLocation,
        primaryOutletId: before.primaryOutletId,
        intendedRoles: before.intendedRoles ?? [],
        hireDate: before.hireDate,
        exitDate: before.exitDate,
        ...input,
      },
      EMP_LABELS,
    );
    if (data.employeeNo !== before.employeeNo) throw ValidationError.field("employeeNo", "Nomor karyawan tidak dapat diubah.");
    if (data.exitDate && data.hireDate && data.exitDate < data.hireDate) throw ValidationError.field("exitDate", "Tanggal keluar tidak boleh sebelum tanggal masuk.");
    const today = ctxBusinessDate(ctx);
    if (before.exitDate && before.exitDate <= today && data.exitDate !== before.exitDate) {
      throw new DomainError("EXIT_REACHED", "Tanggal keluar sudah tercapai dan akses sudah dicabut; tidak dapat diubah. Buat data karyawan baru bila dipekerjakan kembali.");
    }
    if (data.primaryOutletId) await loadOutlet(tx, ctx, data.primaryOutletId);
    const patch = {
      fullName: data.fullName,
      nickname: data.nickname ?? null,
      position: data.position,
      phone: normalizePhone(data.phone),
      workLocation: data.workLocation ?? null,
      primaryOutletId: data.primaryOutletId ?? null,
      intendedRoles: (data.intendedRoles ?? []) as EmployeeRow["intendedRoles"],
      hireDate: data.hireDate ?? null,
      exitDate: data.exitDate ?? null,
    };
    const [after] = await tx.update(employees).set(patch).where(eq(employees.id, employeeId)).returning();
    const keys = Object.keys(patch).filter((k) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((after as Record<string, unknown>)[k]));
    if (keys.length) {
      await auditRecord(tx, {
        ctx,
        objectType: "employee",
        objectId: employeeId,
        action: "update",
        before: Object.fromEntries(keys.map((k) => [k, (before as Record<string, unknown>)[k]])),
        after: Object.fromEntries(keys.map((k) => [k, (after as Record<string, unknown>)[k]])),
        rule: keys.includes("exitDate") ? "BR-37" : null,
      });
    }
    if (after!.exitDate && after!.exitDate !== before.exitDate) await handleExitDateSet(tx, ctx, after!, after!.exitDate);
    return after!;
  });
}

/** Nonaktifkan / aktifkan kembali karyawan beralasan (bukan dihapus). */
export async function setEmployeeActive(ctx: ActorContext, employeeId: string, input: { active: boolean; reason: string }, opts: { tx?: Tx } = {}): Promise<EmployeeRow> {
  await authorize(ctx, "m1.employee.deactivate", { tx: opts.tx, objectType: "employee", objectId: employeeId });
  const data = parseInput(z.object({ active: z.boolean(), reason: reasonSchema }), input);
  return runService(ctx, opts, async (tx) => {
    const before = await loadEmployee(tx, ctx, employeeId);
    if (before.isActive === data.active) throw new DomainError("NO_CHANGE", `Karyawan sudah ${data.active ? "aktif" : "nonaktif"}.`);
    if (data.active && before.exitDate && before.exitDate <= ctxBusinessDate(ctx)) {
      throw new DomainError("EXIT_REACHED", "Karyawan sudah keluar (tanggal keluar tercapai); tidak dapat diaktifkan kembali.");
    }
    const [after] = await tx
      .update(employees)
      .set({ isActive: data.active, deactivatedAt: data.active ? null : ctx.now, deactivationReason: data.active ? null : data.reason })
      .where(eq(employees.id, employeeId))
      .returning();
    if (!data.active) await releaseDefaultCrew(tx, ctx, employeeId, `Karyawan dinonaktifkan: ${data.reason}`);
    await auditRecord(tx, { ctx, objectType: "employee", objectId: employeeId, action: data.active ? "activate" : "deactivate", before: { isActive: before.isActive }, after: { isActive: data.active }, reason: data.reason });
    return after!;
  });
}

/** Daftar karyawan (+ nama outlet utama). */
export async function listEmployees(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m1.employee.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx
    .select({ e: employees, outletName: outlets.name })
    .from(employees)
    .leftJoin(outlets, eq(outlets.id, employees.primaryOutletId))
    .where(eq(employees.tenantId, ctx.tenantId))
    .orderBy(asc(employees.employeeNo));
  return rows.map((r) => ({ ...r.e, outletName: r.outletName, rolesText: (r.e.intendedRoles ?? []).map((x) => label("role", x)).join(", ") }));
}

/**
 * Job harian: karyawan AKTIF yang tanggal keluarnya tercapai → nonaktif, dilepas dari kru default, dan
 * `employee.exited` dipancarkan (M10 mencabut akses, BR-37). Idempoten: karyawan yang sudah nonaktif dilewati
 * (pengaktifan ulang setelah tanggal keluar ditolak `EXIT_REACHED`).
 */
export async function processEmployeeExits(tx: Tx, now: Date, date: BusinessDate = toBusinessDate(now)): Promise<{ processed: number }> {
  const due = await tx
    .select()
    .from(employees)
    .where(and(isNotNull(employees.exitDate), lte(employees.exitDate, date), eq(employees.isActive, true)));
  for (const emp of due) {
    const ctx = systemContext({ tenantId: emp.tenantId, now });
    await deactivateOnExit(tx, ctx, emp, emp.exitDate!);
  }
  return { processed: due.length };
}

/** Pilihan outlet & peran untuk formulir karyawan. */
export async function employeeFormOptions(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["m1.employee.read", "m1.employee.create"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const os = await tx.select({ id: outlets.id, code: outlets.code, name: outlets.name }).from(outlets).where(and(eq(outlets.tenantId, ctx.tenantId), eq(outlets.isActive, true))).orderBy(asc(outlets.code));
  return {
    outlets: os.map((o) => ({ value: o.id, label: `${o.code} — ${o.name}` })),
    roles: ROLE_CODES.filter((r) => r !== "partner_owner" && r !== "regional_coach").map((r) => ({ value: r, label: label("role", r) })),
  };
}
