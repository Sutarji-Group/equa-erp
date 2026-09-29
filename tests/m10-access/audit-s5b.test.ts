/**
 * Uji regresi temuan audit S5-B (Paket B, NFR): gangguan layanan tercatat dengan durasi + laporan uptime bulanan
 * (NFR-02/NFR-28), jendela pemeliharaan PAR-86 (NFR-01), anonimisasi & retensi data aplikasi pelanggan (NFR-12), dan
 * penyamaran data untuk lingkungan uji (NFR-27).
 */
import { and, eq, like } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { maskPersonalData } from "@/db/mask";
import {
  customerAccountRequests,
  customerAccounts,
  customerAddresses,
  customerSessions,
  customers,
  employees,
  incidents,
  jobRuns,
  otpCodes,
  phoneChangeRequests,
  serviceOutages,
  waMessageLogs,
} from "@/db/schema";
import { customerId, EQUA_TENANT_ID } from "@/db/seed";
import { serverEnv } from "@/lib/env";
import { newId } from "@/lib/ids";
import { addDays, toBusinessDate, wibToUtc } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { exportReport } from "@/server/core/export";
import { MONITOR_JOB_KEY, recordServiceOutage, requestAnonymization, runMonitoring, runRetention, uptimeReport } from "@/server/modules/m10-access";
import { POST as outagePost } from "@/app/api/monitor/outage/route";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";

const today = toBusinessDate(new Date());
const yesterday = addDays(today, -1);
const admin = () => seededContext("admin1");
const owner = () => seededContext("pemilik");

