/**
 * Regresi temuan audit S5-B (M4): hari kas yang ditutup tetap terkunci pada jalur persetujuan/pembalik, pembalik setor
 * bank vs pencocokan, ambang PAR-01 per sopir/outlet per hari, selisih setoran tertunda yang kasnya akhirnya diterima,
 * pemisahan tugas "dicatat kantor", tutup kas tertunda, dan label sumber selisih di layar tutup kas.
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, bankDeposits, cashCloseExceptions, discrepancies, domainEvents, incomingTransfers, officeCashMovements, pettyCashTransactions, restitutions } from "@/db/schema";
import { EQUA_TENANT_ID, outletId, userIdByUsername } from "@/db/seed";
import { addDays, toBusinessDate } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { withTx } from "@/server/core/db";
import { ForbiddenError } from "@/server/core/errors";
import * as flags from "@/server/core/flags";
import { put } from "@/server/core/storage";
import * as m3 from "@/server/modules/m3-driver";
import * as m4 from "@/server/modules/m4-cash";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createDeposit } from "../helpers/fixtures";
import { PRICE, at, departArrive, driverDay, driverWorld, expectApplied, finance, finance2, isolateCashDays, manifest, owner } from "./helpers";

const today = () => toBusinessDate(new Date());
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x11, 0x22, 0x33]);
const slip = () => withTx((tx) => put(tx, finance(), { blob: JPEG, contentType: "image/jpeg", kind: "bank_slip" }));

async function officeBalanceThrough(db: Parameters<typeof isolateCashDays>[0], date: string): Promise<number> {
  const rows = await db.select().from(officeCashMovements).where(eq(officeCashMovements.tenantId, EQUA_TENANT_ID));
  return rows.filter((m) => m.businessDate <= date).reduce((s, m) => s + (m.direction === "in" ? m.amount : -m.amount), 0);
}

describe("M4 — hari kas yang ditutup tetap terkunci pada jalur persetujuan & pembalik (US-M4-06 KP-7, BR-38)", () => {
  const t = useTestDb({ seed: true });
  let bankId = "";
  beforeAll(async () => {
    bootstrapForTests();
    await isolateCashDays(t.db, today());
    bankId = (await m4.createBankAccount(finance(), { bankName: "BNI", accountNumber: "0987654321", accountName: "PT EQUA Tirta" })).id;
  });

  it("US-M4-06 KP-7 US-M4-05 KP-2 persetujuan kas kecil & pembalik setor bank yang diputuskan setelah kas ditutup berlaku di hari kas berikutnya; saldo hari yang ditutup tidak berubah", async () => {
    const date = today();
    const hasOpening = (await m4.getOfficeCash(finance(at(date, "09:00")))).hasOpeningBalance;
    if (!hasOpening) await m4.recordOfficeCashOpening(finance(at(date, "08:00")), { amount: 3_000_000, note: "Hitung fisik" });
    const dep = await m4.recordBankDeposit(finance(at(date, "14:00")), { bankAccountId: bankId, amount: 700_000, slipAttachmentId: (await slip()).id });
    const rev = await m4.reverseBankDeposit(finance(at(date, "14:30")), { bankDepositId: dep.id, reason: "Setoran batal di teller" });
    expect(rev.status).toBe("pending_approval");
    const petty = await m4.recordPettyCash(finance(at(date, "15:00")), { kind: "topup", amount: 600_000, description: "Isi kas kecil besar" });
    expect(petty.status).toBe("pending_approval");

    const screen = await m4.getCashDayScreen(finance(at(date, "20:00")));
    expect(screen.canClose).toBe(true);
    const closed = await m4.closeCashDay(finance(at(date, "20:05")), { officeCashPhysical: screen.officeCashSystem });
    expect(closed.status).toBe("closed");

    await approvals.decide(owner(at(date, "21:00")), rev.approvalId!, "approve", "Setuju dibalik");
    const pettyReq = (await t.db.select().from(approvalRequests).where(eq(approvalRequests.objectId, petty.id)))[0]!;
    await approvals.decide(owner(at(date, "21:00")), pettyReq.id, "approve");

    const next = addDays(date, 1);
    const pettyRow = (await t.db.select().from(pettyCashTransactions).where(eq(pettyCashTransactions.id, petty.id)))[0]!;
    expect(pettyRow).toMatchObject({ status: "approved", businessDate: next });
    const pettyMove = (await t.db.select().from(officeCashMovements).where(and(eq(officeCashMovements.sourceObjectType, "petty_cash_transaction"), eq(officeCashMovements.sourceObjectId, petty.id))))[0]!;
    expect(pettyMove).toMatchObject({ businessDate: next, direction: "out", amount: 600_000 });
    expect(pettyMove.description).toContain("setelah kas ditutup");
    const revRow = (await t.db.select().from(bankDeposits).where(eq(bankDeposits.reversalOfId, dep.id)))[0]!;
    expect(revRow.businessDate).toBe(next);
    const revMove = (await t.db.select().from(officeCashMovements).where(eq(officeCashMovements.sourceObjectId, revRow.id)))[0]!;
    expect(revMove).toMatchObject({ businessDate: next, direction: "in", amount: 700_000 });
    expect(revMove.description).toContain("setelah kas ditutup");
    // Hari yang ditutup tetap: saldo sistem sampai tanggal itu sama dengan snapshot tutup kas.
    expect(await officeBalanceThrough(t.db, date)).toBe(closed.officeCashSystem);
    // Pencatatan langsung pada hari yang sudah ditutup ditolak.
    await expect(m4.recordBankDeposit(finance(at(date, "21:10")), { bankAccountId: bankId, amount: 1_000, slipAttachmentId: (await slip()).id, businessDate: date })).rejects.toThrow(/sudah ditutup/);
  });
});

describe("M4 — pembalik setor bank yang menunggu persetujuan vs pencocokan mutasi (US-M4-05 KP-1, US-M4-04 KP-2, BR-38)", () => {
  const t = useTestDb({ seed: true });
  let bankId = "";
  beforeAll(async () => {
    bootstrapForTests();
    bankId = (await m4.createBankAccount(finance(), { bankName: "BCA", accountNumber: "1112223334", accountName: "PT EQUA Tirta" })).id;
    const hasOpening = (await m4.getOfficeCash(finance())).hasOpeningBalance;
    if (!hasOpening) await m4.recordOfficeCashOpening(finance(at(today(), "08:00")), { amount: 5_000_000, note: "Hitung fisik" });
  });

  it("US-M4-05 KP-1 US-M4-04 KP-2 setor bank dicocokkan saat pembaliknya menunggu → permintaan pembalik dibatalkan otomatis; kas kantor tidak dikembalikan", async () => {
    const date = today();
    const dep = await m4.recordBankDeposit(finance(at(date, "10:00")), { bankAccountId: bankId, amount: 800_000, slipAttachmentId: (await slip()).id });
    const rev = await m4.reverseBankDeposit(finance(at(date, "10:30")), { bankDepositId: dep.id, reason: "Dikira gagal setor" });
    expect(rev.status).toBe("pending_approval");
    const tr = (await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.sourceObjectId, dep.id)))[0]!;
    await m4.matchTransfer(finance(at(date, "11:00")), { transferId: tr.id, refDate: date, refAmount: 800_000, refNote: "SETORAN TUNAI" });
    expect((await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, rev.approvalId!)))[0]!.status).toBe("cancelled");
    await expect(approvals.decide(owner(at(date, "12:00")), rev.approvalId!, "approve")).rejects.toThrow(/tidak dapat diputuskan/);
    expect(await t.db.select().from(bankDeposits).where(eq(bankDeposits.reversalOfId, dep.id))).toHaveLength(0);
    expect((await t.db.select().from(bankDeposits).where(eq(bankDeposits.id, dep.id)))[0]!.status).toBe("matched");
  });

  it("NFR-15 US-M4-04 KP-3 unggah .xlsx rusak/bukan xlsx → pesan Indonesia bertindakan, tanpa pesan pustaka berbahasa Inggris", async () => {
    const err = await m4.importBankStatement(finance(), { bankAccountId: bankId, fileName: "mutasi.xlsx", content: new Uint8Array(Buffer.from("bukan berkas zip sama sekali")) }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/rusak atau bukan format \.xlsx.*unggah lagi/);
    expect((err as Error).message).not.toMatch(/zip|central directory|http/i);
  });

  it("US-M4-05 KP-1 BR-38 persetujuan pembalik atas setor bank yang sudah cocok tidak diterapkan (tanpa kas kembali, tanpa jurnal pembalik)", async () => {
    const date = today();
    const dep = await m4.recordBankDeposit(finance(at(date, "13:00")), { bankAccountId: bankId, amount: 900_000, slipAttachmentId: (await slip()).id });
    const rev = await m4.reverseBankDeposit(finance(at(date, "13:10")), { bankDepositId: dep.id, reason: "Salah rekening" });
    // Balapan: status cocok tercatat tanpa lewat pencocokan layanan (mis. impor bersamaan).
    await t.db.update(bankDeposits).set({ status: "matched" }).where(eq(bankDeposits.id, dep.id));
    const decided = await approvals.decide(owner(at(date, "14:00")), rev.approvalId!, "approve");
    expect(decided.outcome).toMatchObject({ applied: false });
    expect(await t.db.select().from(bankDeposits).where(eq(bankDeposits.reversalOfId, dep.id))).toHaveLength(0);
    const evs = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "bank_deposit.reversed"), eq(domainEvents.objectId, dep.id)));
    expect(evs).toHaveLength(0);
  });
});

describe("M4 — ambang PAR-01 per sopir/outlet per hari (6.2a cash_discrepancy, BR-09, US-M4-02 KP-4)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M4-02 KP-4 BR-09 dua setoran shift depot yang sama pada hari yang sama masing-masing kurang 30.000 (total ≥ PAR-01) → keduanya ke keputusan pemilik; yang sudah ditutup dibuka kembali", async () => {
    const date = today();
    const d08 = outletId("D08");
    const a = await createDeposit(t.db, { date, sourceType: "depot_shift", status: "submitted", outletId: d08, expectedCash: 300_000 });
    const r1 = await m4.receiveDeposit(finance(at(date, "15:00")), { depositId: a.id, receivedAmount: 270_000, discrepancyReason: "wrong_change", close: true });
    expect(r1.discrepancy).toMatchObject({ amount: -30_000, requiresOwnerDecision: false });
    expect((await t.db.select().from(discrepancies).where(eq(discrepancies.id, r1.discrepancy!.id)))[0]!.status).toBe("done");

    const b = await createDeposit(t.db, { date, sourceType: "depot_shift", status: "submitted", outletId: d08, expectedCash: 250_000 });
    const r2 = await m4.receiveDeposit(finance(at(date, "16:00")), { depositId: b.id, receivedAmount: 220_000, discrepancyReason: "wrong_change", close: true });
    expect(r2.discrepancy).toMatchObject({ amount: -30_000, requiresOwnerDecision: true });
    const rows = await t.db.select().from(discrepancies).where(and(eq(discrepancies.outletId, d08), eq(discrepancies.businessDate, date)));
    for (const d of rows) {
      expect(d).toMatchObject({ requiresOwnerDecision: true, status: "explained" });
      const req = (await t.db.select().from(approvalRequests).where(and(eq(approvalRequests.objectId, d.id), eq(approvalRequests.type, "cash_discrepancy"))))[0];
      expect(req?.status).toBe("submitted");
    }
    expect(rows.find((d) => d.id === r1.discrepancy!.id)!.reopenReason).toMatch(/PAR-01/);

    // Outlet lain / hari lain tidak dijumlahkan.
    const c = await createDeposit(t.db, { date, sourceType: "depot_shift", status: "submitted", outletId: outletId("D09"), expectedCash: 250_000 });
    const r3 = await m4.receiveDeposit(finance(at(date, "16:30")), { depositId: c.id, receivedAmount: 220_000, discrepancyReason: "wrong_change" });
    expect(r3.discrepancy).toMatchObject({ requiresOwnerDecision: false });
  });
});

describe("M4 — selisih setoran tertunda diselesaikan saat kas akhirnya diterima (US-M4-06 KP-2, US-M4-03 KP-2, BR-11c)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(async () => {
    bootstrapForTests();
    await isolateCashDays(t.db, today());
  });

  async function pendingDiscrepancy() {
    const date = today();
    const d = await driverDay(t.db, { trips: 1 });
    const exc = await m4.requestCloseException(finance(at(date, "20:00")), { depositId: d.depositId, reason: "Sopir sakit mendadak, setor besok" });
    const req = (await t.db.select().from(approvalRequests).where(eq(approvalRequests.objectId, exc.id)))[0]!;
    await approvals.decide(owner(at(date, "20:05")), req.id, "approve", "Izinkan sekali ini");
    return { d, exc, date };
  }

  it("US-M4-06 KP-2 US-M4-03 KP-2 kas setoran tertunda diterima penuh setelah menjadi selisih → selisih setoran tertunda Selesai (tidak menunggu pemilik, tidak mengunci rit); ganti rugi yang sudah tercatat gugur", async () => {
    const { d, exc, date } = await pendingDiscrepancy();
    const screen = await m4.getCashDayScreen(finance(at(date, "20:10")));
    await m4.closeCashDay(finance(at(date, "20:10")), { officeCashPhysical: screen.officeCashSystem });
    const e1 = (await t.db.select().from(cashCloseExceptions).where(eq(cashCloseExceptions.id, exc.id)))[0]!;
    await m4.runPendingDepositDueCheck(new Date(e1.dueAt!.getTime() + 60_000));
    const e2 = (await t.db.select().from(cashCloseExceptions).where(eq(cashCloseExceptions.id, exc.id)))[0]!;
    const discId = e2.convertedDiscrepancyId!;
    expect((await t.db.select().from(discrepancies).where(eq(discrepancies.id, discId)))[0]).toMatchObject({ source: "pending_deposit", amount: -PRICE, status: "formed" });
    // Admin Keuangan menjelaskan → pemilik menolak dengan ganti rugi aktif → ganti rugi tercatat.
    await flags.set(owner(), "cash.restitution_active", true, { reason: "Peraturan Perusahaan berlaku" });
    const next = addDays(date, 1);
    const explained = await m4.explainDiscrepancy(finance(at(next, "10:00")), { discrepancyId: discId, reason: "other", explanation: "Sopir belum menyetor" });
    await m4.decideDiscrepancy(owner(at(next, "11:00")), discId, { decision: "reject", reason: "Setoran wajib hari itu" });
    void explained;
    const rest = (await t.db.select().from(restitutions).where(eq(restitutions.discrepancyId, discId)))[0]!;
    expect(rest).toMatchObject({ amount: PRICE, status: "recorded" });

    // Kas akhirnya diterima penuh.
    const res = await m4.receiveDeposit(finance(at(next, "21:00")), { depositId: d.depositId, receivedAmount: PRICE, lateReason: "Sopir sakit, setor terlambat" });
    expect(res.deposit).toMatchObject({ discrepancyAmount: 0 });
    const disc = (await t.db.select().from(discrepancies).where(eq(discrepancies.id, discId)))[0]!;
    expect(disc).toMatchObject({ status: "done", locksTrips: false });
    expect(disc.followUpNote).toMatch(/diterima/);
    expect((await t.db.select().from(restitutions).where(eq(restitutions.id, rest.id)))[0]).toMatchObject({ status: "settled", settledAmount: PRICE });
    const reopened = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "discrepancy.reopened"), eq(domainEvents.objectId, discId)));
    expect(reopened).toHaveLength(1);
    await flags.set(owner(), "cash.restitution_active", false, { reason: "Kembali ke bawaan uji" });
  });
});

describe("M4 — pemisahan tugas: penerima setoran bukan pencatat transaksi di dalamnya (US-M4-02 KP-9, FR-M10-03)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M4-02 KP-9 FR-M10-03 Admin Keuangan yang mencatat rit \"dicatat kantor\" tidak dapat menerima/menutup setoran yang memuatnya; Admin Keuangan lain dapat", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    await m3.officeCompleteTrip(finance(), { tripId: a.id, reason: "Ponsel sopir mati total, bukti nota kertas No. 21", occurredTime: "09:30", recipientName: "Ibu Penerima", deliveredVolumeL: 5000, payment: { method: "cash", cashReceived: PRICE } });
    expectApplied(await w.send(w.sopir, "m3.deposit.submit", { method: "physical", manifest: manifest({ completedTripIds: [a.id] }) }));
    const dep = (await m4.listDepositsForReceipt(finance2())).waiting.find((r) => r.sourceDetail?.includes(w.truck.code) || r.sourceLabel.includes("Sopir Uji"))!;
    expect(dep).toBeTruthy();
    const detail = await m4.getDepositDetail(finance(at(w.date)), dep.id);
    expect(detail.canReceive).toBe(false);
    expect(detail.blockReason).toMatch(/Anda catat sendiri/);
    await expect(m4.receiveDeposit(finance(at(w.date)), { depositId: dep.id, receivedAmount: PRICE })).rejects.toBeInstanceOf(ForbiddenError);
    const ok = await m4.receiveDeposit(finance2(at(w.date)), { depositId: dep.id, receivedAmount: PRICE, close: true });
    expect(ok.deposit.status).toBe("closed");
    void userIdByUsername;
  });
});

describe("M4 — tutup kas tertunda (7.4.6, US-M4-06 KP-3/KP-7)", () => {
  const t = useTestDb({ seed: true });
  let bankId = "";
  beforeAll(async () => {
    bootstrapForTests();
    await isolateCashDays(t.db, addDays(today(), -1));
    bankId = (await m4.createBankAccount(finance(), { bankName: "BRI", accountNumber: "5556667778", accountName: "PT EQUA Tirta" })).id;
  });

  it("US-M4-06 KP-3 US-M4-06 KP-7 setoran kemarin yang diterima pagi ini masuk kas kemarin; tutup kas kemarin membandingkan laci dengan saldo sampai saat ini — tanpa selisih palsu", async () => {
    const date = today();
    const yesterday = addDays(date, -1);
    const hasOpening = (await m4.getOfficeCash(finance(at(yesterday, "08:00")), { date: yesterday })).hasOpeningBalance;
    if (!hasOpening) await m4.recordOfficeCashOpening(finance(at(yesterday, "08:00")), { amount: 1_000_000, note: "Hitung fisik", businessDate: yesterday });
    const before = await m4.getCashDayScreen(finance(at(date, "07:50")), { date: yesterday });
    const dep = await createDeposit(t.db, { date: yesterday, sourceType: "depot_shift", status: "submitted", outletId: outletId("D08"), expectedCash: 500_000 });
    await m4.receiveDeposit(finance(at(date, "08:00")), { depositId: dep.id, receivedAmount: 500_000, lateReason: "Operator datang pagi", close: true });
    const mv = (await t.db.select().from(officeCashMovements).where(and(eq(officeCashMovements.sourceObjectType, "deposit"), eq(officeCashMovements.sourceObjectId, dep.id))))[0]!;
    expect(mv.businessDate).toBe(yesterday);
    // Setor bank pagi ini (bertanggal hari ini) juga sudah mengurangi laci.
    await m4.recordBankDeposit(finance(at(date, "08:20")), { bankAccountId: bankId, amount: 200_000, slipAttachmentId: (await slip()).id });
    const screen = await m4.getCashDayScreen(finance(at(date, "08:30")), { date: yesterday });
    expect(screen.officeCashThroughDate).toBe(before.officeCashThroughDate + 500_000);
    expect(screen.officeCashLaterNet).toBe(-200_000 + (before.officeCashLaterNet ?? 0));
    const drawer = before.officeCashSystem + 500_000 - 200_000;
    expect(screen.officeCashSystem).toBe(drawer);
    const closed = await m4.closeCashDay(finance(at(date, "08:36")), { date: yesterday, officeCashPhysical: drawer });
    expect(closed).toMatchObject({ status: "closed", officeCashDifference: 0, officeDiscrepancyId: null });
  });

  it("D-12 butir 7 US-M4-06 KP-3 selisih hari ini di layar tutup kas menampilkan outlet/truk & nama karyawan", async () => {
    const date = today();
    const d = await driverDay(t.db, { trips: 1 });
    await m4.receiveDeposit(finance(at(date, "15:00")), { depositId: d.depositId, receivedAmount: PRICE - 10_000, discrepancyReason: "wrong_change" });
    const screen = await m4.getCashDayScreen(finance(at(date, "16:00")));
    const row = screen.discrepancies.find((x) => x.depositId === d.depositId)!;
    expect(row.truckCode).toBe(d.truck.code);
    expect(row.employeeName).toMatch(/Sopir Uji/);
    expect(row.sourceLabel).toContain(d.truck.code);
  });
});
