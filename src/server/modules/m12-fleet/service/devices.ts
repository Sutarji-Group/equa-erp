/**
 * M12 — kesehatan perangkat GPS truk (US-M12-08; US-M12-01 KP-4; NFR-28; 7.12.6).
 *
 * - Mati/Dicabut: tanpa posisi > PAR-25 menit pada jam layanan (job tiap 5 menit) ATAU sinyal daya terputus dari
 *   perangkat (saat posisi diterima) → `devices.gps_state` Mati/Dicabut, kejadian per truk (`device_offline` /
 *   `device_unplugged`), peringatan tim IT & Dispatcher (`gps.device_dead`, kritis), insiden (M10 `raiseIncident`),
 *   dan jejak GPS ponsel cadangan diaktifkan untuk truk itu (`phone_tracking_flags`, dibaca pull `m3.today`).
 * - Aktif kembali (posisi valid berikutnya, daya tersambung) → kejadian ditutup dengan lama mati, pelacakan ponsel
 *   dimatikan, `gps.device_restored`; pola berulang per truk (≥ N kejadian dalam M hari) → pemilik.
 * - Gangguan vendor sistemik (SEMUA perangkat basi sekaligus) → hanya tim IT (`gps.vendor_outage`), tanpa peringatan
 *   per truk. Truk Perbaikan/Nonaktif tidak dipantau (tidak beroperasi).
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";

import { devices, fleetEvents, phoneTrackingFlags, trucks } from "@/db/schema";
import { label } from "@/lib/labels";
import { addDays, businessDateToUtcRange, formatJam, formatTanggalJam, toBusinessDate, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Db, type Tx } from "@/server/core/db";
import { NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import { authorize, runService } from "@/server/core/rbac";
import { raiseIncident } from "@/server/modules/m10-access";

import { phoneTrackingSchema } from "../schemas";
import { fleetTrucks, inServiceHours, m12Rules, tenantsWithTrucks, type DeviceRow, type FleetTruck } from "./common";
import { createFleetEvent, eventLink, notifyOnce, type FleetEventRow } from "./fleet-events";

const OUTAGE_KINDS = ["device_offline", "device_unplugged"] as const;

function minutesBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));
}

function isoWeekKey(date: BusinessDate): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Aktifkan pelacakan GPS ponsel cadangan untuk truk (US-M12-01 KP-4). Idempoten (satu penanda hidup per truk). */
export async function startPhoneTracking(
  tx: Tx,
  input: { truckId: string; reason: "device_dead" | "admin_forced"; setBy: string | null; fleetEventId?: string | null; now: Date },
): Promise<{ created: boolean; flagId: string | null }> {
  const live = await tx.select({ id: phoneTrackingFlags.id }).from(phoneTrackingFlags).where(and(eq(phoneTrackingFlags.truckId, input.truckId), isNull(phoneTrackingFlags.endedAt))).limit(1);
  if (live[0]) return { created: false, flagId: live[0].id };
  const rows = await tx
    .insert(phoneTrackingFlags)
    .values({ truckId: input.truckId, reason: input.reason, setBy: input.setBy, startedAt: input.now, fleetEventId: input.fleetEventId ?? null, createdAt: input.now, updatedAt: input.now })
    .onConflictDoNothing()
    .returning({ id: phoneTrackingFlags.id });
  return { created: rows.length > 0, flagId: rows[0]?.id ?? null };
}

/** Matikan pelacakan ponsel (bawaan: hanya penanda otomatis `device_dead`; penanda paksa admin tetap). */
export async function stopPhoneTracking(tx: Tx, input: { truckId: string; reasons?: readonly ("device_dead" | "admin_forced")[]; now: Date }): Promise<number> {
  const rows = await tx
    .update(phoneTrackingFlags)
    .set({ endedAt: input.now, updatedAt: input.now })
    .where(and(eq(phoneTrackingFlags.truckId, input.truckId), isNull(phoneTrackingFlags.endedAt), inArray(phoneTrackingFlags.reason, [...(input.reasons ?? ["device_dead"])])))
    .returning({ id: phoneTrackingFlags.id });
  return rows.length;
}

