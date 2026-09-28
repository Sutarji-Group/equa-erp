/**
 * Seed demo Pelacakan Armada / GPS (M12) — idempoten (ID deterministik + ON CONFLICT DO NOTHING; posisi unik per truk +
 * sumber + waktu). Tanggal relatif terhadap hari seed dijalankan agar peta, riwayat, kejadian, dan halaman perangkat
 * tidak kosong. Posisi dibangkitkan simulator murni (`domain/simulator`) dan diselaraskan dengan rit demo M2/M3 bila
 * ada (Berangkat → alamat → Selesai/Gagal; sumber air sebelum rit; kembali ke pool setelah rit terakhir).
 *
 * Isi:
 * - Kemarin 06.00–17.30 WIB untuk T1–T7 (+ hari ini sampai jam seed, bila sudah lewat 06.00): posisi perangkat GPS tiap
 *   1 menit saat bergerak / 5 menit saat diam.
 * - Kejadian: T4 "perjalanan di luar jadwal" 15.00 (keterangan sopir sudah ada → daftar tinjauan pemilik); T5 "berhenti
 *   tidak dikenal" saat rit (tanpa keterangan → H+0); T6 "perangkat GPS mati" 09.40–10.25 (ditutup, aktif kembali); T7
 *   "perangkat GPS dicabut" sejak 16.30 kemarin (terbuka; GPS ponsel cadangan aktif untuk T7).
 * - Kesehatan perangkat GPS-T1..T7: terakhir terlihat, daya, versi, baterai, status.
 * PAR-53 (konsumsi & harga BBM) TIDAK diisi — ditetapkan pemilik (US-M12-07).
 *
 * Dilewati saat snapshot DB uji Vitest dibangun (tanggal relatif); uji M12 memanggilnya langsung dengan `{ force: true }`.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { haversineMeters, type LatLng } from "../../lib/geo";
import { addDays, toBusinessDate, wibToUtc } from "../../lib/time";
import { bearing, offsetMeters, prng } from "../../server/modules/m12-fleet/domain/simulator";
import type { DbOrTx } from "../client";
import { customerAddresses, devices, fleetEvents, gpsPositions, outlets, phoneTrackingFlags, trips } from "../schema";
import { seedId } from "./ids";
import { EQUA_TENANT_ID, POOL_SEED, TRUCK_CODES, WATER_SOURCE_SEEDS, deviceId, truckId, userIdByUsername } from "./org";

const POOL: LatLng = { lat: POOL_SEED.lat, lng: POOL_SEED.lng };
const SOURCES: LatLng[] = WATER_SOURCE_SEEDS.map((s) => ({ lat: s.lat, lng: s.lng }));
/** Warung di luar lokasi sah (tujuan perjalanan di luar jadwal T4). */
const WARUNG: LatLng = offsetMeters(POOL, -2_400, -1_300);
/** Titik berhenti tidak dikenal T5. */
const LAPAK: LatLng = offsetMeters(POOL, -5_200, -3_900);
const SPEED_KMH = 32;
const MOVE_INTERVAL_S = 60;
const DWELL_INTERVAL_S = 300;

type Segment = { kind: "dwell"; at: LatLng; from: Date; to: Date; power?: boolean } | { kind: "drive"; from: LatLng; to: LatLng; start: Date; end: Date };

type Fix = { t: Date; lat: number; lng: number; speedKmh: number; heading: number; power: boolean };

const minutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
const travelMs = (a: LatLng, b: LatLng) => (haversineMeters(a, b) / (SPEED_KMH / 3.6)) * 1000;

function nearestSource(p: LatLng): LatLng {
  return SOURCES.reduce((best, s) => (haversineMeters(p, s) < haversineMeters(p, best) ? s : best), SOURCES[0]!);
}

