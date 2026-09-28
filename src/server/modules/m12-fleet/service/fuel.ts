/**
 * M12 — estimasi biaya BBM per rit & pemeriksaan zona (US-M12-07, S, RL-6).
 *
 * - KP-1: jarak rit (US-M12-03) × konsumsi BBM standar per km × harga BBM per liter (PAR-53, ditetapkan pemilik) =
 *   estimasi biaya BBM per rit → `fuel_estimates` (informasi biaya rit lini L2 untuk M11; TIDAK dijurnal) dan dibanding
 *   bulanan dengan BBM nyata (pengeluaran rit M3 jenis BBM); selisih ditampilkan, tidak menyesuaikan otomatis.
 * - KP-2: pemeriksaan zona — rata-rata jarak GPS aktual N rit terakhir per alamat (`m12.fleet_rules.zone_check_trip_count`)
 *   dibanding batas zona (M1 `compareTripDistanceToZone`, US-M1-05 KP-6) dan jarak rute sumber acuan → alamat (M1);
 *   alamat yang masuk zona lain tampil ke pemilik dengan selisih tarifnya. Perubahan zona hanya lewat US-M1-05.
 * - KP-3: laporan bulanan biaya BBM per rit per truk & per zona (ekspor; masukan M9).
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";

import { customerAddresses, customers, fuelEstimates, tariffZones, tripExpenses, tripTracks, trips, trucks } from "@/db/schema";
import { formatRupiah } from "@/lib/money";
import { firstDayOfMonth, lastDayOfMonth, monthOf, toBusinessDate, type BusinessDate } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Db, type Tx } from "@/server/core/db";
import { parseInput } from "@/server/core/errors";
import { authorize } from "@/server/core/rbac";
import { compareTripDistanceToZone, getZoneTariff } from "@/server/modules/m1-master";

import { monthSchema } from "../schemas";
import { m12Rules, tenantsWithTrucks, type M12Rules, type TripRow } from "./common";
import { notifyOnce } from "./fleet-events";

export type FuelEstimateRow = typeof fuelEstimates.$inferSelect;

/** Hitung & simpan estimasi BBM satu rit (idempoten; dihitung ulang bila jarak berubah). Null bila PAR-53 belum ditetapkan. */
export async function upsertFuelEstimate(
  tx: Tx,
  input: { trip: TripRow; distanceM: number | null; now: Date; rules?: M12Rules },
): Promise<FuelEstimateRow | null> {
  const { trip, distanceM, now } = input;
  if (!trip.truckId || !distanceM || distanceM <= 0) return null;
  const date = trip.completionBusinessDate ?? trip.scheduledDate;
  const rules = input.rules ?? (await m12Rules(tx, date, trip.tenantId));
  const { consumptionLPerKm, pricePerL, configured } = rules.fuel;
  if (!configured || consumptionLPerKm === null || pricePerL === null) return null;
  const estimatedCost = Math.round((distanceM / 1000) * consumptionLPerKm * pricePerL);
  const values = { truckId: trip.truckId, businessDate: date, distanceM, consumptionLPerKm, fuelPricePerL: pricePerL, estimatedCost, computedAt: now, updatedAt: now };
  const existing = await tx.select({ id: fuelEstimates.id }).from(fuelEstimates).where(eq(fuelEstimates.tripId, trip.id)).limit(1);
  if (existing[0]) {
    const [row] = await tx.update(fuelEstimates).set(values).where(eq(fuelEstimates.id, existing[0].id)).returning();
    return row!;
  }
  const [row] = await tx.insert(fuelEstimates).values({ tripId: trip.id, ...values, createdAt: now }).onConflictDoNothing().returning();
  return row ?? null;
}

export type FuelTruckRow = {
  truckId: string;
  truckCode: string;
  trips: number;
  distanceM: number;
  liters: number;
  estimatedCost: number;
  actualFuel: number;
  difference: number;
};

export type FuelZoneRow = { zoneId: string | null; zoneCode: string; trips: number; distanceM: number; estimatedCost: number; avgCostPerTrip: number };

