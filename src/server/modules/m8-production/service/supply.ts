/**
 * M8 — pasokan air ke depot sendiri (US-M8-03; PTB-01, BR-33, K20, FR-M6-05).
 *
 * Rit internal mengalir: pengisian di sumber (M8) → Selesai di depot dengan volume diserahkan (M3) → konfirmasi volume
 * diterima operator depot (M6). M8 menampilkan TIGA angka per pasokan (diisi, diserahkan, diterima); selisih diisi vs
 * diterima di luar toleransi PAR-69 → ditandai ke Dispatcher & pemilik dan masuk perhitungan susut (neraca air).
 * Nilai pasokan = volume diterima × harga transfer (tarif zona alamat depot, segmen depot pihak ketiga — sama dengan
 * `transferValueFor` M6 yang dipakai jurnal M11). Ringkasan per depot per hari/bulan (liter, jumlah rit).
 */
import "server-only";

import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";

import { outlets, trips, truckFills, trucks, waterSources, waterSupplyReceipts } from "@/db/schema";
import { monthOf, type BusinessDate } from "@/lib/time";

import type { ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { authorize } from "@/server/core/rbac";
import { transferValueFor } from "@/server/modules/m6-pos";

import { liter, m8Rules, notifyOnce, pct2 } from "./common";

export type SupplyRow = {
  tripId: string;
  tripNumber: string;
  tripStatus: string;
  businessDate: BusinessDate;
  outletId: string;
  outletCode: string;
  outletName: string;
  truckCode: string | null;
  sourceId: string | null;
  sourceName: string | null;
  fillId: string | null;
  /** Diisi di sumber (M8). */
  filledL: number | null;
  /** Diserahkan menurut sopir (M3). */
  deliveredL: number | null;
  /** Diterima menurut operator depot (M6). */
  receivedL: number | null;
  receiptStatus: string | null;
  /** Diisi − diterima (liter; positif = hilang di jalan). */
  differenceL: number | null;
  differencePct: number | null;
  outOfTolerance: boolean;
  /** Nilai transfer internal = diterima × harga transfer (BR-33, K20). */
  transferValue: number | null;
  /** Penerimaan pasokan depot (M6) — sumber jurnal `water_supply.confirmed` (tautan "Lihat jurnal", B-55). */
  receiptId?: string | null;
};

type SupplyQuery = { from: BusinessDate; to: BusinessDate; outletId?: string | null; tripIds?: readonly string[] };

/** Baris pasokan (rit internal ke depot) pada rentang tanggal rit. */
export async function supplyRows(tx: Tx, tenantId: string, q: SupplyQuery): Promise<SupplyRow[]> {
  const rows = await tx
    .select({
      trip: trips,
      outletCode: outlets.code,
      outletName: outlets.name,
      outlet: outlets,
      truckCode: trucks.code,
    })
    .from(trips)
    .innerJoin(outlets, eq(outlets.id, trips.destinationOutletId))
    .leftJoin(trucks, eq(trucks.id, trips.truckId))
    .where(
      and(
        eq(trips.tenantId, tenantId),
        eq(trips.isInternal, true),
        isNull(trips.withdrawnAt),
        ...(q.tripIds ? [inArray(trips.id, [...q.tripIds])] : [gte(trips.scheduledDate, q.from), lte(trips.scheduledDate, q.to)]),
        ...(q.outletId ? [eq(trips.destinationOutletId, q.outletId)] : []),
      ),
    )
    .orderBy(asc(trips.scheduledDate), asc(outlets.code), asc(trips.number));
  if (rows.length === 0) return [];
  const tripIds = rows.map((r) => r.trip.id);
  const fills = await tx
    .select({ fill: truckFills, sourceName: waterSources.name })
    .from(truckFills)
    .innerJoin(waterSources, eq(waterSources.id, truckFills.waterSourceId))
    .where(and(inArray(truckFills.tripId, tripIds), isNull(truckFills.reversalOfId), isNull(truckFills.reversedAt)));
  const receipts = await tx
    .select()
    .from(waterSupplyReceipts)
    .where(and(inArray(waterSupplyReceipts.tripId, tripIds), isNull(waterSupplyReceipts.reversalOfId), isNull(waterSupplyReceipts.reversedAt)));
  const rules = await m8Rules(tx, q.to, tenantId);
  const out: SupplyRow[] = [];
  for (const r of rows) {
    const f = fills.find((x) => x.fill.tripId === r.trip.id);
    const rc = receipts.find((x) => x.tripId === r.trip.id);
    const filledL = f?.fill.volumeL ?? null;
    const deliveredL = r.trip.deliveredVolumeL ?? rc?.deliveredVolumeL ?? null;
    const receivedL = rc && rc.status !== "arrived" ? rc.receivedVolumeL : null;
    const differenceL = filledL !== null && receivedL !== null ? filledL - receivedL : null;
    const differencePct = differenceL !== null && filledL ? pct2(Math.abs(differenceL), filledL) : null;
    const date = r.trip.completionBusinessDate ?? r.trip.scheduledDate;
    out.push({
      tripId: r.trip.id,
      tripNumber: r.trip.number,
      tripStatus: r.trip.status,
      businessDate: date,
      outletId: r.outlet.id,
      outletCode: r.outletCode,
      outletName: r.outletName,
      truckCode: r.truckCode,
      sourceId: f?.fill.waterSourceId ?? null,
      sourceName: f?.sourceName ?? null,
      fillId: f?.fill.id ?? null,
      filledL,
      deliveredL,
      receivedL,
      receiptStatus: rc?.status ?? null,
      differenceL,
      differencePct,
      outOfTolerance: differencePct !== null && differencePct > rules.supplyTolerancePct,
      transferValue: receivedL !== null ? await transferValueFor(tx, r.outlet, receivedL, date) : null,
      receiptId: rc?.id ?? null,
    });
  }
  return out;
}

/**
 * Evaluasi satu pasokan (dipanggil saat pengisian tercatat & saat depot mengonfirmasi): selisih diisi vs diterima di
 * luar PAR-69 → notifikasi Dispatcher & pemilik SEKALI per rit (US-M8-03 KP-2).
 */
export async function evaluateSupply(tx: Tx, ctx: ActorContext, tripId: string): Promise<SupplyRow | null> {
  const [trip] = await tx.select({ tenantId: trips.tenantId, date: trips.scheduledDate }).from(trips).where(eq(trips.id, tripId)).limit(1);
  if (!trip) return null;
  const [row] = await supplyRows(tx, trip.tenantId, { from: trip.date, to: trip.date, tripIds: [tripId] });
  if (!row || !row.outOfTolerance) return row ?? null;
  const rules = await m8Rules(tx, row.businessDate, trip.tenantId);
  await notifyOnce(tx, {
    event: "production.supply_difference",
    tenantId: trip.tenantId,
    groupKey: `supply_difference:${tripId}`,
    title: `Selisih pasokan ${row.outletName} rit ${row.tripNumber}: ${row.differencePct}% (> ${rules.supplyTolerancePct}%)`,
    body: `Diisi ${liter(row.filledL)} di ${row.sourceName ?? "sumber"}, diserahkan ${liter(row.deliveredL)}, diterima ${liter(row.receivedL)}. Selisih masuk neraca air.`,
    objectType: "trip",
    objectId: tripId,
    valueText: liter(row.differenceL),
    link: `/produksi/pengisian?tab=pasokan&dari=${row.businessDate}&sampai=${row.businessDate}`,
    now: ctx.now,
  });
  return row;
}

export type SupplySummaryRow = {
  period: string;
  outletId: string;
  outletCode: string;
  outletName: string;
  trips: number;
  filledL: number;
  deliveredL: number;
  receivedL: number;
  differenceL: number;
  outOfToleranceCount: number;
  transferValue: number;
};

/** US-M8-03 KP-4: ringkasan pasokan per depot per hari (`day`) atau per bulan (`month`) — liter & jumlah rit. */
export function summarizeSupply(rows: readonly SupplyRow[], granularity: "day" | "month"): SupplySummaryRow[] {
  const groups = new Map<string, SupplySummaryRow>();
  for (const r of rows) {
    if (r.tripStatus !== "completed" && r.receivedL === null) continue;
    const period = granularity === "day" ? r.businessDate : monthOf(r.businessDate);
    const key = `${period}:${r.outletId}`;
    const g = groups.get(key) ?? {
      period,
      outletId: r.outletId,
      outletCode: r.outletCode,
      outletName: r.outletName,
      trips: 0,
      filledL: 0,
      deliveredL: 0,
      receivedL: 0,
      differenceL: 0,
      outOfToleranceCount: 0,
      transferValue: 0,
    };
    g.trips++;
    g.filledL += r.filledL ?? 0;
    g.deliveredL += r.deliveredL ?? 0;
    g.receivedL += r.receivedL ?? 0;
    g.differenceL += r.differenceL ?? 0;
    g.outOfToleranceCount += r.outOfTolerance ? 1 : 0;
    g.transferValue += r.transferValue ?? 0;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.period.localeCompare(b.period) || a.outletCode.localeCompare(b.outletCode));
}

/** Kantor: daftar pasokan depot (tiga angka + nilai transfer). */
export async function depotSupplyList(ctx: ActorContext, q: { from: BusinessDate; to: BusinessDate; outletId?: string | null }, opts: { tx?: Tx } = {}): Promise<SupplyRow[]> {
  await authorize(ctx, "m8.truck_fill.read", { tx: opts.tx });
  return supplyRows(opts.tx ?? getDb(), ctx.tenantId, q);
}

/** Kantor/M6/M9/P3: ringkasan pasokan per depot per hari/bulan (US-M8-03 KP-4). */
export async function depotSupplySummary(
  ctx: ActorContext,
  q: { from: BusinessDate; to: BusinessDate; outletId?: string | null; granularity: "day" | "month" },
  opts: { tx?: Tx } = {},
): Promise<SupplySummaryRow[]> {
  await authorize(ctx, "m8.truck_fill.read", { tx: opts.tx });
  return summarizeSupply(await supplyRows(opts.tx ?? getDb(), ctx.tenantId, q), q.granularity);
}

/** Jumlah selisih pasokan (diisi − diterima) per sumber & tanggal pengisian (masukan neraca bulanan). */
export async function supplyDifferenceBySourceDay(tx: Tx, tenantId: string, from: BusinessDate, to: BusinessDate): Promise<Map<string, number>> {
  const rows = await supplyRows(tx, tenantId, { from, to });
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!r.sourceId || r.differenceL === null) continue;
    const key = `${r.sourceId}:${r.businessDate}`;
    out.set(key, (out.get(key) ?? 0) + r.differenceL);
  }
  return out;
}
