import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, dataSignoffs, devices, employees, sessions, userRoles, users, userScopes } from "@/db/schema";
import { deviceId, employeeId, EQUA_TENANT_ID, outletId, truckId, userIdByUsername, waterSourceId } from "@/db/seed";
import { newId } from "@/lib/ids";
import { addDays, toBusinessDate } from "@/lib/time";
import { buildActorContext } from "@/server/core/actor";
import * as approvals from "@/server/core/approvals";
import { createSession } from "@/server/core/auth";
import { withTx } from "@/server/core/db";
import { ConflictError, DomainError, ForbiddenError, ValidationError } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import * as params from "@/server/core/params";
import { permissionsForRoles, ROLE_CATALOG } from "@/server/core/rbac";
import {
  accessChangesOn,
  accessReviewList,
  createUser,
  dailyAccessSummary,
  deactivateUser,
  getUserDetail,
  initialAccountsStatus,
  listUsers,
  markAccessReviewed,
  prepareInitialAccountsSignoff,
  quarterOf,
  requestReactivation,
  requestRoleChange,
  requestScopeExtension,
  revokeRole,
  revokeScope,
  runExitDateSweep,
  signInitialAccounts,
} from "@/server/modules/m10-access";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { accessLogsOf, auditOf, newEmployee, notificationsOf, uniqueName } from "./helpers";

const admin = () => seededContext("admin1");
const owner = () => seededContext("pemilik");

