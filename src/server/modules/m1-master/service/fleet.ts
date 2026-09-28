/**
 * M1 — armada, kru default, perangkat (US-M1-03; FR-M1-03, FR-M12-06, K24).
 *
 * - Truk: nopol, kode, kapasitas (bawaan 5.000 L), status Aktif/Perbaikan/Nonaktif, sopir & kernet default, perangkat
 *   GPS terpasang & ponsel lapangan (perangkat terdaftar oleh admin sistem di M10; M1 hanya memilih), kapasitas rit
 *   harian (override PAR-33), pool.
 * - Perbaikan/Nonaktif tidak dapat menerima rit; rit Ditugaskan yang belum Berangkat ditandai "perlu dipindahkan"
 *   (`trips.needs_reassignment`) + notifikasi Dispatcher + jejak audit (KP-2). Tidak ada event domain khusus (katalog
 *   ARCHITECTURE §8); M2 membaca penanda `needs_reassignment`.
 * - Satu karyawan hanya satu truk default (sopir ATAU kernet) — KP-3.
 */
import "server-only";

import { and, asc, eq, gte, inArray, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";

import { devices, employees, poolLocations, trips, trucks, userRoles, users } from "@/db/schema";
import { label } from "@/lib/labels";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { getDb } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { assertTenantScope, authorize, authorizeAny, runService } from "@/server/core/rbac";

export type TruckRow = typeof trucks.$inferSelect;

const truckSchema = z.object({
  code: z.string().trim().min(1, { error: "Kode truk wajib diisi (mis. T8)." }).max(10),
  plateNumber: z
    .string()
    .trim()
    .min(3, { error: "Nomor polisi wajib diisi." })
    .max(15)
    .transform((v) => v.toUpperCase().replace(/\s+/g, " ")),
  capacityL: z.number().int({ error: "Kapasitas harus liter bulat." }).min(500, { error: "Kapasitas minimal 500 L." }).max(30_000).optional(),
  defaultDriverEmployeeId: z.uuid().nullable().optional(),
  defaultHelperEmployeeId: z.uuid().nullable().optional(),
  gpsDeviceId: z.uuid().nullable().optional(),
  fieldDeviceId: z.uuid().nullable().optional(),
  /** Override PAR-33 per truk; kosong = PAR-33. */
  dailyTripCapacity: z.number().int().min(1, { error: "Kapasitas rit minimal 1." }).max(20).nullable().optional(),
  poolLocationId: z.uuid().nullable().optional(),
});
export type TruckInput = z.input<typeof truckSchema>;

const LABELS = { code: "Kode truk", plateNumber: "Nomor polisi", capacityL: "Kapasitas", dailyTripCapacity: "Kapasitas rit harian" };

async function loadTruck(tx: Tx, ctx: ActorContext | null, id: string, forUpdate = false): Promise<TruckRow> {
  const q = tx.select().from(trucks).where(eq(trucks.id, id)).limit(1);
  const rows = forUpdate ? await q.for("update") : await q;
  if (!rows[0]) throw new NotFoundError("Truk tidak ditemukan.");
  if (ctx) assertTenantScope(ctx, rows[0].tenantId);
  return rows[0];
}

/** Validasi kru default: karyawan aktif ber-peran Sopir/Kernet; satu karyawan hanya satu truk default (KP-3). */
async function assertCrew(tx: Tx, tenantId: string, truckId: string | null, employeeId: string, role: "driver" | "helper"): Promise<void> {
  const rows = await tx.select().from(employees).where(eq(employees.id, employeeId)).limit(1);
  const emp = rows[0];
  if (!emp || emp.tenantId !== tenantId) throw ValidationError.field(role === "driver" ? "defaultDriverEmployeeId" : "defaultHelperEmployeeId", "Karyawan tidak dikenal.");
  if (!emp.isActive || emp.exitDate) throw new DomainError("EMPLOYEE_INACTIVE", `${emp.fullName} tidak aktif / sudah punya tanggal keluar; tidak dapat menjadi kru default.`);
  const intended = emp.intendedRoles ?? [];
  const granted = await tx
    .select({ role: userRoles.role })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(users.employeeId, employeeId), eq(userRoles.status, "active")));
  const roles = new Set([...intended, ...granted.map((g) => g.role)]);
  if (!roles.has(role)) {
    throw new DomainError("CREW_ROLE", `${emp.fullName} bukan karyawan dengan peran ${label("role", role)} (US-M1-03 KP-3).`);
  }
  const clash = await tx
    .select({ id: trucks.id, code: trucks.code })
    .from(trucks)
    .where(
      and(
        or(eq(trucks.defaultDriverEmployeeId, employeeId), eq(trucks.defaultHelperEmployeeId, employeeId)),
        truckId ? ne(trucks.id, truckId) : undefined,
      ),
    )
    .limit(1);
  if (clash[0]) {
    throw new DomainError("CREW_ALREADY_DEFAULT", `${emp.fullName} sudah menjadi kru default truk ${clash[0].code}. Satu karyawan hanya satu truk default; pengecualian harian diatur di jadwal kru.`);
  }
}

