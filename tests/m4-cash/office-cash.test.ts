import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, bankDeposits, discrepancies, domainEvents, incomingTransfers, officeCashMovements, pettyCashTransactions } from "@/db/schema";
import { toBusinessDate } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { withTx } from "@/server/core/db";
import { put } from "@/server/core/storage";
import * as m4 from "@/server/modules/m4-cash";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { at, finance, owner } from "./helpers";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x20, 0x30, 0x40, 0x50]);

async function photo(kind = "bank_slip") {
  return withTx((tx) => put(tx, finance(), { blob: JPEG, contentType: "image/jpeg", kind }));
}

describe("M4 — kas kantor, setor ke bank, kas kecil (US-M4-05)", () => {
  const t = useTestDb({ seed: true });
  const today = toBusinessDate(new Date());
  const fa = () => finance(at(today, "14:00"));
  let bankId = "";
  beforeAll(async () => {
    bootstrapForTests();
    bankId = (await m4.createBankAccount(finance(), { bankName: "BRI", accountNumber: "0021-01-000123-30-1", accountName: "PT EQUA Tirta" })).id;
    await m4.recordOfficeCashOpening(fa(), { amount: 3_000_000, note: "Hitung fisik cut-over" });
  });

  it("US-M4-05 KP-1 setor ke bank: jumlah, tanggal, rekening PT, foto slip; mengurangi kas kantor; dicocokkan dengan mutasi", async () => {
    await expect(m4.recordOfficeCashOpening(fa(), { amount: 1, note: "Lagi" })).rejects.toThrow(/sudah pernah dicatat/);
    await expect(m4.recordBankDeposit(fa(), { bankAccountId: bankId, amount: 1_000_000 } as never)).rejects.toThrow();
    const slip = await photo();
    await expect(m4.recordBankDeposit(fa(), { bankAccountId: bankId, amount: 9_000_000, slipAttachmentId: slip.id })).rejects.toThrow(/melebihi saldo kas kantor/);
    await expect(m4.recordBankDeposit(owner(), { bankAccountId: bankId, amount: 1_000_000, slipAttachmentId: slip.id })).rejects.toThrow();
    const before = (await m4.getOfficeCash(fa())).day.closing;
    const dep = await m4.recordBankDeposit(fa(), { bankAccountId: bankId, amount: 1_000_000, slipAttachmentId: slip.id, notes: "Setor siang" });
    expect(dep).toMatchObject({ amount: 1_000_000, businessDate: today, status: "recorded", slipAttachmentId: slip.id });
    const office = await m4.getOfficeCash(fa());
    expect(office.day.closing).toBe(before - 1_000_000);
    expect(office.day.bankDeposits).toBeGreaterThanOrEqual(1_000_000);
    const tr = (await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.sourceObjectId, dep.id)))[0]!;
    expect(tr).toMatchObject({ sourceKind: "bank_deposit_slip", sourceObjectType: "bank_deposit", amount: 1_000_000, bankAccountId: bankId });
    await m4.matchTransfer(fa(), { transferId: tr.id, refDate: today, refAmount: 1_000_000, refNote: "SETORAN TUNAI" });
    expect((await t.db.select().from(bankDeposits).where(eq(bankDeposits.id, dep.id)))[0]).toMatchObject({ status: "matched" });
    await expect(m4.reverseBankDeposit(fa(), { bankDepositId: dep.id, reason: "Salah rekening" })).rejects.toThrow(/sudah cocok/);
  });

  it("US-M4-05 KP-1 koreksi setor bank = pembalik beralasan; > PAR-21 lewat persetujuan pemilik (BR-38)", async () => {
    const small = await m4.recordBankDeposit(fa(), { bankAccountId: bankId, amount: 200_000, slipAttachmentId: (await photo()).id });
    const r1 = await m4.reverseBankDeposit(fa(), { bankDepositId: small.id, reason: "Slip salah input" });
    expect(r1.status).toBe("reversed");
    expect((await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.sourceObjectId, small.id)))[0]!.status).toBe("cancelled");
    const big = await m4.recordBankDeposit(fa(), { bankAccountId: bankId, amount: 600_000, slipAttachmentId: (await photo()).id });
    const r2 = await m4.reverseBankDeposit(fa(), { bankDepositId: big.id, reason: "Setoran batal di bank" });
    expect(r2.status).toBe("pending_approval");
    expect(await t.db.select().from(bankDeposits).where(eq(bankDeposits.reversalOfId, big.id))).toHaveLength(0);
    await approvals.decide(owner(at(today, "15:00")), r2.approvalId!, "approve", "Setuju dibalik");
    const rev = (await t.db.select().from(bankDeposits).where(eq(bankDeposits.reversalOfId, big.id)))[0]!;
    expect(rev.amount).toBe(-600_000);
    const back = await t.db.select().from(officeCashMovements).where(eq(officeCashMovements.sourceObjectId, rev.id));
    expect(back[0]).toMatchObject({ direction: "in", amount: 600_000, kind: "adjustment" });
    expect((await t.db.select().from(domainEvents).where(eq(domainEvents.type, "bank_deposit.reversed"))).length).toBe(2);
  });

  it("US-M4-05 KP-2 kas kecil: pengisian dari kas kantor; pengeluaran berkategori + pusat laba + foto bukti; > PAR-43 perlu persetujuan pemilik", async () => {
    const officeBefore = (await m4.getOfficeCash(fa())).day.closing;
    const topup = await m4.recordPettyCash(fa(), { kind: "topup", amount: 400_000, description: "Isi kas kecil minggu ini" });
    expect(topup.status).toBe("approved");
    expect((await m4.getOfficeCash(fa())).day.closing).toBe(officeBefore - 400_000);
    await expect(m4.recordPettyCash(fa(), { kind: "expense", amount: 50_000, description: "ATK" })).rejects.toThrow(/kategori/);
    await expect(m4.recordPettyCash(fa(), { kind: "expense", amount: 50_000, category: "office_supplies", profitCenter: "SHARED", description: "ATK" })).rejects.toThrow(/Foto bukti/);
    await expect(m4.recordPettyCash(fa(), { kind: "expense", amount: 450_000, category: "office_supplies", profitCenter: "SHARED", description: "ATK", receiptAttachmentId: (await photo("receipt_note")).id })).rejects.toThrow(/melebihi saldo kas kecil/);
    const exp = await m4.recordPettyCash(fa(), { kind: "expense", amount: 75_000, category: "consumption", profitCenter: "L3", description: "Konsumsi rapat depot", receiptAttachmentId: (await photo("receipt_note")).id });
    expect(exp).toMatchObject({ status: "approved", profitCenter: "L3", category: "consumption" });
    // > PAR-43 (Rp 500.000) → persetujuan pemilik; ditolak → tidak berlaku.
    const big = await m4.recordPettyCash(fa(), { kind: "topup", amount: 600_000, description: "Isi kas kecil besar" });
    expect(big.status).toBe("pending_approval");
    const req = (await t.db.select().from(approvalRequests).where(eq(approvalRequests.objectId, big.id)))[0]!;
    expect(req).toMatchObject({ type: "petty_cash", status: "submitted" });
    const office1 = (await m4.getOfficeCash(fa())).day.closing;
    await approvals.decide(owner(at(today, "15:00")), req.id, "approve");
    expect((await t.db.select().from(pettyCashTransactions).where(eq(pettyCashTransactions.id, big.id)))[0]!.status).toBe("approved");
    expect((await m4.getOfficeCash(fa())).day.closing).toBe(office1 - 600_000);
    const big2 = await m4.recordPettyCash(fa(), { kind: "topup", amount: 700_000, description: "Isi lagi" });
    const req2 = (await t.db.select().from(approvalRequests).where(eq(approvalRequests.objectId, big2.id)))[0]!;
    await approvals.decide(owner(at(today, "15:00")), req2.id, "reject", "Belum perlu");
    expect((await t.db.select().from(pettyCashTransactions).where(eq(pettyCashTransactions.id, big2.id)))[0]!.status).toBe("rejected");
    const petty = await m4.getPettyCash(fa());
    expect(petty.balance).toBe(400_000 - 75_000 + 600_000);
  });

  it("US-M4-05 KP-2 rekonsiliasi fisik kas kecil mingguan: selisih wajib alasan → objek Selisih, saldo disesuaikan", async () => {
    const before = await m4.getPettyCash(fa());
    expect(before.countOverdue).toBe(true);
    await expect(m4.countPettyCash(fa(), { physicalAmount: before.balance - 10_000 })).rejects.toThrow(/isi alasan/);
    const c = await m4.countPettyCash(fa(), { physicalAmount: before.balance - 10_000, reason: "Uang parkir tamu tanpa nota" });
    expect(c).toMatchObject({ systemBalance: before.balance, difference: -10_000 });
    const disc = (await t.db.select().from(discrepancies).where(eq(discrepancies.id, c.discrepancyId!)))[0]!;
    expect(disc).toMatchObject({ source: "petty_cash", amount: -10_000, status: "explained" });
    const after = await m4.getPettyCash(fa());
    expect(after.balance).toBe(before.balance - 10_000);
    expect(after.countOverdue).toBe(false);
    const ok = await m4.countPettyCash(fa(), { physicalAmount: after.balance });
    expect(ok.difference).toBe(0);
  });

  it("US-M4-05 KP-3 semua mutasi kas kantor & kas kecil memancarkan event jurnal M11 dengan pusat laba", async () => {
    const types = (await t.db.select({ type: domainEvents.type, payload: domainEvents.payload }).from(domainEvents)).filter((e) => ["office_cash.moved", "petty_cash.recorded", "bank_deposit.recorded"].includes(e.type));
    expect(types.filter((e) => e.type === "bank_deposit.recorded").length).toBeGreaterThanOrEqual(3);
    const petty = types.filter((e) => e.type === "petty_cash.recorded").map((e) => e.payload as { kind: string; profitCenter?: string | null });
    expect(petty.some((p) => p.kind === "expense" && p.profitCenter === "L3")).toBe(true);
    expect(petty.some((p) => p.kind === "topup")).toBe(true);
    expect(petty.some((p) => p.kind === "adjustment")).toBe(true);
    const moved = types.filter((e) => e.type === "office_cash.moved").map((e) => (e.payload as { kind: string }).kind);
    expect(moved).toEqual(expect.arrayContaining(["opening_balance", "bank_deposit", "petty_cash_topup", "adjustment"]));
    // Riwayat mutasi dengan saldo berjalan.
    const list = await m4.listOfficeCashMovements(fa(), { from: today, to: today });
    expect(list[list.length - 1]!.balanceAfter).toBe((await m4.getOfficeCash(fa())).day.closing);
    const movesWithoutEvent = (await t.db.select().from(officeCashMovements).where(and(eq(officeCashMovements.businessDate, today)))).length;
    expect(moved.length).toBe(movesWithoutEvent);
  });
});