export type FuelTripRow = {
  tripId: string;
  number: string;
  date: BusinessDate;
  truckCode: string;
  customerName: string;
  zoneCode: string;
  distanceM: number;
  liters: number;
  estimatedCost: number;
};

export type FuelMonthly = {
  month: string;
  configured: boolean;
  consumptionLPerKm: number | null;
  pricePerL: number | null;
  byTruck: FuelTruckRow[];
  byZone: FuelZoneRow[];
  trips: FuelTripRow[];
  totals: { trips: number; distanceM: number; estimatedCost: number; actualFuel: number; difference: number };
};

/** Estimasi BBM bulanan per truk & per zona vs BBM nyata (US-M12-07 KP-1/KP-3). */
export async function fuelMonthly(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<FuelMonthly> {
  await authorize(ctx, "m12.fuel_estimate.read", { tx: opts.tx });
  const data = parseInput(monthSchema, input, { month: "Bulan" });
  const tx = opts.tx ?? getDb();
  const from = `${data.month}-01`;
  const to = lastDayOfMonth(from);
  const rules = await m12Rules(tx, to < ctxBusinessDate(ctx) ? to : ctxBusinessDate(ctx), ctx.tenantId);
  const rows = await tx
    .select({ e: fuelEstimates, number: trips.number, truckCode: trucks.code, customerName: customers.name, zoneId: customerAddresses.tariffZoneId, zoneCode: tariffZones.code })
    .from(fuelEstimates)
    .innerJoin(trips, eq(trips.id, fuelEstimates.tripId))
    .innerJoin(trucks, eq(trucks.id, fuelEstimates.truckId))
    .innerJoin(customers, eq(customers.id, trips.customerId))
    .innerJoin(customerAddresses, eq(customerAddresses.id, trips.addressId))
    .leftJoin(tariffZones, eq(tariffZones.id, customerAddresses.tariffZoneId))
    .where(and(eq(trips.tenantId, ctx.tenantId), gte(fuelEstimates.businessDate, from), lte(fuelEstimates.businessDate, to)))
    .orderBy(asc(fuelEstimates.businessDate), asc(trucks.code));
  const actual = await tx
    .select({ truckId: tripExpenses.truckId, amount: sql<number>`coalesce(sum(${tripExpenses.amount}), 0)::bigint` })
    .from(tripExpenses)
    .where(
      and(
        eq(tripExpenses.tenantId, ctx.tenantId),
        eq(tripExpenses.kind, "fuel"),
        ne(tripExpenses.status, "rejected"),
        gte(tripExpenses.businessDate, from),
        lte(tripExpenses.businessDate, to),
        // Koreksi M3 = baris pembalik (BR-38): baris pembalik & baris asal yang sudah dibalik tidak dihitung.
        isNull(tripExpenses.reversalOfId),
        sql`not exists (select 1 from ${tripExpenses} as r where r.reversal_of_id = ${tripExpenses.id})`,
      ),
    )
    .groupBy(tripExpenses.truckId);
  const actualByTruck = new Map(actual.map((a) => [a.truckId, Number(a.amount)]));
  const fleet = await tx.select({ id: trucks.id, code: trucks.code }).from(trucks).where(eq(trucks.tenantId, ctx.tenantId)).orderBy(asc(trucks.code));
  const byTruck: FuelTruckRow[] = [];
  for (const t of fleet) {
    const own = rows.filter((r) => r.e.truckId === t.id);
    const actualFuel = actualByTruck.get(t.id) ?? 0;
    if (own.length === 0 && actualFuel === 0) continue;
    const distanceM = own.reduce((s, r) => s + r.e.distanceM, 0);
    const estimatedCost = own.reduce((s, r) => s + r.e.estimatedCost, 0);
    byTruck.push({
      truckId: t.id,
      truckCode: t.code,
      trips: own.length,
      distanceM,
      liters: Math.round(own.reduce((s, r) => s + (r.e.distanceM / 1000) * r.e.consumptionLPerKm, 0)),
      estimatedCost,
      actualFuel,
      difference: actualFuel - estimatedCost,
    });
  }
  const zones = new Map<string, FuelZoneRow>();
  for (const r of rows) {
    const key = r.zoneId ?? "-";
    const z = zones.get(key) ?? { zoneId: r.zoneId, zoneCode: r.zoneCode ?? "Tanpa zona", trips: 0, distanceM: 0, estimatedCost: 0, avgCostPerTrip: 0 };
    z.trips++;
    z.distanceM += r.e.distanceM;
    z.estimatedCost += r.e.estimatedCost;
    z.avgCostPerTrip = Math.round(z.estimatedCost / z.trips);
    zones.set(key, z);
  }
  const totals = {
    trips: rows.length,
    distanceM: byTruck.reduce((s, r) => s + r.distanceM, 0),
    estimatedCost: byTruck.reduce((s, r) => s + r.estimatedCost, 0),
    actualFuel: byTruck.reduce((s, r) => s + r.actualFuel, 0),
    difference: 0,
  };
  totals.difference = totals.actualFuel - totals.estimatedCost;
  return {
    month: data.month,
    configured: rules.fuel.configured,
    consumptionLPerKm: rules.fuel.consumptionLPerKm,
    pricePerL: rules.fuel.pricePerL,
    byTruck,
    byZone: [...zones.values()].sort((a, b) => a.zoneCode.localeCompare(b.zoneCode)),
    trips: rows.map((r) => ({
      tripId: r.e.tripId,
      number: r.number,
      date: r.e.businessDate,
      truckCode: r.truckCode,
      customerName: r.customerName,
      zoneCode: r.zoneCode ?? "Tanpa zona",
      distanceM: r.e.distanceM,
      liters: Math.round((r.e.distanceM / 1000) * r.e.consumptionLPerKm * 10) / 10,
      estimatedCost: r.e.estimatedCost,
    })),
    totals,
  };
}

export type ZoneCheckRow = {
  addressId: string;
  customerId: string;
  customerName: string;
  addressLabel: string;
  addressText: string;
  segment: string;
  currentZoneId: string | null;
  currentZoneCode: string | null;
  /** Jarak rute sumber acuan → alamat (M1, US-M1-05). */
  routeDistanceM: number | null;
  routeMethod: string | null;
  /** Rata-rata jarak GPS aktual N rit terakhir. */
  avgGpsDistanceM: number;
  tripsUsed: number;
  actualZoneId: string | null;
  actualZoneCode: string | null;
  currentTariff: number | null;
  actualTariff: number | null;
  tariffDifference: number | null;
};

/** Pemeriksaan zona (US-M12-07 KP-2): alamat yang jarak GPS aktualnya masuk zona lain. Tidak mengubah zona. */
export async function zoneCheck(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<{ date: BusinessDate; tripCount: number; rows: ZoneCheckRow[] }> {
  await authorize(ctx, "m12.fuel_estimate.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  return zoneCheckRows(tx, ctx.tenantId, ctxBusinessDate(ctx));
}

export async function zoneCheckRows(tx: Tx, tenantId: string, date: BusinessDate): Promise<{ date: BusinessDate; tripCount: number; rows: ZoneCheckRow[] }> {
  const rules = await m12Rules(tx, date, tenantId);
  const n = rules.fleet.zone_check_trip_count;
  const candidates = await tx
    .select({ tripId: trips.id, addressId: trips.addressId, distanceM: tripTracks.distanceM, completedAt: trips.completedAt })
    .from(trips)
    .innerJoin(tripTracks, eq(tripTracks.tripId, trips.id))
    .where(and(eq(trips.tenantId, tenantId), eq(trips.status, "completed"), eq(trips.isInternal, false), isNotNull(tripTracks.distanceM), eq(tripTracks.isEstimated, false)))
    .orderBy(desc(trips.completedAt));
  const byAddress = new Map<string, number[]>();
  for (const c of candidates) {
    const list = byAddress.get(c.addressId) ?? [];
    if (list.length < n) list.push(c.distanceM!);
    byAddress.set(c.addressId, list);
  }
  const rows: ZoneCheckRow[] = [];
  const addressIds = [...byAddress.keys()];
  if (addressIds.length === 0) return { date, tripCount: n, rows };
  const addrRows = await tx
    .select({ a: customerAddresses, customerName: customers.name, segment: customers.segment, zoneCode: tariffZones.code })
    .from(customerAddresses)
    .innerJoin(customers, eq(customers.id, customerAddresses.customerId))
    .leftJoin(tariffZones, eq(tariffZones.id, customerAddresses.tariffZoneId))
    .where(and(inArray(customerAddresses.id, addressIds), eq(customers.tenantId, tenantId)));
  for (const r of addrRows) {
    const list = byAddress.get(r.a.id)!;
    const avg = Math.round(list.reduce((s, x) => s + x, 0) / list.length);
    const cmp = await compareTripDistanceToZone(tx, { addressId: r.a.id, actualDistanceM: avg, date });
    if (!cmp.deviates) continue;
    const cur = cmp.addressZoneId ? await getZoneTariff(tx, cmp.addressZoneId, r.segment, date) : null;
    const act = cmp.actualZoneId ? await getZoneTariff(tx, cmp.actualZoneId, r.segment, date) : null;
    rows.push({
      addressId: r.a.id,
      customerId: r.a.customerId,
      customerName: r.customerName,
      addressLabel: r.a.label,
      addressText: r.a.addressText,
      segment: r.segment,
      currentZoneId: cmp.addressZoneId,
      currentZoneCode: cmp.addressZoneCode ?? r.zoneCode,
      routeDistanceM: r.a.distanceM,
      routeMethod: r.a.distanceMethod,
      avgGpsDistanceM: avg,
      tripsUsed: list.length,
      actualZoneId: cmp.actualZoneId,
      actualZoneCode: cmp.actualZoneCode,
      currentTariff: cur?.pricePerTrip ?? null,
      actualTariff: act?.pricePerTrip ?? null,
      tariffDifference: cur && act ? act.pricePerTrip - cur.pricePerTrip : null,
    });
  }
  rows.sort((a, b) => Math.abs(b.tariffDifference ?? 0) - Math.abs(a.tariffDifference ?? 0) || a.customerName.localeCompare(b.customerName));
  return { date, tripCount: n, rows };
}

/** Job bulanan: daftar pemeriksaan zona ke pemilik (sekali per bulan per tenant). */
export async function runZoneCheckMonthly(now: Date, db?: Db): Promise<{ tenants: number; mismatches: number }> {
  const date = toBusinessDate(now);
  return withTx(
    async (tx) => {
      let mismatches = 0;
      const tenants = await tenantsWithTrucks(tx);
      for (const tenantId of tenants) {
        const res = await zoneCheckRows(tx, tenantId, date);
        mismatches += res.rows.length;
        if (res.rows.length === 0) continue;
        const gain = res.rows.reduce((s, r) => s + (r.tariffDifference ?? 0), 0);
        await notifyOnce(tx, {
          event: "fleet.zone_mismatch",
          tenantId,
          title: `${res.rows.length} alamat: jarak GPS masuk zona tarif lain`,
          body: `Rata-rata jarak GPS ${res.tripCount} rit terakhir berbeda zona dengan zona alamat. Selisih tarif per rit total ${formatRupiah(gain, { signed: true })}. Ubah zona hanya lewat Data master > Zona (persetujuan pemilik).`,
          objectType: "zone_check",
          objectId: monthOf(date),
          valueText: `${res.rows.length} alamat`,
          link: "/armada/bbm?tampil=zona",
          groupKey: `fleet.zone_mismatch:${tenantId}:${monthOf(date)}`,
          now,
        });
      }
      return { tenants: tenants.length, mismatches };
    },
    { db },
  );
}

/** Rentang bulan (tanggal pertama & terakhir) — pembantu layar. */
export function monthRange(month: string): { from: BusinessDate; to: BusinessDate } {
  const from = firstDayOfMonth(`${month}-01`);
  return { from, to: lastDayOfMonth(from) };
}
