/**
 * D-14 butir 4 / B-90 (v1.0.1): ringkasan armada H+0 versi RENTANG (`fleetRangeSummary`) — kueri tetap per rentang,
 * bukan ±16 kueri per hari. Keluaran per tanggal WAJIB identik dengan versi harian `fleetDaySummary` (fungsi lama),
 * termasuk perangkat mati melintasi tengah malam, kejadian terbuka s.d. `now`, perubahan ambang di tengah rentang,
 * isolasi tenant, dan agregat pengecualian H+0 M9 (`exceptionsForRange`).
 */
import { beforeAll, describe, expect, it } from "vitest";

import { EQUA_TENANT_ID, truckId } from "@/db/seed";
import { addDays, type BusinessDate } from "@/lib/time";
import { withTx, type Tx } from "@/server/core/db";
import * as params from "@/server/core/params";
import { createFleetEvent, fleetDaySummary, fleetRangeSummary, type FleetDaySummary } from "@/server/modules/m12-fleet";
import { exceptionsForRange } from "@/server/modules/m9-reports";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { ensureTenant } from "../helpers/factories";
import { wib } from "./helpers";

const FROM = "2026-09-10";
const TO = "2026-09-16";
const NOW = wib("2026-09-16", "12:00");
const PARTNER = "0192f1c4-7b7a-7cc2-9d7e-3f1b2a4c5d88";

