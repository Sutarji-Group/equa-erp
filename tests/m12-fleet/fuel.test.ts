import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { customerAddresses, fuelEstimates, notifications, tripExpenses, tripTracks, trips } from "@/db/schema";
import { EQUA_TENANT_ID, tariffZoneId, userIdByUsername } from "@/db/seed";
import type { LatLng } from "@/lib/geo";
import { addDays, monthOf, toBusinessDate, wibToUtc } from "@/lib/time";
import { ForbiddenError } from "@/server/core/errors";
import { exportReport } from "@/server/core/export";
import * as params from "@/server/core/params";
import { fuelMonthly, runDailySummaries, runZoneCheckMonthly, zoneCheck } from "@/server/modules/m12-fleet";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { createCustomer, createOrder, createScheduledTrip } from "../helpers/fixtures";
import { chain, drive, dwell, feed, gpsTruck, NOWHERE, SA1, type GpsTruck } from "./helpers";

type Db = ReturnType<typeof useTestDb>["db"];

const owner = () => seededContext("pemilik");

/** Rit Selesai pada tanggal `date` (alamat pelanggan `customer`), Berangkat/Selesai pada jam WIB tertentu. */
async function completedTrip(db: Db, g: GpsTruck, input: { date: string; customer: { id: string; addressId: string | null }; departed: string; completed: string; from?: LatLng; to?: LatLng }) {
  const order = await createOrder(db, { customerId: input.customer.id, addressId: input.customer.addressId!, date: input.date });
  const trip = await createScheduledTrip(db, { order, truckId: g.truckId, date: input.date });
  await db
    .update(trips)
    .set({
      status: "completed",
      publishedAt: wibToUtc(input.date, "05:00"),
      departedAt: wibToUtc(input.date, input.departed),
      departedLat: input.from?.lat ?? null,
      departedLng: input.from?.lng ?? null,
      completedAt: wibToUtc(input.date, input.completed),
      completedLat: input.to?.lat ?? null,
      completedLng: input.to?.lng ?? null,
      completionBusinessDate: input.date,
      driverUserId: userIdByUsername("sopir4"),
    })
    .where(eq(trips.id, trip.id));
  return trip;
}