describe("M10/NFR — regresi temuan audit S5-B", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("NFR-02 NFR-28 US-M10-07 KP-2 pemantau eksternal melaporkan gangguan yang pulih → tercatat dengan durasi + insiden; laporan uptime bulanan per layanan", async () => {
    const startedAt = wibToUtc(yesterday, "10:00");
    const endedAt = wibToUtc(yesterday, "10:30");
    // Rute pelapor pemantau eksternal wajib CRON_SECRET.
    const bad = await outagePost(new Request("http://x/api/monitor/outage", { method: "POST", body: JSON.stringify({ service: "web", startedAt, endedAt }) }));
    expect(bad.status).toBe(401);
    const res = await outagePost(
      new Request("http://x/api/monitor/outage", {
        method: "POST",
        headers: { authorization: `Bearer ${serverEnv().CRON_SECRET}`, "content-type": "application/json" },
        body: JSON.stringify({ service: "web", startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString() }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, created: true, durationMinutes: 30, inMaintenanceWindow: false });
    // Idempoten per layanan + mulai.
    expect((await recordServiceOutage({ service: "web", startedAt, endedAt })).created).toBe(false);
    const [row] = await t.db.select().from(serviceOutages).where(eq(serviceOutages.service, "web"));
    expect(row).toMatchObject({ source: "external_monitor", durationMinutes: 30 });
    const inc = await t.db.select().from(incidents).where(and(eq(incidents.kind, "service_down"), like(incidents.objectId, "service_down:web:%")));
    expect(inc.length).toBeGreaterThan(0);
    expect(inc[0]!.title).toMatch(/Web kantor tidak dapat diakses ±30 menit/);
    expect(inc[0]!.detectedAt.getTime()).toBe(startedAt.getTime());

    const month = yesterday.slice(0, 7);
    const report = await uptimeReport(admin(), { month });
    const web = report.rows.find((r) => r.service === "web")!;
    expect(web).toMatchObject({ outages: 1, downtimeMinutes: 30, targetPct: 99.5 });
    expect(web.availabilityPct).toBeLessThan(100);
    expect(report.rows.find((r) => r.service === "sync")).toMatchObject({ outages: 0, downtimeMinutes: 0, availabilityPct: 100 });
    const file = await exportReport(owner(), "m10.uptime_monthly", "xlsx", { month });
    expect(file.rowCount).toBe(3);
  });

  it("NFR-01 PAR-86 gangguan yang seluruhnya di jendela pemeliharaan dicatat sebagai pemeliharaan (log), tanpa insiden, dan tidak mengurangi ketersediaan jam layanan", async () => {
    const startedAt = wibToUtc(yesterday, "00:30");
    const endedAt = wibToUtc(yesterday, "01:30");
    const before = (await t.db.select().from(incidents).where(eq(incidents.kind, "service_down"))).length;
    const { outage } = await recordServiceOutage({ service: "sync", startedAt, endedAt, note: "Pemeliharaan basis data" });
    expect(outage).toMatchObject({ inMaintenanceWindow: true, durationMinutes: 60 });
    expect((await t.db.select().from(incidents).where(eq(incidents.kind, "service_down"))).length).toBe(before);
    const sync = (await uptimeReport(admin(), { month: yesterday.slice(0, 7) })).rows.find((r) => r.service === "sync")!;
    expect(sync).toMatchObject({ maintenanceMinutes: 60, downtimeMinutes: 0, availabilityPct: 100 });
  });

  it("NFR-02 US-M10-07 KP-2 jeda denyut pekerjaan terjadwal → gangguan layanan inti tercatat otomatis (mulai = denyut sukses terakhir, pulih = tick sukses pertama)", async () => {
    const now = wibToUtc(today, "11:00");
    const last = new Date(now.getTime() - 40 * 60_000);
    await t.db.insert(jobRuns).values({ jobKey: MONITOR_JOB_KEY, runKey: "uji-denyut-s5b", status: "succeeded", startedAt: last });
    await runMonitoring(now);
    const [app] = await t.db.select().from(serviceOutages).where(eq(serviceOutages.service, "app"));
    expect(app).toMatchObject({ source: "heartbeat", durationMinutes: 40, inMaintenanceWindow: false });
    expect(app!.startedAt.getTime()).toBe(last.getTime());
    expect(app!.endedAt.getTime()).toBe(now.getTime());
  });

  it("NFR-12 US-M10-06 KP-2 US-P2-01 KP-5 anonimisasi pelanggan juga menghapus jejak aplikasi: OTP, ganti nomor, catatan permintaan, IP/peramban sesi, log WA OTP tanpa id pelanggan", async () => {
    const cust = customerId("PLG-0006");
    const [c] = await t.db.select().from(customers).where(eq(customers.id, cust));
    const phone = c!.waPhone;
    const [acc] = await t.db
      .insert(customerAccounts)
      .values({ tenantId: EQUA_TENANT_ID, phone, status: "linked", customerId: cust, displayName: "Nama Asli", consentPdpAt: new Date() })
      .returning();
    await t.db.insert(otpCodes).values({ phone, purpose: "login", codeHash: "x", expiresAt: new Date(), customerAccountId: acc!.id, requestIp: "203.0.113.5" });
    await t.db.insert(phoneChangeRequests).values({ customerAccountId: acc!.id, oldPhone: phone, newPhone: "6281999000111", expiresAt: new Date() });
    await t.db.insert(customerAccountRequests).values({ tenantId: EQUA_TENANT_ID, customerAccountId: acc!.id, kind: "review", detail: "Nama Asli Lengkap", candidateCustomerId: cust });
    await t.db.insert(customerSessions).values({ customerAccountId: acc!.id, tokenHash: `uji-${newId()}`, expiresAt: new Date(Date.now() + 86_400_000), ip: "203.0.113.5", userAgent: "Peramban Uji" });
    await t.db.insert(waMessageLogs).values({ tenantId: EQUA_TENANT_ID, kind: "otp", customerId: null, toPhone: "6281999000111", renderedText: "Kode EQUA 123456" });

    const r = await requestAnonymization(admin(), { subjectType: "customer", subjectId: cust, reason: "Permintaan hapus akun aplikasi (UU PDP)" });
    expect(r.approval).not.toBeNull();
    await approvals.decide(owner(), r.approval!.id, "approve");

    expect(await t.db.select().from(otpCodes).where(eq(otpCodes.customerAccountId, acc!.id))).toHaveLength(0);
    expect(await t.db.select().from(otpCodes).where(eq(otpCodes.phone, phone))).toHaveLength(0);
    expect((await t.db.select().from(phoneChangeRequests).where(eq(phoneChangeRequests.customerAccountId, acc!.id)))[0]).toMatchObject({ oldPhone: "0", newPhone: "0" });
    expect((await t.db.select().from(customerAccountRequests).where(eq(customerAccountRequests.customerAccountId, acc!.id)))[0]!.detail).toBeNull();
    expect((await t.db.select().from(customerSessions).where(eq(customerSessions.customerAccountId, acc!.id)))[0]).toMatchObject({ ip: null, userAgent: null });
    expect(await t.db.select().from(waMessageLogs).where(eq(waMessageLogs.toPhone, "6281999000111"))).toHaveLength(0);
    expect(await t.db.select().from(waMessageLogs).where(eq(waMessageLogs.toPhone, phone))).toHaveLength(0);
    expect((await t.db.select().from(customerAccounts).where(eq(customerAccounts.id, acc!.id)))[0]!.phone).toBe(`anon-${acc!.id}`);
  });

  it("US-M10-06 KP-3 NFR-12 B-42 retensi: kode OTP > p2.data_retention hari dihapus & nomor ganti-nomor disamarkan; posisi GPS tidak disentuh M10 (milik M12)", async () => {
    const old = new Date(Date.now() - 45 * 86_400_000);
    await t.db.insert(otpCodes).values([
      { phone: "6281888000001", purpose: "login", codeHash: "x", expiresAt: old, createdAt: old },
      { phone: "6281888000002", purpose: "login", codeHash: "x", expiresAt: new Date(), createdAt: new Date() },
    ]);
    const [acc] = await t.db.insert(customerAccounts).values({ tenantId: EQUA_TENANT_ID, phone: "6281888000003" }).returning();
    await t.db.insert(phoneChangeRequests).values({ customerAccountId: acc!.id, oldPhone: "6281888000003", newPhone: "6281888000004", expiresAt: old, createdAt: new Date(Date.now() - 120 * 86_400_000) });
    const r = await runRetention(new Date());
    expect(r.otpPurged).toBeGreaterThanOrEqual(1);
    expect(r.phoneChangesMasked).toBeGreaterThanOrEqual(1);
    expect(r.gpsPurged).toBe(0);
    expect(await t.db.select().from(otpCodes).where(eq(otpCodes.phone, "6281888000001"))).toHaveLength(0);
    expect(await t.db.select().from(otpCodes).where(eq(otpCodes.phone, "6281888000002"))).toHaveLength(1);
    expect((await t.db.select().from(phoneChangeRequests).where(eq(phoneChangeRequests.customerAccountId, acc!.id)))[0]).toMatchObject({ oldPhone: "0", newPhone: "0" });
  });

  it("NFR-27 alat penyamaran (pnpm db:mask) menghapus WA/alamat/nama penerima/identitas karyawan nyata dari DB lingkungan uji; catatan bisnis tetap", async () => {
    const [before] = await t.db.select().from(customers).where(eq(customers.id, customerId("PLG-0001")));
    const countBefore = (await t.db.select().from(customers)).length;
    const summary = await maskPersonalData(t.db);
    expect(summary.customers).toBe(countBefore);
    const [after] = await t.db.select().from(customers).where(eq(customers.id, customerId("PLG-0001")));
    expect(after!.waPhone).not.toBe(before!.waPhone);
    expect(after!.waPhone).toMatch(/^628000\d{7}$/);
    expect(after!.name).toMatch(/^Pelanggan uji /);
    expect(after!.creditStatus).toBe(before!.creditStatus);
    const addrs = await t.db.select().from(customerAddresses);
    expect(addrs.every((a) => a.addressText.startsWith("Alamat uji "))).toBe(true);
    const emps = await t.db.select().from(employees);
    expect(emps.every((e) => e.fullName.startsWith("Karyawan uji ") && e.phone === null)).toBe(true);
    expect(await t.db.select().from(otpCodes)).toHaveLength(0);
  });
});
