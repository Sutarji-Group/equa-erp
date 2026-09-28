import { count, eq, like } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { orders, trips } from "@/db/schema";
import { seedDemoM2Orders } from "@/db/seed/demo-m2-orders";
import { addDays, toBusinessDate } from "@/lib/time";
import * as m2 from "@/server/modules/m2-orders";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { ctxOf } from "./helpers";

/** Senin 2 Nov 2026 10.00 WIB — jauh dari tanggal uji M2 lain. */
const NOW = new Date("2026-11-02T03:00:00Z");
const DAY = toBusinessDate(NOW);

describe("M2 seed demo", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("snapshot uji tidak memuat data transaksi demo M2 (tanggal relatif hari ini tidak deterministik)", async () => {
    const [row] = await t.db.select({ n: count() }).from(orders).where(like(orders.number, "P-%-9%"));
    expect(row.n).toBe(0);
  });

  it("seed demo idempoten dan mengisi papan jadwal, daftar pesanan, langganan & kru", async () => {
    const first = await seedDemoM2Orders(t.db, NOW, { force: true });
    expect(first.orders).toBe(10);
    const again = await seedDemoM2Orders(t.db, NOW, { force: true });
    expect(again.orders).toBe(0);

    const ctx = ctxOf("dispatcher1", NOW);
    const board = await m2.getBoard(ctx, DAY);
    const t5 = board.lanes.find((l) => l.truck.code === "T5")!;
    const t7 = board.lanes.find((l) => l.truck.code === "T7")!;
    expect(t5.trips).toHaveLength(2);
    expect(t5.schedule?.status).toBe("published");
    expect(t7.trips).toHaveLength(1);
    expect(t7.crew.assignmentSource).toBe("helper");
    // Belum terjadwal: rit lain pesanan T7, 2 rit (satu kemungkinan dobel), internal D05, rit pengganti kemarin (lewat).
    expect(board.unscheduled.length).toBeGreaterThanOrEqual(5);
    expect(board.unscheduled[0].overdue).toBe(true);
    expect(board.unscheduled.some((u) => u.possibleDuplicate)).toBe(true);
    expect(board.unscheduled.some((u) => u.isInternal)).toBe(true);

    const tomorrow = await m2.getBoard(ctx, addDays(DAY, 1));
    expect(tomorrow.lanes.find((l) => l.truck.code === "T5")!.capacityTrips).toBe(4);

    const list = await m2.listOrders(ctx, { from: addDays(DAY, -1), to: addDays(DAY, 1) });
    expect(list.some((r) => r.status === "cancelled")).toBe(true);
    const recurring = await m2.listRecurringOrders(ctx);
    expect(recurring.some((r) => r.status === "active")).toBe(true);
    expect((await m2.listRecurringFailures(ctx)).length).toBeGreaterThanOrEqual(1);

    const failed = await t.db.select({ id: trips.id }).from(trips).where(eq(trips.status, "failed"));
    expect(failed.length).toBeGreaterThanOrEqual(1);
  });
});
