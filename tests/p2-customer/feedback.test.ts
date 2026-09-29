import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { complaints, invoices, notifications, trips } from "@/db/schema";
import { EQUA_TENANT_ID, userIdByUsername } from "@/db/seed";
import { isHardeningViolation } from "@/db/hardening";
import { addDays, monthOf } from "@/lib/time";
import { withTx } from "@/server/core/db";
import { ForbiddenError } from "@/server/core/errors";
import { readAttachment } from "@/server/core/storage";
import * as p2 from "@/server/modules/p2-customer";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { at, dispatcher, enableApp, finance, linkedCustomer, owner, setTrip, TODAY, truckWithDriver } from "./helpers";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);

async function completedDelivery(db: Parameters<typeof linkedCustomer>[0], dayOffset = 1, driverName = "Ujang Suryana") {
  const a = await linkedCustomer(db);
  const [addr] = await p2.listMyAddresses(a.cctx);
  const placed = await p2.placeOrder(a.cctx, { addressId: addr!.id, tankCount: 1, date: addDays(TODAY, dayOffset), slot: "morning", paymentMethod: "cash" });
  const [trip] = await db.select().from(trips).where(eq(trips.orderId, placed.orderId));
  const truck = await truckWithDriver(db, driverName);
  await setTrip(db, trip!.id, { truckId: truck.id, driverEmployeeId: truck.driver.employeeId, status: "completed", completedAt: at(2), deliveredVolumeL: 5000 });
  return { a, placed, trip: trip!, truck };
}