/** Validasi perangkat: terdaftar (M10), jenis sesuai, tidak diblokir/dihapus, tidak terpasang di truk lain. */
async function assertDevice(tx: Tx, tenantId: string, truckId: string | null, deviceId: string, purpose: "gps" | "field"): Promise<void> {
  const rows = await tx.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  const d = rows[0];
  const field = purpose === "gps" ? "gpsDeviceId" : "fieldDeviceId";
  if (!d || d.tenantId !== tenantId) throw ValidationError.field(field, "Perangkat tidak terdaftar. Minta admin sistem mendaftarkannya di Akses > Perangkat.");
  if (purpose === "gps" && d.kind !== "gps") throw ValidationError.field(field, "Pilih perangkat berjenis GPS.");
  if (purpose === "field" && d.kind === "gps") throw ValidationError.field(field, "Pilih ponsel/tablet lapangan, bukan perangkat GPS.");
  if (d.status === "blocked" || d.status === "wipe_pending" || d.status === "wiped") {
    throw new DomainError("DEVICE_BLOCKED", `Perangkat ${d.deviceCode} berstatus ${label("device_status", d.status)} dan tidak dapat dipasang.`);
  }
  const column = purpose === "gps" ? trucks.gpsDeviceId : trucks.fieldDeviceId;
  const clash = await tx
    .select({ code: trucks.code })
    .from(trucks)
    .where(and(eq(column, deviceId), truckId ? ne(trucks.id, truckId) : undefined))
    .limit(1);
  if (clash[0]) throw new DomainError("DEVICE_IN_USE", `Perangkat ${d.deviceCode} sudah terpasang di truk ${clash[0].code}.`);
}

async function validateTruck(tx: Tx, tenantId: string, truckId: string | null, data: z.output<typeof truckSchema>) {
  if (data.defaultDriverEmployeeId && data.defaultDriverEmployeeId === data.defaultHelperEmployeeId) {
    throw new DomainError("CREW_SAME_PERSON", "Sopir dan kernet default harus orang yang berbeda.");
  }
  if (data.defaultDriverEmployeeId) await assertCrew(tx, tenantId, truckId, data.defaultDriverEmployeeId, "driver");
  if (data.defaultHelperEmployeeId) await assertCrew(tx, tenantId, truckId, data.defaultHelperEmployeeId, "helper");
  if (data.gpsDeviceId) await assertDevice(tx, tenantId, truckId, data.gpsDeviceId, "gps");
  if (data.fieldDeviceId) await assertDevice(tx, tenantId, truckId, data.fieldDeviceId, "field");
  if (data.poolLocationId) {
    const p = await tx.select({ tenantId: poolLocations.tenantId }).from(poolLocations).where(eq(poolLocations.id, data.poolLocationId)).limit(1);
    if (!p[0] || p[0].tenantId !== tenantId) throw ValidationError.field("poolLocationId", "Pool/garasi tidak dikenal.");
  }
  const dup = await tx
    .select({ id: trucks.id, code: trucks.code, plate: trucks.plateNumber })
    .from(trucks)
    .where(and(or(eq(trucks.plateNumber, data.plateNumber), and(eq(trucks.tenantId, tenantId), eq(trucks.code, data.code))), truckId ? ne(trucks.id, truckId) : undefined))
    .limit(1);
  if (dup[0]) throw new DomainError("TRUCK_DUPLICATE", `Nomor polisi atau kode sudah dipakai truk ${dup[0].code} (${dup[0].plate}).`);
}

