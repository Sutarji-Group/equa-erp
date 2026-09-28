import { and, eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { discrepancies, domainEvents, incidents, orders, parameters } from "@/db/schema";
import { addDays } from "@/lib/time";
import { withTx } from "@/server/core/db";
import { emit } from "@/server/core/events";
import { exportReport } from "@/server/core/export";
import { systemContext } from "@/server/core/context";
import * as m3 from "@/server/modules/m3-driver";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { createDeposit } from "../helpers/fixtures";
import { HERE, completeCash, departArrive, driverWorld, expectApplied, expectRejected, finance, notificationsFor, owner } from "./helpers";

describe("M3 — kunci PAR-83, event lintas modul, laporan ekspor", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M3-01 KP-5 keputusan pemilik atas selisih tidak memengaruhi kunci, kecuali PAR-83 aktif: \"Menunggu keputusan pemilik atas selisih besar\" + notifikasi pemilik & Dispatcher", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    const dep = await createDeposit(t.db, { date: addDays(w.date, -1), status: "closed", depositorUserId: w.driver.userId });
    const [disc] = await t.db
      .insert(discrepancies)
      .values({ tenantId: w.truck.tenantId, source: "driver", depositId: dep.id, userId: w.driver.userId, employeeId: w.driver.employeeId, businessDate: addDays(w.date, -1), amount: -600_000, requiresOwnerDecision: true })
      .returning();
    // PAR-83 nonaktif (bawaan): selisih besar tidak mengunci.
    expect((await w.today()).lock).toBeNull();
    // Pemilik mengaktifkan PAR-83 (6.2b) mulai hari ini.
    await t.db.insert(parameters).values({ key: "PAR-83", name: "Kunci rit selisih besar", value: { enabled: true, amount_gte: 500_000 }, effectiveFrom: addDays(w.date, -1), reason: "Uji PTB-62" });
    const view = await w.today();
    expect(view.lock?.kind).toBe("par83");
    expect(view.lock?.message).toMatch(/Menunggu keputusan pemilik atas selisih besar/);
    expectRejected(await w.send(w.sopir, "m3.trip.depart", { tripId: a.id, location: HERE }), /Menunggu keputusan pemilik/);
    await withTx((tx) =>
      emit(tx, "discrepancy.formed", { discrepancyId: disc!.id, depositId: dep.id, sourceType: "driver", amount: -600_000, overThreshold: true, employeeId: w.driver.employeeId }, { ctx: systemContext({ now: new Date() }) }),
    );
    const notes = await notificationsFor(t.db, "discrepancy.trip_lock", disc!.id);
    expect(notes.length).toBeGreaterThanOrEqual(2);
    // Pemilik memutuskan → kunci terbuka.
    await t.db.update(discrepancies).set({ status: "approved", decidedAt: new Date(), updatedAt: new Date() }).where(eq(discrepancies.id, disc!.id));
    expect((await w.today()).lock).toBeNull();
    expectApplied(await w.send(w.sopir, "m3.trip.depart", { tripId: a.id, location: HERE }));
    await t.db.update(parameters).set({ value: { enabled: false, amount_gte: 500_000 } }).where(eq(parameters.key, "PAR-83"));
  });

  it("US-M3-04 KP-5 trip.completed & trip.payment_recorded memuat payload lengkap (metode, seharusnya/diterima/kurang, pelanggan, alamat, pesanan, rit, L2, volume, lokasi & jarak, bukti, tanggal bisnis, terlambat sinkron)", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id));
    const { domainEvents } = await import("@/db/schema");
    const evs = await t.db.select().from(domainEvents).where(eq(domainEvents.objectId, a.id));
    const done = evs.find((e) => e.type === "trip.completed")!.payload as Record<string, unknown>;
    for (const k of ["tripId", "orderId", "orderNumber", "tripNumber", "customerId", "addressId", "truckId", "driverUserId", "price", "paymentMethod", "cashReceived", "underpaymentAmount", "volumeL", "profitCenter", "lat", "lng", "distanceToAddressM", "locationDeviation", "photoAttachmentIds", "signatureAttachmentId", "businessDate", "lateSync", "recordedByOffice", "completedAt"]) {
      expect(done, k).toHaveProperty(k);
    }
    expect(done.profitCenter).toBe("L2");
    expect((done.photoAttachmentIds as string[]).length).toBe(1);
  });

  it("US-M3-02 KP-1 US-M3-03 KP-1 Berangkat & Selesai lewat sinkron memicu handler lintas modul tanpa galat: pesanan M2 Dalam pengiriman → Selesai", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expect((await t.db.select({ status: orders.status }).from(orders).where(eq(orders.id, a.orderId)))[0]!.status).toBe("in_delivery");
    expectApplied(await completeCash(w, a.id));
    expect((await t.db.select({ status: orders.status }).from(orders).where(eq(orders.id, a.orderId)))[0]!.status).toBe("completed");
    const evIds = (await t.db.select({ id: domainEvents.id }).from(domainEvents).where(eq(domainEvents.objectId, a.id))).map((e) => e.id);
    expect(evIds.length).toBeGreaterThanOrEqual(3);
    const failures = await t.db.select().from(incidents).where(and(eq(incidents.objectType, "domain_event"), inArray(incidents.objectId, evIds)));
    expect(failures.map((f) => f.title)).toEqual([]);
  });

  it("laporan M3 dapat diekspor Excel/PDF sesuai izin (rit, pembayaran, setoran, dicatat kantor, kendala)", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id));
    const filters = { from: w.date, to: w.date };
    const trips = await exportReport(seededContext("dispatcher1"), "m3.trips", "xlsx", filters);
    expect(trips.body.byteLength).toBeGreaterThan(1000);
    const pays = await exportReport(finance(), "m3.trip_payments", "pdf", filters);
    expect(pays.body.byteLength).toBeGreaterThan(500);
    await exportReport(owner(), "m3.driver_deposits", "xlsx", filters);
    await exportReport(owner(), "m3.office_entries", "xlsx", filters);
    await exportReport(owner(), "m3.incidents", "csv", filters);
    // Dispatcher tidak melihat uang (SOD-04).
    await expect(exportReport(seededContext("dispatcher1"), "m3.trip_payments", "xlsx", filters)).rejects.toThrow();
    const rows = await m3.driverTripReport(finance(), filters);
    expect(rows.find((r) => r.number === a.number)).toMatchObject({ status: "completed", deliveredVolumeL: 5000 });
  });
});
