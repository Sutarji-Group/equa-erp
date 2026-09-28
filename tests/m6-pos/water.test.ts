import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { domainEvents, outlets, waterSupplyReceipts } from "@/db/schema";
import { EQUA_TENANT_ID, outletId, userIdByUsername } from "@/db/seed";
import type { PosReference } from "@/client/m6-pos/contract";
import { newId } from "@/lib/ids";
import { toBusinessDate } from "@/lib/time";
import { systemContext } from "@/server/core/context";
import { withTx } from "@/server/core/db";
import { emit } from "@/server/core/events";
import { postWaterMovement, runWaterBalanceCheck, waterBalanceReport, waterStockNow } from "@/server/modules/m6-pos";
import { resolveInternalTransferPrice } from "@/server/modules/m1-master";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createCustomer, createOrder, createScheduledTrip, createTruck, today } from "../helpers/fixtures";
import { closeVia, expectApplied, isi, notificationsFor, openShiftVia, owner, posFor, sellVia } from "./helpers";

describe("US-M6-05 Menerima pasokan air dan neraca air outlet", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  /** Rit internal Selesai dari M3 (payload yang diharapkan M6). */
  async function internalTripCompleted(outletCode: string, volumeL = 5_000, completedAt = new Date()) {
    const cust = await createCustomer(t.db, { segment: "third_party_depot" });
    const truck = await createTruck(t.db);
    const order = await createOrder(t.db, { customerId: cust.id, addressId: cust.addressId!, date: today() });
    const trip = await createScheduledTrip(t.db, { order, truckId: truck.id, date: today() });
    const payload = {
      tripId: trip.id,
      orderId: order.id,
      customerId: cust.id,
      truckId: truck.id,
      driverUserId: userIdByUsername("sopir1"),
      isInternal: true,
      destinationOutletId: outletId(outletCode),
      volumeL,
      price: 0,
      paymentMethod: "internal" as const,
      cashReceived: 0,
      transferAmount: 0,
      creditAmount: 0,
      underpaymentAmount: 0,
      completedAt: completedAt.toISOString(),
      recordedByOffice: false,
      lateSync: false,
    };
    await withTx(async (tx) => {
      await emit(tx, "trip.completed", payload, { ctx: systemContext({ tenantId: EQUA_TENANT_ID, now: completedAt }), objectType: "trip", objectId: trip.id });
      // Idempoten: event yang sama diproses ulang tidak menggandakan penerimaan.
      await emit(tx, "trip.completed", payload, { ctx: systemContext({ tenantId: EQUA_TENANT_ID, now: completedAt }), objectType: "trip", objectId: trip.id });
    });
    const [receipt] = await t.db.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.tripId, trip.id));
    return receipt!;
  }

  it("US-M6-05 KP-1 rit internal Selesai → 'pasokan tiba' di POS outlet tujuan; operator konfirmasi (bawaan sama) atau volume beda + alasan → ditandai ke Dispatcher/M8", async () => {
    const pos = await posFor("D04");
    const r1 = await internalTripCompleted("D04", 5_000);
    expect(r1).toMatchObject({ status: "arrived", deliveredVolumeL: 5_000, outletId: pos.outletId, source: "equa_truck" });
    expect((await t.db.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.tripId, r1.tripId!)))).toHaveLength(1);
    const ref = (await pos.hp.pull(pos.op, { keys: "m6.pos" })).data["m6.pos"] as PosReference;
    expect(ref.water?.pending.map((p) => p.id)).toContain(r1.id);
    expectApplied(await pos.send("m6.water_supply.confirm", { receiptId: r1.id, receivedVolumeL: 5_000 }));
    expect((await t.db.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.id, r1.id)))[0]).toMatchObject({ status: "confirmed", receivedVolumeL: 5_000, confirmedBy: userIdByUsername("depot04") });
    const r2 = await internalTripCompleted("D04", 5_000);
    const noReason = await pos.send("m6.water_supply.confirm", { receiptId: r2.id, receivedVolumeL: 4_800 });
    expect(noReason.status).toBe("rejected");
    expectApplied(await pos.send("m6.water_supply.confirm", { receiptId: r2.id, receivedVolumeL: 4_800, reason: "Toren penuh, sisa dibawa kembali" }));
    const [row2] = await t.db.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.id, r2.id));
    expect(row2).toMatchObject({ status: "discrepancy", differenceL: -200 });
    expect((await notificationsFor(t.db, "water_supply.discrepancy", { objectId: r2.id, recipient: userIdByUsername("dispatcher1") })).length).toBe(1);
    // Outlet lain tidak dapat mengonfirmasi pasokan D04.
    const p5 = await posFor("D05");
    const r3 = await internalTripCompleted("D04");
    expect((await p5.send("m6.water_supply.confirm", { receiptId: r3.id, receivedVolumeL: 5_000 })).status).toBe("rejected");
  });

  it("US-M6-05 KP-2 belum dikonfirmasi sampai tutup shift berikutnya (PAR-61) → diterima sesuai catatan sopir 'tanpa konfirmasi operator' + lapor Admin Keuangan", async () => {
    const pos = await posFor("D05");
    const arrived = await internalTripCompleted("D05", 5_000, new Date(Date.now() - 3_600_000));
    // Shift yang dibuka SETELAH pasokan tiba: tutupnya menerima otomatis.
    const { shiftId } = await openShiftVia(pos);
    expectApplied(await closeVia(pos, shiftId, { counted: 200_000 }));
    const [row] = await t.db.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.id, arrived.id));
    expect(row).toMatchObject({ status: "auto_accepted", receivedVolumeL: 5_000 });
    expect(row!.autoAcceptedAt).not.toBeNull();
    expect((await notificationsFor(t.db, "water_supply.unconfirmed", { objectId: arrived.id, recipient: userIdByUsername("keuangan1") })).length).toBe(1);
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "water_supply.confirmed"), eq(domainEvents.objectId, arrived.id)));
    expect(ev!.payload).toMatchObject({ confirmedByOperator: false, autoAccepted: true });
    // Pasokan yang tiba SAAT shift terbuka tidak diterima otomatis di tutup shift itu.
    const s2 = await openShiftVia(pos);
    const during = await internalTripCompleted("D05");
    expectApplied(await closeVia(pos, s2.shiftId, { counted: 200_000 }));
    expect((await t.db.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.id, during.id)))[0]!.status).toBe("arrived");
  });

  it("US-M6-05 KP-3 stok air outlet (L) = stok awal + diterima − galon terjual × ukuran galon; melebihi kapasitas simpan ditandai", async () => {
    const pos = await posFor("D06");
    await withTx(async (tx) => {
      await postWaterMovement(tx, { tenantId: EQUA_TENANT_ID, outletId: pos.outletId, kind: "opening", volumeL: 1_000, businessDate: toBusinessDate(new Date()), occurredAt: new Date(), source: null });
    });
    const r = await internalTripCompleted("D06", 3_000);
    expectApplied(await pos.send("m6.water_supply.confirm", { receiptId: r.id, receivedVolumeL: 3_000 }));
    const { shiftId } = await openShiftVia(pos);
    await sellVia(pos, shiftId, [isi(10)]);
    expect(await waterStockNow(t.db, pos.outletId)).toBe(1_000 + 3_000 - 10 * 19);
    expectApplied(await closeVia(pos, shiftId, { counted: 250_000 }));
    expect(await waterStockNow(t.db, pos.outletId)).toBe(1_000 + 3_000 - 190);
    await t.db.update(outlets).set({ storageCapacityL: 3_000 }).where(eq(outlets.id, pos.outletId));
    const ref = (await pos.hp.pull(pos.op, { keys: "m6.pos" })).data["m6.pos"] as PosReference;
    expect(ref.water).toMatchObject({ stockL: 3_810, capacityL: 3_000, overCapacity: true });
  });

  it("US-M6-05 KP-4 neraca air mingguan/bulanan: galon terjual melebihi air tersedia > PAR-59 → ditandai ke pemilik", async () => {
    const pos = await posFor("D07");
    const { shiftId } = await openShiftVia(pos);
    await sellVia(pos, shiftId, [isi(20)]); // 380 L terjual tanpa pasokan tercatat
    expectApplied(await closeVia(pos, shiftId, { counted: 300_000 }));
    const d = toBusinessDate(new Date());
    const report = await waterBalanceReport(owner(), { from: d, to: d, outletId: pos.outletId });
    expect(report[0]).toMatchObject({ soldL: 380, receivedL: 0, exceeded: true, tolerancePct: 5 });
    const nextWeek = new Date(Date.now() + 7 * 86_400_000);
    const weekly = await runWaterBalanceCheck(nextWeek, "week");
    expect(weekly.flagged).toContain(pos.outletId);
    expect((await notificationsFor(t.db, "outlet.water_balance_exceeded", { objectId: pos.outletId, recipient: userIdByUsername("pemilik") })).length).toBeGreaterThan(0);
  });

  it("US-M6-05 KP-5 volume DITERIMA menjadi dasar nilai transfer internal (BR-33, K20) untuk jurnal M11; tidak ada uang di depot", async () => {
    const pos = await posFor("D08");
    const r = await internalTripCompleted("D08", 5_000);
    expectApplied(await pos.send("m6.water_supply.confirm", { receiptId: r.id, receivedVolumeL: 4_000, reason: "Selang bocor" }));
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "water_supply.confirmed"), eq(domainEvents.objectId, r.id)));
    const price = await withTx((tx) => resolveInternalTransferPrice(tx, { depotOutletId: pos.outletId, date: toBusinessDate(new Date()) }));
    expect(ev!.payload).toMatchObject({ volumeSentL: 5_000, volumeReceivedL: 4_000, transferValue: Math.round((price.unitPrice * 4_000) / 5_000) });
  });

  it("US-M6-05 KP-6 pasokan darurat dari sumber lain dicatat dengan sumber 'lain' + alasan; tampil di neraca air", async () => {
    const pos = await posFor("D09");
    expect((await pos.send("m6.water_supply.record_other", { receiptId: newId(), volumeL: 2_000, reason: "" })).status).toBe("rejected");
    const id = newId();
    expectApplied(await pos.send("m6.water_supply.record_other", { receiptId: id, volumeL: 2_000, reason: "Truk EQUA mogok", sourceNote: "Depot tetangga" }));
    const [row] = await t.db.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.id, id));
    expect(row).toMatchObject({ source: "other", status: "confirmed", receivedVolumeL: 2_000 });
    expect(row!.otherSourceReason).toMatch(/Truk EQUA mogok/);
    const d = toBusinessDate(new Date());
    const report = await waterBalanceReport(owner(), { from: d, to: d, outletId: pos.outletId });
    expect(report[0]!.receivedL).toBe(2_000);
  });
});