/** Daftarkan truk (US-M1-03 KP-1). */
export async function createTruck(ctx: ActorContext, input: TruckInput, opts: { tx?: Tx } = {}): Promise<TruckRow> {
  await authorize(ctx, "m1.truck.create", { tx: opts.tx });
  const data = parseInput(truckSchema, input, LABELS);
  return runService(ctx, opts, async (tx) => {
    await validateTruck(tx, ctx.tenantId, null, data);
    const [row] = await tx
      .insert(trucks)
      .values({
        tenantId: ctx.tenantId,
        code: data.code.toUpperCase(),
        plateNumber: data.plateNumber,
        capacityL: data.capacityL ?? 5000,
        defaultDriverEmployeeId: data.defaultDriverEmployeeId ?? null,
        defaultHelperEmployeeId: data.defaultHelperEmployeeId ?? null,
        gpsDeviceId: data.gpsDeviceId ?? null,
        fieldDeviceId: data.fieldDeviceId ?? null,
        dailyTripCapacity: data.dailyTripCapacity ?? null,
        poolLocationId: data.poolLocationId ?? null,
        fleetDetectionEnabled: Boolean(data.gpsDeviceId),
        createdBy: ctx.userId,
      })
      .returning();
    await auditRecord(tx, { ctx, objectType: "truck", objectId: row!.id, action: "create", after: row });
    return row!;
  });
}

/** Ubah truk: kapasitas, kru default, perangkat, kapasitas rit, pool (status lewat `setTruckStatus`). */
export async function updateTruck(ctx: ActorContext, truckId: string, input: Partial<TruckInput>, opts: { tx?: Tx } = {}): Promise<TruckRow> {
  await authorize(ctx, "m1.truck.update", { tx: opts.tx, objectType: "truck", objectId: truckId });
  return runService(ctx, opts, async (tx) => {
    const before = await loadTruck(tx, ctx, truckId, true);
    const merged = parseInput(
      truckSchema,
      {
        code: before.code,
        plateNumber: before.plateNumber,
        capacityL: before.capacityL,
        defaultDriverEmployeeId: before.defaultDriverEmployeeId,
        defaultHelperEmployeeId: before.defaultHelperEmployeeId,
        gpsDeviceId: before.gpsDeviceId,
        fieldDeviceId: before.fieldDeviceId,
        dailyTripCapacity: before.dailyTripCapacity,
        poolLocationId: before.poolLocationId,
        ...input,
      },
      LABELS,
    );
    await validateTruck(tx, before.tenantId, truckId, merged);
    const patch = {
      code: merged.code.toUpperCase(),
      plateNumber: merged.plateNumber,
      capacityL: merged.capacityL ?? before.capacityL,
      defaultDriverEmployeeId: merged.defaultDriverEmployeeId ?? null,
      defaultHelperEmployeeId: merged.defaultHelperEmployeeId ?? null,
      gpsDeviceId: merged.gpsDeviceId ?? null,
      fieldDeviceId: merged.fieldDeviceId ?? null,
      dailyTripCapacity: merged.dailyTripCapacity ?? null,
      poolLocationId: merged.poolLocationId ?? null,
    };
    const [after] = await tx.update(trucks).set(patch).where(eq(trucks.id, truckId)).returning();
    const changed = Object.keys(patch).filter((k) => (before as Record<string, unknown>)[k] !== (after as Record<string, unknown>)[k]);
    if (changed.length) {
      await auditRecord(tx, {
        ctx,
        objectType: "truck",
        objectId: truckId,
        action: "update",
        before: Object.fromEntries(changed.map((k) => [k, (before as Record<string, unknown>)[k]])),
        after: Object.fromEntries(changed.map((k) => [k, (after as Record<string, unknown>)[k]])),
      });
    }
    return after!;
  });
}

