import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, domainEvents, posSales, shifts } from "@/db/schema";
import { userIdByUsername } from "@/db/seed";
import { hardeningViolationCode } from "@/db/hardening";
import { voidNeedsApproval } from "@/client/m6-pos/contract";
import * as approvals from "@/server/core/approvals";
import { toBusinessDate } from "@/lib/time";
import { reverseSaleAfterClose, voidReport } from "@/server/modules/m6-pos";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { closeVia, expectApplied, finance, galonBaru, isi, notificationsFor, openShiftVia, owner, posFor, sellVia } from "./helpers";

describe("US-M6-03 Void dengan alasan", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M6-03 KP-1 void hanya shift terbuka, alasan wajib dari daftar (Lainnya + teks); transaksi asli tetap tampil 'di-void' dengan transaksi pengganti", async () => {
    const pos = await posFor("D04");
    const { shiftId } = await openShiftVia(pos);
    const sale = await sellVia(pos, shiftId, [isi(2)]);
    expect((await pos.send("m6.pos_sale.void", { saleId: sale.saleId, reason: "salah" })).status).toBe("rejected");
    expect((await pos.send("m6.pos_sale.void", { saleId: sale.saleId, reason: "other" })).status).toBe("rejected");
    expectApplied(await pos.send("m6.pos_sale.void", { saleId: sale.saleId, reason: "wrong_quantity", note: "Seharusnya 3" }));
    const repl = await sellVia(pos, shiftId, [isi(3)], { replacesSaleId: sale.saleId });
    expectApplied(repl.res);
    const rows = await t.db.select().from(posSales).where(eq(posSales.shiftId, shiftId));
    expect(rows.find((r) => r.id === sale.saleId)).toMatchObject({ status: "voided", voidReason: "wrong_quantity", voidNote: "Seharusnya 3", voidedBy: userIdByUsername("depot04") });
    expect(rows.find((r) => r.id === repl.saleId)!.replacesSaleId).toBe(sale.saleId);
    expect(rows).toHaveLength(2); // asli tidak hilang
    // Void kedua pada transaksi yang sama ditolak; void setelah shift ditutup ditolak.
    expect((await pos.send("m6.pos_sale.void", { saleId: sale.saleId, reason: "wrong_product" })).status).toBe("rejected");
    expectApplied(await closeVia(pos, shiftId, { counted: 215_000 }));
    const after = await pos.send("m6.pos_sale.void", { saleId: repl.saleId, reason: "customer_cancelled" });
    expect(after.status).toBe("rejected");
  });

  it("US-M6-03 KP-2 void > PAR-04 menunggu persetujuan pemilik (Admin Keuangan diberi tahu), tetap dihitung sampai disetujui; disetujui setelah shift ditutup → pembalik Admin Keuangan; lewat tenggat = ditolak", async () => {
    const pos = await posFor("D05");
    const { shiftId } = await openShiftVia(pos);
    const big = await sellVia(pos, shiftId, [galonBaru(3)]); // 135.000 > 100.000
    expect(voidNeedsApproval(135_000, { voidApprovalAbove: 100_000 })).toBe(true);
    const req = await pos.send("m6.pos_sale.void", { saleId: big.saleId, reason: "customer_cancelled" });
    expectApplied(req);
    expect(req.result).toMatchObject({ status: "void_pending" });
    const [pending] = await t.db.select().from(posSales).where(eq(posSales.id, big.saleId));
    expect(pending!.status).toBe("void_pending");
    const [appr] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, pending!.voidApprovalId!));
    expect(appr).toMatchObject({ type: "pos_void", status: "submitted", amount: 135_000, approverRole: "owner" });
    expect((await notificationsFor(t.db, "pos.void_requested", { recipient: userIdByUsername("keuangan1") })).length).toBeGreaterThan(0);
    // Tetap dihitung sebagai penjualan pada tutup shift (PTB-43).
    const close = await closeVia(pos, shiftId, { counted: 200_000 + 135_000 });
    expectApplied(close);
    const [shift] = await t.db.select().from(shifts).where(eq(shifts.id, shiftId));
    expect(shift!.cashSales).toBe(135_000);
    // Disetujui setelah shift ditutup → notifikasi Admin Keuangan; pembalik dibuat Admin Keuangan.
    await approvals.decide(owner(), appr!.id, "approve");
    expect((await notificationsFor(t.db, "pos.void_reversal_needed", { objectId: big.saleId })).length).toBeGreaterThan(0);
    const rev = await reverseSaleAfterClose(finance(), { saleId: big.saleId, reason: "Void disetujui pemilik setelah shift ditutup" });
    expect(rev.reversal).toMatchObject({ total: -135_000, isReversal: true, correctionApprovalId: appr!.id });
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "pos_sale.voided"), eq(domainEvents.objectId, big.saleId)));
    expect(ev!.payload).toMatchObject({ afterClose: true, reversalId: rev.reversal.id });

    // Disetujui selama shift masih terbuka → langsung Di-void.
    const next = await openShiftVia(pos);
    const s2 = await sellVia(pos, next.shiftId, [galonBaru(3)]);
    await pos.send("m6.pos_sale.void", { saleId: s2.saleId, reason: "wrong_product" });
    const [row2] = await t.db.select().from(posSales).where(eq(posSales.id, s2.saleId));
    await approvals.decide(owner(), row2!.voidApprovalId!, "approve");
    expect((await t.db.select().from(posSales).where(eq(posSales.id, s2.saleId)))[0]!.status).toBe("voided");

    // Ditolak → transaksi kembali Sah.
    const s3 = await sellVia(pos, next.shiftId, [galonBaru(3)]);
    await pos.send("m6.pos_sale.void", { saleId: s3.saleId, reason: "wrong_product" });
    const [row3] = await t.db.select().from(posSales).where(eq(posSales.id, s3.saleId));
    await approvals.decide(owner(), row3!.voidApprovalId!, "reject", "Pelanggan sudah membawa galon");
    expect((await t.db.select().from(posSales).where(eq(posSales.id, s3.saleId)))[0]!.status).toBe("valid");

    // Lewat tenggat (akhir hari bisnis shift) → dianggap ditolak, transaksi tetap dihitung.
    const s4 = await sellVia(pos, next.shiftId, [galonBaru(3)]);
    await pos.send("m6.pos_sale.void", { saleId: s4.saleId, reason: "wrong_product" });
    const [row4] = await t.db.select().from(posSales).where(eq(posSales.id, s4.saleId));
    const [appr4] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, row4!.voidApprovalId!));
    expect(toBusinessDate(appr4!.deadlineAt!)).toBe(toBusinessDate(new Date()));
    await approvals.expireDue(new Date(appr4!.deadlineAt!.getTime() + 60_000));
    const [after4] = await t.db.select().from(posSales).where(eq(posSales.id, s4.saleId));
    expect(after4!.status).toBe("valid");
    // Pemohon tidak dapat memutuskan permintaannya sendiri; operator tidak dapat membuat pembalik.
    await expect(reverseSaleAfterClose(seededContext("depot05"), { saleId: s4.saleId, reason: "Coba dari operator" })).rejects.toThrow();
  });

  it("US-M6-03 KP-3 lebih dari PAR-03 void per hari per outlet → notifikasi Admin Keuangan; nilai & jumlah void per outlet per hari tampil di laporan", async () => {
    const pos = await posFor("D06");
    const { shiftId } = await openShiftVia(pos);
    for (let i = 0; i < 4; i++) {
      const s = await sellVia(pos, shiftId, [isi(1)]);
      const r = await pos.send("m6.pos_sale.void", { saleId: s.saleId, reason: "wrong_product" });
      expectApplied(r);
      expect((r.result as { excessiveVoids: boolean }).excessiveVoids).toBe(i === 3);
    }
    const notes = await notificationsFor(t.db, "pos.excessive_voids", { objectId: pos.outletId });
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((n) => n.recipientUserId !== userIdByUsername("depot06"))).toBe(true);
    const today = toBusinessDate(new Date());
    const rows = await voidReport(finance(), { from: today, to: today, outletId: pos.outletId });
    expect(rows[0]).toMatchObject({ voidCount: 4, voidAmount: 20_000, overLimit: true });
  });

  it("US-M6-03 KP-4 void QRIS ditandai → Admin Keuangan mencatat pengembalian dana di luar sistem", async () => {
    const pos = await posFor("D07");
    const { shiftId } = await openShiftVia(pos);
    const q = await sellVia(pos, shiftId, [isi(2)], { method: "qris", qrisReference: "REF77" });
    expectApplied(await pos.send("m6.pos_sale.void", { saleId: q.saleId, reason: "wrong_payment_method" }));
    const notes = await notificationsFor(t.db, "pos.qris_voided", { objectId: q.saleId });
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]!.body).toMatch(/REF77/);
  });

  it("US-M6-03 KP-5 tidak ada tombol hapus (DB menolak DELETE) dan tidak ada void massal (satu transaksi per perintah)", async () => {
    const pos = await posFor("D08");
    const { shiftId } = await openShiftVia(pos);
    const a = await sellVia(pos, shiftId, [isi(1)]);
    const b = await sellVia(pos, shiftId, [isi(1)]);
    const del = await t.db.execute(sql`delete from pos_sales where id = ${a.saleId}`).catch((e: unknown) => e);
    expect(hardeningViolationCode(del)).toBe("EQ001");
    const mass = await pos.send("m6.pos_sale.void", { saleIds: [a.saleId, b.saleId], reason: "wrong_product" });
    expect(mass.status).toBe("rejected");
    expect((await t.db.select().from(posSales).where(eq(posSales.shiftId, shiftId))).every((s) => s.status === "valid")).toBe(true);
  });
});