/** Pelacakan ponsel aktif untuk truk-truk (peta, halaman perangkat). */
export async function livePhoneTracking(tx: Tx, truckIds: readonly string[]): Promise<Map<string, typeof phoneTrackingFlags.$inferSelect>> {
  if (truckIds.length === 0) return new Map();
  const rows = await tx.select().from(phoneTrackingFlags).where(and(inArray(phoneTrackingFlags.truckId, [...truckIds]), isNull(phoneTrackingFlags.endedAt)));
  return new Map(rows.map((r) => [r.truckId, r]));
}

type TruckRef = { id: string; code: string; tenantId: string };

/**
 * Tandai perangkat Mati (`device_offline`) atau Dicabut (`device_unplugged`) — US-M12-08 KP-1/KP-2. Idempoten per
 * perangkat + waktu mulai.
 */
export async function markDeviceOutage(
  tx: Tx,
  input: { device: DeviceRow; truck: TruckRef; kind: (typeof OUTAGE_KINDS)[number]; since: Date; now: Date; rules?: { deadMinutes: number } },
): Promise<{ event: FleetEventRow; created: boolean }> {
  const { device, truck, kind, since, now } = input;
  const state = kind === "device_unplugged" ? "unplugged" : "dead";
  if (device.gpsState !== state) {
    await tx.update(devices).set({ gpsState: state, gpsStateSince: since, updatedAt: now }).where(eq(devices.id, device.id));
  }
  const res = await createFleetEvent(tx, {
    tenantId: truck.tenantId,
    kind,
    dedupeKey: `dev:${device.id}:${since.toISOString()}`,
    truckId: truck.id,
    deviceId: device.id,
    businessDate: toBusinessDate(since),
    startedAt: since,
    details: {
      deviceCode: device.deviceCode,
      vendor: device.vendor,
      lastPositionAt: device.gpsLastPositionAt?.toISOString() ?? null,
      powerConnected: device.gpsPowerConnected,
      thresholdMinutes: input.rules?.deadMinutes ?? null,
    },
    rule: kind === "device_unplugged" ? "US-M12-08 KP-1 (daya terputus)" : "US-M12-08 KP-1, PAR-25",
    now,
  });
  if (!res.created) return res;
  const ctx = systemContext({ tenantId: truck.tenantId, now });
  const what = kind === "device_unplugged" ? "dicabut (daya terputus)" : `tanpa posisi sejak ${formatJam(since)}`;
  await auditRecord(tx, {
    ctx,
    objectType: "device",
    objectId: device.id,
    action: "update",
    before: { gpsState: device.gpsState },
    after: { gpsState: state, gpsStateSince: since },
    rule: "US-M12-08 KP-1",
  });
  const phone = await startPhoneTracking(tx, { truckId: truck.id, reason: "device_dead", setBy: null, fleetEventId: res.event.id, now });
  await notify(tx, {
    event: "gps.device_dead",
    tenantId: truck.tenantId,
    title: `GPS truk ${truck.code} ${kind === "device_unplugged" ? "dicabut" : "mati"}`,
    body: `Perangkat ${device.deviceCode} ${what}. GPS ponsel sopir ${phone.created || phone.flagId ? "diaktifkan sebagai cadangan" : "tetap aktif"}; rit tetap berjalan. Periksa perangkat hari ini.`,
    objectType: "fleet_event",
    objectId: res.event.id,
    link: eventLink(res.event.id),
    groupKey: `gps.device_dead:${device.id}:${since.toISOString()}`,
    now,
  });
  await raiseIncident(tx, {
    tenantId: truck.tenantId,
    kind: "gps_device_dead",
    severity: "major",
    title: `Perangkat GPS ${device.deviceCode} (truk ${truck.code}) ${kind === "device_unplugged" ? "dicabut" : "mati"}`,
    description: `${label("fleet_event_kind", kind)} sejak ${formatTanggalJam(since)}. Jejak GPS ponsel cadangan aktif untuk truk ${truck.code}.`,
    objectType: "device",
    objectId: device.id,
    detectedAt: since,
    now,
  });
  return res;
}

