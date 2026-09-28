/**
 * M8 — pembaruan OPTIMISTIS data `m8.today` di ponsel operator produksi (reducer murni `applyM8Command` dapat diuji
 * tanpa IndexedDB; pendaftaran hanya di peramban). Perintah yang masih di antrean diterapkan ulang di atas hasil pull
 * terakhir sehingga layar selalu menampilkan keadaan terbaru walau tanpa sinyal (US-M8-07 KP-1/KP-2): pembacaan meter
 * pagi/malam, pengisian truk (rit terisi, rit berikutnya disarankan, total liter truk), level tandon, penjelasan susut
 * yang sudah dikirim, dan hasil uji mutu.
 */
import { registerOptimistic, type OutboxItem } from "@/client/offline";

import {
  M8_COMMANDS,
  M8_REFS,
  type LossInvestigationPayload,
  type M8Today,
  type M8TruckRef,
  type MeterReadingPayload,
  type QualityTestPayload,
  type TankLevelPayload,
  type TruckFillPayload,
} from "./contract";

type ItemMeta = Pick<OutboxItem, "userId" | "deviceTime" | "businessDate" | "id">;

/** Rit berikutnya yang disarankan (cermin server): rit truk urutan rute yang belum Berangkat dan belum diisi. */
export function nextSuggestedTrip(truck: Pick<M8TruckRef, "trips">): string | null {
  return truck.trips.find((t) => t.status === "assigned" && !t.filled)?.id ?? null;
}

function applyReading(data: M8Today, p: MeterReadingPayload, item: ItemMeta): M8Today {
  if (item.businessDate !== data.date) return data;
  return {
    ...data,
    meters: data.meters.map((m) => {
      if (m.id !== p.waterMeterId) return m;
      if (m.today[p.phase]) return m; // sudah tercatat → server menolak ubah (SOD-05)
      const below = p.readingL < (p.phase === "morning" ? m.previousDayL : (m.today.morning?.readingL ?? m.previousDayL));
      return {
        ...m,
        today: { ...m.today, [p.phase]: { id: p.readingId, readingL: p.readingL, readAt: item.deviceTime, status: "recorded", lateReason: p.lateReason ?? null, local: true } },
        last: { businessDate: item.businessDate, phase: p.phase, readingL: p.readingL, readAt: item.deviceTime },
        rollover: below ? null : m.rollover,
      };
    }),
  };
}

function applyFill(data: M8Today, p: TruckFillPayload, item: ItemMeta): M8Today {
  if (item.businessDate !== data.date || data.fills.some((f) => f.id === p.fillId)) return data;
  const truck = data.trucks.find((t) => t.id === p.truckId);
  const trip = truck?.trips.find((t) => t.id === p.tripId) ?? null;
  // Satu pengisian satu rit (PTB-09): rit yang sudah terisi → server mencatat pengisian tanpa rit + konflik.
  const linked = trip && !trip.filled ? trip : null;
  const fill = {
    id: p.fillId,
    truckId: p.truckId,
    truckCode: truck?.code ?? "—",
    tripId: linked?.id ?? null,
    tripNumber: linked?.number ?? null,
    volumeL: p.volumeL,
    volumeReason: p.volumeReason ?? null,
    filledAt: item.deviceTime,
    status: linked ? "linked" : "unlinked",
    isDepotSupply: !!linked?.isInternal,
    unplannedTruck: !!truck && !truck.planned,
    reversed: false,
    local: true,
  };
  return {
    ...data,
    fills: [fill, ...data.fills],
    trucks: data.trucks.map((t) => {
      if (t.id !== p.truckId) return t;
      const trips = t.trips.map((x) => (linked && x.id === linked.id ? { ...x, filled: true } : x));
      const next = { ...t, trips, filledTodayL: t.filledTodayL + p.volumeL, carriedWater: null };
      return { ...next, nextTripId: nextSuggestedTrip(next) };
    }),
  };
}

function applyTank(data: M8Today, p: TankLevelPayload, item: ItemMeta): M8Today {
  if (item.businessDate !== data.date || data.tankLevels.some((t) => t.id === p.tankLevelId)) return data;
  return { ...data, tankLevels: [{ id: p.tankLevelId, levelL: p.levelL ?? null, levelPct: p.levelPct ?? null, readAt: item.deviceTime, local: true }, ...data.tankLevels] };
}

function applyInvestigation(data: M8Today, p: LossInvestigationPayload): M8Today {
  return {
    ...data,
    investigations: data.investigations.map((i) => (i.waterBalanceId === p.waterBalanceId ? { ...i, status: "investigating", reason: p.reason, note: p.note, reviewNote: null, local: true } : i)),
  };
}

function applyQuality(data: M8Today, p: QualityTestPayload): M8Today {
  if (data.quality.recent.some((q) => q.id === p.qualityTestId)) return data;
  return { ...data, quality: { ...data.quality, recent: [{ id: p.qualityTestId, testDate: p.testDate, laboratory: p.laboratory, passed: p.passed, local: true }, ...data.quality.recent] } };
}

/** Terapkan satu perintah M8 ke `m8.today` (murni). Perintah yang tidak dikenal dikembalikan apa adanya. */
export function applyM8Command(data: M8Today, type: string, payload: unknown, item: ItemMeta): M8Today {
  if (!data.source) return data;
  switch (type) {
    case M8_COMMANDS.meterReading:
      return applyReading(data, payload as MeterReadingPayload, item);
    case M8_COMMANDS.truckFill:
      return applyFill(data, payload as TruckFillPayload, item);
    case M8_COMMANDS.tankLevel:
      return applyTank(data, payload as TankLevelPayload, item);
    case M8_COMMANDS.lossInvestigation:
      return applyInvestigation(data, payload as LossInvestigationPayload);
    case M8_COMMANDS.qualityTest:
      return applyQuality(data, payload as QualityTestPayload);
    default:
      return data;
  }
}

let registered = false;

/** Daftarkan reducer optimistis M8 (sekali per halaman). */
export function registerM8Optimistic(): void {
  if (registered) return;
  registered = true;
  for (const type of Object.values(M8_COMMANDS)) {
    registerOptimistic<M8Today | null, unknown>(type, {
      refKey: M8_REFS.today,
      apply: (data, payload, item) => (data ? applyM8Command(data, type, payload, item) : data),
    });
  }
}
