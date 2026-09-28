/**
 * M8 — jumlah pengisian per sumber per hari (dasar neraca air US-M8-04 & utilisasi US-M8-05).
 *
 * Pengisian dihitung BERSIH: baris pembalik Admin Keuangan (volume negatif) ikut dijumlahkan; air rit gagal yang
 * dikembalikan ke sumber (US-M3-06 KP-2, `loaded_water_disposition = returned_to_source`) dikurangkan karena kembali ke
 * tandon. Pasokan depot (rit internal) dipisah dari pengisian pelanggan (US-M8-04 KP-4).
 */
import "server-only";

import { and, eq, gte, inArray, lte } from "drizzle-orm";

import { trips, truckFills } from "@/db/schema";
import type { BusinessDate } from "@/lib/time";

import type { Tx } from "@/server/core/db";

export type FillTotals = {
  /** Pengisian pelanggan bersih (setelah pembalik & air kembali). */
  customerL: number;
  /** Pasokan depot bersih. */
  depotL: number;
  /** Air rit gagal yang dikembalikan ke sumber (sudah dikurangkan dari dua angka di atas). */
  returnedL: number;
  totalL: number;
  /** Jumlah pengisian hidup (tidak termasuk pembalik & yang dibalik). */
  count: number;
  withoutTripCount: number;
};

export const EMPTY_TOTALS: FillTotals = { customerL: 0, depotL: 0, returnedL: 0, totalL: 0, count: 0, withoutTripCount: 0 };

/** Kunci peta `sourceId:YYYY-MM-DD`. */
export function dayKey(sourceId: string, date: BusinessDate): string {
  return `${sourceId}:${date}`;
}

/** Jumlah pengisian per (sumber, tanggal) pada rentang. */
export async function fillTotalsByDay(tx: Tx, sourceIds: readonly string[], from: BusinessDate, to: BusinessDate): Promise<Map<string, FillTotals>> {
  const out = new Map<string, FillTotals>();
  if (sourceIds.length === 0) return out;
  const rows = await tx
    .select({
      sourceId: truckFills.waterSourceId,
      date: truckFills.businessDate,
      volumeL: truckFills.volumeL,
      isDepotSupply: truckFills.isDepotSupply,
      tripId: truckFills.tripId,
      reversalOfId: truckFills.reversalOfId,
      reversedAt: truckFills.reversedAt,
      tripStatus: trips.status,
      disposition: trips.loadedWaterDisposition,
    })
    .from(truckFills)
    .leftJoin(trips, eq(trips.id, truckFills.tripId))
    .where(and(inArray(truckFills.waterSourceId, [...sourceIds]), gte(truckFills.businessDate, from), lte(truckFills.businessDate, to)));
  for (const r of rows) {
    const key = dayKey(r.sourceId, r.date);
    const t = out.get(key) ?? { ...EMPTY_TOTALS };
    if (r.isDepotSupply) t.depotL += r.volumeL;
    else t.customerL += r.volumeL;
    const live = !r.reversalOfId && !r.reversedAt;
    if (live) {
      t.count++;
      if (!r.tripId) t.withoutTripCount++;
      if (r.tripId && r.tripStatus === "failed" && r.disposition === "returned_to_source") {
        t.returnedL += r.volumeL;
        if (r.isDepotSupply) t.depotL -= r.volumeL;
        else t.customerL -= r.volumeL;
      }
    }
    t.totalL = t.customerL + t.depotL;
    out.set(key, t);
  }
  return out;
}

/** Jumlah pengisian satu sumber satu hari. */
export async function fillTotalsOf(tx: Tx, sourceId: string, date: BusinessDate): Promise<FillTotals> {
  return (await fillTotalsByDay(tx, [sourceId], date, date)).get(dayKey(sourceId, date)) ?? { ...EMPTY_TOTALS };
}
