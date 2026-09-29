import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { approvalRequests, auditLogs, domainEvents, notifications } from "@/db/schema";
import { userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";
import * as approvals from "@/server/core/approvals";
import { ConflictError, ForbiddenError, ValidationError } from "@/server/core/errors";
import * as flags from "@/server/core/flags";

import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { createTestUser } from "../helpers/factories";

const T0 = new Date("2026-09-28T10:00:00Z"); // 17.00 WIB Senin
const hours = (h: number) => new Date(T0.getTime() + h * 3_600_000);

async function notificationsFor(db: ReturnType<typeof useTestDb>["db"], username: string, event: string) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.recipientUserId, userIdByUsername(username)), eq(notifications.event, event)));
}

describe("Registri persetujuan (murni)", () => {
  it("US-M10-04 KP-1 semua jenis 6.2a terdaftar dengan penyetuju sesuai matriks", () => {
    for (const type of [
      "cash_discrepancy",
      "credit_order",
      "credit_grant",
      "credit_terms_change",
      "credit_hold_release",
      "price_change",
      "special_price",
      "store_discount",
      "pos_void",
      "stock_adjustment",
      "manual_journal",
      "correction",
      "petty_cash",
      "cash_close_exception",
      "second_underpayment_order",
      "field_payment_to_credit",
      "period_lock",
      "account_create",
      "role_grant",
      "scope_extension",
      "multi_role",
    ]) {
      expect(approvals.getApprovalType(type), type).toBeDefined();
    }
    expect(approvals.getApprovalType("field_payment_to_credit")!.approverRole).toBe("dispatcher");
    expect(approvals.getApprovalType("store_product")!.approverRole).toBe("finance_admin");
    expect(approvals.getApprovalType("cash_discrepancy")!.thresholdParam).toBe("PAR-01");
    expect(approvals.getApprovalType("pos_void")!.onExpire).toBe("expire");
    expect(approvals.getApprovalType("cash_discrepancy")!.onExpire).toBe("escalate");
  });
});