/** Posisi dari segmen (getar ± 6 m, deterministik per truk-hari). */
function fixesOf(segments: readonly Segment[], seed: number, until: Date): Fix[] {
  const rand = prng(seed);
  const out: Fix[] = [];
  const jitter = (p: LatLng) => offsetMeters(p, (rand() - 0.5) * 12, (rand() - 0.5) * 12);
  for (const s of segments) {
    if (s.kind === "dwell") {
      for (let t = s.from.getTime(); t < s.to.getTime() && t <= until.getTime(); t += DWELL_INTERVAL_S * 1000) {
        const p = jitter(s.at);
        out.push({ t: new Date(t), lat: p.lat, lng: p.lng, speedKmh: 0, heading: 0, power: s.power ?? true });
      }
    } else {
      const total = s.end.getTime() - s.start.getTime();
      const km = haversineMeters(s.from, s.to) / 1000;
      const speed = total > 0 ? Math.round((km / (total / 3_600_000)) * (0.9 + rand() * 0.2)) : 0;
      const head = bearing(s.from, s.to);
      for (let t = s.start.getTime(); t < s.end.getTime() && t <= until.getTime(); t += MOVE_INTERVAL_S * 1000) {
        const f = total > 0 ? (t - s.start.getTime()) / total : 1;
        const p = jitter({ lat: s.from.lat + (s.to.lat - s.from.lat) * f, lng: s.from.lng + (s.to.lng - s.from.lng) * f });
        out.push({ t: new Date(t), lat: p.lat, lng: p.lng, speedKmh: speed, heading: head, power: true });
      }
    }
  }
  return out;
}

type DemoTrip = { id: string; departedAt: Date; endAt: Date; dest: LatLng; failed: boolean };

/** Rencana hari truk dari rit (sumber sebelum rit, alamat, kembali ke pool). */
function dayWithTrips(date: string, list: readonly DemoTrip[], stopover?: { tripIndex: number; at: LatLng; minutes: number }): Segment[] {
  const segs: Segment[] = [];
  let pos = POOL;
  let cursor = wibToUtc(date, "06:00");
  const dwell = (at: LatLng, to: Date) => {
    if (to > cursor) segs.push({ kind: "dwell", at, from: cursor, to });
    cursor = to > cursor ? to : cursor;
  };
  const drive = (to: LatLng, end: Date) => {
    // Waktu selalu maju (rit demo yang berdekatan): minimal satu menit perjalanan.
    const safeEnd = new Date(Math.max(end.getTime(), cursor.getTime() + 60_000));
    segs.push({ kind: "drive", from: pos, to, start: cursor, end: safeEnd });
    cursor = safeEnd;
    pos = to;
  };
  for (const [i, trip] of list.entries()) {
    const source = nearestSource(trip.dest);
    if (haversineMeters(pos, source) > 100) {
      const leave = new Date(Math.max(cursor.getTime(), trip.departedAt.getTime() - 15 * 60_000 - travelMs(pos, source)));
      dwell(pos, leave);
      drive(source, new Date(Math.min(leave.getTime() + travelMs(pos, source), trip.departedAt.getTime() - 60_000)));
    }
    dwell(source, trip.departedAt);
    const latest = minutes(trip.endAt, -5);
    if (stopover && stopover.tripIndex === i) {
      const toStop = new Date(Math.min(cursor.getTime() + travelMs(pos, stopover.at), latest.getTime()));
      drive(stopover.at, toStop);
      dwell(stopover.at, minutes(cursor, stopover.minutes));
    }
    drive(trip.dest, new Date(Math.max(cursor.getTime() + 60_000, Math.min(cursor.getTime() + travelMs(pos, trip.dest), latest.getTime()))));
    dwell(trip.dest, trip.endAt);
  }
  if (list.length) {
    drive(POOL, new Date(cursor.getTime() + travelMs(pos, POOL)));
    dwell(POOL, wibToUtc(date, "17:30"));
  }
  return segs;
}

