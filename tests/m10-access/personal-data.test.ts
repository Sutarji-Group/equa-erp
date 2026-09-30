import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { accessLogs, anonymizationRequests, attachments, customerAddresses, customers, employees, exportLogs, gpsPositions, invoices, tenants, truckDaySummaries, unbilledCharges, users } from "@/db/schema";
import { customerId, employeeId, EQUA_TENANT_ID, truckId, userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";
import { toBusinessDate } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import * as m12 from "@/server/modules/m12-fleet";
import { ForbiddenError, NotFoundError } from "@/server/core/errors";
import { exportReport, registerReport } from "@/server/core/export";
import {
  backupOverview,
  deactivateUser,
  employeeDataAccess,
  getUserDetail,
  listUsers,
  maskCustomerPii,
  recordBackupStatus,
  redactEmployeeValues,
  requestAnonymization,
  resubmitAnonymization,
  runRetention,
  viewPolicy,
} from "@/server/modules/m10-access";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext, testContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { createTestUser, ensureTenant } from "../helpers/factories";
import { notificationsOf } from "./helpers";

const CUSTOMER_ROW = { name: "Depot Air Tirta Sari", contactName: "Pak Rahmat", waPhone: "6281234567890", addressText: "Jl. Raya Cibeber No. 12, Cibeber", lat: -6.9, lng: 107.1 };

describe("US-M10-06 Data pribadi, retensi, dan pencadangan", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M10-06 KP-1 data pribadi pelanggan hanya penuh untuk Dispatcher, Admin Keuangan, Pemilik, dan Sopir/Kernet untuk rit hari itu; peran lain nama tanpa kontak", () => {
    for (const role of ["dispatcher", "finance_admin", "owner"] as const) {
      expect(maskCustomerPii(testContext({ role }), CUSTOMER_ROW), role).toEqual(CUSTOMER_ROW);
    }
    const masked = maskCustomerPii(testContext({ role: "depot_operator" }), CUSTOMER_ROW);
    expect(masked).toMatchObject({ name: "Depot Air Tirta Sari", contactName: null, waPhone: "62•••••••7890", addressText: "Cibeber", lat: null, lng: null });
    expect(maskCustomerPii(testContext({ role: "system_admin" }), CUSTOMER_ROW).waPhone).not.toBe(CUSTOMER_ROW.waPhone);
    expect(viewPolicy(testContext({ role: "driver" })).customer).toBe("name_only");
    expect(viewPolicy(testContext({ role: "driver" }), { ownTripToday: true }).customer).toBe("full");
    expect(maskCustomerPii(testContext({ role: "helper" }), CUSTOMER_ROW, { ownTripToday: true })).toEqual(CUSTOMER_ROW);
  });

  it("US-M10-06 KP-1 data karyawan (PIN, riwayat selisih, ganti rugi) hanya pemilik, admin sistem tanpa nilai selisih, dan yang bersangkutan", () => {
    const emp = employeeId("EQ-009");
    const self = testContext({ role: "driver", employeeId: emp });
    expect(employeeDataAccess(seededContext("pemilik"), emp, "discrepancy_history")).toBe("full");
    expect(employeeDataAccess(seededContext("admin1"), emp, "discrepancy_history")).toBe("without_values");
    expect(employeeDataAccess(self, emp, "restitution")).toBe("full");
    expect(employeeDataAccess(seededContext("dispatcher1"), emp, "restitution")).toBe("none");
    expect(employeeDataAccess(seededContext("keuangan1"), emp, "discrepancy_history")).toBe("none");
    expect(employeeDataAccess(seededContext("admin1"), emp, "pin")).toBe("without_values");
    const row = { date: "2026-09-01", amount: 75_000, reason: "Uang kurang" };
    expect(redactEmployeeValues(row, "without_values")).toEqual({ ...row, amount: null });
    expect(redactEmployeeValues(row, "none")).toBeNull();
  });

  it("US-M10-06 KP-2 anonimisasi: admin sistem mencatat → pemilik menyetujui → nama/WA/alamat/koordinat dihapus di seluruh objek; catatan keuangan tetap", async () => {
    const cust = customerId("PLG-0004");
    const [inv] = await t.db
      .insert(invoices)
      .values({ tenantId: EQUA_TENANT_ID, number: `F-UJI-${newId().slice(-6)}`, kind: "delivery", customerId: cust, issueDate: "2026-08-01", dueDate: "2026-08-15", amount: 200_000, paidAmount: 200_000, outstandingAmount: 0, status: "paid" })
      .returning();
    await expect(requestAnonymization(seededContext("pemilik"), { subjectType: "customer", subjectId: cust, reason: "Permintaan UU PDP" })).rejects.toBeInstanceOf(ForbiddenError);
    const r = await requestAnonymization(seededContext("admin1"), { subjectType: "customer", subjectId: cust, reason: "Surat permintaan penghapusan data 12/09" });
    expect(r.approval).toMatchObject({ type: "anonymization", approverRole: "owner" });
    expect((await t.db.select().from(customers).where(eq(customers.id, cust)))[0]!.name).toBe("Depot Amanah Sukaresmi");
    await approvals.decide(seededContext("pemilik"), r.approval!.id, "approve");
    const c = (await t.db.select().from(customers).where(eq(customers.id, cust)))[0]!;
    expect(c.name).toMatch(/^Pelanggan anonim/);
    expect(c.waPhone).toBe("0");
    expect(c.contactName).toBeNull();
    expect(c.anonymizedAt).not.toBeNull();
    const addr = await t.db.select().from(customerAddresses).where(eq(customerAddresses.customerId, cust));
    expect(addr.every((a) => a.lat === null && a.lng === null && /dianonimkan/.test(a.addressText))).toBe(true);
    const keptInvoice = (await t.db.select().from(invoices).where(eq(invoices.id, inv!.id)))[0]!;
    expect(keptInvoice).toMatchObject({ amount: 200_000, customerId: cust, status: "paid" });
    expect((await t.db.select().from(anonymizationRequests).where(eq(anonymizationRequests.id, r.request.id)))[0]!.status).toBe("executed");
  });

  it("US-M10-06 KP-2 pelanggan dengan piutang terbuka tidak dapat dianonimkan sebelum lunas (PTB-36); pemohon diberi tahu, ajukan ulang setelah lunas", async () => {
    const cust = customerId("PLG-0003");
    const [inv] = await t.db
      .insert(invoices)
      .values({ tenantId: EQUA_TENANT_ID, number: `F-UJI-${newId().slice(-6)}`, kind: "delivery", customerId: cust, issueDate: "2026-09-01", dueDate: "2026-09-15", amount: 300_000, outstandingAmount: 300_000, status: "open" })
      .returning();
    const r = await requestAnonymization(seededContext("admin1"), { subjectType: "customer", subjectId: cust, reason: "Permintaan penghapusan lewat WA" });
    expect(r.request.status).toBe("deferred");
    expect(r.approval).toBeNull();
    expect(r.deferredReason).toMatch(/Rp 300\.000/);
    expect((await t.db.select().from(customers).where(eq(customers.id, cust)))[0]!.anonymizedAt).toBeNull();
    await expect(resubmitAnonymization(seededContext("admin1"), r.request.id)).resolves.toMatchObject({ request: { status: "deferred" } });
    await t.db.update(invoices).set({ paidAmount: 300_000, outstandingAmount: 0, status: "paid" }).where(eq(invoices.id, inv!.id));
    const again = await resubmitAnonymization(seededContext("admin1"), r.request.id);
    expect(again.approval).not.toBeNull();
    await approvals.decide(seededContext("pemilik"), again.approval!.id, "approve");
    expect((await t.db.select().from(customers).where(eq(customers.id, cust)))[0]!.anonymizedAt).not.toBeNull();
  });

  it("US-M10-06 KP-2 PTB-36 rit tempo BELUM DITAGIH (pelanggan tagihan bulanan sebelum faktur terbit) juga piutang terbuka → anonimisasi ditunda", async () => {
    const cust = customerId("PLG-0005");
    const [charge] = await t.db
      .insert(unbilledCharges)
      .values({ tenantId: EQUA_TENANT_ID, customerId: cust, serviceDate: toBusinessDate(new Date()), description: "Rit tempo belum ditagih", amount: 450_000, status: "unbilled" })
      .returning();
    const r = await requestAnonymization(seededContext("admin1"), { subjectType: "customer", subjectId: cust, reason: "Permintaan penghapusan lewat WA" });
    expect(r.request.status).toBe("deferred");
    expect(r.approval).toBeNull();
    expect(r.deferredReason).toMatch(/Rp 450\.000 belum ditagih/);
    expect((await t.db.select().from(customers).where(eq(customers.id, cust)))[0]!.anonymizedAt).toBeNull();
    // Setelah masuk faktur & lunas → dapat diajukan ulang.
    await t.db.update(unbilledCharges).set({ status: "billed" }).where(eq(unbilledCharges.id, charge!.id));
    const again = await resubmitAnonymization(seededContext("admin1"), r.request.id);
    expect(again.approval).not.toBeNull();
  });

  it("US-M10-06 KP-2 karyawan hanya dianonimkan setelah keluar; kredensial dibersihkan, transaksi tetap", async () => {
    await expect(requestAnonymization(seededContext("admin1"), { subjectType: "employee", subjectId: employeeId("EQ-015"), reason: "Permintaan mantan karyawan" })).rejects.toThrow(/masih aktif/);
    await deactivateUser(seededContext("admin1"), { userId: userIdByUsername("sopir7"), reason: "Keluar" });
    await t.db.update(employees).set({ isActive: false, exitDate: toBusinessDate(new Date()) }).where(eq(employees.id, employeeId("EQ-015")));
    const r = await requestAnonymization(seededContext("admin1"), { subjectType: "employee", subjectId: employeeId("EQ-015"), reason: "Permintaan mantan karyawan" });
    await approvals.decide(seededContext("pemilik"), r.approval!.id, "approve");
    const e = (await t.db.select().from(employees).where(eq(employees.id, employeeId("EQ-015"))))[0]!;
    expect(e.fullName).toMatch(/^Karyawan anonim/);
    expect(e.phone).toBeNull();
    expect((await t.db.select().from(users).where(eq(users.id, userIdByUsername("sopir7"))))[0]!.pinHash).toBeNull();
    expect((await notificationsOf(t.db, "pemilik", "anonymization.executed")).length).toBeGreaterThanOrEqual(1);
  });

  it("US-M10-06 KP-3 US-M12-01 KP-6 retensi otomatis: log akses 1 tahun & GPS mentah 12 bulan dihapus lewat jalur retensi (ringkasan dulu); foto > 2 tahun diarsipkan & tetap dapat dibuka", async () => {
    const old = new Date(Date.now() - 800 * 86_400_000);
    const [photo] = await t.db
      .insert(attachments)
      .values({ tenantId: EQUA_TENANT_ID, storageKey: "uji/foto-lama.jpg", contentType: "image/jpeg", sizeBytes: 1000, kind: "delivery_photo", createdAt: old })
      .returning();
    const [fresh] = await t.db
      .insert(attachments)
      .values({ tenantId: EQUA_TENANT_ID, storageKey: "uji/foto-baru.jpg", contentType: "image/jpeg", sizeBytes: 1000, kind: "delivery_photo" })
      .returning();
    await t.db.insert(gpsPositions).values([
      { tenantId: EQUA_TENANT_ID, truckId: truckId("T1"), source: "gps_device", deviceTime: new Date(Date.now() - 400 * 86_400_000), lat: -6.8, lng: 107.1 },
      { tenantId: EQUA_TENANT_ID, truckId: truckId("T1"), source: "gps_device", deviceTime: new Date(Date.now() - 30 * 86_400_000), lat: -6.8, lng: 107.1 },
    ]);
    await t.db.insert(accessLogs).values({ tenantId: EQUA_TENANT_ID, event: "logout", occurredAt: new Date(Date.now() - 370 * 86_400_000) });
    const r = await runRetention(new Date());
    expect(r.policy).toMatchObject({ accessLogYears: 1, photoYears: 2, accountingYears: 10, gpsMonths: 12 });
    // B-42: posisi GPS mentah dimiliki M12 — M10 tidak menghapusnya; M12 memastikan ringkasan lalu menghapus.
    expect(r.gpsPurged).toBe(0);
    expect((await t.db.select().from(gpsPositions)).length).toBe(2);
    const m12Purge = await m12.purgeExpiredPositions(new Date());
    expect(m12Purge.purged).toBe(1);
    expect(r.accessLogsPurged).toBeGreaterThanOrEqual(1);
    expect(r.photosArchived).toBeGreaterThanOrEqual(1);
    const rows = await t.db.select().from(attachments).where(eq(attachments.id, photo!.id));
    expect(rows[0]!.archivedAt).not.toBeNull();
    expect(rows[0]!.storageKey).toBe("uji/foto-lama.jpg");
    expect((await t.db.select().from(attachments).where(eq(attachments.id, fresh!.id)))[0]!.archivedAt).toBeNull();
    expect((await t.db.select().from(gpsPositions)).length).toBe(1);
    // US-M12-01 KP-6 PTB-33: ringkasan hari truk dipastikan SEBELUM posisi mentahnya dihapus (jalur M12).
    const oldDay = toBusinessDate(new Date(Date.now() - 400 * 86_400_000));
    const summaries = await t.db.select().from(truckDaySummaries).where(and(eq(truckDaySummaries.truckId, truckId("T1")), eq(truckDaySummaries.businessDate, oldDay)));
    expect(summaries).toHaveLength(1);
  });

  it("US-M10-06 KP-4 status cadangan terakhir tampil ke admin sistem & pemilik; uji pemulihan dicatat (RPO/RTO); gagal diberitahukan", async () => {
    const now = new Date();
    const before = await backupOverview(seededContext("admin1"));
    await expect(recordBackupStatus(seededContext("pemilik"), { kind: "daily", status: "success", startedAt: now })).rejects.toBeInstanceOf(ForbiddenError);
    await recordBackupStatus(seededContext("admin1"), { kind: "daily", status: "success", startedAt: new Date(now.getTime() - 3_600_000), finishedAt: now, sizeBytes: 12_000_000, location: "Neon PITR" });
    await expect(recordBackupStatus(seededContext("admin1"), { kind: "restore_test", status: "success", startedAt: now })).rejects.toThrow(/RPO/);
    await recordBackupStatus(seededContext("admin1"), { kind: "restore_test", status: "success", startedAt: new Date(now.getTime() - 7_200_000), rpoMinutes: 45, rtoMinutes: 150, notes: "Uji pemulihan semester 1" });
    await recordBackupStatus(seededContext("admin1"), { kind: "monthly", status: "failed", startedAt: new Date(now.getTime() - 60_000), notes: "Kuota penyimpanan penuh" });
    const view = await backupOverview(seededContext("pemilik"));
    expect(view.lastDaily?.status).toBe("success");
    expect(view.lastRestoreTest).toMatchObject({ rpoMinutes: 45, rtoMinutes: 150 });
    expect(view.flags.dailyStale).toBe(false);
    expect(view.restoreTestsLast12Months).toBe(before.restoreTestsLast12Months + 1);
    expect(view.flags.restoreTestsBelowTarget).toBe(view.restoreTestsLast12Months < view.policy.restore_tests_per_year);
    expect(view.policy.restore_tests_per_year).toBe(2);
    expect((await notificationsOf(t.db, "pemilik", "backup.failed")).length).toBe(1);
  });

  it("US-M10-06 KP-5 ekspor data pribadi pelanggan hanya pemilik/Admin Keuangan dengan tujuan tercatat; seluruh ekspor tercatat di log akses", async () => {
    registerReport({
      key: "uji.m10_pelanggan",
      title: "Uji pelanggan",
      module: "m10",
      permission: "m1.customer.read",
      containsPii: true,
      columns: [
        { key: "name", header: "Nama" },
        { key: "waPhone", header: "WA", pii: "phone" },
      ],
      fetch: async (_ctx, _f, { tx }) => ({ rows: await tx.select({ name: customers.name, waPhone: customers.waPhone }).from(customers).limit(3) }),
    });
    await expect(exportReport(seededContext("pemilik"), "uji.m10_pelanggan", "csv", {})).rejects.toThrow(/[Tt]ujuan/);
    const full = await exportReport(seededContext("keuangan1"), "uji.m10_pelanggan", "csv", {}, "Konfirmasi saldo piutang akhir bulan");
    expect(full.containsPersonalData).toBe(true);
    const stripped = await exportReport(seededContext("dispatcher1"), "uji.m10_pelanggan", "csv", {});
    expect(stripped.containsPersonalData).toBe(false);
    expect(stripped.body.toString("utf8")).not.toMatch(/628\d{6,}/);
    const logs = await t.db.select().from(exportLogs).where(eq(exportLogs.reportKey, "uji.m10_pelanggan"));
    expect(logs.find((l) => l.containsPersonalData)!.purpose).toBe("Konfirmasi saldo piutang akhir bulan");
    const access = await t.db.select().from(accessLogs).where(and(eq(accessLogs.event, "export"), eq(accessLogs.userId, userIdByUsername("dispatcher1"))));
    expect(access.length).toBeGreaterThanOrEqual(1);
  });

  it("US-M10-06 KP-6 data terpisah per tenant (NFR-30): pengguna tenant mitra tidak terlihat di daftar EQUA dan sebaliknya", async () => {
    const partnerId = newId();
    await ensureTenant(t.db, partnerId, `MITRA-${partnerId.slice(-4)}`, "partner");
    const partner = await createTestUser(t.db, { role: "partner_owner", tenantId: partnerId, scope: { tenantIds: [partnerId] } });
    const list = await listUsers(seededContext("admin1"), { status: "all" });
    expect(list.some((u) => u.id === partner.userId)).toBe(false);
    await expect(getUserDetail(seededContext("admin1"), partner.userId)).rejects.toBeInstanceOf(NotFoundError);
    expect((await t.db.select().from(tenants).where(eq(tenants.id, partnerId)))[0]!.kind).toBe("partner");
  });
});