describe("P2 Penilaian & keluhan (US-P2-06)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(async () => {
    bootstrapForTests();
    await enableApp();
  });

  it("US-P2-06 KP-1 nilai 1–5 + komentar sekali per pengiriman Selesai (dapat dilewati); terkait rit, truk, sopir", async () => {
    const { a, trip, truck } = await completedDelivery(t.db);
    await expect(p2.rateDelivery(a.cctx, trip.id, { rating: 6 })).rejects.toThrow(/1–5/);
    const r = await p2.rateDelivery(a.cctx, trip.id, { rating: 4, comment: "Sopir ramah, air jernih" });
    expect(r).toMatchObject({ tripId: trip.id, truckId: truck.id, driverEmployeeId: truck.driver.employeeId, rating: 4 });
    await expect(p2.rateDelivery(a.cctx, trip.id, { rating: 5 })).rejects.toThrow(/sudah Anda nilai/);
    const d = await p2.getMyOrder(a.cctx, trip.orderId);
    expect(d.deliveries[0]).toMatchObject({ rating: 4, canRate: false });
    // Belum Selesai → belum dapat dinilai.
    const b = await linkedCustomer(t.db);
    const [addrB] = await p2.listMyAddresses(b.cctx);
    const o = await p2.placeOrder(b.cctx, { addressId: addrB!.id, tankCount: 1, date: addDays(TODAY, 2), slot: "morning", paymentMethod: "cash" });
    const [tb] = await t.db.select().from(trips).where(eq(trips.orderId, o.orderId));
    await expect(p2.rateDelivery(b.cctx, tb!.id, { rating: 5 })).rejects.toThrow(/setelah air diterima/);
  });

  it("US-P2-06 KP-1 agregat per truk & sopir untuk kinerja M9 (US-M9-05); komentar mentah hanya pemilik & Dispatcher", async () => {
    const x = await completedDelivery(t.db, 3, "Engkos Kosasih");
    await p2.rateDelivery(x.a.cctx, x.trip.id, { rating: 2, comment: "Terlambat 2 jam" });
    const month = monthOf(TODAY);
    const agg = await p2.ratingAggregates(t.db, { tenantId: EQUA_TENANT_ID, from: `${month}-01`, to: addDays(TODAY, 30) });
    const truckRow = agg.trucks.find((r) => r.key === x.truck.id)!;
    expect(truckRow).toMatchObject({ count: 1, average: 2, lowCount: 1 });
    expect(agg.drivers.find((r) => r.label === "Engkos Kosasih")).toMatchObject({ count: 1, average: 2 });
    expect(JSON.stringify(agg)).not.toMatch(/Terlambat 2 jam/);

    const ov = await p2.ratingOverview(owner(), { month });
    expect(ov.comments.some((c) => c.comment === "Terlambat 2 jam")).toBe(true);
    expect((await p2.ratingOverview(dispatcher(), { month })).comments.length).toBeGreaterThan(0);
    await expect(p2.ratingOverview(finance(), { month })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("US-P2-06 KP-2 keluhan (jenis, teks, foto, terkait pesanan/rit) → kotak Dispatcher (operasional) / Admin Keuangan (tagihan); tanggapan pertama ≤ 24 jam layanan (PAR-75)", async () => {
    const { a, trip } = await completedDelivery(t.db, 4);
    await expect(p2.submitComplaint(a.cctx, { kind: "lateness", description: "pendek" })).rejects.toThrow(/minimal 10/);
    const ops = await p2.submitComplaint(a.cctx, { kind: "lateness", description: "Truk datang jam 13, padahal slot pagi", tripId: trip.id, photo: { blob: JPEG, contentType: "image/jpeg", name: "bukti.jpg" } });
    expect(ops).toMatchObject({ assignedRole: "dispatcher", status: "submitted", orderId: trip.orderId, tripId: trip.id });
    // PAR-07 05.00–22.00: 10.00 + 12 jam (s.d. 22.00) + 12 jam esok (05.00–17.00) = Selasa 17.00 WIB.
    expect(ops.dueAt!.toISOString()).toBe("2026-10-06T10:00:00.000Z");
    expect(ops.photoAttachmentId).not.toBeNull();
    const photo = await readAttachment(dispatcher(), ops.photoAttachmentId!);
    expect(photo.row.kind).toBe("complaint_photo");
    const bill = await p2.submitComplaint(a.cctx, { kind: "billing", description: "Tagihan bulan lalu dobel dua kali" });
    expect(bill.assignedRole).toBe("finance_admin");

    const notif = await t.db.select().from(notifications).where(eq(notifications.event, "customer_app.complaint_submitted"));
    expect(notif.some((n) => n.objectId === ops.id && n.recipientUserId === userIdByUsername("dispatcher1"))).toBe(true);
    expect(notif.some((n) => n.objectId === bill.id && n.recipientUserId === userIdByUsername("keuangan1"))).toBe(true);
    expect(notif.some((n) => n.objectId === bill.id && n.recipientUserId === userIdByUsername("dispatcher1"))).toBe(false);

    // Kotak bawaan per peran.
    expect((await p2.listComplaints(dispatcher())).map((c) => c.id)).toContain(ops.id);
    expect((await p2.listComplaints(dispatcher())).map((c) => c.id)).not.toContain(bill.id);
    expect((await p2.listComplaints(finance())).map((c) => c.id)).toContain(bill.id);
    expect((await p2.listComplaints(owner())).map((c) => c.id)).toEqual(expect.arrayContaining([ops.id, bill.id]));

    // Dispatcher tidak menanggapi kotak tagihan; tanggapan tampil ke pelanggan.
    await expect(p2.respondComplaint(dispatcher(), bill.id, { response: "Kami cek dulu ya" })).rejects.toBeInstanceOf(ForbiddenError);
    const responded = await p2.respondComplaint(dispatcher(at(1)), ops.id, { response: "Mohon maaf, truk tertahan antrean pengisian. Besok kami utamakan." });
    expect(responded).toMatchObject({ status: "responded", firstResponseBy: userIdByUsername("dispatcher1") });
    const mine = await p2.getMyComplaint(a.cctx, ops.id);
    expect(mine).toMatchObject({ statusLabel: "Ditanggapi", hasPhoto: true });
    expect(mine.updates[0]!.note).toMatch(/Mohon maaf/);
    expect((await p2.listMyNotifications(a.cctx)).some((n) => n.kind === "complaint_update")).toBe(true);

    // Lewat tenggat tanpa tanggapan → notifikasi sekali (job) ke kotak & pemilik.
    expect(await withTx((tx) => p2.notifyOverdueComplaints(tx, at(40)))).toBeGreaterThanOrEqual(1);
    expect(await withTx((tx) => p2.notifyOverdueComplaints(tx, at(41)))).toBe(0);
    const overdue = await t.db.select().from(notifications).where(and(eq(notifications.event, "customer_app.complaint_overdue"), eq(notifications.objectId, bill.id)));
    expect(overdue.some((n) => n.recipientUserId === userIdByUsername("pemilik"))).toBe(true);
    expect(overdue.some((n) => n.recipientUserId === userIdByUsername("keuangan1"))).toBe(true);
    expect((await p2.listComplaints(finance())).find((c) => c.id === bill.id)!.overdue).toBe(false);
  });

  it("US-P2-06 KP-2 keluhan volume dapat memicu sengketa faktur (7.5.6) oleh Admin Keuangan; pindah kotak beralasan", async () => {
    const { a, trip } = await completedDelivery(t.db, 5);
    const [inv] = await t.db
      .insert(invoices)
      .values({ tenantId: EQUA_TENANT_ID, number: "F-26-790001", kind: "delivery", customerId: a.customer.id, tripId: trip.id, issueDate: TODAY, dueDate: addDays(TODAY, 14), amount: 300_000, outstandingAmount: 300_000, status: "open" })
      .returning();
    const c = await p2.submitComplaint(a.cctx, { kind: "volume", description: "Air yang masuk tandon hanya sekitar 4.000 liter", tripId: trip.id });
    const detail = await p2.getComplaint(dispatcher(), c.id);
    expect(detail.disputeCandidates.map((x) => x.id)).toContain(inv!.id);
    await expect(p2.disputeInvoiceFromComplaint(dispatcher(), c.id, { invoiceId: inv!.id, note: "Volume dipersoalkan pelanggan" })).rejects.toBeInstanceOf(ForbiddenError);
    await p2.reassignComplaint(dispatcher(at(1)), c.id, { box: "finance_admin", note: "Perlu sengketa faktur" });
    await p2.disputeInvoiceFromComplaint(finance(at(2)), c.id, { invoiceId: inv!.id, note: "Volume dipersoalkan pelanggan, cek meter truk" });
    const [after] = await t.db.select().from(invoices).where(eq(invoices.id, inv!.id));
    expect(after!.disputeStatus).toBe("disputed");
    const view = await p2.getComplaint(finance(), c.id);
    expect(view.box).toBe("finance_admin");
    expect(view.actions.map((x) => x.action)).toEqual(["reassign", "invoice_dispute"]);
  });

  it("US-P2-06 KP-3 keluhan tidak dapat dihapus; ditutup dengan penyelesaian tercatat; laporan bulanan per jenis & per truk", async () => {
    const { a, trip, truck } = await completedDelivery(t.db, 6);
    const c = await p2.submitComplaint(a.cctx, { kind: "attitude", description: "Kernet berbicara kasar saat mengisi tandon", tripId: trip.id });
    await expect(t.db.execute(sql`delete from complaints where id = ${c.id}`)).rejects.toSatisfy((e: unknown) => isHardeningViolation(e));
    await expect(p2.resolveComplaint(dispatcher(), c.id, { resolution: "ok" })).rejects.toThrow(/minimal 5/);
    const done = await p2.resolveComplaint(dispatcher(at(2)), c.id, { resolution: "Kernet sudah ditegur; permintaan maaf disampaikan lewat telepon." });
    expect(done).toMatchObject({ status: "done", resolvedBy: userIdByUsername("dispatcher1") });
    expect(done.resolution).toMatch(/ditegur/);
    await expect(p2.respondComplaint(dispatcher(), c.id, { response: "tambahan tanggapan" })).rejects.toThrow(/sudah selesai/);
    expect((await p2.getMyComplaint(a.cctx, c.id)).statusLabel).toBe("Selesai");
    const [row] = await t.db.select().from(complaints).where(eq(complaints.id, c.id));
    expect(row).toBeDefined();

    const rep = await p2.complaintReport(owner(), { month: monthOf(TODAY) });
    expect(rep.byKind.find((k) => k.kind === "attitude")!.count).toBeGreaterThanOrEqual(1);
    expect(rep.byTruck.find((x) => x.truckId === truck.id)).toMatchObject({ count: 1, kinds: { attitude: 1 } });
    expect(rep.total).toBeGreaterThanOrEqual(1);
    await expect(p2.complaintReport(ctxAccountant(), { month: monthOf(TODAY) })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

function ctxAccountant() {
  return { ...owner(), roles: ["accountant" as const], userId: userIdByUsername("akuntan") };
}

