import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, auditLogs, exportLogs, notifications } from "@/db/schema";
import { userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";
import { addDays, toBusinessDate } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { ForbiddenError } from "@/server/core/errors";
import { exportReport } from "@/server/core/export";
import { FLAG_REGISTRY } from "@/server/core/flags";
import * as params from "@/server/core/params";
import { authorize, PERMISSIONS } from "@/server/core/rbac";
import { approvalObjectText, createUser, describeApprovalRules, listDenials, roleMatrixView } from "@/server/modules/m10-access";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { createTestUser } from "../helpers/factories";
import { newEmployee, notificationsOf, uniqueName } from "./helpers";

describe("US-M10-03 Pemisahan tugas dipaksakan", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M10-03 KP-1 aturan tetap diperiksa pada setiap tindakan (menolak, bukan memperingatkan)", async () => {
    const cases: [string, string, RegExp][] = [
      ["admin1", "m4.deposit.receive", /Admin sistem tidak mengubah transaksi keuangan|tidak diizinkan/],
      ["pemilik", "m2.order.create", /Pemilik tidak menginput transaksi harian/],
      ["dispatcher1", "m4.deposit.receive", /Dispatcher tidak mengakses kas/],
      ["keuangan1", "m2.order.create", /Admin Keuangan tidak membuat\/mengubah pesanan/],
      ["pemilik", "m10.user.create", /Hak akses hanya lewat peran/],
      ["akuntan", "m11.journal.create", /Akuntan hanya dapat membaca/],
    ];
    for (const [who, perm, msg] of cases) {
      await expect(authorize(seededContext(who), perm), `${who} ${perm}`).rejects.toThrow(msg);
    }
    // Pembuat permintaan bukan penyetujunya (admin sistem mengajukan akun; ia tidak dapat memutuskannya).
    const emp = await newEmployee(t.db);
    const r = await createUser(seededContext("admin1"), { employeeId: emp, username: uniqueName("sod"), role: "dispatcher", reason: "Dispatcher baru" });
    await expect(approvals.decide(seededContext("admin1"), r.approval!.id, "approve")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("US-M10-03 KP-2 pelanggaran menyebut aturannya, tercatat di log akses, dan > 3 percobaan sehari diberitahukan ke pemilik (sekali)", async () => {
    const u = await createTestUser(t.db, { role: "dispatcher" });
    for (let i = 0; i < 5; i++) {
      await expect(authorize(u.ctx, "m4.cash_day.close")).rejects.toThrow(/SOD|Dispatcher tidak mengakses kas/);
    }
    const alerts = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.event, "access.repeated_denial"), eq(notifications.objectId, u.userId)));
    expect(alerts.filter((a) => a.recipientUserId === userIdByUsername("pemilik"))).toHaveLength(1);
    const denials = await listDenials(seededContext("pemilik"));
    const mine = denials.byUserDay.find((d) => d.userId === u.userId)!;
    expect(mine.count).toBe(5);
    expect(mine.alerted).toBe(true);
    expect(denials.items.find((i) => i.userId === u.userId)!.rule).toBe("SOD-04");
  });

  it("US-M10-03 KP-3 tidak ada mode darurat: tidak ada izin/flag pintas; pengecualian hanya jalur yang ditetapkan & berjejak", () => {
    // Satu-satunya "darurat" adalah jalur pengecualian yang ditetapkan PRD (Bab 6.1 "dicatat kantor") — berpenanda `exception`.
    expect(PERMISSIONS.filter((p) => !p.exception && /emergency|darurat|bypass|override|superuser/i.test(`${p.key} ${p.label}`))).toEqual([]);
    expect(Object.keys(FLAG_REGISTRY).filter((k) => /emergency|darurat|bypass|override/i.test(k))).toEqual([]);
    const exceptions = PERMISSIONS.filter((p) => p.exception).map((p) => p.key);
    expect(exceptions.every((k) => ["m3.office_entry.create", "m4.cash_close_exception.request"].includes(k))).toBe(true);
    // Tidak ada peran yang memegang seluruh izin (tanpa peran "super").
    const roles = new Set(PERMISSIONS.flatMap((p) => p.roles));
    for (const role of roles) expect(PERMISSIONS.every((p) => p.roles.includes(role)), role).toBe(false);
  });

  it("US-M10-03 KP-4 matriks peran × tindakan ditampilkan & diekspor pemilik (Excel/PDF); admin sistem tidak dapat mengekspor", async () => {
    const view = roleMatrixView();
    expect(view.rows).toHaveLength(PERMISSIONS.length);
    expect(view.combos.length).toBeGreaterThan(10);
    expect(view.rules.map((r) => r.code)).toContain("SOD-07");
    const xlsx = await exportReport(seededContext("pemilik"), "core.rbac_matrix", "xlsx");
    expect(xlsx.body.byteLength).toBeGreaterThan(1000);
    const pdf = await exportReport(seededContext("pemilik"), "core.rbac_matrix", "pdf");
    expect(pdf.contentType).toBe("application/pdf");
    await expect(exportReport(seededContext("admin1"), "core.rbac_matrix", "xlsx")).rejects.toBeInstanceOf(ForbiddenError);
    expect((await t.db.select().from(exportLogs).where(eq(exportLogs.reportKey, "core.rbac_matrix"))).length).toBeGreaterThanOrEqual(2);
  });
});

