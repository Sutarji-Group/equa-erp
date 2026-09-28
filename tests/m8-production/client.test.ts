import { describe, expect, it } from "vitest";

import {
  fillableTrips,
  formatLiter,
  formatPct,
  isLateReading,
  itemSyncText,
  M8_COMMANDS,
  meterReadingProblem,
  readingLimits,
  sortTrucksForSource,
  suggestedPhase,
  volumeNeedsReason,
  wibClock,
  type M8MeterRef,
  type M8Today,
  type M8TruckRef,
} from "@/client/m8-production/contract";
import { applyM8Command, nextSuggestedTrip } from "@/client/m8-production/optimistic";

const RULES = { morningDeadline: "08:00", eveningDeadline: "23:00" };

function meter(over: Partial<M8MeterRef> = {}): M8MeterRef {
  return {
    id: "m1",
    code: "MTR-SA1",
    name: null,
    initialReadingL: 1_000_000,
    last: null,
    previousDayL: 1_000_000,
    today: { morning: null, evening: null },
    rollover: null,
    ...over,
  };
}

function trip(id: string, over: Partial<M8TruckRef["trips"][number]> = {}): M8TruckRef["trips"][number] {
  return { id, number: `R-${id}`, customerName: "Pelanggan", isInternal: false, destinationName: null, routeOrder: 1, status: "assigned", plannedVolumeL: 5_000, filled: false, ...over };
}

function truck(over: Partial<M8TruckRef> = {}): M8TruckRef {
  return { id: "t1", code: "T1", plateNumber: "F 1 AA", capacityL: 6_000, planned: true, plannedSourceName: null, nextTripId: "a", trips: [trip("a", { routeOrder: 1 }), trip("b", { routeOrder: 2 })], carriedWater: null, filledTodayL: 0, ...over };
}

function today(over: Partial<M8Today> = {}): M8Today {
  return {
    date: "2026-09-21",
    generatedAt: "2026-09-20T22:00:00.000Z",
    source: { id: "s1", code: "SA1", name: "Sumber A", dailyCapacityL: 50_000 },
    blockedReason: null,
    rules: { standardVolumeL: 5_000, maxPhotoKb: 300, morningDeadline: "08:00", eveningDeadline: "23:00", lossMaxPct: 5, supplyTolerancePct: 2 },
    meters: [meter()],
    production: { today: null, yesterday: null },
    trucks: [truck(), truck({ id: "t2", code: "T2", planned: false, nextTripId: null, trips: [] })],
    fills: [],
    tankLevels: [],
    investigations: [
      { waterBalanceId: "wb1", businessDate: "2026-09-20", producedL: 20_000, filledTotalL: 18_000, lossL: 2_000, lossPct: 10, status: "over_threshold", reason: null, note: null, reviewNote: null },
    ],
    lastBalance: null,
    quality: { schedules: [], recent: [], employees: [] },
    history: [],
    ...over,
  };
}

const item = (deviceTime: string, businessDate = "2026-09-21") => ({ id: "cmd", userId: "u1", deviceTime, businessDate });

