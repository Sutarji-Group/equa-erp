/**
 * B-56 — laporan M11:
 * 1. Alokasi biaya L1 ke L3 dipecah per outlet depot menurut volume pasokan (US-M11-01 KP-1 "L3 depot per outlet", KP-3).
 * 2. Markup harga mitra transfer internal toko → depot (PTB-37) dieliminasi pada konsolidasi: bagian yang terpakai dari
 *    beban bahan depot (laba rugi) dan bagian yang masih di persediaan depot (neraca) — US-M11-01 KP-4, BR-33.
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { customerAddresses, truckFills, trips } from "@/db/schema";
import { EQUA_TENANT_ID, internalCustomerId, outletId, truckId, waterSourceId } from "@/db/seed";
import { newId } from "@/lib/ids";
import * as m11 from "@/server/modules/m11-accounting";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createOrder, createScheduledTrip } from "../helpers/fixtures";
import { THIS_PERIOD, TODAY, accountant, emitEvent, finance, linesOf, manualJournal, pair, setPeriod } from "./helpers";

describe("B-56 alokasi L1 per outlet depot & eliminasi markup transfer internal", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  /** Rit pasokan internal Selesai ke depot `code` + pengisian di sumber sebesar `liters`. */
  async function supplyTrip(code: string, liters: number) {
    const [addr] = await t.db.select().from(customerAddresses).where(eq(customerAddresses.customerId, internalCustomerId(code))).limit(1);
    const order = await createOrder(t.db, { customerId: internalCustomerId(code), addressId: addr!.id, date: TODAY, pricePerTrip: 0 });
    const trip = await createScheduledTrip(t.db, { order, truckId: truckId("T2"), date: TODAY, paymentMethod: "internal" });
    await t.db.update(trips).set({ isInternal: true, destinationOutletId: outletId(code), status: "completed", deliveredVolumeL: liters, completionBusinessDate: TODAY }).where(eq(trips.id, trip.id));
    await t.db.insert(truckFills).values({ tenantId: EQUA_TENANT_ID, waterSourceId: waterSourceId("SA1"), truckId: truckId("T2"), tripId: trip.id, businessDate: TODAY, volumeL: liters, filledAt: new Date(`${TODAY}T03:00:00Z`), isDepotSupply: true });
  }

  it("B-56 US-M11-01 KP-1 KP-3 alokasi L1 → L3 dibagi per outlet depot menurut volume pasokan; baris jurnal berdimensi outlet", async () => {
    const period = await setPeriod(t.db, THIS_PERIOD, "open");
    await manualJournal(finance(), { date: TODAY, description: "Listrik pompa sumber air SA1", lines: pair("6-1301", "1-1101", 1_000_000, { debit: "L1" }) });
    await t.db.insert(truckFills).values({ tenantId: EQUA_TENANT_ID, waterSourceId: waterSourceId("SA1"), truckId: truckId("T1"), businessDate: TODAY, volumeL: 10_000, filledAt: new Date(`${TODAY}T02:00:00Z`), isDepotSupply: false });
    await supplyTrip("D01", 6_000);
    await supplyTrip("D02", 4_000);

    const st = await m11.allocationStatus(finance(), { periodId: period.id });
    expect(st.l1).toMatchObject({ total: 1_000_000, shares: { L2: 500_000, L3: 500_000 } });
    expect(st.l1.l3ByOutlet.map((o) => [o.code, o.liters, o.amount])).toEqual([
      ["D01", 6_000, 300_000],
      ["D02", 4_000, 200_000],
    ]);
    const res = await m11.runCostAllocation(finance(), { periodId: period.id, kind: "l1_allocation" });
    const lines = await linesOf(t.db, res.journal.id);
    expect(lines.map((l) => [l.code, l.profitCenter, l.outletId, l.debit, l.credit])).toEqual([
      ["5-1501", "L2", null, 500_000, 0],
      ["5-1501", "L3", outletId("D01"), 300_000, 0],
      ["5-1501", "L3", outletId("D02"), 200_000, 0],
      ["5-1502", "L1", null, 0, 1_000_000],
    ]);
    const pl = (await m11.getStatements(accountant(), { period: THIS_PERIOD })).profitLoss;
    expect(pl.centers.L3.allocationL1).toBe(-500_000);
    expect(res.run.basis).toMatchObject({ depotOutlets: [expect.objectContaining({ code: "D01", amount: 300_000 }), expect.objectContaining({ code: "D02", amount: 200_000 })] });
  });

  it("B-56 US-M11-01 KP-4 BR-33 markup harga mitra transfer toko → depot dieliminasi pada konsolidasi: terpakai dari beban, sisa dari persediaan (neraca tetap seimbang)", async () => {
    const before = await m11.getStatements(accountant(), { period: THIS_PERIOD });
    // Toko mengirim bahan ke depot D03: harga mitra 100.000, HPP toko 70.000 (markup 30.000).
    await emitEvent("internal_transfer.sent", { internalTransferId: newId(), fromOutletId: outletId("TK1"), toOutletId: outletId("D03"), totalValue: 100_000, totalCost: 70_000 });
    // Depot memakai 40% bahan (nilai harga mitra 40.000).
    await emitEvent("consumable.usage_posted", { shiftId: newId(), outletId: outletId("D03"), totalValue: 40_000, lines: [] });
    const after = await m11.getStatements(accountant(), { period: THIS_PERIOD });
    const pl = after.profitLoss;
    // Per lini tetap harga mitra (PTB-37): L4 laba internal 30.000, L3 beban 40.000.
    expect(pl.centers.L4.beforeAllocation - before.profitLoss.centers.L4.beforeAllocation).toBe(30_000);
    expect(pl.centers.L3.beforeAllocation - before.profitLoss.centers.L3.beforeAllocation).toBe(-40_000);
    // Konsolidasi: bahan terpakai dinilai HPP toko (40% × 70.000 = 28.000) → markup terpakai 12.000 dieliminasi.
    expect(pl.consolidated.markupRealized - before.profitLoss.consolidated.markupRealized).toBe(12_000);
    expect(pl.consolidated.net - before.profitLoss.consolidated.net).toBe(-28_000);
    // Sisa persediaan depot 60.000 memuat markup 18.000 (belum terealisasi) → dieliminasi di neraca.
    expect(pl.consolidated.markupUnrealized - before.profitLoss.consolidated.markupUnrealized).toBe(18_000);
    const bs = after.balanceSheet;
    expect(bs.rows.find((r) => r.name.startsWith("Eliminasi markup transfer internal"))!.amount).toBe(-pl.consolidated.markupUnrealized);
    expect(bs.rows.find((r) => r.name.startsWith("Laba internal belum terealisasi"))!.amount).toBe(-pl.consolidated.markupUnrealized);
    expect(bs.balanced).toBe(true);
  });
});
