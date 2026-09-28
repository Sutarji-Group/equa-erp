import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { customerAddresses, trips, waterSupplyReceipts } from "@/db/schema";
import { EQUA_TENANT_ID, internalCustomerId, outletId, userIdByUsername } from "@/db/seed";
import { systemContext } from "@/server/core/context";
import { withTx } from "@/server/core/db";
import { emit } from "@/server/core/events";
import { exportReport } from "@/server/core/export";
import * as params from "@/server/core/params";
import { resolveInternalTransferPrice } from "@/server/modules/m1-master";
import { depotSupplyList, depotSupplySummary, supplyRows } from "@/server/modules/m8-production";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { posFor } from "../m6-pos/helpers";
import { dispatcher, owner, productionWorld, type ProdWorld } from "./helpers";

describe("M8 — pasokan air ke depot sendiri (US-M8-03)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  /** Rit internal ke depot `code` dari sumber dunia uji (alamat pelanggan internal → sumber acuan dunia). */
  async function internalTrip(w: ProdWorld, code: string) {
    const [addr] = await t.db.select().from(customerAddresses).where(eq(customerAddresses.customerId, internalCustomerId(code))).limit(1);
    await t.db.update(customerAddresses).set({ referenceWaterSourceId: w.source.id }).where(eq(customerAddresses.id, addr!.id));
    return w.addTrip({ isInternal: true, destinationOutletId: outletId(code), customer: { id: internalCustomerId(code), code: `INT-${code}`, addressId: addr!.id, tenantId: EQUA_TENANT_ID } });
  }

  /** Sopir menyelesaikan rit internal di depot (M3 → `trip.completed`; M6 membuat "pasokan tiba"). */
  async function completeAtDepot(w: ProdWorld, trip: { id: string; orderId: string }, code: string, deliveredL: number) {
    await t.db.update(trips).set({ status: "completed", deliveredVolumeL: deliveredL, completedAt: w.at("11:00"), completionBusinessDate: w.date }).where(eq(trips.id, trip.id));
    await withTx((tx) =>
      emit(
        tx,
        "trip.completed",
        {
          tripId: trip.id,
          orderId: trip.orderId,
          customerId: internalCustomerId(code),
          truckId: w.truck.id,
          driverUserId: userIdByUsername("sopir1"),
          isInternal: true,
          destinationOutletId: outletId(code),
          volumeL: deliveredL,
          price: 0,
          paymentMethod: "internal",
          cashReceived: 0,
          transferAmount: 0,
          creditAmount: 0,
          underpaymentAmount: 0,
          completedAt: w.at("11:00").toISOString(),
          recordedByOffice: false,
          lateSync: false,
        },
        { ctx: systemContext({ tenantId: EQUA_TENANT_ID, now: w.at("11:00") }), objectType: "trip", objectId: trip.id },
      ),
    );
    const [receipt] = await t.db.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.tripId, trip.id));
    return receipt!;
  }

  it("US-M8-03 KP-1 rit internal mengalir: pengisian di sumber → Selesai di depot (volume diserahkan) → konfirmasi diterima operator depot", async () => {
    const w = await productionWorld(t.db);
    const trip = await internalTrip(w, "D07");
    const fill = await w.fill({ tripId: trip.id });
    expect(fill.result).toMatchObject({ isDepotSupply: true });
    const receipt = await completeAtDepot(w, trip, "D07", 5_000);
    expect(receipt.status).toBe("arrived");
    let [row] = await supplyRows(t.db, EQUA_TENANT_ID, { from: w.date, to: w.date, tripIds: [trip.id] });
    expect(row).toMatchObject({ filledL: 5_000, deliveredL: 5_000, receivedL: null, receiptStatus: "arrived" });
    const pos = await posFor("D07");
    const conf = await pos.send("m6.water_supply.confirm", { receiptId: receipt.id, receivedVolumeL: 5_000 });
    expect(conf.status).toBe("applied");
    [row] = await supplyRows(t.db, EQUA_TENANT_ID, { from: w.date, to: w.date, tripIds: [trip.id] });
    expect(row).toMatchObject({ filledL: 5_000, deliveredL: 5_000, receivedL: 5_000, receiptStatus: "confirmed", differenceL: 0, outOfTolerance: false });
  });

  it("US-M8-03 KP-2 tiga angka per pasokan; selisih diisi vs diterima > PAR-69 → Dispatcher & pemilik + masuk neraca", async () => {
    const w = await productionWorld(t.db);
    const trip = await internalTrip(w, "D08");
    await w.fill({ tripId: trip.id });
    const receipt = await completeAtDepot(w, trip, "D08", 4_950);
    const pos = await posFor("D08");
    expect((await pos.send("m6.water_supply.confirm", { receiptId: receipt.id, receivedVolumeL: 4_800, reason: "Toren bocor saat pengisian" })).status).toBe("applied");
    const [row] = await supplyRows(t.db, EQUA_TENANT_ID, { from: w.date, to: w.date, tripIds: [trip.id] });
    const tol = (await params.get(t.db, "PAR-69", w.date)).percent;
    expect(row).toMatchObject({ filledL: 5_000, deliveredL: 4_950, receivedL: 4_800, differenceL: 200, differencePct: 4, outOfTolerance: 4 > tol });
    const notes = await w.notificationsFor("production.supply_difference", trip.id);
    const recipients = new Set(notes.map((n) => n.recipientUserId));
    expect(recipients.has(userIdByUsername("dispatcher1"))).toBe(true);
    expect(recipients.has(userIdByUsername("pemilik"))).toBe(true);
    // Evaluasi ulang (mis. pengisian menyusul / event berulang) tidak menggandakan notifikasi.
    await withTx((tx) =>
      emit(
        tx,
        "water_supply.confirmed",
        { waterSupplyReceiptId: receipt.id, tripId: trip.id, outletId: outletId("D08"), volumeSentL: 4_950, volumeReceivedL: 4_800, transferValue: 0, confirmedByOperator: true },
        { ctx: systemContext({ now: w.at("12:00") }) },
      ),
    );
    expect((await w.notificationsFor("production.supply_difference", trip.id)).length).toBe(notes.length);
    // Selisih dalam toleransi tidak ditandai.
    const w2 = await productionWorld(t.db);
    const trip2 = await internalTrip(w2, "D09");
    await w2.fill({ tripId: trip2.id });
    const r2 = await completeAtDepot(w2, trip2, "D09", 5_000);
    const pos9 = await posFor("D09");
    await pos9.send("m6.water_supply.confirm", { receiptId: r2.id, receivedVolumeL: 4_950, reason: "Selisih meteran kecil" });
    expect((await w2.notificationsFor("production.supply_difference", trip2.id)).length).toBe(0);
  });

  it("US-M8-03 KP-3 nilai pasokan = volume diterima × harga transfer (tarif zona alamat depot, segmen depot pihak ketiga; K20)", async () => {
    const w = await productionWorld(t.db);
    const trip = await internalTrip(w, "D10");
    await w.fill({ tripId: trip.id });
    const receipt = await completeAtDepot(w, trip, "D10", 5_000);
    const pos = await posFor("D10");
    await pos.send("m6.water_supply.confirm", { receiptId: receipt.id, receivedVolumeL: 4_900, reason: "Tumpah saat pengisian toren" });
    const [row] = await supplyRows(t.db, EQUA_TENANT_ID, { from: w.date, to: w.date, tripIds: [trip.id] });
    const price = await resolveInternalTransferPrice(t.db, { depotOutletId: outletId("D10"), date: w.date });
    const std = (await params.get(t.db, "PAR-15", w.date)).liters;
    expect(price.unitPrice).toBeGreaterThan(0);
    expect(row!.transferValue).toBe(Math.round((price.unitPrice * 4_900) / std));
  });

  it("US-M8-03 KP-4 ringkasan pasokan per depot per hari/bulan (liter, jumlah rit) + ekspor", async () => {
    const w = await productionWorld(t.db);
    for (const code of ["D05", "D05", "D04"]) {
      const trip = await internalTrip(w, code);
      await w.fill({ tripId: trip.id });
      const receipt = await completeAtDepot(w, trip, code, 5_000);
      await t.db.update(waterSupplyReceipts).set({ status: "confirmed", receivedVolumeL: 5_000, differenceL: 0, confirmedAt: w.at("12:00") }).where(eq(waterSupplyReceipts.id, receipt.id));
    }
    const perDay = await depotSupplySummary(dispatcher(), { from: w.date, to: w.date, granularity: "day" });
    const d05 = perDay.find((r) => r.outletCode === "D05")!;
    expect(d05).toMatchObject({ period: w.date, trips: 2, receivedL: 10_000, filledL: 10_000 });
    const perMonth = await depotSupplySummary(owner(), { from: w.date, to: w.date, granularity: "month" });
    expect(perMonth.find((r) => r.outletCode === "D04")).toMatchObject({ period: w.date.slice(0, 7), trips: 1, receivedL: 5_000 });
    const list = await depotSupplyList(dispatcher(), { from: w.date, to: w.date, outletId: outletId("D05") });
    expect(list).toHaveLength(2);
    const exp = await exportReport(owner(), "m8.depot_supply_summary", "xlsx", { from: w.date, to: w.date, granularity: "month" });
    expect(exp.rowCount).toBeGreaterThanOrEqual(2);
  });
});