describe("US-M10-01 Pengguna, peran, dan lingkup akses", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  async function approve(requestId: string) {
    return approvals.decide(owner(), requestId, "approve");
  }

  async function activeUser(role: Parameters<typeof createUser>[1]["role"], scopes: { type: "truck" | "outlet" | "water_source" | "tenant"; refId: string }[] = []) {
    const emp = await newEmployee(t.db);
    const r = await createUser(admin(), { employeeId: emp, username: uniqueName("u"), role, scopes, reason: "Karyawan baru bergabung" });
    await approve(r.approval!.id);
    return { userId: r.user.id, employeeId: emp };
  }

  it("US-M10-01 KP-1 peran dari katalog tetap; hak hanya lewat peran (dua pengguna berperan sama → hak identik)", async () => {
    expect(Object.keys(ROLE_CATALOG)).toHaveLength(12);
    const emp = await newEmployee(t.db);
    await expect(createUser(admin(), { employeeId: emp, username: uniqueName("x"), role: "superadmin" as never, reason: "Peran di luar katalog" })).rejects.toBeInstanceOf(ValidationError);
    const a = await activeUser("dispatcher");
    const b = await activeUser("dispatcher");
    const ca = await buildActorContext(t.db, a.userId, { source: "web" });
    const cb = await buildActorContext(t.db, b.userId, { source: "web" });
    expect(permissionsForRoles(ca.roles)).toEqual(permissionsForRoles(cb.roles));
    expect(permissionsForRoles(ca.roles)).toContain("m2.order.create");
  });

  it("US-M10-01 KP-2 akun wajib terikat tepat satu karyawan: tanpa karyawan ditolak, akun kedua ditolak, nama pengguna unik", async () => {
    await expect(createUser(admin(), { employeeId: newId(), username: "kasir1baru", role: "store_cashier", scopes: [{ type: "outlet", refId: outletId("TK1") }], reason: "Akun tanpa karyawan" })).rejects.toThrow(/BR-36/);
    const emp = await newEmployee(t.db);
    const username = uniqueName("dua");
    await createUser(admin(), { employeeId: emp, username, role: "dispatcher", reason: "Dispatcher baru" });
    const second = createUser(admin(), { employeeId: emp, username: uniqueName("dua"), role: "dispatcher", reason: "Akun kedua" });
    await expect(second).rejects.toBeInstanceOf(ConflictError);
    await expect(second).rejects.toThrow(/Satu orang satu akun/);
    const emp2 = await newEmployee(t.db);
    await expect(createUser(admin(), { employeeId: emp2, username: username.toUpperCase(), role: "dispatcher", reason: "Nama sama" })).rejects.toThrow(/sudah dipakai/);
    const exited = await newEmployee(t.db, { exitDate: toBusinessDate(new Date()) });
    await expect(createUser(admin(), { employeeId: exited, username: uniqueName("k"), role: "dispatcher", reason: "Sudah keluar" })).rejects.toThrow(/keluar/);
  });

  it("US-M10-01 KP-3 lingkup mengikat data: sopir → truk, kasir → toko, operator produksi → sumber air, kantor → tenant; peran lapangan tidak berlingkup tenant", async () => {
    const emp = await newEmployee(t.db);
    await expect(createUser(admin(), { employeeId: emp, username: uniqueName("s"), role: "driver", reason: "Sopir tanpa truk" })).rejects.toThrow(/wajib diberi lingkup truk/);
    await expect(
      createUser(admin(), { employeeId: emp, username: uniqueName("s"), role: "driver", scopes: [{ type: "tenant", refId: EQUA_TENANT_ID }, { type: "truck", refId: truckId("T2") }], reason: "Sopir lintas lingkup" }),
    ).rejects.toThrow(/tidak sesuai peran/);
    await expect(createUser(admin(), { employeeId: emp, username: uniqueName("k"), role: "store_cashier", scopes: [{ type: "outlet", refId: outletId("D01") }], reason: "Kasir di depot" })).rejects.toThrow(/toko/);

    const sopir = await activeUser("driver", [{ type: "truck", refId: truckId("T2") }]);
    const ctx = await buildActorContext(t.db, sopir.userId, { source: "field" });
    expect(ctx.scope).toMatchObject({ truckIds: [truckId("T2")], tenantIds: [] });
    const prod = await activeUser("production_operator", [{ type: "water_source", refId: waterSourceId("SA2") }]);
    expect((await buildActorContext(t.db, prod.userId, { source: "field" })).scope.sourceIds).toEqual([waterSourceId("SA2")]);
    const disp = await activeUser("dispatcher");
    expect((await buildActorContext(t.db, disp.userId, { source: "web" })).scope.tenantIds).toEqual([EQUA_TENANT_ID]);
  });

  it("US-M10-01 KP-4 multi-peran hanya lewat persetujuan pemilik dengan alasan & masa berlaku; kombinasi terlarang PTB-31 tidak dapat diajukan", async () => {
    const disp = await activeUser("dispatcher");
    await expect(requestRoleChange(admin(), { userId: disp.userId, role: "accountant", mode: "add", reason: "Bantu tutup buku" })).rejects.toThrow(/masa berlaku/);

    const fa = await activeUser("finance_admin");
    const forbidden = requestRoleChange(admin(), { userId: fa.userId, role: "driver", mode: "add", validUntil: addDays(toBusinessDate(new Date()), 30), scopes: [{ type: "truck", refId: truckId("T3") }], reason: "Sopir cadangan" });
    await expect(forbidden).rejects.toBeInstanceOf(ForbiddenError);
    await expect(forbidden).rejects.toThrow(/PTB-31/);
    expect(await t.db.select().from(approvalRequests).where(and(eq(approvalRequests.objectId, fa.userId), eq(approvalRequests.type, "multi_role")))).toHaveLength(0);
    expect((await accessLogsOf(t.db, userIdByUsername("admin1"), "action_denied")).some((l) => l.rule === "PTB-31")).toBe(true);

    const until = addDays(toBusinessDate(new Date()), 10);
    const req = await requestRoleChange(admin(), { userId: disp.userId, role: "accountant", mode: "add", validUntil: until, reason: "Pendampingan tutup buku kuartal" });
    expect(req.type).toBe("multi_role");
    expect((await buildActorContext(t.db, disp.userId, { source: "web" })).roles).toEqual(["dispatcher"]);
    await approve(req.id);
    expect((await buildActorContext(t.db, disp.userId, { source: "web" })).roles.sort()).toEqual(["accountant", "dispatcher"]);
    const later = new Date(Date.now() + 12 * 86_400_000);
    expect((await buildActorContext(t.db, disp.userId, { source: "web", now: later })).roles).toEqual(["dispatcher"]);
    const view = await accessReviewList(seededContext("pemilik", { now: later }));
    expect(view.items.find((i) => i.userId === disp.userId)!.flags).toContain("multi_role_expired");
  });

  it("US-M10-01 KP-5 admin sistem menonaktifkan seketika: sesi diputus, perangkat yang dipegang diblokir, data lama tetap merujuk namanya", async () => {
    const sopir1 = userIdByUsername("sopir1");
    const { session } = await withTx((tx) => createSession(tx, { userId: sopir1, kind: "device", deviceId: deviceId("HP-T1") }));
    await expect(deactivateUser(admin(), { userId: userIdByUsername("admin1"), reason: "Coba nonaktifkan diri" })).rejects.toThrow(/akun Anda sendiri/);
    const res = await deactivateUser(admin(), { userId: sopir1, reason: "Mengundurkan diri" });
    expect(res.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect(res.devicesBlocked).toContain(deviceId("HP-T1"));
    expect((await t.db.select().from(sessions).where(eq(sessions.id, session.id)))[0]!.revokedAt).not.toBeNull();
    expect((await t.db.select().from(devices).where(eq(devices.id, deviceId("HP-T1"))))[0]!.status).toBe("blocked");
    expect((await t.db.select().from(users).where(eq(users.id, sopir1)))[0]!.status).toBe("inactive");
    await expect(buildActorContext(t.db, sopir1, { source: "field" })).rejects.toThrow(/tidak aktif/);
    // Karyawan & akun tetap ada (tidak dihapus) sehingga catatan lama tetap merujuk namanya.
    const detail = await getUserDetail(admin(), sopir1);
    expect(detail.fullName).toBe("Asep Saepudin");
    expect((await auditOf(t.db, "user", sopir1)).some((a) => a.action === "deactivate" && a.rule === "BR-37")).toBe(true);
  });

  it("US-M10-01 KP-5 tanggal keluar di master M1 menonaktifkan akun otomatis pada hari itu (event employee.exited + job harian)", async () => {
    const today = toBusinessDate(new Date());
    const now = await activeUser("dispatcher");
    await withTx((tx) => emit(tx, "employee.exited", { employeeId: now.employeeId, exitDate: today, tenantId: EQUA_TENANT_ID }, { tenantId: EQUA_TENANT_ID }));
    expect((await t.db.select().from(users).where(eq(users.id, now.userId)))[0]!.status).toBe("inactive");
    const auto = (await auditOf(t.db, "user", now.userId)).find((a) => a.action === "deactivate")!;
    expect(auto.source).toBe("system");
    expect(auto.rule).toBe("BR-37");

    const future = await activeUser("dispatcher");
    const exitDate = addDays(today, 3);
    await t.db.update(employees).set({ exitDate }).where(eq(employees.id, future.employeeId));
    await withTx((tx) => emit(tx, "employee.exited", { employeeId: future.employeeId, exitDate, tenantId: EQUA_TENANT_ID }, { tenantId: EQUA_TENANT_ID }));
    expect((await t.db.select().from(users).where(eq(users.id, future.userId)))[0]!.status).toBe("active");
    await runExitDateSweep(new Date(Date.now() + 3 * 86_400_000 + 3_600_000));
    expect((await t.db.select().from(users).where(eq(users.id, future.userId)))[0]!.status).toBe("inactive");
  });

  it("US-M10-01 KP-6 tinjauan kuartalan: daftar pengguna/peran/lingkup/login terakhir; tanpa login > 60 hari ditandai; pemilik menandai ditinjau", async () => {
    const u = await activeUser("dispatcher");
    await t.db.update(users).set({ lastLoginAt: new Date(Date.now() - 61 * 86_400_000) }).where(eq(users.id, u.userId));
    const view = await accessReviewList(owner());
    const item = view.items.find((i) => i.userId === u.userId)!;
    expect(item.flags).toContain("no_login");
    expect(item.roles.map((r) => r.role)).toEqual(["dispatcher"]);
    expect(item.scopes[0]).toMatch(/Tenant/);
    expect(view.inactiveDays).toBe(60);

    // Ambang dari parameter: dinaikkan pemilik → tidak lagi ditandai.
    await params.set(owner(), "access.review_inactive_days", { days: 90 }, toBusinessDate(new Date()), "Kalibrasi setelah pilot");
    expect((await accessReviewList(owner())).items.find((i) => i.userId === u.userId)!.flags).not.toContain("no_login");

    await expect(markAccessReviewed(admin(), { quarter: quarterOf(new Date()) })).rejects.toBeInstanceOf(ForbiddenError);
    const review = await markAccessReviewed(owner(), { quarter: quarterOf(new Date()), notes: "Semua sesuai" });
    expect(review.status).toBe("reviewed");
    expect((review.snapshot as { count: number }).count).toBeGreaterThan(10);
    await expect(markAccessReviewed(owner(), { quarter: quarterOf(new Date()) })).rejects.toThrow(/sudah ditandai/);
  });

  it("US-M10-01 KP-7 semua perubahan pengguna/peran/lingkup berjejak dan masuk ringkasan harian pemilik", async () => {
    const u = await activeUser("dispatcher");
    const roleRow = (await t.db.select().from(userRoles).where(and(eq(userRoles.userId, u.userId), eq(userRoles.status, "active"))))[0]!;
    const scopeRow = (await t.db.select().from(userScopes).where(and(eq(userScopes.userId, u.userId), eq(userScopes.status, "active"))))[0]!;
    await revokeScope(admin(), { userId: u.userId, scopeId: scopeRow.id, reason: "Pengurangan lingkup" });
    await revokeRole(admin(), { userId: u.userId, roleId: roleRow.id, reason: "Peran tidak diperlukan" });
    expect((await auditOf(t.db, "user", u.userId)).map((a) => a.action)).toEqual(expect.arrayContaining(["create", "activate"]));
    expect((await auditOf(t.db, "user_role", roleRow.id)).map((a) => a.action)).toEqual(expect.arrayContaining(["activate", "revoke"]));
    expect((await auditOf(t.db, "user_scope", scopeRow.id)).map((a) => a.action)).toContain("revoke");

    const summary = await accessChangesOn(t.db, EQUA_TENANT_ID, toBusinessDate(new Date()));
    expect(summary.total).toBeGreaterThan(0);
    expect(summary.byKind["user_role:revoke"]).toBeGreaterThanOrEqual(1);
    await dailyAccessSummary(new Date());
    const notes = await notificationsOf(t.db, "pemilik", "access.daily_summary");
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes[0]!.body).toMatch(/peran dicabut/);
  });

  it("US-M10-01 KP-7 perubahan akses sesudah ringkasan 22.15 (sampai tengah malam) masuk ringkasan berikutnya — tidak ada yang hilang", async () => {
    const first = new Date();
    await dailyAccessSummary(first);
    // Perubahan SESUDAH ringkasan hari ini (mis. 23.00 WIB).
    const u = await activeUser("dispatcher");
    const roleRow = (await t.db.select().from(userRoles).where(and(eq(userRoles.userId, u.userId), eq(userRoles.status, "active"))))[0]!;
    await revokeRole(admin(), { userId: u.userId, roleId: roleRow.id, reason: "Salah peran, dicabut malam hari" });
    // Ringkasan besok: jendela = sejak akhir ringkasan terakhir, bukan hanya tanggal besok.
    const next = new Date(first.getTime() + 24 * 3_600_000);
    await dailyAccessSummary(next);
    const notes = (await notificationsOf(t.db, "pemilik", "access.daily_summary")).filter((n) => n.objectId === toBusinessDate(next));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toMatch(/peran dicabut/);
  });

  it("US-M10-01 KP-8 akun/peran/lingkup baru aktif setelah disetujui pemilik; ditolak → tidak aktif; pencabutan seketika tanpa persetujuan", async () => {
    const emp = await newEmployee(t.db);
    const r = await createUser(admin(), { employeeId: emp, username: uniqueName("p"), role: "depot_operator", scopes: [{ type: "outlet", refId: outletId("D03") }], reason: "Operator depot baru" });
    expect(r.user.status).toBe("pending_approval");
    expect(r.approval).toMatchObject({ type: "account_create", status: "submitted", approverRole: "owner" });
    await expect(buildActorContext(t.db, r.user.id, { source: "pos" })).rejects.toThrow(/tidak aktif/);
    // Pemohon (admin sistem) tidak dapat memutuskan sendiri.
    await expect(approvals.decide(admin(), r.approval!.id, "approve")).rejects.toBeInstanceOf(ForbiddenError);
    await approve(r.approval!.id);
    const ctx = await buildActorContext(t.db, r.user.id, { source: "pos" });
    expect(ctx.roles).toEqual(["depot_operator"]);
    expect(ctx.scope.outletIds).toEqual([outletId("D03")]);

    // Perluasan lingkup → persetujuan; pengurangan → seketika.
    const ext = await requestScopeExtension(admin(), { userId: r.user.id, scopes: [{ type: "outlet", refId: outletId("D04") }], reason: "Menggantikan operator D04" });
    expect((await buildActorContext(t.db, r.user.id, { source: "pos" })).scope.outletIds).toEqual([outletId("D03")]);
    await approve(ext.id);
    expect((await buildActorContext(t.db, r.user.id, { source: "pos" })).scope.outletIds.sort()).toEqual([outletId("D03"), outletId("D04")].sort());
    const d04 = (await t.db.select().from(userScopes).where(and(eq(userScopes.userId, r.user.id), eq(userScopes.refId, outletId("D04")))))[0]!;
    await revokeScope(admin(), { userId: r.user.id, scopeId: d04.id, reason: "Selesai menggantikan" });
    expect((await buildActorContext(t.db, r.user.id, { source: "pos" })).scope.outletIds).toEqual([outletId("D03")]);

    // Ditolak → akun tetap tidak aktif; dapat diajukan aktif kembali.
    const emp2 = await newEmployee(t.db);
    const r2 = await createUser(admin(), { employeeId: emp2, username: uniqueName("tolak"), role: "dispatcher", reason: "Dispatcher kontrak" });
    await expect(approvals.decide(owner(), r2.approval!.id, "reject")).rejects.toThrow(/Alasan/);
    await approvals.decide(owner(), r2.approval!.id, "reject", "Kontrak belum ditandatangani");
    expect((await t.db.select().from(users).where(eq(users.id, r2.user.id)))[0]!.status).toBe("inactive");
    const again = await requestReactivation(admin(), { userId: r2.user.id, role: "dispatcher", reason: "Kontrak sudah ditandatangani" });
    await approve(again.id);
    expect((await t.db.select().from(users).where(eq(users.id, r2.user.id)))[0]!.status).toBe("active");
  });

  it("US-M10-01 KP-8 lewat tenggat 2 hari kerja: permintaan tetap terbuka & ditandai terlambat, akun TIDAK aktif (D-08 escalate)", async () => {
    const emp = await newEmployee(t.db);
    const r = await createUser(admin(), { employeeId: emp, username: uniqueName("late"), role: "dispatcher", reason: "Dispatcher shift malam" });
    const due = new Date(r.approval!.deadlineAt!.getTime() + 60_000);
    const result = await approvals.expireDue(due);
    expect(result.escalated).toBeGreaterThanOrEqual(1);
    const row = (await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, r.approval!.id)))[0]!;
    expect(row.status).toBe("submitted");
    expect(row.overdueAt).not.toBeNull();
    expect((await t.db.select().from(users).where(eq(users.id, r.user.id)))[0]!.status).toBe("pending_approval");
  });

  it("US-M10-01 KP-8 pindah peran: akun tetap, peran lama dicabut & lingkup diubah setelah disetujui pemilik", async () => {
    const sopir = await activeUser("driver", [{ type: "truck", refId: truckId("T5") }]);
    const req = await requestRoleChange(admin(), { userId: sopir.userId, role: "depot_operator", mode: "replace", scopes: [{ type: "outlet", refId: outletId("D05") }], reason: "Pindah menjadi operator depot" });
    expect(req.type).toBe("role_grant");
    expect((await buildActorContext(t.db, sopir.userId, { source: "field" })).roles).toEqual(["driver"]);
    await approve(req.id);
    const ctx = await buildActorContext(t.db, sopir.userId, { source: "pos" });
    expect(ctx.roles).toEqual(["depot_operator"]);
    expect(ctx.scope).toMatchObject({ truckIds: [], outletIds: [outletId("D05")] });
    const history = await t.db.select().from(userRoles).where(eq(userRoles.userId, sopir.userId));
    expect(history.find((h) => h.role === "driver")!.status).toBe("revoked");
  });

  it("US-M10-01 KP-8 go-live: akun awal disetujui sekaligus per daftar tanda tangan data awal (NFR-34), lalu mode akun awal ditutup", async () => {
    const e1 = await newEmployee(t.db);
    const e2 = await newEmployee(t.db);
    const a = await createUser(admin(), { employeeId: e1, username: uniqueName("awal"), role: "dispatcher", reason: "Akun awal go-live", initialLoad: true });
    const b = await createUser(admin(), { employeeId: e2, username: uniqueName("awal"), role: "driver", scopes: [{ type: "truck", refId: truckId("T6") }], reason: "Akun awal go-live", initialLoad: true });
    expect(a.approval).toBeNull();
    const signoff = await prepareInitialAccountsSignoff(admin());
    expect(signoff).toMatchObject({ group: "initial_accounts", status: "draft" });
    expect((signoff.summary as { count: number }).count).toBeGreaterThanOrEqual(2);
    await expect(signInitialAccounts(admin(), signoff.id)).rejects.toBeInstanceOf(ForbiddenError);
    const signed = await signInitialAccounts(owner(), signoff.id);
    expect(signed.activated).toBeGreaterThanOrEqual(2);
    for (const id of [a.user.id, b.user.id]) expect((await t.db.select().from(users).where(eq(users.id, id)))[0]!.status).toBe("active");
    expect((await buildActorContext(t.db, b.user.id, { source: "field" })).scope.truckIds).toEqual([truckId("T6")]);
    expect((await t.db.select().from(dataSignoffs).where(eq(dataSignoffs.id, signoff.id)))[0]!.status).toBe("signed");
    const e3 = await newEmployee(t.db);
    await expect(createUser(admin(), { employeeId: e3, username: uniqueName("awal"), role: "dispatcher", reason: "Terlambat", initialLoad: true })).rejects.toBeInstanceOf(DomainError);
    expect((await initialAccountsStatus(admin())).signed?.id).toBe(signoff.id);
  });

  it("US-M10-01 daftar pengguna tersaring per status & pencarian; tenant lain tidak terlihat (NFR-30)", async () => {
    const all = await listUsers(admin(), { status: "all" });
    expect(all.some((u) => u.username === "pemilik")).toBe(true);
    const found = await listUsers(admin(), { q: "keuangan1" });
    expect(found.map((u) => u.username)).toEqual(["keuangan1"]);
    expect(found[0]!.roles[0]!.role).toBe("finance_admin");
    await expect(listUsers(seededContext("dispatcher1"))).rejects.toBeInstanceOf(ForbiddenError);
    const detail = await getUserDetail(owner(), userIdByUsername("depot01"));
    expect(detail.scopes[0]!.label).toMatch(/D01/);
    expect(detail.employeeId).toBe(employeeId("EQ-023"));
  });
});