/** Tabel PRD 6.2a: jenis → [penyetuju, perilaku lewat tenggat, parameter ambang]. */
const PRD_62A: Record<string, [string, "expire" | "escalate" | "none", string | undefined]> = {
  cash_discrepancy: ["owner", "escalate", "PAR-01"],
  credit_order: ["owner", "expire", undefined],
  credit_grant: ["owner", "none", "PAR-11"],
  credit_terms_change: ["owner", "none", "PAR-10"],
  credit_hold_release: ["owner", "none", undefined],
  price_change: ["owner", "expire", undefined],
  special_price: ["owner", "none", "PAR-24"],
  store_discount: ["owner", "expire", "PAR-14"],
  pos_void: ["owner", "expire", "PAR-04"],
  stock_adjustment: ["owner", "escalate", undefined],
  manual_journal: ["owner", "escalate", "PAR-20"],
  correction: ["owner", "none", "PAR-21"],
  petty_cash: ["owner", "none", "PAR-43"],
  cash_close_exception: ["owner", "expire", "PAR-89"],
  second_underpayment_order: ["owner", "expire", undefined],
  field_payment_to_credit: ["dispatcher", "expire", undefined],
  period_lock: ["owner", "escalate", "PAR-23"],
  account_create: ["owner", "escalate", undefined],
  role_grant: ["owner", "escalate", undefined],
  scope_extension: ["owner", "escalate", undefined],
  multi_role: ["owner", "none", undefined],
};

