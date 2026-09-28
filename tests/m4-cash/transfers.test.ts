import * as ExcelJSNs from "exceljs";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { bankAccounts, bankStatementLines, domainEvents, employees, incomingTransfers, tripPayments } from "@/db/schema";
import { EQUA_TENANT_ID, customerId, userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";
import { addDays, toBusinessDate } from "@/lib/time";
import { systemContext } from "@/server/core/context";
import { withTx } from "@/server/core/db";
import { emit } from "@/server/core/events";
import { exportReport } from "@/server/core/export";
import * as m4 from "@/server/modules/m4-cash";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { PRICE, at, depotDay, driverDay, finance, manifest, notificationsOf, owner } from "./helpers";

const ExcelJS = ((ExcelJSNs as unknown as { default?: typeof ExcelJSNs }).default ?? ExcelJSNs) as typeof ExcelJSNs;

describe("M4 — pembaca berkas mutasi (US-M4-04 KP-3)", () => {
  it("US-M4-04 KP-3 angka & tanggal mutasi bank dikenali (titik/koma ribuan, CR/DB, tanpa tahun)", () => {
    expect(m4.parseBankAmount("1.500.000")).toEqual({ value: 1_500_000, sign: 0 });
    expect(m4.parseBankAmount("1,500,000.00")).toEqual({ value: 1_500_000, sign: 0 });
    expect(m4.parseBankAmount("Rp 250.000,00 CR")).toEqual({ value: 250_000, sign: 1 });
    expect(m4.parseBankAmount("75.000 DB")).toEqual({ value: 75_000, sign: -1 });
    expect(m4.parseBankAmount("(5.000)")).toEqual({ value: 5_000, sign: -1 });
    expect(m4.parseBankAmount("1500,50")).toEqual({ value: 1_501, sign: 0 });
    expect(m4.parseBankAmount("abc")).toBeNull();
    expect(m4.parseBankDate("28/09/2026")).toBe("2026-09-28");
    expect(m4.parseBankDate("2026-09-28")).toBe("2026-09-28");
    expect(m4.parseBankDate("28/09", 2026)).toBe("2026-09-28");
    expect(m4.parseBankDate("5 Okt 2026")).toBe("2026-10-05");
    expect(m4.parseBankDate("31/02/2026")).toBeNull();
    const parsed = m4.parseStatementCsv("Tanggal;Keterangan;Kredit;Debit;Saldo\n28/09/2026;TRF PLG;250.000;;1.250.000\n28/09/2026;BIAYA ADM;;5.000;1.245.000\n;;;;\n");
    expect(parsed.lines.map((l) => l.amount)).toEqual([250_000, -5_000]);
    expect(parsed.lines[0]!.balance).toBe(1_250_000);
    expect(() => m4.parseStatementCsv("a,b\n1,2")).toThrow(/tidak dikenali/);
  });
});

describe("M4 — transfer masuk & pencocokan (US-M4-04)", () => {
  const t = useTestDb({ seed: true });
  let bankId = "";
  beforeAll(async () => {
    bootstrapForTests();
    const acc = await m4.createBankAccount(finance(), { bankName: "BCA", accountNumber: "1234567890", accountName: "PT EQUA Tirta", isCustomerFacing: true });
    bankId = acc.id;
  });

  it("US-M4-04 KP-1 daftar transfer tercatat dari pembayaran rit, QRIS per shift, setor bank sopir/outlet, pelunasan mitra toko — jumlah, bukti, sumber, tanggal, status; satu per sumber", async () => {
    const d = await driverDay(t.db, { trips: 0, transferTrips: 1 });
    const pay = (await t.db.select().from(tripPayments).where(eq(tripPayments.tripId, d.tripIds[0]!)))[0]!;
    const tr = (await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.sourceObjectId, pay.id)))[0]!;
    expect(tr).toMatchObject({ sourceKind: "trip_payment", amount: PRICE, status: "unmatched", customerId: pay.customerId, sourceUserId: d.driver.userId, transferDate: d.date });
    expect(tr.proofAttachmentId).toBe(pay.transferProofAttachmentId);
    expect(pay.incomingTransferId).toBe(tr.id);
    // QRIS per shift (PTB-04).
    const depot = await depotDay(t.db, "D08", { sales: 1, qris: 2 });
    const qris = (await t.db.select().from(incomingTransfers).where(and(eq(incomingTransfers.shiftId, depot.shiftId), eq(incomingTransfers.sourceKind, "qris_shift"))))[0]!;
    expect(qris).toMatchObject({ amount: 2 * 15_000, outletId: depot.pos.outletId });
    // Setor bank sopir yang diizinkan (PTB-23).
    const s = await driverDay(t.db, { trips: 1, submit: false });
    await t.db.update(employees).set({ allowBankDeposit: true }).where(eq(employees.id, s.driver.employeeId));
    expect((await s.send(s.sopir, "m3.deposit.submit", { method: "bank_slip", manifest: manifest({ completedTripIds: s.tripIds }) }, { attach: [{ kind: "deposit_slip" }] })).status).toBe("applied");
    const slip = (await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.sourceKind, "bank_deposit_slip"))).find((x) => x.sourceUserId === s.driver.userId)!;
    expect(slip).toMatchObject({ amount: PRICE, status: "unmatched", sourceObjectType: "deposit" });
    // Pelunasan mitra toko (transfer) — event yang sama dua kali tidak menggandakan.
    const paymentId = newId();
    for (let i = 0; i < 2; i++) {
      await withTx((tx) =>
        emit(
          tx,
          "collection.recorded",
          { customerPaymentId: paymentId, customerId: customerId("PLG-0001"), amount: 400_000, channel: "store", method: "transfer", allocations: [], advanceAmount: 0, businessDate: d.date },
          { ctx: systemContext({ tenantId: EQUA_TENANT_ID }), businessDate: d.date },
        ),
      );
    }
    const store = await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.sourceObjectId, paymentId));
    expect(store).toHaveLength(1);
    expect(store[0]).toMatchObject({ sourceKind: "store_collection", amount: 400_000 });
    const list = await m4.listIncomingTransfers(finance(), { status: "open" });
    expect(list.map((r) => r.sourceKind)).toEqual(expect.arrayContaining(["trip_payment", "qris_shift", "bank_deposit_slip", "store_collection"]));
    expect(list.find((r) => r.id === tr.id)).toMatchObject({ customerName: expect.any(String), sourceUserName: expect.any(String) });
  });

  it("US-M4-04 KP-2 pencocokan manual: Admin Keuangan mencatat referensi mutasi (tanggal, jumlah, keterangan) → Cocok", async () => {
    const d = await driverDay(t.db, { trips: 0, transferTrips: 1 });
    const tr = (await t.db.select().from(incomingTransfers).where(and(eq(incomingTransfers.sourceKind, "trip_payment"), eq(incomingTransfers.sourceUserId, d.driver.userId))))[0]!;
    await expect(m4.matchTransfer(owner(), { transferId: tr.id, refDate: d.date, refAmount: PRICE, refNote: "TRF MASUK" })).rejects.toThrow();
    await expect(m4.matchTransfer(finance(), { transferId: tr.id, refDate: d.date, refAmount: PRICE - 1_000, refNote: "TRF MASUK" })).rejects.toThrow(/berbeda dengan transfer tercatat/);
    const m = await m4.matchTransfer(finance(at(d.date, "16:00")), { transferId: tr.id, refDate: d.date, refAmount: PRICE, refNote: "TRSF E-BANKING CR 2809 PLG" });
    expect(m).toMatchObject({ status: "matched", matchRefDate: d.date, matchRefAmount: PRICE, matchRefNote: "TRSF E-BANKING CR 2809 PLG", matchedBy: userIdByUsername("keuangan1") });
    await expect(m4.matchTransfer(finance(), { transferId: tr.id, refDate: d.date, refAmount: PRICE, refNote: "lagi" })).rejects.toThrow(/sudah cocok/);
  });

  it("US-M4-04 KP-3 impor CSV/Excel mutasi: usulan pasangan (jumlah sama, tanggal ± 1 hari) dikonfirmasi; mutasi tanpa pasangan → daftar tindak lanjut; impor ulang tidak menggandakan", async () => {
    const a = await driverDay(t.db, { trips: 0, transferTrips: 1 });
    const b = await driverDay(t.db, { trips: 0, transferTrips: 1 });
    const ta = (await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.sourceUserId, a.driver.userId)))[0]!;
    const tb = (await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.sourceUserId, b.driver.userId)))[0]!;
    // Transfer b dicatat 1 hari lebih awal (masih ± 1 hari).
    // Jumlah unik agar tidak berpasangan dengan transfer uji lain yang masih terbuka.
    await t.db.update(incomingTransfers).set({ amount: PRICE + 7 }).where(eq(incomingTransfers.id, ta.id));
    await t.db.update(incomingTransfers).set({ transferDate: addDays(a.date, -1), amount: PRICE + 1 }).where(eq(incomingTransfers.id, tb.id));
    const [y, mo, dd] = a.date.split("-");
    const csv = [
      "Tanggal,Keterangan,Jumlah,Saldo",
      `${dd}/${mo}/${y},TRSF E-BANKING CR PELANGGAN A,"${(PRICE + 7).toLocaleString("en-US")}.00 CR",0`,
      `${dd}/${mo}/${y},TRSF CR PELANGGAN B,"${(PRICE + 1).toLocaleString("en-US")}.00 CR",0`,
      `${dd}/${mo}/${y},BUNGA JASA GIRO,"1,234.00 CR",0`,
      `${dd}/${mo}/${y},BIAYA ADM,"5,000.00 DB",0`,
    ].join("\n");
    const imp = await m4.importBankStatement(finance(at(a.date, "16:00")), { bankAccountId: bankId, fileName: "mutasi.csv", content: csv });
    expect(imp.inserted).toBe(4);
    const pa = imp.proposals.find((p) => p.transfer.id === ta.id);
    const pb = imp.proposals.find((p) => p.transfer.id === tb.id);
    expect(pa?.line.amount).toBe(PRICE + 7);
    expect(pb).toMatchObject({ dateDiff: 1 });
    expect(imp.unpaired.map((l) => l.amount)).toContain(1_234);
    const again = await m4.importBankStatement(finance(at(a.date, "16:05")), { bankAccountId: bankId, fileName: "mutasi.csv", content: csv });
    expect(again).toMatchObject({ inserted: 0, duplicates: 4 });
    const res = await m4.confirmStatementMatches(finance(at(a.date, "16:10")), { pairs: [{ lineId: pa!.line.id, transferId: ta.id }, { lineId: pb!.line.id, transferId: tb.id }] });
    expect(res.matched).toBe(2);
    expect((await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.id, ta.id)))[0]).toMatchObject({ status: "matched", bankStatementLineId: pa!.line.id, bankAccountId: bankId });
    expect((await t.db.select().from(bankStatementLines).where(eq(bankStatementLines.id, pa!.line.id)))[0]!.status).toBe("matched");
    // Mutasi tanpa pasangan → tindak lanjut.
    const giro = imp.unpaired.find((l) => l.amount === 1_234)!;
    await m4.markStatementLine(finance(), { lineId: giro.id, status: "follow_up", note: "Bunga giro — catat di M11" });
    const follow = await m4.listStatementLines(finance(), { status: "open" });
    expect(follow.find((l) => l.id === giro.id)).toMatchObject({ status: "follow_up", followUpNote: "Bunga giro — catat di M11" });
    expect((await notificationsOf(t.db, "bank_statement.unmatched")).length).toBeGreaterThan(0);
    // Excel (.xlsx) juga terbaca.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Mutasi");
    ws.addRow(["Rekening 1234567890"]);
    ws.addRow(["Tanggal Transaksi", "Keterangan", "Kredit", "Debet"]);
    ws.addRow([new Date(Date.UTC(Number(y), Number(mo) - 1, Number(dd))), "SETORAN TUNAI", 777_000, null]);
    const buf = new Uint8Array(await wb.xlsx.writeBuffer());
    const x = await m4.importBankStatement(finance(at(a.date, "16:20")), { bankAccountId: bankId, fileName: "mutasi.xlsx", content: buf });
    expect(x.inserted).toBe(1);
    await expect(m4.importBankStatement(finance(), { bankAccountId: bankId, fileName: "mutasi.pdf", content: "x" })).rejects.toThrow(/tidak didukung/);
  });

  it("US-M4-04 KP-4 transfer tanpa mutasi > PAR-39 hari → Tidak ditemukan + notifikasi pemilik & Admin Keuangan; transfer.not_found (piutang sementara M5)", async () => {
    const d = await driverDay(t.db, { trips: 0, transferTrips: 1 });
    const tr = (await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.sourceUserId, d.driver.userId)))[0]!;
    const twoDays = at(addDays(d.date, 2), "07:00");
    await m4.runTransferNotFoundCheck(twoDays);
    expect((await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.id, tr.id)))[0]!.status).toBe("unmatched");
    const threeDays = at(addDays(d.date, 3), "07:00");
    const res = await m4.runTransferNotFoundCheck(threeDays);
    expect(res.flagged).toBeGreaterThanOrEqual(1);
    expect((await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.id, tr.id)))[0]).toMatchObject({ status: "not_found" });
    const notes = await notificationsOf(t.db, "transfer.not_found", tr.id);
    const who = new Set(notes.map((n) => n.recipientUserId));
    expect(who.has(userIdByUsername("pemilik"))).toBe(true);
    expect(who.has(userIdByUsername("keuangan1"))).toBe(true);
    const ev = (await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "transfer.not_found"), eq(domainEvents.objectId, tr.id))))[0]!;
    expect(ev.payload).toMatchObject({ amount: PRICE, sourceKind: "trip_payment", customerId: tr.customerId, sourceObjectType: "trip_payment", tripId: d.tripIds[0] });
    // Mutasi datang kemudian → tetap dapat dicocokkan (terselesaikan).
    const m = await m4.matchTransfer(finance(threeDays), { transferId: tr.id, refDate: addDays(d.date, 3), refAmount: PRICE, refNote: "TRF terlambat masuk" });
    expect(m.status).toBe("matched");
  });

  it("US-M4-04 KP-5 hasil pencocokan harian menjadi masukan rekonsiliasi bank M11 (transfer.matched + laporan harian)", async () => {
    const d = await driverDay(t.db, { trips: 0, transferTrips: 1 });
    const tr = (await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.sourceUserId, d.driver.userId)))[0]!;
    const ctx = finance(at(d.date, "17:00"));
    await m4.matchTransfer(ctx, { transferId: tr.id, refDate: d.date, refAmount: PRICE, refNote: "TRF CR" });
    const ev = (await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "transfer.matched"), eq(domainEvents.objectId, tr.id))))[0]!;
    expect(ev.payload).toMatchObject({ incomingTransferId: tr.id, amount: PRICE, sourceKind: "trip_payment", targetType: "trip_payment", targetId: tr.sourceObjectId, customerId: tr.customerId });
    const day = await m4.dailyMatchingResults(ctx, { from: toBusinessDate(ctx.now), to: toBusinessDate(ctx.now) });
    expect(day.some((r) => r.status === "matched" && r.amount === PRICE && r.matchRefNote === "TRF CR")).toBe(true);
    const x = await exportReport(ctx, "m4.daily_matching", "xlsx", { from: d.date, to: d.date });
    expect(x.rowCount).toBeGreaterThanOrEqual(1);
    const acc = (await t.db.select().from(bankAccounts))[0];
    expect(acc).toBeTruthy();
  });
});