describe("Alur persetujuan (US-M10-04)", () => {
  const t = useTestDb({ seed: true });

  it("US-M10-04 KP-1 submit: nomor A-YY, tenggat 24 jam, audit, notifikasi penyetuju", async () => {
    const keu = seededContext("keuangan1", { now: T0 });
    const req = await approvals.submit(keu, {
      type: "cash_discrepancy",
      objectId: newId(),
      amount: -75_000,
      reason: "Kurang setor sopir T1, uang rusak",
    });
    expect(req.number).toBe("A-26-000001");
    expect(req.status).toBe("submitted");
    expect(req.approverRole).toBe("owner");
    expect(req.deadlineAt?.toISOString()).toBe(hours(24).toISOString());
    const notes = await notificationsFor(t.db, "pemilik", "approval.requested");
    expect(notes[0]!.severity).toBe("critical");
    expect(notes[0]!.valueAmount).toBe(-75_000);
    const audit = await t.db.select().from(auditLogs).where(eq(auditLogs.objectId, req.id));
    expect(audit.map((a) => a.action)).toEqual(["submit"]);
  });

  it("US-M10-04 KP-2 hanya peran pemohon yang dapat mengajukan; satu permintaan terbuka per objek", async () => {
    await expect(
      approvals.submit(seededContext("dispatcher1", { now: T0 }), { type: "cash_discrepancy", objectId: newId(), reason: "coba ajukan" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const objectId = newId();
    const keu = seededContext("keuangan1", { now: T0 });
    await approvals.submit(keu, { type: "petty_cash", objectId, amount: 750_000, reason: "Beli ATK kantor" });
    await expect(approvals.submit(keu, { type: "petty_cash", objectId, amount: 750_000, reason: "Beli ATK kantor" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(approvals.submit(keu, { type: "pos_void" as never, objectId: newId(), reason: "x" })).rejects.toThrow();
  });

  it("US-M10-04 KP-3 setujui: handler modul mengubah objek sumber, audit objek, event approval.decided, notifikasi pemohon", async () => {
    const calls: string[] = [];
    const off = approvals.registerApprovalHandler("correction", {
      onApproved: async ({ request, decision }) => {
        calls.push(`${decision}:${request.objectId}`);
        return { applied: true };
      },
    });
    try {
      const objectId = newId();
      const req = await approvals.submit(seededContext("keuangan1", { now: T0 }), {
        type: "correction",
        // Jenis objek netral: `trip`/`trip_payment` kini punya handler `correction` nyata di M3 (B-34, S5).
        objectType: "objek_uji",
        objectId,
        amount: 600_000,
        reason: "Salah pelanggan saat Selesai",
      });
      const decided = await approvals.decide(seededContext("pemilik", { now: hours(1) }), req.id, "approve");
      expect(decided.status).toBe("approved");
      expect(decided.decidedBy).toBe(userIdByUsername("pemilik"));
      expect(decided.outcome).toEqual({ applied: true });
      expect(calls).toEqual([`approved:${objectId}`]);
      const objAudit = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "objek_uji"), eq(auditLogs.objectId, objectId)));
      expect(objAudit[0]!.action).toBe("approve");
      const ev = await t.db.select().from(domainEvents).where(eq(domainEvents.objectId, req.id));
      expect(ev[0]!.type).toBe("approval.decided");
      expect((await notificationsFor(t.db, "keuangan1", "approval.decided")).length).toBeGreaterThan(0);
      await expect(approvals.decide(seededContext("pemilik", { now: hours(2) }), req.id, "reject", "berubah pikiran")).rejects.toBeInstanceOf(
        ConflictError,
      );
    } finally {
      off();
    }
  });

  it("US-M10-04 KP-3 tolak wajib alasan; handler onRejected dipanggil", async () => {
    let rejectedWith: string | null = null;
    const off = approvals.registerApprovalHandler("special_price", {
      onRejected: ({ reason }) => {
        rejectedWith = reason;
      },
    });
    try {
      const req = await approvals.submit(seededContext("dispatcher1", { now: T0 }), {
        type: "special_price",
        objectId: newId(),
        reason: "Pelanggan hotel langganan",
      });
      await expect(approvals.decide(seededContext("pemilik", { now: T0 }), req.id, "reject", "")).rejects.toBeInstanceOf(ValidationError);
      const r = await approvals.decide(seededContext("pemilik", { now: T0 }), req.id, "reject", "Harga terlalu rendah");
      expect(r.status).toBe("rejected");
      expect(r.decisionReason).toBe("Harga terlalu rendah");
      expect(rejectedWith).toBe("Harga terlalu rendah");
    } finally {
      off();
    }
  });

  it("FR-M10-03 pemohon tidak pernah dapat menyetujui permintaannya sendiri walau memegang peran pemilik", async () => {
    const dual = await createTestUser(t.db, { roles: ["owner", "system_admin"], now: T0 });
    const req = await approvals.submit(dual.ctx, { type: "account_create", objectType: "user", objectId: newId(), reason: "Akun operator depot baru" });
    const err = await approvals.decide(dual.ctx, req.id, "approve").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).rule).toBe("SOD-01");
    expect((await approvals.getApproval(t.db, req.id))!.status).toBe("submitted");
    // Pemilik lain tetap dapat memutuskan.
    await expect(approvals.decide(seededContext("pemilik", { now: T0 }), req.id, "approve")).resolves.toMatchObject({ status: "approved" });
  });

  it("PTB-19 tunai → tempo di lapangan diputuskan Dispatcher (bukan pemilik); pemohon Dispatcher+Sopir tetap tidak boleh menyetujui sendiri", async () => {
    const sopir = seededContext("sopir1", { now: T0 });
    const req = await approvals.submit(sopir, {
      type: "field_payment_to_credit",
      objectId: newId(),
      amount: 250_000,
      reason: "Pelanggan minta tempo",
      deadlineAt: hours(0.5),
    });
    await expect(approvals.decide(seededContext("keuangan1", { now: T0 }), req.id, "approve")).rejects.toThrow(/hanya dapat diputuskan oleh Dispatcher/);
    await expect(approvals.decide(seededContext("dispatcher1", { now: T0 }), req.id, "approve")).resolves.toMatchObject({ status: "approved" });

    const both = await createTestUser(t.db, { roles: ["dispatcher", "driver"], now: T0 });
    const own = await approvals.submit(both.ctx, {
      type: "field_payment_to_credit",
      objectId: newId(),
      reason: "Pelanggan minta tempo",
      deadlineAt: hours(0.5),
    });
    await expect(approvals.decide(both.ctx, own.id, "approve")).rejects.toMatchObject({ rule: "SOD-01" });
  });

  it("US-M10-04 KP-4 lewat tenggat: jenis 'expire' → Lewat tenggat + onExpired; 'escalate' → penanda & pengingat sekali", async () => {
    const expired: string[] = [];
    const off = approvals.registerApprovalHandler("pos_void", {
      onExpired: ({ request }) => {
        expired.push(request.id);
        return { treatedAs: "rejected_end_of_shift" };
      },
    });
    try {
      const voidReq = await approvals.submit(seededContext("depot01", { now: T0 }), {
        type: "pos_void",
        objectType: "pos_sale",
        objectId: newId(),
        amount: 150_000,
        reason: "Salah produk",
        deadlineAt: hours(4),
      });
      const discReq = await approvals.submit(seededContext("keuangan2", { now: T0 }), {
        type: "cash_discrepancy",
        objectId: newId(),
        amount: -60_000,
        reason: "Selisih depot D03",
      });

      await approvals.expireDue(hours(3));
      expect((await approvals.getApproval(t.db, voidReq.id))!.status).toBe("submitted");
      expect((await approvals.getApproval(t.db, discReq.id))!.overdueAt).toBeNull();

      const r1 = await approvals.expireDue(hours(25));
      expect(r1.errors).toEqual([]);
      expect(r1.expired).toBeGreaterThanOrEqual(1);
      expect(r1.escalated).toBeGreaterThanOrEqual(1);
      const v = (await approvals.getApproval(t.db, voidReq.id))!;
      expect(v.status).toBe("expired");
      expect(v.outcome).toEqual({ treatedAs: "rejected_end_of_shift" });
      expect(expired).toContain(voidReq.id);
      const d = (await approvals.getApproval(t.db, discReq.id))!;
      expect(d.status).toBe("submitted");
      expect(d.overdueAt?.toISOString()).toBe(hours(25).toISOString());
      const overdueNotes = await notificationsFor(t.db, "pemilik", "approval.overdue");
      const forDisc = overdueNotes.filter((n) => n.objectId === discReq.id);
      expect(forDisc).toHaveLength(1);

      await approvals.expireDue(hours(26));
      expect((await notificationsFor(t.db, "pemilik", "approval.overdue")).filter((n) => n.objectId === discReq.id)).toHaveLength(1);

      // Jenis expire yang sudah lewat tenggat tidak dapat diputuskan.
      const late = await approvals.submit(seededContext("depot01", { now: T0 }), {
        type: "pos_void",
        objectType: "pos_sale",
        objectId: newId(),
        reason: "Salah jumlah",
        deadlineAt: hours(1),
      });
      await expect(approvals.decide(seededContext("pemilik", { now: hours(2) }), late.id, "approve")).rejects.toThrow(/lewat tenggat/);
    } finally {
      off();
    }
  });

  it("US-M9-04 KP-4 kotak persetujuan: lewat tenggat di atas; permintaan sendiri tidak dapat diputuskan", async () => {
    const inbox = await approvals.listInbox(seededContext("pemilik", { now: hours(30) }));
    expect(inbox.length).toBeGreaterThan(0);
    const firstNonOverdue = inbox.findIndex((i) => !i.isOverdue);
    const lastOverdue = inbox.map((i) => i.isOverdue).lastIndexOf(true);
    if (firstNonOverdue >= 0 && lastOverdue >= 0) expect(lastOverdue).toBeLessThan(firstNonOverdue);
    expect(inbox.every((i) => i.approverRole === "owner")).toBe(true);
    const dispInbox = await approvals.listInbox(seededContext("dispatcher1", { now: hours(30) }));
    expect(dispInbox.every((i) => i.approverRole === "dispatcher")).toBe(true);
    await expect(approvals.listInbox(seededContext("sopir1"))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("pembatalan hanya oleh pemohon selama Diajukan", async () => {
    const req = await approvals.submit(seededContext("keuangan1", { now: T0 }), { type: "manual_journal", objectId: newId(), amount: 6_000_000, reason: "Gaji September", deadlineAt: hours(240) });
    await expect(approvals.cancel(seededContext("keuangan2", { now: T0 }), req.id, "bukan milik saya")).rejects.toBeInstanceOf(ForbiddenError);
    const c = await approvals.cancel(seededContext("keuangan1", { now: T0 }), req.id, "Salah akun, ajukan ulang");
    expect(c.status).toBe("cancelled");
  });

  it("PTB-32 delegasi hanya aktif bila flag menyala; per jenis; keputusan delegasi diberitahukan ke pemilik", async () => {
    const owner = seededContext("pemilik", { now: T0 });
    const delegateUser = userIdByUsername("keuangan2");
    const input = { delegateUserId: delegateUser, approvalType: "petty_cash", validFrom: hours(-1), validUntil: hours(48), reason: "Pemilik dinas luar kota" };
    await expect(approvals.createDelegation(owner, input)).rejects.toThrow(/tidak aktif/);

    await flags.set(owner, "approvals.delegation", true, { reason: "Pemilik memutuskan delegasi sementara" });
    // Delegasi kepada peran pemohon jenis itu ditolak (kas kecil diajukan Admin Keuangan).
    await expect(approvals.createDelegation(owner, input)).rejects.toBeInstanceOf(ForbiddenError);

    const del = await approvals.createDelegation(owner, { ...input, approvalType: "credit_grant" });
    expect(del.approvalType).toBe("credit_grant");
    const req = await approvals.submit(seededContext("dispatcher2", { now: T0 }), { type: "credit_grant", objectId: newId(), reason: "Pelanggan hotel memenuhi syarat" });
    const decided = await approvals.decide(seededContext("keuangan2", { now: T0 }), req.id, "approve");
    expect(decided.delegationId).toBe(del.id);
    expect((await notificationsFor(t.db, "pemilik", "approval.delegated_decision")).length).toBe(1);
    await approvals.revokeDelegation(owner, del.id, "Pemilik sudah kembali");
    const req2 = await approvals.submit(seededContext("dispatcher2", { now: T0 }), { type: "credit_grant", objectId: newId(), reason: "Pelanggan industri memenuhi syarat" });
    await expect(approvals.decide(seededContext("keuangan2", { now: T0 }), req2.id, "approve")).rejects.toBeInstanceOf(ForbiddenError);
    await flags.set(owner, "approvals.delegation", false, { reason: "Kembali tanpa delegasi" });
    const rows = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, req2.id));
    expect(rows[0]!.status).toBe("submitted");
  });
});

describe("Persetujuan: perbaikan pasca-tinjauan (6.2a, BR-32, PTB-32)", () => {
  const t = useTestDb({ seed: true });

  it("PTB-32 job lewat tenggat tidak memilih ulang escalate yang sudah ditandai — > 500 escalate lama tidak menutup jenis expire", async () => {
    const past = new Date(T0.getTime() - 72 * 3_600_000);
    const requester = userIdByUsername("keuangan1");
    await t.db.insert(approvalRequests).values(
      Array.from({ length: 501 }, (_, i) => ({
        tenantId: seededContext("keuangan1").tenantId,
        number: `A-26-9${String(i).padStart(5, "0")}`,
        type: "cash_discrepancy",
        status: "submitted" as const,
        requesterUserId: requester,
        requesterRole: "finance_admin" as const,
        approverRole: "owner" as const,
        objectType: "discrepancy",
        objectId: newId(),
        reason: "Selisih lama belum diputuskan",
        payload: {},
        deadlineAt: past,
        overdueAt: past,
      })),
    );
    const disp = seededContext("dispatcher1", { now: new Date(T0.getTime() - 2 * 3_600_000) });
    const credit = await approvals.submit(disp, {
      type: "credit_order",
      objectId: newId(),
      reason: "Pesanan tempo hotel di luar batas",
      deadlineAt: new Date(T0.getTime() - 3_600_000),
    });
    const res = await approvals.expireDue(T0);
    expect(res.expired).toBeGreaterThanOrEqual(1);
    const [row] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, credit.id));
    expect(row!.status).toBe("expired");
  });

  it("BR-32 tenggat tutup buku dihitung dari periode yang diajukan (periode Sep diajukan 3 Okt → 10 Okt); tanpa tanggal periode ditolak", async () => {
    const keu = seededContext("keuangan1", { now: new Date("2026-10-03T03:00:00Z") });
    await expect(approvals.submit(keu, { type: "period_lock", objectId: newId(), reason: "Kunci periode September" })).rejects.toMatchObject({
      code: "DEADLINE_REQUIRED",
    });
    const req = await approvals.submit(keu, { type: "period_lock", objectId: newId(), reason: "Kunci periode September", businessDate: "2026-09-30" });
    expect(req.deadlineAt?.toISOString()).toBe("2026-10-10T16:59:00.000Z");
  });

  it("6.2a void POS: pemilik memutuskan, Admin Keuangan menerima notifikasi saat diajukan", async () => {
    const op = seededContext("depot01", { now: T0 });
    const req = await approvals.submit(op, {
      type: "pos_void",
      objectId: newId(),
      amount: 150_000,
      reason: "Salah input produk",
      deadlineAt: new Date(T0.getTime() + 4 * 3_600_000),
    });
    const fa = await notificationsFor(t.db, "keuangan1", "pos.void_requested");
    expect(fa.some((n) => n.objectId === req.id)).toBe(true);
    const owner = await notificationsFor(t.db, "pemilik", "approval.requested");
    expect(owner.some((n) => n.objectId === req.id)).toBe(true);
  });
});
