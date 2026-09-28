import { and, count, eq, like } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { orders, waterBalances } from "@/db/schema";
import { deviceId, EQUA_TENANT_ID, truckId, userIdByUsername, waterSourceId } from "@/db/seed";
import { seedDemoM8Production } from "@/db/seed/demo-m8-production";
import { addDays, toBusinessDate } from "@/lib/time";
import { systemContext } from "@/server/core/context";
import { withTx } from "@/server/core/db";
import { buildProductionToday, computeDailyProduction, computeWaterBalance, qualityOverview } from "@/server/modules/m8-production";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";

/** Kamis 12 Nov 2026 09.00 WIB — jauh dari tanggal uji M8 lain. */
const NOW = new Date("2026-11-12T02:00:00Z");
const DAY = toBusinessDate(NOW);

describe("M8 seed demo", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("snapshot uji tidak memuat data demo M8 (tanggal relatif hari ini tidak deterministik)", async () => {
    const [row] = await t.db.select({ n: count() }).from(orders).where(like(orders.number, "P-%-9008%"));
    expect(row!.n).toBe(0);
  });

  it("US-M8-04 KP-1 seed demo idempoten; neraca demo sama dengan hitungan layanan; aplikasi operator SA1 berisi truk terjadwal", async () => {
    const first = await seedDemoM8Production(t.db, NOW, { force: true });
    expect(first).toEqual({ readings: 9, fills: 14, trips: 17 });
    const again = await seedDemoM8Production(t.db, NOW, { force: true });
    expect(again).toEqual({ readings: 0, fills: 0, trips: 0 });

    const status = async (code: string, offset: number) =>
      (await t.db.select().from(waterBalances).where(and(eq(waterBalances.waterSourceId, waterSourceId(code)), eq(waterBalances.businessDate, addDays(DAY, offset)))))[0];
    expect((await status("SA1", -3))!.status).toBe("normal");
    expect((await status("SA1", -2))!.status).toBe("investigating");
    expect((await status("SA2", -2))!.status).toBe("negative_anomaly");
    expect(await status("SA2", -1)).toMatchObject({ status: "formed", isIncomplete: true, filledTotalL: 10_000 });

    // Hitung ulang layanan atas data mentah demo = angka seed (produksi, penyimpangan PAR-68, neraca).
    const ctx = systemContext({ tenantId: EQUA_TENANT_ID, now: NOW });
    const before = (await status("SA1", -1))!;
    await withTx(async (tx) => {
      const prod = await computeDailyProduction(tx, ctx, waterSourceId("SA1"), addDays(DAY, -1));
      expect(prod.production).toMatchObject({ producedL: 20_400, status: "complete", flaggedForVerification: true });
      expect(prod.changed).toBe(false);
      const bal = await computeWaterBalance(tx, ctx, waterSourceId("SA1"), addDays(DAY, -1), prod.production);
      expect(bal.changed).toBe(false);
      expect(bal.balance).toMatchObject({ producedL: before.producedL, lossL: before.lossL, lossPct: before.lossPct, avgLoss7dPct: before.avgLoss7dPct, utilizationPct: before.utilizationPct });
    });

    // Aplikasi operator SA1 (produksi1) hari ini: truk T3 terjadwal dengan rit disarankan, angka meter sebelumnya.
    const op = seededContext("produksi1", { now: NOW });
    const today = (await buildProductionToday(t.db as never, op, { waterSourceId: waterSourceId("SA1"), tenantId: EQUA_TENANT_ID }, null, { now: NOW }))!;
    expect(today.source?.code).toBe("SA1");
    const t3 = today.trucks.find((x) => x.id === truckId("T3"))!;
    expect(t3.planned).toBe(true);
    expect(t3.nextTripId).toBe(t3.trips[0]!.id);
    expect(today.meters[0]!.previousDayL).toBe(12_503_900);
    expect(today.investigations.map((i) => i.businessDate)).toContain(addDays(DAY, -2));
    expect(today.quality.schedules[0]).toMatchObject({ dueSoon: true });
    expect(deviceId("HP-SA1")).toBeTruthy();

    const quality = await qualityOverview(seededContext("pemilik", { now: NOW }));
    expect(quality.tests.some((q) => !q.passed && q.actionRequired && !q.actionDoneAt)).toBe(true);
    expect(userIdByUsername("produksi1")).toBeTruthy();
  });
});