const statusSchema = z.object({
  status: z.enum(["active", "maintenance", "inactive"], { error: "Status truk tidak dikenal." }),
  reason: z.string().trim().min(3, { error: "Alasan perubahan status wajib diisi (minimal 3 karakter)." }),
});

/**
 * Ubah status truk (US-M1-03 KP-2): Perbaikan/Nonaktif → rit Ditugaskan (belum Berangkat, hari ini & sesudahnya) pada
 * truk itu ditandai perlu dipindahkan, Dispatcher diberi tahu.
 */
export async function setTruckStatus(ctx: ActorContext, truckId: string, input: z.input<typeof statusSchema>, opts: { tx?: Tx } = {}) {
  const data = parseInput(statusSchema, input, { reason: "Alasan" });
  if (data.status === "inactive") await authorizeAny(ctx, ["m1.truck.deactivate"], { tx: opts.tx, objectType: "truck", objectId: truckId });
  else await authorize(ctx, "m1.truck.update", { tx: opts.tx, objectType: "truck", objectId: truckId });
  return runService(ctx, opts, async (tx) => {
    const before = await loadTruck(tx, ctx, truckId, true);
    if (before.status === data.status) throw new DomainError("NO_CHANGE", `Truk ${before.code} sudah berstatus ${label("truck_status", data.status)}.`);
    const deactivate = data.status === "inactive";
    const [after] = await tx
      .update(trucks)
      .set({
        status: data.status,
        statusChangedAt: ctx.now,
        statusReason: data.reason,
        isActive: !deactivate,
        deactivatedAt: deactivate ? ctx.now : null,
        deactivatedBy: deactivate ? ctx.userId : null,
        deactivationReason: deactivate ? data.reason : null,
      })
      .where(eq(trucks.id, truckId))
      .returning();
    let flagged: { id: string; number: string }[] = [];
    if (data.status !== "active") {
      flagged = await tx
        .update(trips)
        .set({ needsReassignment: true })
        .where(
          and(
            eq(trips.truckId, truckId),
            eq(trips.status, "assigned"),
            isNull(trips.withdrawnAt),
            gte(trips.scheduledDate, ctxBusinessDate(ctx)),
          ),
        )
        .returning({ id: trips.id, number: trips.number });
      if (flagged.length) {
        await notify(tx, {
          event: "truck.trips_need_reassignment",
          tenantId: before.tenantId,
          title: `${flagged.length} rit truk ${before.code} perlu dipindahkan`,
          body: `Truk ${before.code} (${before.plateNumber}) berstatus ${label("truck_status", data.status)}: ${data.reason}. Rit: ${flagged.map((f) => f.number).join(", ")}.`,
          objectType: "truck",
          objectId: truckId,
          link: "/jadwal",
          now: ctx.now,
        });
      }
    }
    await auditRecord(tx, {
      ctx,
      objectType: "truck",
      objectId: truckId,
      action: deactivate ? "deactivate" : "update",
      before: { status: before.status },
      after: { status: data.status, flaggedTrips: flagged.map((f) => f.number) },
      reason: data.reason,
      rule: "US-M1-03 KP-2",
    });
    return { truck: after!, flaggedTrips: flagged };
  });
}

/**
 * Pastikan truk dapat menerima rit (US-M1-03 KP-2, US-M2-03 KP-4): Aktif. Dipakai M2 saat menugaskan rit.
 */
export async function assertTruckCanReceiveTrips(tx: Tx, truckId: string): Promise<TruckRow> {
  const truck = await loadTruck(tx, null, truckId);
  if (truck.status !== "active" || !truck.isActive) {
    throw new DomainError("TRUCK_NOT_ACTIVE", `Truk ${truck.code} berstatus ${label("truck_status", truck.status)} dan tidak dapat menerima rit.`);
  }
  return truck;
}

/** Kapasitas rit harian truk (override per truk, bila kosong PAR-33). */
export async function truckDailyTripCapacity(tx: Tx, truckId: string, date: string): Promise<number> {
  const truck = await loadTruck(tx, null, truckId);
  if (truck.dailyTripCapacity) return truck.dailyTripCapacity;
  const par33 = await params.get(tx, "PAR-33", date);
  return par33.trips;
}

