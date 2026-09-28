/**
 * M4 — aturan hasil tinjauan KP sesi lanjutan: "ganti rugi aktif" diatur pemilik dari layar Ganti rugi, PAR-83 di bawah
 * PAR-01, rujukan kejadian ganti rugi (setoran & rit), kas diterima setelah hari kasnya ditutup, setoran slip bank lewat
 * impor mutasi (rekening untuk jurnal M11), lampiran berkas mutasi, dan pilihan outlet kas kecil.
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, attachments, auditLogs, discrepancies, domainEvents, officeCashMovements, parameters, restitutions, trips } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import { newId } from "@/lib/ids";
import { addDays, toBusinessDate } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { withTx } from "@/server/core/db";
import { ForbiddenError } from "@/server/core/errors";
import { put } from "@/server/core/storage";
import * as m3 from "@/server/modules/m3-driver";
import * as m4 from "@/server/modules/m4-cash";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { PRICE, at, depotDay, driverDay, finance, isolateCashDays, notificationsOf, owner } from "./helpers";

const today = () => toBusinessDate(new Date());

describe("M4 — ganti rugi aktif, PAR-83, rujukan kejadian (US-M4-02 KP-10, US-M4-03 KP-3/KP-4)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M4-03 KP-4 hanya pemilik mengaktifkan 'ganti rugi aktif' dari layar Ganti rugi: alasan wajib, berjejak audit, Admin Keuangan diberi tahu", async () => {
    expect(await m4.getRestitutionActive(finance())).toBe(false);
    // Admin Keuangan tidak dapat mengubah (6.2b: pengatur flag = pemilik) — ditolak, bukan diperingatkan.
    await expect(m4.setRestitutionActive(finance(), { enabled: true, reason: "Peraturan Perusahaan berlaku" })).rejects.toBeInstanceOf(ForbiddenError);
    // Alasan wajib (minimal 5 karakter); masukan ketat.
    await expect(m4.setRestitutionActive(owner(), { enabled: true, reason: "PP" })).rejects.toThrow(/Alasan/);
    await expect(m4.setRestitutionActive(owner(), { enabled: true, reason: "Peraturan Perusahaan berlaku", extra: 1 })).rejects.toThrow();
    expect(await m4.getRestitutionActive(owner())).toBe(false);

    const on = await m4.setRestitutionActive(owner(), { enabled: true, reason: "Peraturan Perusahaan No. 1/2026 berlaku" });
    expect(on).toEqual({ enabled: true });
    expect(await m4.getRestitutionActive(finance())).toBe(true);
    const audit = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "feature_flag"), eq(auditLogs.action, "set")));
    expect(audit.some((a) => a.objectId.startsWith("cash.restitution_active") && a.reason === "Peraturan Perusahaan No. 1/2026 berlaku")).toBe(true);
    const notes = (await notificationsOf(t.db, "parameter.changed")).filter((n) => n.link === "/kas/ganti-rugi");
    expect(notes.length).toBeGreaterThan(0);

    await m4.setRestitutionActive(owner(), { enabled: false, reason: "Kembali ke bawaan uji" });
    expect(await m4.getRestitutionActive(finance())).toBe(false);
  });

  it("US-M4-02 KP-10 PAR-83 diatur di bawah PAR-01: selisih yang mengunci rit tetap menunggu keputusan pemilik (tidak ikut ditutup Admin Keuangan bersama setoran)", async () => {
    await t.db.update(parameters).set({ value: { enabled: true, amount_gte: 20_000 } }).where(eq(parameters.key, "PAR-83"));
    try {
      const d = await driverDay(t.db, { trips: 1 });
      // 30.000 < PAR-01 (50.000) tetapi ≥ PAR-83 (20.000).
      const res = await m4.receiveDeposit(finance(at(d.date)), { depositId: d.depositId, receivedAmount: PRICE - 30_000, discrepancyReason: "other", discrepancyNote: "Uang kurang, sopir tidak tahu" });
      expect(res.deposit.status).toBe("closed");
      expect(res.discrepancy).toMatchObject({ amount: -30_000, locksTrips: true, requiresOwnerDecision: true, status: "explained" });
      const row = (await t.db.select().from(discrepancies).where(eq(discrepancies.id, res.discrepancy!.id)))[0]!;
      expect(row.closedBelowThresholdAt).toBeNull();
      const req = (await t.db.select().from(approvalRequests).where(eq(approvalRequests.objectId, row.id)))[0]!;
      expect(req).toMatchObject({ type: "cash_discrepancy", status: "submitted" });
      const next = addDays(d.date, 1);
      const lockOf = () => m3.driverLock(t.db, { userId: d.driver.userId, employeeId: d.driver.employeeId, date: next, tenantId: EQUA_TENANT_ID });
      expect((await lockOf())?.kind).toBe("par83");
      await approvals.decide(owner(at(d.date, "16:00")), req.id, "approve", "Dibebankan ke pusat laba");
      expect(await lockOf()).toBeNull();
      expect((await t.db.select().from(discrepancies).where(eq(discrepancies.id, row.id)))[0]).toMatchObject({ status: "done", decision: "approved", locksTrips: false });
    } finally {
      await t.db.update(parameters).set({ value: { enabled: false, amount_gte: 500_000 } }).where(eq(parameters.key, "PAR-83"));
    }
  });

  it("US-M4-03 KP-3 ganti rugi per kejadian mencatat karyawan, tanggal, jumlah, rujukan setoran & rit, serta alasan penolakan", async () => {
    await m4.setRestitutionActive(owner(), { enabled: true, reason: "Peraturan Perusahaan berlaku" });
    try {
      const d = await driverDay(t.db, { trips: 1 });
      const res = await m4.receiveDeposit(finance(at(d.date)), { depositId: d.depositId, receivedAmount: PRICE - 60_000, discrepancyReason: "other", discrepancyNote: "Uang hilang di jalan" });
      await m4.decideDiscrepancy(owner(at(d.date, "17:00")), res.discrepancy!.id, { decision: "reject", reason: "Kelalaian menjaga uang setoran" });
      const rest = (await t.db.select().from(restitutions).where(eq(restitutions.discrepancyId, res.discrepancy!.id)))[0]!;
      const trip = (await t.db.select({ id: trips.id, number: trips.number }).from(trips).where(eq(trips.id, d.tripIds[0]!)))[0]!;
      expect(rest).toMatchObject({ employeeId: d.driver.employeeId, businessDate: d.date, amount: 60_000, tripId: trip.id, status: "recorded" });
      expect(rest.reason).toContain(res.deposit.number);
      expect(rest.reason).toContain(trip.number);
      expect(rest.reason).toContain("Kelalaian menjaga uang setoran");
      const list = await m4.listRestitutions(finance(), { view: "open" });
      expect(list.find((r) => r.id === rest.id)).toMatchObject({ depositId: d.depositId, depositNumber: res.deposit.number, discrepancyAmount: -60_000 });
    } finally {
      await m4.setRestitutionActive(owner(), { enabled: false, reason: "Kembali ke bawaan uji" });
    }
  });

  it("US-M4-05 KP-2 pilihan outlet pengeluaran kas kecil hanya untuk peran berizin kas kecil", async () => {
    const outlets = await m4.pettyCashOutletOptions(finance());
    expect(outlets.length).toBeGreaterThanOrEqual(11);
    expect(outlets.some((o) => o.code === "D01") && outlets.some((o) => o.code === "TK1")).toBe(true);
    await expect(m4.pettyCashOutletOptions(seededContext("sopir1"))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("M4 — kas diterima setelah hari kasnya ditutup (US-M4-06 KP-7, Bab 5.3)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(async () => {
    bootstrapForTests();
    await isolateCashDays(t.db, today());
  });

  it("US-M4-06 KP-7 setoran tertunda (pengecualian) diterima setelah kas ditutup → kas kantor masuk hari kas berikutnya bertanda; hari yang ditutup tidak berubah", async () => {
    const date = today();
    const d = await driverDay(t.db, { trips: 1 });
    const exc = await m4.requestCloseException(finance(at(date, "20:00")), { depositId: d.depositId, reason: "Sopir sakit mendadak, setor malam ini" });
    const req = (await t.db.select().from(approvalRequests).where(eq(approvalRequests.objectId, exc.id)))[0]!;
    await approvals.decide(owner(at(date, "20:05")), req.id, "approve", "Izinkan sekali ini");
    const before = await m4.getCashDayScreen(finance(at(date, "20:10")));
    const closed = await m4.closeCashDay(finance(at(date, "20:10")), { officeCashPhysical: before.officeCashSystem });
    expect(closed.status).toBe("closed");

    // Uang datang malam itu juga (setelah kas ditutup).
    const res = await m4.receiveDeposit(finance(at(date, "21:30")), { depositId: d.depositId, receivedAmount: PRICE });
    expect(res.deposit.status).toBe("closed");
    const mv = (await t.db.select().from(officeCashMovements).where(and(eq(officeCashMovements.sourceObjectType, "deposit"), eq(officeCashMovements.sourceObjectId, d.depositId))))[0]!;
    expect(mv).toMatchObject({ kind: "deposit_received", direction: "in", amount: PRICE, businessDate: addDays(date, 1) });
    expect(mv.description).toContain("setelah kas ditutup");
    // Hari yang ditutup tetap: saldo sistem hari itu tidak berubah; kas besok bertambah.
    const closedDay = await m4.getOfficeCash(finance(at(date, "21:35")), { date });
    expect(closedDay.day.closing).toBe(before.officeCashSystem);
    const nextDay = await m4.getOfficeCash(finance(at(addDays(date, 1), "08:00")), { date: addDays(date, 1) });
    expect(nextDay.day).toMatchObject({ opening: before.officeCashSystem, depositsReceived: PRICE, closing: before.officeCashSystem + PRICE });
  });
});

describe("M4 — setoran slip bank lewat impor mutasi (US-M4-02 KP-7, US-M4-04 KP-3/KP-5)", () => {
  const t = useTestDb({ seed: true });
  let bankId = "";
  beforeAll(async () => {
    bootstrapForTests();
    bankId = (await m4.createBankAccount(finance(), { bankName: "BRI", accountNumber: "0987654321", accountName: "PT EQUA Tirta", isCustomerFacing: false })).id;
  });

  it("US-M4-04 KP-3 US-M4-04 KP-5 berkas mutasi tersimpan sebagai lampiran impor; pasangan slip setor bank dikonfirmasi → setoran Diterima, deposit.received membawa rekening (jurnal M11 ke bank, bukan kas)", async () => {
    // Shift depot ditutup lalu disetor lewat bank dengan slip (jalur M6 nyata).
    const slip = await depotDay(t.db, "D06", { sales: 3 });
    const cmdId = newId();
    const up = await slip.pos.hp.upload(slip.pos.op, { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]), kind: "bank_slip", commandId: cmdId });
    const sub = await slip.pos.send("m6.shift_deposit.submit", { shiftId: slip.shiftId, method: "bank_slip" }, { id: cmdId, attachmentIds: [up.attachmentId], attachmentHashes: [up.sha256] });
    expect(sub.status, sub.message ?? "").toBe("applied");
    await m4.sweepSlipDeposits(new Date());
    const fa = finance(at(slip.date, "16:00"));
    const tr = (await m4.listIncomingTransfers(fa, { status: "open" })).find((x) => x.sourceObjectId === slip.depositId)!;
    expect(tr).toMatchObject({ sourceKind: "bank_deposit_slip", amount: slip.cashSales, status: "unmatched" });

    const [y, mo, dd] = slip.date.split("-");
    const csv = ["Tanggal,Keterangan,Jumlah,Saldo", `${dd}/${mo}/${y},SETORAN TUNAI D06 SLIP,"${slip.cashSales.toLocaleString("en-US")}.00 CR",0`].join("\n");
    const file = await withTx((tx) => put(tx, fa, { blob: Buffer.from(csv), contentType: "text/csv", kind: "bank_statement", originalName: "mutasi-bri.csv" }));
    const imp = await m4.importBankStatement(fa, { bankAccountId: bankId, fileName: "mutasi-bri.csv", content: csv, fileAttachmentId: file.id });
    expect(imp.inserted).toBe(1);
    expect((await t.db.select().from(attachments).where(eq(attachments.id, file.id)))[0]).toMatchObject({ objectType: "bank_statement_import", objectId: imp.importId });
    const line = (await m4.listStatementLines(fa, { status: "open" })).find((l) => l.importId === imp.importId)!;
    expect(line).toMatchObject({ amount: slip.cashSales, status: "unmatched" });

    const res = await m4.confirmStatementMatches(finance(at(slip.date, "16:10")), { pairs: [{ lineId: line.id, transferId: tr.id }] });
    expect(res.matched).toBe(1);
    const detail = await m4.getDepositDetail(fa, slip.depositId);
    expect(detail.deposit).toMatchObject({ status: "closed", receivedAmount: slip.cashSales, discrepancyAmount: 0, slipTransferId: tr.id });
    const ev = (await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "deposit.received"), eq(domainEvents.objectId, slip.depositId))))[0]!;
    expect(ev.payload).toMatchObject({ method: "bank_slip", bankAccountId: bankId, receivedAmount: slip.cashSales, sourceType: "depot_shift" });
    // Uang slip langsung ke bank: kas kantor tidak bertambah.
    expect(await t.db.select().from(officeCashMovements).where(eq(officeCashMovements.sourceObjectId, slip.depositId))).toHaveLength(0);
    const matched = (await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "transfer.matched"), eq(domainEvents.objectId, tr.id))))[0]!;
    expect(matched.payload).toMatchObject({ sourceKind: "bank_deposit_slip", bankAccountId: bankId });
  });
});