describe("M8 — aturan & tampilan aplikasi operator (murni, perangkat = server)", () => {
  it("US-M8-01 KP-2 angka lebih kecil dari pembacaan sebelumnya ditolak di ponsel dengan pesan tindakan (kecuali putaran tercatat)", () => {
    expect(meterReadingProblem({ value: 999_999, previousL: 1_000_000, rolloverPending: false, meterCode: "MTR-SA1" })).toMatch(/lebih kecil dari pembacaan sebelumnya.*admin sistem/);
    expect(meterReadingProblem({ value: 5, previousL: 1_000_000, rolloverPending: true, meterCode: "MTR-SA1" })).toBeNull();
    expect(meterReadingProblem({ value: 1_000_500, previousL: 1_000_000, nextL: 1_000_400, rolloverPending: false, meterCode: "MTR-SA1" })).toMatch(/Angka pagi tidak boleh lebih besar/);
    expect(meterReadingProblem({ value: 10.5, previousL: 0, rolloverPending: false, meterCode: "X" })).toMatch(/liter bulat/);
    // Batas per fase: pagi ≥ angka sebelum hari ini & ≤ malam; malam ≥ pagi hari ini.
    const m = meter({ today: { morning: { id: "r1", readingL: 1_000_100, readAt: "", status: "recorded" }, evening: { id: "r2", readingL: 1_010_000, readAt: "", status: "recorded" } } });
    expect(readingLimits(m, "morning")).toEqual({ previousL: 1_000_000, nextL: 1_010_000 });
    expect(readingLimits(m, "evening")).toEqual({ previousL: 1_000_100, nextL: null });
    expect(readingLimits(meter(), "evening")).toEqual({ previousL: 1_000_000, nextL: null });
  });

  it("US-M8-01 KP-3 pembacaan setelah jam batas (08.00 pagi / 23.00 malam, WIB) wajib alasan; fase disarankan otomatis", () => {
    expect(isLateReading("morning", "2026-09-21T00:59:00Z", RULES)).toBe(false); // 07.59 WIB
    expect(isLateReading("morning", "2026-09-21T01:01:00Z", RULES)).toBe(true); // 08.01 WIB
    expect(isLateReading("evening", "2026-09-21T15:59:00Z", RULES)).toBe(false); // 22.59 WIB
    expect(isLateReading("evening", "2026-09-21T16:30:00Z", RULES)).toBe(true); // 23.30 WIB
    expect(wibClock("2026-09-21T16:30:00Z")).toBe("23:30");
    expect(suggestedPhase(meter())).toBe("morning");
    expect(suggestedPhase(meter({ today: { morning: { id: "r", readingL: 1, readAt: "", status: "recorded" }, evening: null } }))).toBe("evening");
  });

  it("US-M8-02 KP-1 truk terjadwal tampil pertama; rit yang boleh dituju = belum diisi & belum Selesai/Gagal; volume ≠ PAR-15 wajib alasan", () => {
    const list = sortTrucksForSource([truck({ id: "x", code: "T9", planned: false }), truck({ id: "y", code: "T3", planned: true }), truck({ id: "z", code: "T1", planned: false })]);
    expect(list.map((t) => t.code)).toEqual(["T3", "T1", "T9"]);
    const t = truck({ trips: [trip("a", { filled: true }), trip("b", { status: "completed" }), trip("c", { status: "departed" }), trip("d")] });
    expect(fillableTrips(t).map((x) => x.id)).toEqual(["c", "d"]);
    expect(nextSuggestedTrip(t)).toBe("d"); // rit berikutnya yang belum Berangkat & belum diisi
    expect(volumeNeedsReason(5_000, 5_000)).toBe(false);
    expect(volumeNeedsReason(3_000, 5_000)).toBe(true);
    expect(formatLiter(5_000)).toBe("5.000 L");
    expect(formatPct(5.25)).toBe("5,3%");
  });

  it("US-M8-07 KP-2 data yang masih di antrean tampil 'tersimpan di ponsel' dan layar diperbarui optimistis (meter, isi truk, tandon, investigasi, uji mutu)", () => {
    expect(itemSyncText(true)).toBe("Tersimpan di ponsel");
    expect(itemSyncText(false)).toBe("Terkirim");
    let d = today();
    d = applyM8Command(d, M8_COMMANDS.meterReading, { readingId: "r1", waterMeterId: "m1", phase: "morning", readingL: 1_000_050 }, item("2026-09-21T00:10:00Z"));
    expect(d.meters[0]!.today.morning).toMatchObject({ id: "r1", readingL: 1_000_050, local: true });
    // Pembacaan kedua fase yang sama tidak menimpa (server menolak ubah — SOD-05).
    const again = applyM8Command(d, M8_COMMANDS.meterReading, { readingId: "r9", waterMeterId: "m1", phase: "morning", readingL: 1_000_900 }, item("2026-09-21T00:20:00Z"));
    expect(again.meters[0]!.today.morning!.id).toBe("r1");
    // Pengisian ke rit disarankan → rit terisi, rit berikutnya disarankan, total liter truk bertambah.
    d = applyM8Command(d, M8_COMMANDS.truckFill, { fillId: "f1", truckId: "t1", tripId: "a", volumeL: 5_000 }, item("2026-09-21T01:30:00Z"));
    const t1 = d.trucks.find((t) => t.id === "t1")!;
    expect(t1).toMatchObject({ nextTripId: "b", filledTodayL: 5_000 });
    expect(t1.trips.find((x) => x.id === "a")!.filled).toBe(true);
    expect(d.fills[0]).toMatchObject({ id: "f1", tripId: "a", status: "linked", local: true });
    // Rit yang sudah diisi → dicatat tanpa rit (server menandai konflik).
    d = applyM8Command(d, M8_COMMANDS.truckFill, { fillId: "f2", truckId: "t1", tripId: "a", volumeL: 2_000, volumeReason: "Sisa muatan" }, item("2026-09-21T02:00:00Z"));
    expect(d.fills[0]).toMatchObject({ id: "f2", tripId: null, status: "unlinked" });
    // Truk di luar rencana ditandai.
    d = applyM8Command(d, M8_COMMANDS.truckFill, { fillId: "f3", truckId: "t2", tripId: null, volumeL: 5_000, unplannedConfirmed: true }, item("2026-09-21T03:00:00Z"));
    expect(d.fills[0]).toMatchObject({ id: "f3", unplannedTruck: true });
    // Idempoten: perintah yang sama diterapkan ulang tidak menggandakan.
    expect(applyM8Command(d, M8_COMMANDS.truckFill, { fillId: "f3", truckId: "t2", tripId: null, volumeL: 5_000 }, item("2026-09-21T03:00:00Z")).fills).toHaveLength(3);
    d = applyM8Command(d, M8_COMMANDS.tankLevel, { tankLevelId: "tk1", levelPct: 60 }, item("2026-09-21T05:00:00Z"));
    expect(d.tankLevels[0]).toMatchObject({ id: "tk1", levelPct: 60, local: true });
    d = applyM8Command(d, M8_COMMANDS.lossInvestigation, { waterBalanceId: "wb1", reason: "leakage", note: "Pipa bocor" }, item("2026-09-21T06:00:00Z"));
    expect(d.investigations[0]).toMatchObject({ status: "investigating", reason: "leakage", local: true });
    d = applyM8Command(d, M8_COMMANDS.qualityTest, { qualityTestId: "q1", testDate: "2026-09-20", laboratory: "Labkesda", results: [], passed: true }, item("2026-09-21T07:00:00Z"));
    expect(d.quality.recent[0]).toMatchObject({ id: "q1", passed: true, local: true });
    // Perintah hari lain tidak mengubah data hari ini.
    expect(applyM8Command(today(), M8_COMMANDS.truckFill, { fillId: "old", truckId: "t1", tripId: "a", volumeL: 5_000 }, item("2026-09-20T03:00:00Z", "2026-09-20")).fills).toHaveLength(0);
    // Ponsel tanpa sumber (terkunci) → tidak berubah.
    const blocked = today({ source: null });
    expect(applyM8Command(blocked, M8_COMMANDS.tankLevel, { tankLevelId: "x", levelPct: 1 }, item("2026-09-21T05:00:00Z"))).toBe(blocked);
  });
});