/** Perangkat aktif kembali → tutup kejadian dengan lama mati, matikan pelacakan ponsel otomatis (US-M12-08 KP-3). */
export async function restoreDevice(tx: Tx, input: { device: DeviceRow; truck: TruckRef; at: Date; now: Date }): Promise<{ closed: FleetEventRow[] }> {
  const { device, truck, at, now } = input;
  await tx.update(devices).set({ gpsState: "active", gpsStateSince: at, updatedAt: now }).where(eq(devices.id, device.id));
  const open = await tx
    .select()
    .from(fleetEvents)
    .where(and(eq(fleetEvents.deviceId, device.id), inArray(fleetEvents.kind, [...OUTAGE_KINDS]), isNull(fleetEvents.endedAt)));
  const closed: FleetEventRow[] = [];
  for (const ev of open) {
    const end = at.getTime() < ev.startedAt.getTime() ? ev.startedAt : at;
    const durationS = Math.round((end.getTime() - ev.startedAt.getTime()) / 1000);
    const [row] = await tx
      .update(fleetEvents)
      .set({ endedAt: end, durationS, status: "done", doneAt: now, details: { ...(ev.details ?? {}), restoredAt: at.toISOString() }, updatedAt: now })
      .where(eq(fleetEvents.id, ev.id))
      .returning();
    closed.push(row!);
  }
  await stopPhoneTracking(tx, { truckId: truck.id, now });
  const ctx = systemContext({ tenantId: truck.tenantId, now });
  await auditRecord(tx, {
    ctx,
    objectType: "device",
    objectId: device.id,
    action: "update",
    before: { gpsState: device.gpsState },
    after: { gpsState: "active", closedEvents: closed.map((c) => ({ id: c.id, durationS: c.durationS })) },
    rule: "US-M12-08 KP-3",
  });
  const minutes = closed.reduce((s, c) => s + Math.round((c.durationS ?? 0) / 60), 0);
  await notify(tx, {
    event: "gps.device_restored",
    tenantId: truck.tenantId,
    title: `GPS truk ${truck.code} aktif kembali`,
    body: `Perangkat ${device.deviceCode} mengirim posisi lagi${minutes ? ` setelah ±${minutes} menit mati` : ""}. GPS ponsel cadangan dimatikan.`,
    objectType: closed[0] ? "fleet_event" : "device",
    objectId: closed[0]?.id ?? device.id,
    link: closed[0] ? eventLink(closed[0].id) : "/armada/perangkat",
    now,
  });
  await checkOutagePattern(tx, truck, now);
  return { closed };
}

