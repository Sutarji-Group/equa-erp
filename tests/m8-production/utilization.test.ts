import { beforeAll, describe, expect, it } from "vitest";

import { userIdByUsername } from "@/db/seed";
import { addDays, daysBetween } from "@/lib/time";
import { exportReport } from "@/server/core/export";
import { computeUtilizationMonth, utilizationDaily, utilizationExportRange, utilizationFlags, utilizationMonthly } from "@/server/modules/m8-production";

import { EQUA_TENANT_ID } from "@/db/seed";
import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { dispatcher, finance, owner, productionWorld, seedFill } from "./helpers";

describe("M8 — utilisasi kapasitas & peringatan (US-M8-05)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M8-05 KP-1 utilisasi harian = Σ pengisian ÷ kapasitas harian; bulanan = rata-rata & hari > 90%; per sumber dan gabungan", async () => {
    const w = await productionWorld(t.db, { date: "2026-07-10", capacityL: 20_000 });
    const w2 = await productionWorld(t.db, { date: "2026-07-10", capacityL: 30_000 });
    await seedFill(t.db, { sourceId: w.source.id, truckId: w.truck.id, date: "2026-07-01", volumeL: 19_000 }); // 95%
    await seedFill(t.db, { sourceId: w.source.id, truckId: w.truck.id, date: "2026-07-02", volumeL: 10_000 }); // 50%
    await seedFill(t.db, { sourceId: w2.source.id, truckId: w2.truck.id, date: "2026-07-01", volumeL: 15_000 }); // 50%
    const days = await utilizationDaily(owner(), { from: "2026-07-01", to: "2026-07-02" });
    const d1 = days.find((d) => d.sourceId === w.source.id && d.businessDate === "2026-07-01")!;
    expect(d1).toMatchObject({ filledL: 19_000, capacityL: 20_000, utilizationPct: 95, high: true });
    expect(days.find((d) => d.sourceId === w.source.id && d.businessDate === "2026-07-02")).toMatchObject({ utilizationPct: 50, high: false });
    // Gabungan hari 1 (semua sumber aktif, termasuk seed SA1/SA2).
    const combined = days.find((d) => d.sourceId === null && d.businessDate === "2026-07-01")!;
    expect(combined.filledL).toBeGreaterThanOrEqual(34_000);
    expect(combined.sourceName).toMatch(/Gabungan/);

    const month = await computeUtilizationMonth(t.db, EQUA_TENANT_ID, "2026-07", "2026-07-02", w.source.id);
    const m = month.find((r) => r.sourceId === w.source.id)!;
    expect(m).toMatchObject({ days: 2, totalFilledL: 29_000, avgUtilizationPct: 72.5, maxUtilizationPct: 95, daysAboveThreshold: 1 });
    await expect(utilizationMonthly(dispatcher(), { month: "2026-07" })).rejects.toThrow();
    expect((await utilizationMonthly(finance(), { month: "2026-07", sourceId: w.source.id })).length).toBe(1);
  });

  it("US-M8-05 KP-2 harian > PAR-19 ditandai (dashboard & H+0); > PAR-19 selama PAR-85 hari berturut → notifikasi push pemilik sekali; ruang tumbuh ditampilkan", async () => {
    const w = await productionWorld(t.db, { date: "2026-09-21", capacityL: 10_000 });
    // Dua hari sebelumnya > 90% (data historis), hari ini 5 pengisian × 2.000 L = 100%.
    await seedFill(t.db, { sourceId: w.source.id, truckId: w.truck.id, date: addDays(w.date, -2), volumeL: 9_500 });
    await seedFill(t.db, { sourceId: w.source.id, truckId: w.truck.id, date: addDays(w.date, -1), volumeL: 9_200 });
    for (let i = 0; i < 5; i++) await w.fill({ volumeL: 2_000, volumeReason: "Tangki tidak diisi penuh", at: w.at(`${String(8 + i).padStart(2, "0")}:00`) });
    const flags = await utilizationFlags(t.db, EQUA_TENANT_ID, w.date);
    expect(flags.find((f) => f.sourceId === w.source.id)).toMatchObject({ utilizationPct: 100, high: true });
    // Neraca malam memeriksa rangkaian → push ke pemilik.
    await w.reading("morning", 1_000_000);
    await w.reading("evening", 1_010_500);
    const notes = await w.notificationsFor("source.utilization_high", w.source.id);
    expect(notes.map((n) => n.recipientUserId)).toEqual([userIdByUsername("pemilik")]);
    expect(notes[0]!.title).toMatch(/3 hari berturut/);
    // Dihitung ulang (data terlambat) tidak mengirim ulang untuk rangkaian yang sama.
    await w.fill({ volumeL: 1_000, volumeReason: "Tangki tidak diisi penuh", at: w.at("21:45") });
    expect((await w.notificationsFor("source.utilization_high", w.source.id)).length).toBe(1);
    // Dua hari saja belum memicu notifikasi.
    const w2 = await productionWorld(t.db, { date: "2026-09-21", capacityL: 10_000 });
    await seedFill(t.db, { sourceId: w2.source.id, truckId: w2.truck.id, date: addDays(w2.date, -1), volumeL: 9_500 });
    await w2.fill({ volumeL: 5_000 });
    await w2.fill({ volumeL: 5_000, at: w2.at("10:00") });
    await w2.reading("morning", 1_000_000);
    await w2.reading("evening", 1_010_500);
    expect((await w2.notificationsFor("source.utilization_high", w2.source.id)).length).toBe(0);

    // Ruang tumbuh (liter/hari & setara rit) — kapasitas − rata-rata pengisian.
    const month = await computeUtilizationMonth(t.db, EQUA_TENANT_ID, "2026-09", "2026-09-21", w2.source.id);
    const r = month.find((x) => x.sourceId === w2.source.id)!;
    expect(r.growthRoomL).toBe(Math.round(10_000 - r.avgFilledL));
    expect(r.growthRoomTrips).toBeCloseTo(r.growthRoomL / 5_000, 1);
  });

  it("US-M8-05 KP-3 ekspor data harian 6 bulan untuk studi kelayakan kapasitas dalam satu berkas (pemilik)", async () => {
    const range = utilizationExportRange("2026-09-28", 6);
    expect(range).toEqual({ from: "2026-03-29", to: "2026-09-28" });
    const exp = await exportReport(owner(new Date("2026-09-28T03:00:00Z")), "m8.utilization_daily", "xlsx", {});
    const days = daysBetween(range.from, range.to) + 1;
    // Satu baris per hari per sumber aktif (≥ 2) + baris gabungan.
    expect(exp.rowCount).toBeGreaterThanOrEqual(days * 3);
    expect(exp.filename).toMatch(/\.xlsx$/);
    await expect(exportReport(finance(), "m8.utilization_daily", "xlsx", {})).rejects.toThrow();
  });
});
