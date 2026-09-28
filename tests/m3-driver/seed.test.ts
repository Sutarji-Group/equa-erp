import { count, like } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { computeDayFigures } from "@/client/m3-driver/contract";
import { orders } from "@/db/schema";
import { seedDemoM3Driver } from "@/db/seed/demo-m3-driver";
import { addDays, toBusinessDate } from "@/lib/time";
import type { Tx } from "@/server/core/db";
import * as m3 from "@/server/modules/m3-driver";
import { buildDepositHistory, buildToday } from "@/server/modules/m3-driver/service/pull";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";

/** Selasa 10 Nov 2026 10.00 WIB — jauh dari tanggal uji M3 lain. */
const NOW = new Date("2026-11-10T03:00:00Z");
const DAY = toBusinessDate(NOW);

describe("M3 seed demo", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("snapshot uji tidak memuat data transaksi demo M3 (tanggal relatif hari ini tidak deterministik)", async () => {
    const [row] = await t.db.select({ n: count() }).from(orders).where(like(orders.number, "P-%-9002%"));
    expect(row.n).toBe(0);
  });

  it("US-M3-01 KP-1 seed demo idempoten: aplikasi sopir T2 berisi rit hari ini, setoran berjalan, riwayat setoran & kendala", async () => {
    const first = await seedDemoM3Driver(t.db, NOW, { force: true });
    expect(first.trips).toBe(6);
    const again = await seedDemoM3Driver(t.db, NOW, { force: true });
    expect(again.trips).toBe(0);

    const sopir = seededContext("sopir2", { now: NOW });
    const today = (await buildToday(t.db as unknown as Tx, sopir, null))!;
    expect(today.date).toBe(DAY);
    expect(today.actingRole).toBe("driver");
    expect(today.lock).toBeNull();
    expect(today.trips.map((r) => r.status).sort()).toEqual(["assigned", "assigned", "assigned", "completed"]);
    expect(today.trips.filter((r) => r.paymentMethod === "credit")).toHaveLength(1);
    const figures = computeDayFigures(today);
    expect(figures.completedTrips).toBe(1);
    expect(figures.tripCash).toBe(today.trips.find((r) => r.status === "completed")!.price);
    expect(today.deposit?.status).toBe("running");

    const history = (await buildDepositHistory(t.db as unknown as Tx, sopir, null))!;
    const closed = history.rows.find((r) => r.businessDate === addDays(DAY, -1));
    expect(closed?.status).toBe("closed");
    expect(closed?.discrepancyAmount).toBe(0);

    const incidents = await m3.listIncidents(seededContext("dispatcher1", { now: NOW }), { from: DAY, to: DAY });
    expect(incidents.some((i) => i.kind === "road_blocked" && !i.acknowledgedAt)).toBe(true);

    const board = await m3.officeEntryBoard(seededContext("keuangan1", { now: NOW }), { date: DAY });
    expect(board.trips.filter((r) => r.truckCode === "T2")).toHaveLength(4);
  });
});