/** Pola berulang perangkat mati/dicabut per truk (US-M12-08 KP-3) → pemilik, sekali per truk per minggu. */
export async function checkOutagePattern(tx: Tx, truck: TruckRef, now: Date): Promise<{ count: number; reported: boolean }> {
  const today = toBusinessDate(now);
  const rules = await m12Rules(tx, today, truck.tenantId);
  const since = addDays(today, -(rules.fleet.repeat_outage_days - 1));
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int`, minutes: sql<number>`coalesce(sum(${fleetEvents.durationS}), 0)::int` })
    .from(fleetEvents)
    .where(and(eq(fleetEvents.truckId, truck.id), inArray(fleetEvents.kind, [...OUTAGE_KINDS]), gte(fleetEvents.businessDate, since)));
  const count = Number(row?.n ?? 0);
  if (count < rules.fleet.repeat_outage_count) return { count, reported: false };
  await notifyOnce(tx, {
    event: "fleet.device_outage_pattern",
    tenantId: truck.tenantId,
    title: `GPS truk ${truck.code} mati/dicabut ${count}× dalam ${rules.fleet.repeat_outage_days} hari`,
    body: `Total ±${Math.round(Number(row?.minutes ?? 0) / 60)} menit tanpa sinyal. Pola berulang dapat menandakan pencabutan disengaja — tinjau bersama sopir.`,
    objectType: "truck",
    objectId: truck.id,
    valueText: `${count} kejadian`,
    link: `/armada/perangkat?truk=${truck.id}`,
    groupKey: `fleet.device_outage_pattern:${truck.id}:${isoWeekKey(today)}`,
    now,
  });
  return { count, reported: true };
}

export type DeviceHealthRunResult = {
  tenantId: string;
  skipped: "outside_service_hours" | null;
  monitored: number;
  stale: number;
  marked: number;
  vendorOutage: boolean;
};

/** Truk dipantau: aktif, beroperasi (bukan Perbaikan), perangkat GPS dapat dipakai & pernah mengirim posisi. */
function monitoredTrucks(fleet: FleetTruck[]): (FleetTruck & { gpsDevice: DeviceRow })[] {
  return fleet.filter(
    (t): t is FleetTruck & { gpsDevice: DeviceRow } =>
      t.isActive && t.status === "active" && !!t.gpsDevice && !t.gpsDevice.isSpare && !["blocked", "wipe_pending", "wiped"].includes(t.gpsDevice.status) && t.gpsDevice.gpsLastPositionAt !== null,
  );
}

/** Job tiap 5 menit (US-M12-08 KP-1, 7.12.6): perangkat tanpa posisi > PAR-25 menit pada jam layanan. */
export async function runDeviceHealthCheck(now: Date, db?: Db): Promise<DeviceHealthRunResult[]> {
  return withTx(
    async (tx) => {
      const out: DeviceHealthRunResult[] = [];
      for (const tenantId of await tenantsWithTrucks(tx)) {
        const rules = await m12Rules(tx, toBusinessDate(now), tenantId);
        const result: DeviceHealthRunResult = { tenantId, skipped: null, monitored: 0, stale: 0, marked: 0, vendorOutage: false };
        out.push(result);
        if (!inServiceHours(rules, now)) {
          result.skipped = "outside_service_hours";
          continue;
        }
        const fleet = monitoredTrucks(await fleetTrucks(tx, tenantId));
        const alive = fleet.filter((t) => t.gpsDevice.gpsState !== "dead" && t.gpsDevice.gpsState !== "unplugged");
        const cutoff = now.getTime() - rules.deadMinutes * 60_000;
        const stale = alive.filter((t) => t.gpsDevice.gpsLastPositionAt!.getTime() < cutoff);
        result.monitored = fleet.length;
        result.stale = stale.length;
        if (stale.length === 0) continue;
        // 7.12.6: gangguan vendor sistemik — semua perangkat yang semestinya aktif basi sekaligus.
        if (alive.length >= rules.fleet.vendor_outage_min_devices && stale.length === alive.length) {
          result.vendorOutage = true;
          const vendors = [...new Set(stale.map((t) => t.gpsDevice.vendor ?? "vendor GPS"))].join(", ");
          const oldest = new Date(Math.min(...stale.map((t) => t.gpsDevice.gpsLastPositionAt!.getTime())));
          await notifyOnce(tx, {
            event: "gps.vendor_outage",
            tenantId,
            title: `Gangguan layanan GPS: ${stale.length} truk tanpa posisi sejak ${formatJam(oldest)}`,
            body: `Semua perangkat (${vendors}) berhenti mengirim posisi sekaligus. Peringatan "perangkat mati" per truk tidak dikirim; hubungi vendor.`,
            objectType: "gps_vendor",
            objectId: vendors,
            link: "/armada/perangkat",
            groupKey: `gps.vendor_outage:${tenantId}:${toBusinessDate(now)}`,
            now,
          });
          await raiseIncident(tx, {
            tenantId,
            kind: "other",
            severity: "major",
            title: `Gangguan layanan vendor GPS (${stale.length} truk basi)`,
            description: `Semua perangkat GPS tanpa posisi sejak ${formatTanggalJam(oldest)}. Dicatat sebagai gangguan vendor sistemik (7.12.6).`,
            objectType: "gps_vendor",
            objectId: tenantId,
            detectedAt: oldest,
            now,
          });
          // US-M12-01 KP-4 / US-M12-08 KP-2: tanpa peringatan per truk, tetapi GPS ponsel cadangan TETAP diaktifkan
          // untuk setiap truk basi agar tidak ada truk yang hilang dari peta; dimatikan saat posisi perangkat kembali.
          for (const t of stale) await startPhoneTracking(tx, { truckId: t.id, reason: "device_dead", setBy: null, now });
          continue;
        }
        for (const t of stale) {
          const res = await markDeviceOutage(tx, {
            device: t.gpsDevice,
            truck: { id: t.id, code: t.code, tenantId: t.tenantId },
            kind: "device_offline",
            since: t.gpsDevice.gpsLastPositionAt!,
            now,
            rules,
          });
          if (res.created) result.marked++;
        }
      }
      return out;
    },
    { db },
  );
}

// =====================================================================================================================
// Layar & API untuk modul lain
// =====================================================================================================================

export type GpsDeviceHealth = {
  deviceId: string;
  deviceCode: string;
  name: string;
  vendor: string | null;
  imei: string | null;
  firmwareVersion: string | null;
  status: string;
  isSpare: boolean;
  gpsState: string | null;
  gpsStateSince: Date | null;
  lastPositionAt: Date | null;
  lastSeenAt: Date | null;
  powerConnected: boolean | null;
  batteryPct: number | null;
  truckId: string | null;
  truckCode: string | null;
  truckStatus: string | null;
  minutesSinceLastPosition: number | null;
  stale: boolean;
  openOutage: { id: string; kind: string; startedAt: Date; minutes: number } | null;
  phoneTracking: { reason: string; since: Date } | null;
  outages30d: number;
  outageMinutes30d: number;
};

/** Kesehatan perangkat GPS (US-M12-08 KP-4): terakhir terlihat, daya, versi, status, kejadian terbuka, pelacakan ponsel. */
export async function listGpsDevices(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<GpsDeviceHealth[]> {
  await authorize(ctx, "m12.fleet_event.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  return gpsDeviceHealthRows(tx, ctx.tenantId, ctx.now);
}

/** Kesehatan satu perangkat GPS — untuk disematkan di halaman perangkat M10 (US-M12-08 KP-4). */
export async function getGpsDeviceHealth(ctx: ActorContext, deviceId: string, opts: { tx?: Tx } = {}): Promise<GpsDeviceHealth> {
  await authorize(ctx, "m12.fleet_event.read", { tx: opts.tx, objectType: "device", objectId: deviceId });
  const tx = opts.tx ?? getDb();
  const rows = await gpsDeviceHealthRows(tx, ctx.tenantId, ctx.now, deviceId);
  if (!rows[0]) throw new NotFoundError("Perangkat GPS tidak ditemukan.");
  return rows[0];
}

export async function gpsDeviceHealthRows(tx: Tx, tenantId: string, now: Date, deviceId?: string): Promise<GpsDeviceHealth[]> {
  const today = toBusinessDate(now);
  const rules = await m12Rules(tx, today, tenantId);
  const devRows = await tx
    .select()
    .from(devices)
    .where(and(eq(devices.tenantId, tenantId), eq(devices.kind, "gps"), deviceId ? eq(devices.id, deviceId) : sql`true`))
    .orderBy(asc(devices.deviceCode));
  const truckRows = await tx.select({ id: trucks.id, code: trucks.code, status: trucks.status, gpsDeviceId: trucks.gpsDeviceId }).from(trucks).where(eq(trucks.tenantId, tenantId));
  // Pemetaan master armada (US-M12-01 KP-2) didahulukan; cadangan: penetapan unit perangkat (M10).
  const rows = devRows.map((d) => {
    const t = truckRows.find((x) => x.gpsDeviceId === d.id) ?? (d.truckId ? truckRows.find((x) => x.id === d.truckId && !x.gpsDeviceId) : undefined) ?? null;
    return { d, truckId: t?.id ?? null, truckCode: t?.code ?? null, truckStatus: t?.status ?? null };
  });
  const truckIds = rows.map((r) => r.truckId).filter((x): x is string => !!x);
  const phone = await livePhoneTracking(tx, truckIds);
  const ids = rows.map((r) => r.d.id);
  const since = addDays(today, -29);
  const outages = ids.length
    ? await tx
        .select()
        .from(fleetEvents)
        .where(and(inArray(fleetEvents.deviceId, ids), inArray(fleetEvents.kind, [...OUTAGE_KINDS]), gte(fleetEvents.businessDate, since)))
        .orderBy(desc(fleetEvents.startedAt))
    : [];
  return rows.map((r) => {
    const own = outages.filter((o) => o.deviceId === r.d.id);
    const open = own.find((o) => !o.endedAt) ?? null;
    const minutesSince = r.d.gpsLastPositionAt ? minutesBetween(r.d.gpsLastPositionAt, now) : null;
    const flag = r.truckId ? phone.get(r.truckId) : undefined;
    return {
      deviceId: r.d.id,
      deviceCode: r.d.deviceCode,
      name: r.d.name,
      vendor: r.d.vendor,
      imei: r.d.imei,
      firmwareVersion: r.d.firmwareVersion,
      status: r.d.status,
      isSpare: r.d.isSpare,
      gpsState: r.d.gpsState,
      gpsStateSince: r.d.gpsStateSince,
      lastPositionAt: r.d.gpsLastPositionAt,
      lastSeenAt: r.d.lastSeenAt,
      powerConnected: r.d.gpsPowerConnected,
      batteryPct: r.d.batteryPct,
      truckId: r.truckId,
      truckCode: r.truckCode,
      truckStatus: r.truckStatus,
      minutesSinceLastPosition: minutesSince,
      stale: minutesSince !== null && minutesSince > rules.staleMinutes,
      openOutage: open ? { id: open.id, kind: open.kind, startedAt: open.startedAt, minutes: minutesBetween(open.startedAt, now) } : null,
      phoneTracking: flag ? { reason: flag.reason, since: flag.startedAt } : null,
      outages30d: own.length,
      outageMinutes30d: own.reduce((s, o) => s + Math.round((o.durationS ?? (o.endedAt ? 0 : (now.getTime() - o.startedAt.getTime()) / 1000)) / 60), 0),
    };
  });
}

/** Menit perangkat mati/dicabut truk pada tanggal (irisan interval kejadian dengan hari WIB) — US-M12-08 KP-2 (H+0). */
export async function deviceOutageMinutesOn(tx: Tx, truckIds: readonly string[], date: BusinessDate, now: Date): Promise<Map<string, number>> {
  if (truckIds.length === 0) return new Map();
  const range = businessDateToUtcRange(date);
  const rows = await outageRowsOverlapping(tx, truckIds, range.start, range.end);
  return outageMinutesForDay(rows, date, now);
}

type OutageInterval = Pick<FleetEventRow, "truckId" | "startedAt" | "endedAt">;

/** Kejadian perangkat mati/dicabut truk yang beririsan dengan [start, end). */
async function outageRowsOverlapping(tx: Tx, truckIds: readonly string[], start: Date, end: Date): Promise<OutageInterval[]> {
  return tx
    .select({ truckId: fleetEvents.truckId, startedAt: fleetEvents.startedAt, endedAt: fleetEvents.endedAt })
    .from(fleetEvents)
    .where(
      and(
        inArray(fleetEvents.truckId, [...truckIds]),
        inArray(fleetEvents.kind, [...OUTAGE_KINDS]),
        lt(fleetEvents.startedAt, end),
        or(isNull(fleetEvents.endedAt), gte(fleetEvents.endedAt, start)),
      ),
    );
}

/** Menit mati per truk pada satu tanggal dari interval kejadian (irisan dengan hari WIB; kejadian terbuka s.d. `now`). */
function outageMinutesForDay(rows: readonly OutageInterval[], date: BusinessDate, now: Date): Map<string, number> {
  const out = new Map<string, number>();
  const range = businessDateToUtcRange(date);
  const start = range.start.getTime();
  const end = range.end.getTime();
  for (const r of rows) {
    // Sama dengan saringan kueri per hari: mulai < akhir hari DAN (belum selesai ATAU selesai ≥ awal hari).
    if (!(r.startedAt.getTime() < end && (r.endedAt === null || r.endedAt.getTime() >= start))) continue;
    const s = Math.max(start, r.startedAt.getTime());
    const e = Math.min(end, (r.endedAt ?? now).getTime());
    if (e > s) out.set(r.truckId!, (out.get(r.truckId!) ?? 0) + Math.round((e - s) / 60_000));
  }
  return out;
}

/**
 * Versi RENTANG `deviceOutageMinutesOn` (v1.0.1, D-14 butir 4): SATU kueri untuk semua tanggal, lalu menit per tanggal
 * dihitung dengan aturan yang sama (hasil per tanggal identik dengan `deviceOutageMinutesOn(tx, truckIds, d, now)`).
 */
export async function deviceOutageMinutesForRange(
  tx: Tx,
  truckIds: readonly string[],
  dates: readonly BusinessDate[],
  now: Date,
): Promise<Map<BusinessDate, Map<string, number>>> {
  const out = new Map<BusinessDate, Map<string, number>>();
  if (dates.length === 0) return out;
  if (truckIds.length === 0) {
    for (const d of dates) out.set(d, new Map());
    return out;
  }
  const sorted = [...dates].sort();
  const rows = await outageRowsOverlapping(tx, truckIds, businessDateToUtcRange(sorted[0]!).start, businessDateToUtcRange(sorted[sorted.length - 1]!).end);
  for (const d of dates) out.set(d, outageMinutesForDay(rows, d, now));
  return out;
}

export type OutageReportRow = {
  truckId: string;
  truckCode: string;
  deviceCode: string | null;
  count: number;
  totalMinutes: number;
  longestMinutes: number;
  unplugged: number;
  pattern: boolean;
};

/** Laporan perangkat mati/dicabut per truk (US-M12-08 KP-3: pola berulang → pemilik). */
export async function deviceOutageReport(ctx: ActorContext, input: { from: BusinessDate; to: BusinessDate }, opts: { tx?: Tx } = {}): Promise<OutageReportRow[]> {
  await authorize(ctx, "m12.fleet_event.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rules = await m12Rules(tx, ctxBusinessDate(ctx), ctx.tenantId);
  const rows = await tx
    .select({ e: fleetEvents, truckCode: trucks.code, deviceCode: devices.deviceCode })
    .from(fleetEvents)
    .innerJoin(trucks, eq(trucks.id, fleetEvents.truckId))
    .leftJoin(devices, eq(devices.id, fleetEvents.deviceId))
    .where(and(eq(fleetEvents.tenantId, ctx.tenantId), inArray(fleetEvents.kind, [...OUTAGE_KINDS]), gte(fleetEvents.businessDate, input.from), sql`${fleetEvents.businessDate} <= ${input.to}`));
  const byTruck = new Map<string, OutageReportRow>();
  for (const r of rows) {
    const key = r.e.truckId!;
    const cur = byTruck.get(key) ?? { truckId: key, truckCode: r.truckCode, deviceCode: r.deviceCode, count: 0, totalMinutes: 0, longestMinutes: 0, unplugged: 0, pattern: false };
    const minutes = Math.round((r.e.durationS ?? (ctx.now.getTime() - r.e.startedAt.getTime()) / 1000) / 60);
    cur.count++;
    cur.totalMinutes += minutes;
    cur.longestMinutes = Math.max(cur.longestMinutes, minutes);
    if (r.e.kind === "device_unplugged") cur.unplugged++;
    byTruck.set(key, cur);
  }
  for (const r of byTruck.values()) r.pattern = r.count >= rules.fleet.repeat_outage_count;
  return [...byTruck.values()].sort((a, b) => b.count - a.count || a.truckCode.localeCompare(b.truckCode));
}

/** Admin sistem memaksa GPS ponsel cadangan aktif/nonaktif per truk (izin `m12.phone_tracking.enable`, berjejak). */
export async function setPhoneTracking(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<{ enabled: boolean; changed: boolean }> {
  await authorize(ctx, "m12.phone_tracking.enable", { tx: opts.tx });
  const data = parseInput(phoneTrackingSchema, input, { truckId: "Truk", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const [truck] = await tx.select({ id: trucks.id, code: trucks.code, tenantId: trucks.tenantId }).from(trucks).where(eq(trucks.id, data.truckId)).limit(1);
    if (!truck || truck.tenantId !== ctx.tenantId) throw ValidationError.field("truckId", "Truk tidak ditemukan.");
    let changed = false;
    if (data.enabled) {
      const res = await startPhoneTracking(tx, { truckId: truck.id, reason: "admin_forced", setBy: ctx.userId, now: ctx.now });
      changed = res.created;
    } else {
      changed = (await stopPhoneTracking(tx, { truckId: truck.id, reasons: ["admin_forced", "device_dead"], now: ctx.now })) > 0;
    }
    if (changed) {
      await auditRecord(tx, {
        ctx,
        objectType: "phone_tracking_flag",
        objectId: truck.id,
        action: data.enabled ? "activate" : "deactivate",
        after: { truckId: truck.id, truckCode: truck.code, enabled: data.enabled },
        reason: data.reason,
        rule: "US-M3-02 KP-5, US-M12-01 KP-4",
      });
    }
    return { enabled: data.enabled, changed };
  });
}

/** Truk dengan perangkat Mati/Dicabut saat ini (peta). */
export async function deadDeviceTrucks(tx: Tx, tenantId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ truckId: trucks.id })
    .from(trucks)
    .innerJoin(devices, eq(devices.id, trucks.gpsDeviceId))
    .where(and(eq(trucks.tenantId, tenantId), inArray(devices.gpsState, ["dead", "unplugged"]), ne(devices.status, "blocked")));
  return new Set(rows.map((r) => r.truckId));
}