/** Hari tanpa rit: isi di sumber lalu kembali ke pool (perjalanan yang diharapkan — tidak ditandai). */
function dayWithoutTrips(date: string, variant: "fill" | "idle"): Segment[] {
  const segs: Segment[] = [];
  const start = wibToUtc(date, "06:00");
  if (variant === "idle") return [{ kind: "dwell", at: POOL, from: start, to: wibToUtc(date, "17:30") }];
  const source = SOURCES[0]!;
  const leave = wibToUtc(date, "07:10");
  const arrive = new Date(leave.getTime() + travelMs(POOL, source));
  segs.push({ kind: "dwell", at: POOL, from: start, to: leave });
  segs.push({ kind: "drive", from: POOL, to: source, start: leave, end: arrive });
  segs.push({ kind: "dwell", at: source, from: arrive, to: minutes(arrive, 20) });
  const back = minutes(arrive, 20);
  segs.push({ kind: "drive", from: source, to: POOL, start: back, end: new Date(back.getTime() + travelMs(source, POOL)) });
  segs.push({ kind: "dwell", at: POOL, from: new Date(back.getTime() + travelMs(source, POOL)), to: wibToUtc(date, "17:30") });
  return segs;
}

async function tripsOf(tx: DbOrTx, date: string): Promise<Map<string, DemoTrip[]>> {
  const rows = await tx
    .select({
      id: trips.id,
      truckId: trips.truckId,
      status: trips.status,
      departedAt: trips.departedAt,
      completedAt: trips.completedAt,
      failedAt: trips.failedAt,
      isInternal: trips.isInternal,
      lat: customerAddresses.lat,
      lng: customerAddresses.lng,
      outletLat: outlets.lat,
      outletLng: outlets.lng,
    })
    .from(trips)
    .innerJoin(customerAddresses, eq(customerAddresses.id, trips.addressId))
    .leftJoin(outlets, eq(outlets.id, trips.destinationOutletId))
    .where(and(eq(trips.tenantId, EQUA_TENANT_ID), eq(trips.scheduledDate, date), isNotNull(trips.departedAt), inArray(trips.status, ["completed", "failed", "departed", "arrived"])));
  const out = new Map<string, DemoTrip[]>();
  for (const r of rows) {
    const lat = r.isInternal && r.outletLat != null ? r.outletLat : r.lat;
    const lng = r.isInternal && r.outletLng != null ? r.outletLng : r.lng;
    if (!r.truckId || lat == null || lng == null || !r.departedAt) continue;
    const endAt = r.completedAt ?? r.failedAt ?? minutes(r.departedAt, 45);
    const list = out.get(r.truckId) ?? [];
    list.push({ id: r.id, departedAt: r.departedAt, endAt, dest: { lat, lng }, failed: r.status === "failed" });
    out.set(r.truckId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.departedAt.getTime() - b.departedAt.getTime());
  return out;
}

async function insertFixes(tx: DbOrTx, truckCode: string, fixes: readonly Fix[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < fixes.length; i += 400) {
    const chunk = fixes.slice(i, i + 400);
    const rows = await tx
      .insert(gpsPositions)
      .values(
        chunk.map((f, k) => ({
          tenantId: EQUA_TENANT_ID,
          truckId: truckId(truckCode),
          deviceId: deviceId(`GPS-${truckCode}`),
          source: "gps_device" as const,
          deviceTime: f.t,
          serverTime: new Date(f.t.getTime() + 2_000),
          lat: f.lat,
          lng: f.lng,
          speedKmh: f.speedKmh,
          heading: f.heading,
          accuracyM: 6 + ((i + k) % 7),
          ignitionOn: f.speedKmh > 0,
          powerConnected: f.power,
          isValid: true,
          vendor: "generic-json",
        })),
      )
      .onConflictDoNothing()
      .returning({ id: gpsPositions.id });
    n += rows.length;
  }
  return n;
}

export async function seedDemoM12Fleet(tx: DbOrTx, now: Date = new Date(), opts: { force?: boolean } = {}): Promise<{ positions: number; events: number }> {
  if (!opts.force && (process.env.VITEST || process.env.NODE_ENV === "test")) return { positions: 0, events: 0 };
  const today = toBusinessDate(now);
  const yesterday = addDays(today, -1);
  let positions = 0;
  const lastFix = new Map<string, Fix>();

  const plan = async (date: string, until: Date) => {
    const byTruck = await tripsOf(tx, date);
    for (const [i, code] of TRUCK_CODES.entries()) {
      const own = byTruck.get(truckId(code)) ?? [];
      let segs: Segment[];
      if (own.length) {
        const failedIndex = own.findIndex((t) => t.failed);
        segs = dayWithTrips(date, own, code === "T5" && failedIndex >= 0 && date === yesterday ? { tripIndex: failedIndex, at: LAPAK, minutes: 24 } : undefined);
      } else if (code === "T4" && date === yesterday) {
        // Perjalanan di luar jadwal: diam di pool, 15.00 ke warung (bukan lokasi sah), 20 menit, kembali ke pool.
        const out = wibToUtc(date, "15:00");
        const arrive = new Date(out.getTime() + travelMs(POOL, WARUNG));
        const back = minutes(arrive, 20);
        const home = new Date(back.getTime() + travelMs(WARUNG, POOL));
        segs = [
          { kind: "dwell", at: POOL, from: wibToUtc(date, "06:00"), to: out },
          { kind: "drive", from: POOL, to: WARUNG, start: out, end: arrive },
          { kind: "dwell", at: WARUNG, from: arrive, to: back },
          { kind: "drive", from: WARUNG, to: POOL, start: back, end: home },
          { kind: "dwell", at: POOL, from: home, to: wibToUtc(date, "17:30") },
        ];
      } else if (code === "T6" && date === yesterday) {
        // Perangkat mati 09.40–10.25 (tanpa posisi), lalu aktif kembali.
        segs = [
          { kind: "dwell", at: POOL, from: wibToUtc(date, "06:00"), to: wibToUtc(date, "09:40") },
          { kind: "dwell", at: POOL, from: wibToUtc(date, "10:25"), to: wibToUtc(date, "17:30") },
        ];
      } else if (code === "T7") {
        // Dicabut sejak 16.30 kemarin: posisi terakhir membawa sinyal daya terputus; hari ini tanpa posisi perangkat.
        segs = date === yesterday ? [...dayWithoutTrips(date, "fill").map((s) => (s.kind === "dwell" && s.to > wibToUtc(date, "16:30") ? { ...s, to: wibToUtc(date, "16:30") } : s)), { kind: "dwell", at: POOL, from: wibToUtc(date, "16:30"), to: wibToUtc(date, "16:31"), power: false }] : [];
      } else {
        segs = dayWithoutTrips(date, i % 2 === 0 ? "fill" : "idle");
      }
      const fixes = fixesOf(segs, 1_000 + i * 17 + (date === today ? 7 : 0), until);
      positions += await insertFixes(tx, code, fixes);
      const last = fixes[fixes.length - 1];
      if (last && (!lastFix.get(code) || last.t > lastFix.get(code)!.t)) lastFix.set(code, last);
    }
  };
  await plan(yesterday, wibToUtc(yesterday, "23:59"));
  if (now.getTime() > wibToUtc(today, "06:00").getTime()) await plan(today, now);

  // Kesehatan perangkat (US-M12-08 KP-4).
  for (const code of TRUCK_CODES) {
    const last = lastFix.get(code);
    if (!last) continue;
    await tx
      .update(devices)
      .set({
        gpsLastPositionAt: last.t,
        lastSeenAt: last.t,
        gpsPowerConnected: code !== "T7",
        firmwareVersion: "FW-2.4.1",
        batteryPct: code === "T7" ? 64 : 100,
        gpsState: code === "T7" ? "unplugged" : "active",
        gpsStateSince: code === "T7" ? wibToUtc(yesterday, "16:30") : wibToUtc(yesterday, "06:00"),
      })
      .where(eq(devices.id, deviceId(`GPS-${code}`)));
  }

  // Kejadian armada demo.
  const tripsYesterday = await tripsOf(tx, yesterday);
  const t5Failed = (tripsYesterday.get(truckId("T5")) ?? []).find((t) => t.failed) ?? null;
  const warungOut = wibToUtc(yesterday, "15:00");
  const warungArrive = new Date(warungOut.getTime() + travelMs(POOL, WARUNG));
  const events: (typeof fleetEvents.$inferInsert)[] = [
    {
      id: seedId(`m12:event:offschedule:T4:${yesterday}`),
      tenantId: EQUA_TENANT_ID,
      kind: "off_schedule_trip",
      status: "explained",
      truckId: truckId("T4"),
      deviceId: deviceId("GPS-T4"),
      userId: userIdByUsername("sopir4"),
      businessDate: yesterday,
      startedAt: warungOut,
      endedAt: warungArrive,
      durationS: Math.round((warungArrive.getTime() - warungOut.getTime()) / 1000),
      distanceM: Math.round(haversineMeters(POOL, WARUNG)),
      lat: WARUNG.lat,
      lng: WARUNG.lng,
      requiresExplanation: true,
      explanation: "Ke tambal ban dekat pool, ban belakang kiri kempis. Sudah izin Dispatcher lewat telepon.",
      explainedBy: userIdByUsername("sopir4"),
      explainedAt: wibToUtc(yesterday, "16:05"),
      explanationBusinessDate: yesterday,
      details: { start: POOL, end: WARUNG, startPlace: POOL_SEED.name, endedByDeparture: false, offHours: false, demo: true },
      dedupeKey: `demo:offschedule:T4:${yesterday}`,
    },
    {
      id: seedId(`m12:event:offline:T6:${yesterday}`),
      tenantId: EQUA_TENANT_ID,
      kind: "device_offline",
      status: "done",
      truckId: truckId("T6"),
      deviceId: deviceId("GPS-T6"),
      businessDate: yesterday,
      startedAt: wibToUtc(yesterday, "09:40"),
      endedAt: wibToUtc(yesterday, "10:25"),
      durationS: 45 * 60,
      doneAt: wibToUtc(yesterday, "10:25"),
      details: { deviceCode: "GPS-T6", restoredAt: wibToUtc(yesterday, "10:25").toISOString(), thresholdMinutes: 15, demo: true },
      dedupeKey: `demo:offline:T6:${yesterday}`,
    },
    {
      id: seedId(`m12:event:unplugged:T7:${yesterday}`),
      tenantId: EQUA_TENANT_ID,
      kind: "device_unplugged",
      status: "detected",
      truckId: truckId("T7"),
      deviceId: deviceId("GPS-T7"),
      businessDate: yesterday,
      startedAt: wibToUtc(yesterday, "16:30"),
      lat: POOL.lat,
      lng: POOL.lng,
      details: { deviceCode: "GPS-T7", powerConnected: false, demo: true },
      dedupeKey: `demo:unplugged:T7:${yesterday}`,
    },
  ];
  if (t5Failed) {
    const stopAt = new Date(t5Failed.departedAt.getTime() + travelMs(nearestSource(t5Failed.dest), LAPAK));
    events.push({
      id: seedId(`m12:event:unknownstop:T5:${yesterday}`),
      tenantId: EQUA_TENANT_ID,
      kind: "unknown_stop",
      status: "detected",
      truckId: truckId("T5"),
      tripId: t5Failed.id,
      deviceId: deviceId("GPS-T5"),
      userId: userIdByUsername("sopir5"),
      businessDate: yesterday,
      startedAt: stopAt,
      endedAt: minutes(stopAt, 24),
      durationS: 24 * 60,
      lat: LAPAK.lat,
      lng: LAPAK.lng,
      requiresExplanation: true,
      details: { ongoing: false, thresholdMinutes: 15, demo: true },
      dedupeKey: `demo:unknownstop:T5:${yesterday}`,
    });
  }
  const inserted = await tx.insert(fleetEvents).values(events).onConflictDoNothing().returning({ id: fleetEvents.id });
  await tx
    .insert(phoneTrackingFlags)
    .values({ id: seedId(`m12:phone:T7:${yesterday}`), truckId: truckId("T7"), reason: "device_dead", startedAt: wibToUtc(yesterday, "16:30"), fleetEventId: seedId(`m12:event:unplugged:T7:${yesterday}`) })
    .onConflictDoNothing();
  return { positions, events: inserted.length };
}
