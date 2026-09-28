import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { accessLogs, auditLogs } from "@/db/schema";
import { deviceId, EQUA_TENANT_ID, userIdByUsername } from "@/db/seed";
import { isHardeningViolation } from "@/db/hardening";
import { toBusinessDate } from "@/lib/time";
import { describeAudit, queryForActor, verifyAuditChain } from "@/server/core/audit";
import { withTx } from "@/server/core/db";
import { ForbiddenError } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { exportReport } from "@/server/core/export";
import { createUser, listAccessLogs, runRetention, updateDeviceAssignment } from "@/server/modules/m10-access";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { fieldDevice } from "../helpers/field";
import { newEmployee, uniqueName } from "./helpers";

describe("US-M10-05 Jejak audit", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M10-05 KP-1 setiap perubahan mencatat pelaku (pengguna, peran, perangkat), waktu perangkat & server, nilai lama/baru, alasan, sumber", async () => {
    const emp = await newEmployee(t.db);
    const r = await createUser(seededContext("admin1"), { employeeId: emp, username: uniqueName("aud"), role: "dispatcher", reason: "Rekrutmen dispatcher" });
    const [row] = await t.db.select().from(auditLogs).where(eq(auditLogs.objectId, r.user.id));
    expect(row).toMatchObject({ actorUserId: userIdByUsername("admin1"), actorRoles: ["system_admin"], source: "web", objectType: "user", action: "create", reason: "Rekrutmen dispatcher" });
    expect(row!.serverTime).toBeInstanceOf(Date);
    expect((row!.after as { username: string }).username).toBe(r.user.username);

    // Aksi dari aplikasi lapangan: perangkat & waktu perangkat ikut tercatat.
    const hp = await fieldDevice("HP-T2");
    const sopir = await hp.login("sopir2");
    const deviceTime = new Date(Date.now() - 2 * 60_000);
    const res = await hp.push([hp.command(sopir, "core.support.report", { subject: "Aplikasi lambat sekali", description: "Tombol berangkat lama merespons di jalan." }, { deviceTime })]);
    expect(res.results[0]!.status).toBe("applied");
    const fieldRow = (await t.db.select().from(auditLogs).where(eq(auditLogs.objectType, "support_ticket"))).at(-1)!;
    expect(fieldRow).toMatchObject({ source: "field", actorDeviceId: deviceId("HP-T2"), actorUserId: userIdByUsername("sopir2") });
    expect(fieldRow.deviceTime?.toISOString()).toBe(deviceTime.toISOString());
  });

  it("US-M10-05 KP-2 catatan tidak dapat diubah/dihapus siapa pun; integritas terverifikasi (rantai hash)", async () => {
    const err = await t.db.execute(sql`update audit_logs set reason = 'diubah' where seq = 1`).catch((e: unknown) => e);
    expect(isHardeningViolation(err)).toBe(true);
    const del = await t.db.execute(sql`delete from audit_logs where seq = 1`).catch((e: unknown) => e);
    expect(isHardeningViolation(del)).toBe(true);
    const check = await verifyAuditChain(t.db);
    expect(check.ok).toBe(true);
    expect(check.checked).toBeGreaterThan(0);
  });

  it("US-M10-05 KP-3 pencarian per objek, pengguna, rentang waktu, jenis tindakan — ditampilkan dalam kalimat bahasa lapangan", async () => {
    await updateDeviceAssignment(seededContext("admin1"), { deviceId: deviceId("HP-CAD-2"), isSpare: false, reason: "Dijadikan ponsel tetap T7" });
    const today = toBusinessDate(new Date());
    const byObject = await queryForActor(seededContext("pemilik"), { objectType: "device", objectId: deviceId("HP-CAD-2") });
    expect(byObject.length).toBeGreaterThanOrEqual(1);
    const byUser = await queryForActor(seededContext("pemilik"), { actorUserId: userIdByUsername("admin1"), action: "update", from: new Date(`${today}T00:00:00+07:00`) });
    expect(byUser.every((r) => r.actorUserId === userIdByUsername("admin1") && r.action === "update")).toBe(true);
    const sentence = describeAudit(byObject[0]!, { actorName: "Fajar Nugraha" });
    expect(sentence).toBe("status cadangan perangkat diubah dari aktif menjadi nonaktif oleh Fajar Nugraha (Admin sistem), alasan: Dijadikan ponsel tetap T7");
  });

  it("US-M10-05 KP-4 log akses terpisah (login, gagal login, perangkat, ekspor, penolakan) — hanya pemilik & admin sistem; disimpan 1 tahun (PAR-29)", async () => {
    await exportReport(seededContext("pemilik"), "m10.devices", "xlsx");
    const logs = await listAccessLogs(seededContext("pemilik"), { event: "export" });
    expect(logs.some((l) => l.userName === "H. Ahmad Syarifudin" && l.eventLabel === "Ekspor data")).toBe(true);
    await expect(listAccessLogs(seededContext("dispatcher1"))).rejects.toBeInstanceOf(ForbiddenError);
    await t.db.insert(accessLogs).values([
      { tenantId: EQUA_TENANT_ID, event: "login_success", userId: userIdByUsername("keuangan1"), occurredAt: new Date(Date.now() - 400 * 86_400_000) },
      { tenantId: EQUA_TENANT_ID, event: "login_success", userId: userIdByUsername("keuangan1"), occurredAt: new Date(Date.now() - 300 * 86_400_000) },
    ]);
    const r = await runRetention(new Date());
    expect(r.accessLogsPurged).toBe(1);
    const left = await t.db.select().from(accessLogs).where(eq(accessLogs.userId, userIdByUsername("keuangan1")));
    expect(left.every((l) => l.occurredAt.getTime() > Date.now() - 366 * 86_400_000)).toBe(true);
  });

  it("US-M10-05 KP-5 tindakan otomatis sistem dicatat dengan pelaku 'Sistem' dan aturan pemicunya", async () => {
    const emp = await newEmployee(t.db);
    const r = await createUser(seededContext("admin1"), { employeeId: emp, username: uniqueName("sys"), role: "dispatcher", reason: "Dispatcher sementara" });
    const { decide } = await import("@/server/core/approvals");
    await decide(seededContext("pemilik"), r.approval!.id, "approve");
    await withTx((tx) => emit(tx, "employee.exited", { employeeId: emp, exitDate: toBusinessDate(new Date()), tenantId: EQUA_TENANT_ID }, { tenantId: EQUA_TENANT_ID }));
    const row = (await t.db.select().from(auditLogs).where(eq(auditLogs.objectId, r.user.id))).find((a) => a.action === "deactivate")!;
    expect(row.source).toBe("system");
    expect(row.actorUserId).toBeNull();
    expect(describeAudit(row)).toMatch(/^Pengguna .* dinonaktifkan oleh Sistem \(aturan BR-37\)/);
  });

  it("US-M10-05 KP-6 ekspor jejak audit & log akses oleh pemilik; akuntan hanya objek keuangan; admin sistem tanpa nilai keuangan", async () => {
    const xlsx = await exportReport(seededContext("pemilik"), "core.audit_log", "xlsx", { objectType: "user" });
    expect(xlsx.rowCount).toBeGreaterThan(0);
    const acc = await exportReport(seededContext("pemilik"), "m10.access_log", "pdf", {});
    expect(acc.contentType).toBe("application/pdf");
    await expect(exportReport(seededContext("admin1"), "core.audit_log", "xlsx")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(exportReport(seededContext("admin1"), "m10.access_log", "xlsx")).rejects.toBeInstanceOf(ForbiddenError);
    const accountant = await queryForActor(seededContext("akuntan"), { objectType: ["user", "deposit"] });
    expect(accountant.every((r) => r.objectType === "deposit")).toBe(true);
  });
});