describe("M12 — jarak rit untuk biaya BBM & pemeriksaan zona (US-M12-07)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M12-07 KP-1 jarak rit × konsumsi BBM × harga BBM (PAR-53 ditetapkan pemilik) = estimasi biaya per rit; dibanding bulanan dengan BBM nyata, selisih ditampilkan tanpa penyesuaian otomatis", async () => {
    const today = toBusinessDate(new Date());
    const before = addDays(today, 1);
    const effective = addDays(today, 2);
    const g = await gpsTruck(t.db);
    const cust = await createCustomer(t.db, { lat: NOWHERE.lat, lng: NOWHERE.lng });

    // Sebelum PAR-53 ditetapkan: jarak dihitung, estimasi BBM tidak dibuat.
    await feed(t.db, chain([(s) => dwell(g.deviceCode, SA1, s, 2), (s) => drive(g.deviceCode, SA1, NOWHERE, s, { speedKmh: 40 }), (s) => dwell(g.deviceCode, NOWHERE, s, 5)], wibToUtc(before, "08:00")));
    const early = await completedTrip(t.db, g, { date: before, customer: cust, departed: "08:02", completed: "08:25" });
    await runDailySummaries(wibToUtc(addDays(before, 1), "00:40"), t.db, { date: before });
    expect((await t.db.select().from(tripTracks).where(eq(tripTracks.tripId, early.id)))[0]!.distanceM!).toBeGreaterThan(9_000);
    expect(await t.db.select().from(fuelEstimates).where(eq(fuelEstimates.tripId, early.id))).toHaveLength(0);

    // Hanya pemilik yang menetapkan PAR-53 (tanggal berlaku, berjejak).
    const value = { consumption_l_per_km: 0.25, fuel_price_per_l: 6_800, configured: true };
    await expect(params.set(seededContext("dispatcher1"), "PAR-53", value, effective, "Uji")).rejects.toBeInstanceOf(ForbiddenError);
    await params.set(owner(), "PAR-53", value, effective, "Konsumsi truk tangki 4 km/L, harga solar industri");

    await feed(t.db, chain([(s) => dwell(g.deviceCode, SA1, s, 2), (s) => drive(g.deviceCode, SA1, NOWHERE, s, { speedKmh: 40 }), (s) => dwell(g.deviceCode, NOWHERE, s, 5)], wibToUtc(effective, "08:00")));
    const trip = await completedTrip(t.db, g, { date: effective, customer: cust, departed: "08:02", completed: "08:25" });
    await runDailySummaries(wibToUtc(addDays(effective, 1), "00:40"), t.db, { date: effective });
    const [est] = await t.db.select().from(fuelEstimates).where(eq(fuelEstimates.tripId, trip.id));
    expect(est).toMatchObject({ truckId: g.truckId, businessDate: effective, consumptionLPerKm: 0.25, fuelPricePerL: 6_800 });
    expect(est!.estimatedCost).toBe(Math.round((est!.distanceM / 1000) * 0.25 * 6_800));
    expect(est!.distanceM).toBeGreaterThan(9_000);

    // BBM nyata (pengeluaran rit M3 jenis BBM): ditolak & yang dikoreksi (dibalik) tidak dihitung.
    const expense = (amount: number, over: Partial<typeof tripExpenses.$inferInsert> = {}) =>
      t.db
        .insert(tripExpenses)
        .values({ tenantId: EQUA_TENANT_ID, truckId: g.truckId, tripId: trip.id, businessDate: effective, kind: "fuel", amount, fundingSource: "cash_on_hand", status: "accepted", ...over })
        .returning();
    await expense(25_000);
    await expense(99_000, { status: "rejected" });
    const [wrong] = await expense(40_000);
    await expense(40_000, { reversalOfId: wrong!.id, reversalReason: "Salah ketik nominal" });
    const month = await fuelMonthly(seededContext("keuangan1", { now: wibToUtc(effective, "20:00") }), { month: monthOf(effective) });
    expect(month).toMatchObject({ configured: true, consumptionLPerKm: 0.25, pricePerL: 6_800 });
    const row = month.byTruck.find((r) => r.truckId === g.truckId)!;
    expect(row).toMatchObject({ trips: 1, estimatedCost: est!.estimatedCost, actualFuel: 25_000, difference: 25_000 - est!.estimatedCost });
    // Selisih hanya ditampilkan: estimasi tetap.
    expect((await t.db.select().from(fuelEstimates).where(eq(fuelEstimates.tripId, trip.id)))[0]!.estimatedCost).toBe(est!.estimatedCost);
    await expect(fuelMonthly(seededContext("dispatcher1"), { month: monthOf(effective) })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("US-M12-07 KP-2 pemeriksaan zona: rata-rata jarak GPS 3 rit terakhir vs batas zona → alamat yang masuk zona lain tampil ke pemilik dengan selisih tarif; zona alamat tidak berubah otomatis", async () => {
    const g = await gpsTruck(t.db);
    const cust = await createCustomer(t.db, { lat: NOWHERE.lat, lng: NOWHERE.lng, zoneId: tariffZoneId("Z1") });
    const date = "2026-09-21";
    const distances = [20_000, 7_200, 7_400, 7_600]; // rit tertua tidak ikut (3 rit terakhir)
    for (const [i, d] of distances.entries()) {
      const trip = await completedTrip(t.db, g, { date, customer: cust, departed: `0${6 + i}:00`, completed: `0${6 + i}:40` });
      await t.db.insert(tripTracks).values({ tripId: trip.id, truckId: g.truckId, distanceM: d, durationS: 2_400, isEstimated: false, computedAt: new Date() });
    }
    const res = await zoneCheck(owner());
    expect(res.tripCount).toBe(3);
    const row = res.rows.find((r) => r.addressId === cust.addressId)!;
    expect(row).toMatchObject({ currentZoneCode: "Z1", actualZoneCode: "Z2", avgGpsDistanceM: 7_400, tripsUsed: 3 });
    expect(row.tariffDifference).toBe(row.actualTariff! - row.currentTariff!);
    expect(row.tariffDifference!).toBeGreaterThan(0);
    await expect(zoneCheck(seededContext("dispatcher1"))).rejects.toBeInstanceOf(ForbiddenError);

    // Job bulanan memberi tahu pemilik sekali per bulan; zona alamat tetap (perubahan hanya lewat US-M1-05).
    const now = wibToUtc("2026-10-01", "07:10");
    await runZoneCheckMonthly(now, t.db);
    await runZoneCheckMonthly(new Date(now.getTime() + 60_000), t.db);
    const notes = await t.db.select().from(notifications).where(and(eq(notifications.event, "fleet.zone_mismatch"), eq(notifications.recipientUserId, userIdByUsername("pemilik"))));
    expect(notes).toHaveLength(1);
    const [addr] = await t.db.select().from(customerAddresses).where(eq(customerAddresses.id, cust.addressId!));
    expect(addr!.tariffZoneId).toBe(tariffZoneId("Z1"));
  });

  it("US-M12-07 KP-3 laporan bulanan biaya BBM per rit, per truk, dan per zona (ekspor untuk M9)", async () => {
    const today = toBusinessDate(new Date());
    const effective = addDays(today, 2);
    const ctx = seededContext("pemilik", { now: wibToUtc(effective, "21:00") });
    const month = await fuelMonthly(ctx, { month: monthOf(effective) });
    expect(month.trips.length).toBeGreaterThanOrEqual(1);
    expect(month.byZone.length).toBeGreaterThanOrEqual(1);
    expect(month.totals.estimatedCost).toBe(month.byTruck.reduce((s, r) => s + r.estimatedCost, 0));
    const perTrip = await exportReport(ctx, "m12.fuel_monthly", "xlsx", { month: monthOf(effective) });
    expect(perTrip.rowCount).toBe(month.trips.length);
    const perTruck = await exportReport(ctx, "m12.fuel_trucks", "pdf", { month: monthOf(effective) });
    expect(perTruck.contentType).toContain("pdf");
    const perZone = await exportReport(ctx, "m12.fuel_zones", "xlsx", { month: monthOf(effective) });
    expect(perZone.rowCount).toBe(month.byZone.length);
  });
});