export type TruckListRow = TruckRow & {
  driverName: string | null;
  helperName: string | null;
  gpsDeviceCode: string | null;
  fieldDeviceCode: string | null;
  poolName: string | null;
  effectiveTripCapacity: number;
};

/** Daftar truk dengan kru default & perangkat. */
export async function listTrucks(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<TruckListRow[]> {
  await authorize(ctx, "m1.truck.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx.select().from(trucks).where(eq(trucks.tenantId, ctx.tenantId)).orderBy(asc(trucks.code));
  const empIds = rows.flatMap((r) => [r.defaultDriverEmployeeId, r.defaultHelperEmployeeId]).filter((x): x is string => !!x);
  const devIds = rows.flatMap((r) => [r.gpsDeviceId, r.fieldDeviceId]).filter((x): x is string => !!x);
  const emps = empIds.length ? await tx.select({ id: employees.id, name: employees.fullName }).from(employees).where(inArray(employees.id, empIds)) : [];
  const devs = devIds.length ? await tx.select({ id: devices.id, code: devices.deviceCode }).from(devices).where(inArray(devices.id, devIds)) : [];
  const pools = await tx.select({ id: poolLocations.id, name: poolLocations.name }).from(poolLocations).where(eq(poolLocations.tenantId, ctx.tenantId));
  const par33 = await params.get(tx, "PAR-33", ctxBusinessDate(ctx));
  const name = (id: string | null) => (id ? (emps.find((e) => e.id === id)?.name ?? null) : null);
  const dev = (id: string | null) => (id ? (devs.find((d) => d.id === id)?.code ?? null) : null);
  return rows.map((r) => ({
    ...r,
    driverName: name(r.defaultDriverEmployeeId),
    helperName: name(r.defaultHelperEmployeeId),
    gpsDeviceCode: dev(r.gpsDeviceId),
    fieldDeviceCode: dev(r.fieldDeviceId),
    poolName: r.poolLocationId ? (pools.find((p) => p.id === r.poolLocationId)?.name ?? null) : null,
    effectiveTripCapacity: r.dailyTripCapacity ?? par33.trips,
  }));
}

/** Pilihan formulir truk: karyawan Sopir/Kernet aktif, perangkat terdaftar, pool. */
export async function truckFormOptions(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["m1.truck.create", "m1.truck.update", "m1.truck.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const emps = await tx
    .select({ id: employees.id, name: employees.fullName, no: employees.employeeNo, roles: employees.intendedRoles })
    .from(employees)
    .where(and(eq(employees.tenantId, ctx.tenantId), eq(employees.isActive, true), isNull(employees.exitDate)))
    .orderBy(asc(employees.fullName));
  const devs = await tx
    .select({ id: devices.id, code: devices.deviceCode, name: devices.name, kind: devices.kind, status: devices.status })
    .from(devices)
    .where(and(eq(devices.tenantId, ctx.tenantId), inArray(devices.status, ["registered", "active"])))
    .orderBy(asc(devices.deviceCode));
  const pools = await tx.select({ id: poolLocations.id, name: poolLocations.name }).from(poolLocations).where(and(eq(poolLocations.tenantId, ctx.tenantId), eq(poolLocations.isActive, true)));
  return {
    drivers: emps.filter((e) => (e.roles ?? []).includes("driver")).map((e) => ({ value: e.id, label: `${e.name} (${e.no})` })),
    helpers: emps.filter((e) => (e.roles ?? []).includes("helper")).map((e) => ({ value: e.id, label: `${e.name} (${e.no})` })),
    gpsDevices: devs.filter((d) => d.kind === "gps").map((d) => ({ value: d.id, label: `${d.code} — ${d.name}` })),
    fieldDevices: devs.filter((d) => d.kind !== "gps").map((d) => ({ value: d.id, label: `${d.code} — ${d.name}` })),
    pools: pools.map((p) => ({ value: p.id, label: p.name })),
  };
}
