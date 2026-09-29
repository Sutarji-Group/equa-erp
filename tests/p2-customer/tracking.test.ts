import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { gpsPositions, trips, waMessageLogs } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import { addDays } from "@/lib/time";
import { NotFoundError } from "@/server/core/errors";
import * as p2 from "@/server/modules/p2-customer";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { at, emitEvent, enableApp, fakeCloudProvider, linkedCustomer, minutes, setTrip, TODAY, truckWithDriver } from "./helpers";

async function orderWithTrip(db: Parameters<typeof linkedCustomer>[0], dayOffset = 1) {
  const a = await linkedCustomer(db);
  const [addr] = await p2.listMyAddresses(a.cctx);
  const placed = await p2.placeOrder(a.cctx, { addressId: addr!.id, tankCount: 1, date: addDays(TODAY, dayOffset), slot: "morning", paymentMethod: "cash" });
  const [trip] = await db.select().from(trips).where(eq(trips.orderId, placed.orderId));
  const truck = await truckWithDriver(db, "Dadang Supriatna");
  await setTrip(db, trip!.id, { truckId: truck.id, driverEmployeeId: truck.driver.employeeId, publishedAt: at(0.5), scheduledDate: addDays(TODAY, dayOffset) });
  return { a, placed, trip: trip!, truck };
}