describe("US-M10-04 Alur persetujuan", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M10-04 KP-2 NFR-15 kartu persetujuan menampilkan jenis objek Bahasa Indonesia + nomor dokumen, tanpa ID teknis (UUID)", () => {
    const uuid = "01941f29-7c00-7c86-995f-82b4a1cacb74";
    expect(approvalObjectText("discrepancy", { number: "SL-26-000012" })).toBe("Selisih SL-26-000012");
    expect(approvalObjectText("invoice", { invoiceNumber: "F-26-000101" })).toBe("Faktur F-26-000101");
    const bare = approvalObjectText("deposit", {});
    expect(bare).toBe("Setoran");
    expect(bare).not.toContain(uuid);
    expect(approvalObjectText("jenis_tak_dikenal", null)).toBe("Objek");
  });

  it("US-M10-04 KP-1 seluruh jenis 6.2a terdaftar dengan pemohon, penyetuju, ambang (parameter), tenggat, dan perilaku lewat tenggat", async () => {
    const rules = await describeApprovalRules(t.db, toBusinessDate(new Date()));
    for (const [type, [approver, onExpire, param]] of Object.entries(PRD_62A)) {
      const def = approvals.getApprovalType(type);
      expect(def, type).toBeDefined();
      expect(def!.approverRole, type).toBe(approver);
      expect(def!.onExpire, type).toBe(onExpire);
      expect(def!.thresholdParam, type).toBe(param);
      expect(def!.requesterRoles.length, type).toBeGreaterThan(0);
      const rule = rules.find((r) => r.type === type)!;
      expect(rule.deadline, type).toBeTruthy();
      if (param) expect(rule.thresholdValue, type).not.toBeNull();
    }
    expect(rules.find((r) => r.type === "account_create")!.deadline).toBe("≤ 2 hari kerja");
    expect(rules.find((r) => r.type === "cash_discrepancy")!.deadline).toBe("≤ 24 jam");
  });

  it("US-M10-04 KP-2 penyetuju sesuai matriks; pemohon tidak pernah menyetujui sendiri walau memegang peran penyetuju; 6.2b/6.2c tidak masuk alur tetapi berjejak", async () => {
    const both = await createTestUser(t.db, { roles: ["dispatcher", "driver"] });
    const req = await approvals.submit(both.ctx, { type: "field_payment_to_credit", objectId: newId(), reason: "Pelanggan minta tempo", deadlineAt: new Date(Date.now() + 3_600_000) });
    expect(req.approverRole).toBe("dispatcher");
    await expect(approvals.decide(both.ctx, req.id, "approve")).rejects.toThrow(/SOD-01|Pembuat/);
    await approvals.decide(seededContext("dispatcher1"), req.id, "approve");

    const before = (await t.db.select().from(approvalRequests)).length;
    await params.set(seededContext("pemilik"), "PAR-03", { count: 4 }, addDays(toBusinessDate(new Date()), 1), "Keputusan langsung pemilik (6.2b)");
    expect((await t.db.select().from(approvalRequests)).length).toBe(before);
    const trail = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "parameter"), eq(auditLogs.objectId, "PAR-03")));
    expect(trail.at(-1)!.rule).toBe("6.2b");
    expect((await notificationsOf(t.db, "keuangan1", "parameter.changed")).length).toBeGreaterThanOrEqual(1);
    const types = approvals.APPROVAL_TYPES.map((d) => d.type);
    expect(types).not.toEqual(expect.arrayContaining(["parameter_change"]));
    expect(types.filter((x) => /override|reopen|parameter/.test(x))).toEqual([]);
  });

  it("US-M10-04 KP-3 keputusan satu ketuk dari tautan push (/persetujuan?id=…) mengubah objek sumber & tercatat; tolak wajib alasan", async () => {
    const emp = await newEmployee(t.db);
    const r = await createUser(seededContext("admin1"), { employeeId: emp, username: uniqueName("ketuk"), role: "dispatcher", reason: "Dispatcher baru" });
    const pushNote = (await notificationsOf(t.db, "pemilik", "approval.requested")).find((n) => n.objectId === r.approval!.id)!;
    expect(pushNote.link).toBe(`/persetujuan?id=${r.approval!.id}`);
    const decided = await approvals.decide(seededContext("pemilik"), r.approval!.id, "approve");
    expect(decided.status).toBe("approved");
    expect(decided.outcome).toMatchObject({ activated: true });
    const onObject = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "user"), eq(auditLogs.objectId, r.user.id)));
    expect(onObject.map((a) => a.action)).toEqual(expect.arrayContaining(["approve", "activate"]));
    const emp2 = await newEmployee(t.db);
    const r2 = await createUser(seededContext("admin1"), { employeeId: emp2, username: uniqueName("ketuk"), role: "dispatcher", reason: "Dispatcher kedua" });
    await expect(approvals.decide(seededContext("pemilik"), r2.approval!.id, "reject", "")).rejects.toThrow(/Alasan/);
  });

  it("US-M10-04 KP-4 lewat tenggat mengikuti kolom 6.2a: jenis 'expire' gugur (void dianggap ditolak), jenis akses 'escalate' tetap terbuka + pengingat", async () => {
    const op = seededContext("depot01");
    const deadline = new Date(Date.now() + 60_000);
    const voidReq = await approvals.submit(op, { type: "pos_void", objectId: newId(), amount: 150_000, reason: "Salah input", deadlineAt: deadline });
    const emp = await newEmployee(t.db);
    const acc = await createUser(seededContext("admin1"), { employeeId: emp, username: uniqueName("tenggat"), role: "dispatcher", reason: "Dispatcher baru" });
    const later = new Date(Math.max(deadline.getTime(), acc.approval!.deadlineAt!.getTime()) + 60_000);
    await approvals.expireDue(later);
    const rows = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, voidReq.id));
    expect(rows[0]!.status).toBe("expired");
    const accRow = (await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, acc.approval!.id)))[0]!;
    expect(accRow).toMatchObject({ status: "submitted" });
    expect(accRow.overdueAt).not.toBeNull();
    expect((await notificationsOf(t.db, "pemilik", "approval.overdue")).some((n) => n.objectId === acc.approval!.id)).toBe(true);
    const inbox = await approvals.listInbox(seededContext("pemilik", { now: later }));
    expect(inbox[0]!.isOverdue).toBe(true);
  });

  it("US-M10-04 KP-5 tanpa pendelegasian secara bawaan (PTB-32)", async () => {
    const accountant = await createTestUser(t.db, { role: "accountant" });
    await expect(
      approvals.createDelegation(seededContext("pemilik"), {
        delegateUserId: accountant.userId,
        approvalType: "cash_discrepancy",
        validFrom: new Date(),
        validUntil: new Date(Date.now() + 86_400_000),
        reason: "Pemilik cuti seminggu",
      }),
    ).rejects.toThrow(/tidak aktif/);
  });

  it("US-M10-04 KP-6 ambang dari parameter Lampiran B; perubahan parameter (hanya pemilik) mengubah ambang mulai tanggal berlaku", async () => {
    const today = toBusinessDate(new Date());
    const tomorrow = addDays(today, 1);
    const now = await describeApprovalRules(t.db, today);
    expect(now.find((r) => r.type === "pos_void")!.thresholdValue).toEqual({ amount_gt: 100_000 });
    await expect(params.set(seededContext("admin1"), "PAR-04", { amount_gt: 150_000 }, tomorrow, "Naikkan ambang void")).rejects.toBeInstanceOf(ForbiddenError);
    await params.set(seededContext("pemilik"), "PAR-04", { amount_gt: 150_000 }, tomorrow, "Naikkan ambang void setelah evaluasi");
    expect((await describeApprovalRules(t.db, today)).find((r) => r.type === "pos_void")!.thresholdValue).toEqual({ amount_gt: 100_000 });
    expect((await describeApprovalRules(t.db, tomorrow)).find((r) => r.type === "pos_void")!.thresholdValue).toEqual({ amount_gt: 150_000 });
  });
});
