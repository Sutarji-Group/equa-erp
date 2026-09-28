import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { bankReconciliations, bankStatementLines, cashDays, cashReconciliations, incomingTransfers } from "@/db/schema";
import { EQUA_TENANT_ID, outletId, seedId } from "@/db/seed";
import { newId } from "@/lib/ids";
import { addDays, lastDayOfMonth, wibToUtc } from "@/lib/time";
import { ForbiddenError } from "@/server/core/errors";
import * as m11 from "@/server/modules/m11-accounting";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { THIS_PERIOD, TODAY, accountant, emitEvent, finance, manualJournal, owner, pair, setPeriod, tripPayload } from "./helpers";

const BANK = seedId("bank_account:operasional");
const END = lastDayOfMonth(TODAY);

describe("M11 rekonsiliasi bank & kas (US-M11-06)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());
  let periodId = "";
  let notFoundId = "";

  beforeAll(async () => {
    periodId = (await setPeriod(t.db, THIS_PERIOD, "open")).id;
    // Buku bank: sewa dibayar dari rekening 1.000.000; transfer rit dicocokkan masuk 300.000 (jurnal M4 → bank).
    await manualJournal(finance(), { date: TODAY, description: "Sewa kantor dibayar transfer", lines: pair("6-1201", "1-1201", 1_000_000) });
    await emitEvent("transfer.matched", { incomingTransferId: newId(), amount: 300_000, sourceKind: "trip_payment", bankAccountId: BANK, matchedAt: new Date().toISOString() });
    // Pencocokan harian M4: sisa item per akhir periode.
    const base = { tenantId: EQUA_TENANT_ID, bankAccountId: BANK, transferDate: TODAY, businessDate: TODAY };
    const [nf] = await t.db
      .insert(incomingTransfers)
      .values([
        { ...base, sourceKind: "trip_payment", amount: 150_000, status: "unmatched", reference: "TRF-UNMATCHED" },
        { ...base, sourceKind: "bank_deposit_slip", amount: 400_000, status: "unmatched", reference: "SLIP-01" },
        { ...base, sourceKind: "trip_payment", amount: 90_000, status: "matched", matchedAt: new Date(), reference: "TRF-DONE" },
        { ...base, sourceKind: "office_payment", amount: 75_000, status: "matched", matchedAt: wibToUtc(addDays(END, 3), "09:00"), reference: "TRF-NEXT-MONTH" },
        { ...base, sourceKind: "trip_payment", amount: 60_000, status: "not_found", notFoundAt: new Date(), reference: "TRF-NOTFOUND" },
      ])
      .returning()
      .then((rows) => rows.filter((r) => r.status === "not_found"));
    notFoundId = nf!.id;
    await t.db.insert(bankStatementLines).values({ bankAccountId: BANK, lineDate: TODAY, amount: -1_000_000, balance: 8_888_000, rowHash: "uji-1", description: "Mutasi impor" });
  });

  it("US-M11-06 KP-1 & KP-4 rekonsiliasi bank per rekening per periode: saldo rekening vs buku; item penyesuai dari pencocokan harian M4 terisi otomatis; transfer tidak ditemukan menghalangi; selisih harus nol", async () => {
    const view = await m11.reconciliationOverview(accountant(), { periodId });
    const bank = view.bank.find((b) => b.bankAccountId === BANK)!;
    expect(bank).toMatchObject({ required: true, zero: false, bookBalance: -1_000_000 + 300_000, suggestedStatementBalance: 8_888_000 });
    const byRef = new Map(bank.autoItems.map((i) => [i.description.split(" ").pop(), i]));
    expect(byRef.get("TRF-UNMATCHED")).toMatchObject({ kind: "unmatched_transfer", amount: 150_000, auto: true });
    expect(byRef.get("SLIP-01")).toMatchObject({ kind: "deposit_in_transit", amount: -400_000 });
    expect(byRef.get("TRF-NEXT-MONTH")).toMatchObject({ kind: "unmatched_transfer", amount: 75_000 });
    expect(bank.autoItems.some((i) => i.description.includes("TRF-DONE"))).toBe(false);
    const nf = bank.autoItems.find((i) => i.kind === "transfer_not_found")!;
    expect(nf).toMatchObject({ blocking: true, amount: 0 });

    const autoSum = bank.autoItems.reduce((s, i) => s + i.amount, 0);
    const fa = finance();
    await expect(m11.saveBankReconciliation(accountant(), { periodId, bankAccountId: BANK, statementBalance: 0 })).rejects.toBeInstanceOf(ForbiddenError);
    // Rekening koran: buku + item otomatis − biaya bank 6.500 yang belum dijurnal → selisih −6.500 sampai dicatat sebagai item.
    const statement = bank.bookBalance + autoSum - 6_500;
    const first = await m11.saveBankReconciliation(fa, { periodId, bankAccountId: BANK, statementBalance: statement });
    expect(first).toMatchObject({ difference: -6_500, zero: false, blocking: true });
    const second = await m11.saveBankReconciliation(fa, { periodId, bankAccountId: BANK, statementBalance: statement, manualItems: [{ kind: "bank_fee", description: "Biaya administrasi bulanan", amount: -6_500 }] });
    expect(second).toMatchObject({ difference: 0, blocking: true, zero: false });
    expect(second.reconciliation.status).toBe("in_progress");
    // M4 menyelesaikan transfer tidak ditemukan (dibatalkan karena salah input) → tidak menghalangi lagi.
    await t.db.update(incomingTransfers).set({ status: "cancelled", cancelledAt: new Date(), cancelReason: "Salah input" }).where(eq(incomingTransfers.id, notFoundId));
    const done = await m11.saveBankReconciliation(fa, { periodId, bankAccountId: BANK, statementBalance: statement, manualItems: [{ kind: "bank_fee", description: "Biaya administrasi bulanan", amount: -6_500 }] });
    expect(done).toMatchObject({ difference: 0, blocking: false, zero: true });
  });

  it("US-M11-06 KP-2 rekonsiliasi kas: kas kantor (hitung fisik M4), kas awal tetap outlet (PAR-57), kas di tangan sopir harus 0, kas kecil — selisih wajib beralasan", async () => {
    await emitEvent("trip.completed", tripPayload({ cashReceived: 250_000 }));
    await t.db.insert(cashDays).values({ tenantId: EQUA_TENANT_ID, businessDate: TODAY, status: "closed", closedAt: new Date(), officeCashPhysical: 0 }).onConflictDoNothing();
    const view = await m11.reconciliationOverview(finance(), { periodId });
    const driver = view.cash.find((c) => c.kind === "driver_cash")!;
    expect(driver).toMatchObject({ systemBalance: 250_000, suggestedPhysical: 0, required: true, zero: false });
    const d01 = view.cash.find((c) => c.kind === "outlet_fixed_cash" && c.outletId === outletId("D01"))!;
    expect(d01).toMatchObject({ suggestedPhysical: 200_000 });
    expect(view.cash.map((c) => c.kind)).toEqual(expect.arrayContaining(["office_cash", "driver_cash", "petty_cash", "outlet_fixed_cash"]));

    const fa = finance();
    await expect(m11.saveCashReconciliation(fa, { periodId, kind: "driver_cash", physicalBalance: 0 })).rejects.toThrow(/wajib beralasan/);
    const res = await m11.saveCashReconciliation(fa, { periodId, kind: "driver_cash", physicalBalance: 0, reason: "Setoran sopir belum diterima — ikuti alur selisih M4" });
    expect(res).toMatchObject({ difference: -250_000, zero: false });
    expect(res.reconciliation.status).toBe("in_progress");
    expect((await m11.reconciliationOverview(fa, { periodId })).cashOk).toBe(false);
    const office = await m11.saveCashReconciliation(fa, { periodId, kind: "office_cash", physicalBalance: view.cash.find((c) => c.kind === "office_cash")!.systemBalance });
    expect(office).toMatchObject({ difference: 0, zero: true });
  });

  it("US-M11-06 KP-3 hasil rekonsiliasi (nol selisih, siapa, kapan, item penyesuai) tersimpan per periode dan tampil bagi akuntan", async () => {
    const [bankRow] = await t.db.select().from(bankReconciliations).where(eq(bankReconciliations.periodId, periodId));
    expect(bankRow).toMatchObject({ status: "zero_difference", difference: 0, completedBy: finance().userId });
    expect(bankRow!.completedAt).not.toBeNull();
    expect((bankRow!.adjustingItems as { kind: string }[]).map((i) => i.kind)).toEqual(expect.arrayContaining(["unmatched_transfer", "deposit_in_transit", "bank_fee"]));
    const cash = await t.db.select().from(cashReconciliations).where(eq(cashReconciliations.periodId, periodId));
    expect(cash.find((c) => c.kind === "driver_cash")).toMatchObject({ status: "in_progress", reason: expect.stringContaining("Setoran sopir") });
    const history = await m11.reconciliationHistory(accountant());
    expect(history.bank.some((r) => r.period === THIS_PERIOD && r.r.status === "zero_difference")).toBe(true);
    expect(history.cash.some((r) => r.r.kind === "office_cash" && r.r.status === "zero_difference")).toBe(true);
    await expect(m11.reconciliationHistory(owner())).resolves.toBeTruthy();
  });
});