describe("P2 Status & posisi truk (US-P2-03)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(async () => {
    bootstrapForTests();
    await enableApp();
  });
  afterEach(() => p2.setCustomerWaProviderForTests(null));

  it("US-P2-03 KP-1 garis waktu Diajukan → Dikonfirmasi (tanggal, slot, truk) → Berangkat → Tiba → Selesai (volume, penerima, waktu)", async () => {
    const { a, placed, trip, truck } = await orderWithTrip(t.db);
    let d = await p2.getMyOrder(a.cctx, placed.orderId);
    expect(d.timeline.map((s) => s.title)).toEqual(["Diajukan", "Dikonfirmasi", "Berangkat", "Tiba", "Selesai"]);
    expect(d.timeline[1]!.state).toBe("current");
    await setTrip(t.db, trip.id, { status: "departed", departedAt: at(1) });
    await t.db.update(trips).set({ status: "arrived", arrivedAt: at(1.5) }).where(eq(trips.id, trip.id));
    await setTrip(t.db, trip.id, { status: "completed", completedAt: at(2), deliveredVolumeL: 5000, recipientName: "Pak Ujang" });
    d = await p2.getMyOrder(a.cctx, placed.orderId);
    expect(d.timeline.every((s) => s.state === "done")).toBe(true);
    const done = d.timeline.at(-1)!;
    expect(done.description).toMatch(/5\.000 L terkirim, diterima Pak Ujang/);
    expect(d.deliveries[0]).toMatchObject({ statusLabel: "Selesai", truckPlate: truck.plate, driverFirstName: "Dadang", canRate: true });
  });

  it("US-P2-03 KP-1 Gagal menampilkan alasan yang layak dilihat pelanggan (bukan istilah internal)", async () => {
    const { a, placed, trip } = await orderWithTrip(t.db, 2);
    await setTrip(t.db, trip.id, { status: "failed", failedAt: at(3), failReason: "customer_absent" });
    const d = await p2.getMyOrder(a.cctx, placed.orderId);
    const last = d.timeline.at(-1)!;
    expect(last).toMatchObject({ title: "Gagal", state: "failed" });
    expect(last.description).toBe("Tidak ada yang menerima di lokasi");
    expect(JSON.stringify(d.timeline)).not.toMatch(/\brit\b/i);
  });

  it("US-P2-03 KP-2 peta posisi truk HANYA selama rit Berangkat menuju alamat pelanggan itu (PTB-54) + perkiraan tiba; tidak ada riwayat posisi", async () => {
    const { a, placed, trip, truck } = await orderWithTrip(t.db, 3);
    // Sebelum berangkat: tidak ada posisi.
    const before = await p2.getTracking(a.cctx, placed.orderId);
    expect(before.active).toBe(false);
    await t.db.insert(gpsPositions).values([
      { tenantId: EQUA_TENANT_ID, truckId: truck.id, source: "gps_device", deviceTime: minutes(-30), lat: -6.9, lng: 107.0 },
      { tenantId: EQUA_TENANT_ID, truckId: truck.id, source: "gps_device", deviceTime: minutes(58), lat: -6.83, lng: 107.13 },
    ]);
    await setTrip(t.db, trip.id, { status: "departed", departedAt: at(0.9) });
    const live = await p2.getTracking({ ...a.cctx, now: at(1) }, placed.orderId);
    if (!live.active) throw new Error("harus aktif");
    expect(live.position).toMatchObject({ lat: -6.83, lng: 107.13 });
    expect(live.eta!.minutes).toBeGreaterThan(0);
    expect(live.truckPlate).toBe(truck.plate);
    // Pelanggan lain tidak dapat melihat posisi pesanan ini.
    const other = await linkedCustomer(t.db);
    await expect(p2.getTracking(other.cctx, placed.orderId)).rejects.toBeInstanceOf(NotFoundError);
    // Setelah Tiba → posisi tidak ditampilkan lagi.
    await setTrip(t.db, trip.id, { status: "arrived", arrivedAt: at(1.2) });
    expect((await p2.getTracking({ ...a.cctx, now: at(1.3) }, placed.orderId)).active).toBe(false);
  });

  it("US-P2-03 KP-3 identitas: nomor polisi & nama DEPAN sopir; tombol hubungi ke kantor (Dispatcher), bukan ponsel sopir", async () => {
    const { a, placed, trip, truck } = await orderWithTrip(t.db, 4);
    await setTrip(t.db, trip.id, { status: "departed", departedAt: at(1) });
    const v = await p2.getTracking({ ...a.cctx, now: at(1.1) }, placed.orderId);
    if (!v.active) throw new Error("harus aktif");
    expect(v.driverFirstName).toBe("Dadang");
    expect(v.truckPlate).toBe(truck.plate);
    expect(v.officePhone).toBe("0263-000000");
    expect(JSON.stringify(v)).not.toMatch(/Supriatna/);
    const d = await p2.getMyOrder(a.cctx, placed.orderId);
    expect(d.officePhone).toBe("0263-000000");
  });

  it("US-P2-03 KP-5 tanpa posisi segar (perangkat mati & ponsel cadangan tidak aktif) → 'posisi sementara tidak tersedia', bukan posisi lama", async () => {
    const { a, placed, trip, truck } = await orderWithTrip(t.db, 5);
    await t.db.insert(gpsPositions).values({ tenantId: EQUA_TENANT_ID, truckId: truck.id, source: "gps_device", deviceTime: at(0.95), lat: -6.84, lng: 107.12 });
    await setTrip(t.db, trip.id, { status: "departed", departedAt: at(0.9) });
    const stale = await p2.getTracking({ ...a.cctx, now: at(3) }, placed.orderId);
    if (!stale.active) throw new Error("harus aktif (rit Berangkat)");
    expect(stale.position).toBeNull();
    expect(stale.message).toBe("Posisi sementara tidak tersedia.");
    expect(stale.eta).toBeNull();
  });

  it("US-P2-03 KP-4 notifikasi otomatis WA (template) + dalam aplikasi pada Dikonfirmasi, Berangkat, Selesai", async () => {
    const { a, placed, trip, truck } = await orderWithTrip(t.db, 6);
    const wa = fakeCloudProvider();
    p2.setCustomerWaProviderForTests(wa.provider);
    await emitEvent("order.status_changed", { orderId: placed.orderId, number: placed.number, customerId: a.customer.id, from: "new", to: "scheduled" }, { now: at(0.6) });
    await setTrip(t.db, trip.id, { status: "departed", departedAt: at(1) });
    await emitEvent("trip.departed", { tripId: trip.id, orderId: placed.orderId, truckId: truck.id, driverUserId: null, departedAt: at(1).toISOString() }, { now: at(1) });
    await setTrip(t.db, trip.id, { status: "completed", completedAt: at(2), deliveredVolumeL: 5000, recipientName: "Bu Imas" });
    await emitEvent(
      "trip.completed",
      { tripId: trip.id, orderId: placed.orderId, customerId: a.customer.id, truckId: truck.id, driverUserId: null, isInternal: false, volumeL: 5000, price: placed.pricePerTank, paymentMethod: "cash", cashReceived: placed.pricePerTank, transferAmount: 0, creditAmount: 0, underpaymentAmount: 0, completedAt: at(2).toISOString(), recordedByOffice: false, lateSync: false },
      { now: at(2) },
    );
    // Event berulang tidak menggandakan pesan.
    await emitEvent("trip.departed", { tripId: trip.id, orderId: placed.orderId, truckId: truck.id, driverUserId: null, departedAt: at(1).toISOString() }, { now: at(1.1) });
    const kinds = (await p2.listMyNotifications(a.cctx)).map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(["order_confirmed", "delivery_departed", "delivery_completed"]));
    expect(kinds.filter((k) => k === "delivery_departed")).toHaveLength(1);
    expect(wa.sent.map((s) => s.templateName)).toEqual(["equa_konfirmasi_pesanan", "equa_status_pengiriman", "equa_struk_pengiriman"]);
    expect(wa.sent.every((s) => s.to === a.phone)).toBe(true);
    const logs = await t.db.select().from(waMessageLogs).where(eq(waMessageLogs.customerId, a.customer.id));
    expect(logs.every((l) => l.provider === "cloud_api" && l.status === "sent")).toBe(true);
  });

  it("US-P2-03 KP-4 tanpa Cloud API (mode tautan) tetap ada notifikasi dalam aplikasi, tanpa klaim WA terkirim", async () => {
    const { a, placed, trip, truck } = await orderWithTrip(t.db, 7);
    await emitEvent("trip.departed", { tripId: trip.id, orderId: placed.orderId, truckId: truck.id, driverUserId: null, departedAt: at(1).toISOString() }, { now: at(1) });
    expect((await p2.listMyNotifications(a.cctx)).some((n) => n.kind === "delivery_departed")).toBe(true);
    const logs = await t.db.select().from(waMessageLogs).where(eq(waMessageLogs.customerId, a.customer.id));
    expect(logs).toHaveLength(0);
  });
});
