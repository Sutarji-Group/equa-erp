import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { outletId } from "@/db/seed";
import { DEMO_M6_SHIFT_ID, seedDemoM6Pos } from "@/db/seed/demo-m6-pos";
import { deposits, posSales, shifts, stockBalances, waterSupplyReceipts } from "@/db/schema";
import { computeShiftFigures, getShiftDetail, isShiftFullySynced, listOutletsOverview, waterStockNow } from "@/server/modules/m6-pos";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { finance, owner, P } from "./helpers";

describe("M6 seed demo (D02/D03)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("shift demo D02 konsisten dengan perhitungan layanan (tunai, QRIS, void, setoran, galon) dan tersinkron penuh", async () => {
    const [shift] = await t.db.select().from(shifts).where(eq(shifts.id, DEMO_M6_SHIFT_ID));
    expect(shift?.status).toBe("closed");
    const f = await computeShiftFigures(t.db, shift!);
    expect(f.cashSales).toBe(shift!.cashSales);
    expect(f.qrisSales).toBe(shift!.qrisSales);
    expect(f.voidCount).toBe(shift!.voidCount);
    expect(f.voidAmount).toBe(shift!.voidAmount);
    expect(f.expectedCash).toBe(shift!.expectedCash);
    expect(f.depositAmount).toBe(shift!.depositAmount);
    expect(f.gallonsSold).toBe(14);
    expect(await isShiftFullySynced(t.db, DEMO_M6_SHIFT_ID)).toBe(true);
    const [dep] = await t.db.select().from(deposits).where(eq(deposits.shiftId, DEMO_M6_SHIFT_ID));
    expect(dep).toMatchObject({ status: "submitted", sourceType: "depot_shift", isPartial: false, expectedCash: shift!.depositAmount });
    const detail = await getShiftDetail(await finance(), DEMO_M6_SHIFT_ID, { tx: t.db });
    expect(detail.sales).toHaveLength(8);
    expect(detail.sync.fullySynced).toBe(true);
  });

  it("stok bahan & buku air demo sesuai pemakaian resep dan pasokan; D03 punya pasokan Tiba menunggu konfirmasi", async () => {
    const [tutup] = await t.db.select().from(stockBalances).where(sql`${stockBalances.outletId} = ${outletId("D02")} and ${stockBalances.productId} = ${P.TUTUP}`);
    expect(tutup?.quantity).toBe(400 - 14);
    expect(await waterStockNow(t.db, outletId("D02"))).toBe(1_500 + 2_980 - 14 * 19);
    const pending = await t.db.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.outletId, outletId("D03")));
    expect(pending.map((p) => p.status)).toContain("arrived");
    const overview = await listOutletsOverview(await owner(), { tx: t.db });
    const d03 = overview.rows.find((r) => r.outlet.id === outletId("D03"));
    expect(d03?.pendingSupplies).toBeGreaterThanOrEqual(1);
  });

  it("seed demo idempoten: dijalankan ulang tidak menambah transaksi, shift, maupun nomor", async () => {
    const before = await t.db.select({ n: sql<number>`count(*)::int` }).from(posSales).where(eq(posSales.outletId, outletId("D02")));
    const res = await seedDemoM6Pos(t.db);
    expect(res).toEqual({ stockLines: 0, shift: false, supplies: 0 });
    const after = await t.db.select({ n: sql<number>`count(*)::int` }).from(posSales).where(eq(posSales.outletId, outletId("D02")));
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});