function datesOf(from: BusinessDate, to: BusinessDate): BusinessDate[] {
  const out: BusinessDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Acuan = cara LAMA di M9 `exceptionsForRange`: `fleetDaySummary` per hari lalu dijumlahkan. */
async function legacyFleetExceptions(tx: Tx, from: BusinessDate, to: BusinessDate, now: Date) {
  const fleet = { offSchedule: 0, unknownStops: 0, deviationsL2: 0, inconsistent: 0, geofenceFlags: 0, awaitingReview: 0, unexplained: 0, deviceOutages: [] as { truckCode: string; minutes: number }[] };
  const outages = new Map<string, number>();
  for (const d of datesOf(from, to)) {
    const f = await fleetDaySummary(tx, EQUA_TENANT_ID, d, now);
    fleet.offSchedule += f.counts.offSchedule;
    fleet.unknownStops += f.counts.unknownStops;
    fleet.deviationsL2 += f.counts.deviationsL2;
    fleet.inconsistent += f.counts.inconsistent;
    fleet.geofenceFlags += f.counts.geofenceFlags;
    fleet.awaitingReview += f.counts.awaitingReview;
    fleet.unexplained += f.unexplained.length;
    for (const o of f.deviceOutages) outages.set(o.truckCode, (outages.get(o.truckCode) ?? 0) + o.minutes);
  }
  fleet.deviceOutages = [...outages.entries()].map(([truckCode, minutes]) => ({ truckCode, minutes })).sort((a, b) => b.minutes - a.minutes);
  return fleet;
}

describe("D-14 B-90 ringkasan armada H+0 versi rentang (M12 → M9)", () => {
  const t = useTestDb({ seed: true });
  let n = 0;
  const event = (input: Omit<Parameters<typeof createFleetEvent>[1], "dedupeKey" | "tenantId" | "now" | "rule"> & { tenantId?: string; now?: Date }) =>
    withTx((tx) => createFleetEvent(tx, { tenantId: EQUA_TENANT_ID, dedupeKey: `uji-rentang-${++n}`, now: input.startedAt, rule: "D-14 uji rentang", ...input }));

  beforeAll(async () => {
    bootstrapForTests();
    const T1 = truckId("T1");
    const T2 = truckId("T2");
    const T3 = truckId("T3");
    // Kejadian perjalanan/lokasi (perlu keterangan / tinjauan pemilik) di beberapa tanggal.
    await event({ kind: "off_schedule_trip", truckId: T1, businessDate: "2026-09-10", startedAt: wib("2026-09-10", "06:10"), requiresExplanation: true });
    await event({ kind: "off_hours_trip", truckId: T2, businessDate: "2026-09-10", startedAt: wib("2026-09-10", "23:10"), requiresExplanation: true });
    await event({ kind: "unknown_stop", truckId: T1, businessDate: "2026-09-11", startedAt: wib("2026-09-11", "10:00"), status: "done" });
    await event({ kind: "location_deviation_l2", truckId: T3, businessDate: "2026-09-12", startedAt: wib("2026-09-12", "09:00") });
    await event({ kind: "location_source_inconsistent", truckId: T3, businessDate: "2026-09-12", startedAt: wib("2026-09-12", "09:00") }); // jam sama (urutan seri)
    await event({ kind: "fill_without_geofence", truckId: T2, businessDate: "2026-09-13", startedAt: wib("2026-09-13", "07:30"), requiresExplanation: true });
    await event({ kind: "geofence_without_fill", truckId: T2, businessDate: "2026-09-15", startedAt: wib("2026-09-15", "08:00") });
    await event({ kind: "supply_without_geofence", truckId: T1, businessDate: "2026-09-16", startedAt: wib("2026-09-16", "08:00") });
    // Perangkat mati: melintasi tengah malam (11→12), dua kejadian sehari (13), terbuka s.d. `now` (14..16).
    await event({ kind: "device_offline", truckId: T1, businessDate: "2026-09-11", startedAt: wib("2026-09-11", "22:00"), endedAt: wib("2026-09-12", "03:30"), status: "done" });
    await event({ kind: "device_offline", truckId: T3, businessDate: "2026-09-13", startedAt: wib("2026-09-13", "08:00"), endedAt: wib("2026-09-13", "10:00"), status: "done" });
    await event({ kind: "device_offline", truckId: T3, businessDate: "2026-09-13", startedAt: wib("2026-09-13", "13:00"), endedAt: wib("2026-09-13", "13:50"), status: "done" });
    await event({ kind: "device_unplugged", truckId: T2, businessDate: "2026-09-14", startedAt: wib("2026-09-14", "06:00") });
    // Sebelum rentang tetapi masih mati saat rentang dimulai (09-09 20:00 → 09-10 02:30).
    await event({ kind: "device_offline", truckId: T3, businessDate: "2026-09-09", startedAt: wib("2026-09-09", "20:00"), endedAt: wib("2026-09-10", "02:30"), status: "done" });
    // Tenant lain pada tanggal yang sama tidak boleh ikut terhitung.
    await ensureTenant(t.db, PARTNER, "MITRA88", "partner");
    await event({ tenantId: PARTNER, kind: "unknown_stop", truckId: null, businessDate: "2026-09-12", startedAt: wib("2026-09-12", "11:00"), requiresExplanation: true });
    // Ambang H+0 perangkat mati berubah di tengah rentang (120 → 60 menit mulai 14/09).
    const owner = seededContext("pemilik", { now: wib("2026-09-01", "09:00") });
    const current = await params.get(t.db, "m12.fleet_rules", "2026-09-01");
    await params.set(owner, "m12.fleet_rules", { ...current, device_dead_h0_minutes: 60 }, "2026-09-14", "Uji ambang H+0 rentang");
  });

  it("US-M12-08 KP-2 US-M12-05 KP-4 D-14 fleetRangeSummary per tanggal identik dengan fleetDaySummary (fungsi lama) — tengah malam, kejadian terbuka, ambang berubah, isolasi tenant", async () => {
    const range = await withTx((tx) => fleetRangeSummary(tx, EQUA_TENANT_ID, FROM, TO, NOW));
    const legacy: FleetDaySummary[] = [];
    for (const d of datesOf(FROM, TO)) legacy.push(await fleetDaySummary(t.db, EQUA_TENANT_ID, d, NOW));
    expect(range.map((r) => r.date)).toEqual(datesOf(FROM, TO));
    expect(range).toEqual(legacy);

    // Titik uji eksplisit (bukan hanya kesamaan): data uji benar-benar menjangkau cabang yang dimaksud.
    const byDate = new Map(range.map((r) => [r.date, r]));
    expect(byDate.get("2026-09-10")!.unexplained.map((u) => u.kind)).toEqual(["off_schedule_trip", "off_hours_trip"]);
    expect(byDate.get("2026-09-12")!.counts).toMatchObject({ deviationsL2: 1, inconsistent: 1, awaitingReview: 2 });
    expect(byDate.get("2026-09-12")!.deviceOutages).toEqual([{ truckId: truckId("T1"), truckCode: "T1", minutes: 210 }]);
    expect(byDate.get("2026-09-11")!.deviceOutages).toEqual([]); // 120 menit, tidak > 120
    expect(byDate.get("2026-09-13")!.deviceOutages).toEqual([{ truckId: truckId("T3"), truckCode: "T3", minutes: 170 }]);
    expect(byDate.get("2026-09-14")!.deviceOutageThresholdMinutes).toBe(60);
    expect(byDate.get("2026-09-16")!.deviceOutages).toEqual([{ truckId: truckId("T2"), truckCode: "T2", minutes: 720 }]);

    // Satu tanggal & rentang kosong.
    expect(await fleetRangeSummary(t.db, EQUA_TENANT_ID, "2026-09-12", "2026-09-12", NOW)).toEqual([legacy[2]]);
    expect(await fleetRangeSummary(t.db, EQUA_TENANT_ID, TO, FROM, NOW)).toEqual([]);
  });

  it("D-14 rentang 30 hari: aturan armada dibaca lewat cache parameter satu kali per parameter (13 kueri, bukan 13 × 30)", async () => {
    await withTx(async (tx) => {
      const cache = params.cached(tx);
      const days = await fleetRangeSummary(tx, EQUA_TENANT_ID, "2026-09-01", "2026-09-30", NOW, { cache });
      expect(days).toHaveLength(30);
      expect(cache.queries).toBe(13);
      // Cache yang sama dipakai lagi dalam transaksi ini → tanpa kueri parameter tambahan.
      await fleetRangeSummary(tx, EQUA_TENANT_ID, "2026-09-05", "2026-09-20", NOW);
      expect(params.cached(tx)).toBe(cache);
      expect(cache.queries).toBe(13);
    });
  });

  it("US-M9-01 KP-1 D-14 pengecualian armada H+0 rentang (exceptionsForRange) = penjumlahan harian cara lama", async () => {
    const legacy = await legacyFleetExceptions(t.db, FROM, TO, NOW);
    const now = await exceptionsForRange(t.db, EQUA_TENANT_ID, FROM, TO, NOW, 0);
    expect(now.fleet).toEqual(legacy);
    expect(legacy.unexplained).toBeGreaterThan(0);
    expect(legacy.deviceOutages.length).toBeGreaterThan(1);
    const withCache = await exceptionsForRange(t.db, EQUA_TENANT_ID, FROM, TO, NOW, 0, { cache: params.cached(t.db) });
    expect(withCache).toEqual(now);
  });
});
