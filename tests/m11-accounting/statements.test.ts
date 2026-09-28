import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { periodReviewNotes } from "@/db/schema";
import { outletId } from "@/db/seed";
import { newId } from "@/lib/ids";
import { ForbiddenError } from "@/server/core/errors";
import { exportReport } from "@/server/core/export";
import * as m11 from "@/server/modules/m11-accounting";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { THIS_PERIOD, TODAY, acc, accountant, dispatcher, emitEvent, finance, manualJournal, owner, pair, periodRow, setPeriod, shiftMonth, tripPayload } from "./helpers";

const PREV = shiftMonth(THIS_PERIOD, -1);
const sameYear = PREV.slice(0, 4) === THIS_PERIOD.slice(0, 4);

describe("M11 buku besar & laporan keuangan (US-M11-04)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());
  const tripA = tripPayload({ cashReceived: 250_000 });
  const saleId = newId();

  beforeAll(async () => {
    await setPeriod(t.db, PREV, "open");
    await setPeriod(t.db, THIS_PERIOD, "open");
    await emitEvent("trip.completed", tripA);
    await emitEvent("trip.completed", tripPayload({ paymentMethod: "credit", cashReceived: 0, creditAmount: 300_000 }));
    await emitEvent("pos_sale.recorded", { posSaleId: saleId, outletId: outletId("D01"), outletKind: "depot", shiftId: newId(), method: "cash", total: 100_000, discount: 0, lines: [] });
    await emitEvent("pos_sale.recorded", { posSaleId: newId(), outletId: outletId("TK1"), outletKind: "store", shiftId: newId(), method: "cash", total: 50_000, discount: 5_000, cogs: 30_000, lines: [] });
    await emitEvent("partner.subscription_invoiced", { invoiceId: newId(), partnerContractId: newId(), partnerTenantId: newId(), amount: 200_000, outletCount: 1 });
    await emitEvent("water_supply.confirmed", { waterSupplyReceiptId: newId(), outletId: outletId("D01"), volumeSentL: 8000, volumeReceivedL: 8000, transferValue: 400_000, confirmedByOperator: true });
    await manualJournal(finance(), { date: TODAY, description: "Sewa kantor bulan ini", template: "rent", lines: pair("6-1201", "1-1201", 1_000_000) });
    await manualJournal(finance(), { date: `${PREV}-20`, description: "Listrik kantor bulan lalu", template: "electricity", lines: pair("6-1301", "1-1201", 150_000) });
  });

  it("US-M11-04 KP-1 buku besar per akun & pusat laba; neraca saldo seimbang; laba rugi per lini L1–L5 + konsolidasi (eliminasi transfer internal); neraca seimbang; arus kas metode langsung — per periode & kumulatif tahun berjalan", async () => {
    const ac = accountant();
    const ledger = await m11.getLedger(ac, { accountId: acc("4-1101"), profitCenter: "L2", fromPeriod: THIS_PERIOD });
    expect(ledger.credit).toBe(550_000);
    expect(ledger.closing).toBe(550_000);
    expect(ledger.lines.every((l) => l.profitCenter === "L2" && l.sourceLabel)).toBe(true);

    const s = await m11.getStatements(ac, { period: THIS_PERIOD });
    expect(s.status).toBe("provisional");
    expect(s.trialBalance.balanced).toBe(true);
    const pl = s.profitLoss;
    expect(pl.centers.L2.revenue).toBe(550_000 + 400_000);
    expect(pl.centers.L3.revenue).toBe(100_000);
    // Diskon kasir sebagai pengurang pendapatan: bruto 55.000 − diskon 5.000 = dibayar 50.000.
    expect(pl.centers.L4.revenue).toBe(50_000);
    expect(pl.rows.find((r) => r.code === "4-1302")!.byCenter.L4).toBe(-5_000);
    expect(pl.centers.L4.beforeAllocation).toBe(50_000 - 30_000);
    expect(pl.centers.L5.revenue).toBe(200_000);
    expect(pl.centers.SHARED.beforeAllocation).toBe(-1_000_000);
    expect(pl.consolidated.eliminatedRevenue).toBe(400_000);
    expect(pl.consolidated.revenue).toBe(550_000 + 100_000 + 50_000 + 200_000);
    expect(pl.consolidated.net).toBe(550_000 + 100_000 + 50_000 - 30_000 + 200_000 - 1_000_000);
    const internalRow = pl.rows.find((r) => r.code === "4-1501")!;
    expect(internalRow).toMatchObject({ internal: true, total: 400_000, elimination: 400_000, consolidated: 0, section: "Transfer internal (dieliminasi)" });

    expect(s.balanceSheet.balanced).toBe(true);
    expect(s.balanceSheet.assets).toBe(s.balanceSheet.liabilities + s.balanceSheet.equity);
    const cf = s.cashFlow;
    expect(cf.categories.find((c) => c.key === "customers")!.inflow).toBe(250_000 + 100_000 + 50_000);
    expect(cf.categories.find((c) => c.key === "operating_expenses")!.outflow).toBe(1_000_000);
    expect(cf.closingCash).toBe(cf.openingCash + cf.netChange);
    expect(cf.openingCash).toBe(-150_000);

    const ytd = await m11.getStatements(ac, { period: THIS_PERIOD, basis: "ytd" });
    expect(ytd.basis).toBe("ytd");
    expect(ytd.trialBalance.balanced).toBe(true);
    expect(ytd.profitLoss.netTotal).toBe(pl.netTotal - (sameYear ? 150_000 : 0));
  });

  it("US-M11-04 KP-3 setiap angka laporan dapat diturunkan ke jurnal dan ke transaksi sumber (dua arah)", async () => {
    const ac = accountant();
    const s = await m11.getStatements(ac, { period: THIS_PERIOD });
    const row = s.profitLoss.rows.find((r) => r.code === "4-1201")!;
    expect(row.byCenter.L3).toBe(100_000);
    const ledger = await m11.getLedger(ac, { accountId: row.accountId, profitCenter: "L3", fromPeriod: THIS_PERIOD });
    const line = ledger.lines.find((l) => l.sourceObjectId === saleId)!;
    expect(line).toMatchObject({ credit: 100_000, sourceObjectType: "pos_sale" });
    const detail = await m11.getJournalDetail(ac, line.journalId);
    expect(detail.source).toMatchObject({ href: "/outlet" });
    // Sumber → jurnal.
    const back = await m11.journalsForSource(ac, { type: "pos_sale", id: saleId });
    expect(back.map((j) => j.id)).toEqual([line.journalId]);
    const tripJournals = await m11.listJournals(ac, { sourceObjectType: "trip", sourceObjectId: tripA.tripId });
    expect(tripJournals).toHaveLength(1);
  });

  it("US-M11-04 KP-4 ekspor Excel/PDF laporan keuangan (berlabel Sementara/Final) dan buku besar", async () => {
    for (const key of ["m11.trial_balance", "m11.profit_loss", "m11.balance_sheet", "m11.cash_flow"]) {
      const x = await exportReport(accountant(), key, "xlsx", { period: THIS_PERIOD });
      expect(x.contentType).toContain("spreadsheet");
      expect(x.rowCount).toBeGreaterThan(0);
    }
    const pdf = await exportReport(owner(), "m11.profit_loss", "pdf", { period: THIS_PERIOD, basis: "ytd" });
    expect(pdf.contentType).toContain("pdf");
    const ledger = await exportReport(finance(), "m11.ledger", "xlsx", { accountId: acc("4-1101"), from: THIS_PERIOD });
    expect(ledger.rowCount).toBe(2);
    await expect(exportReport(dispatcher(), "m11.profit_loss", "xlsx", { period: THIS_PERIOD })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("US-M11-04 KP-5 laporan bulan pertama ditinjau akuntan; catatan tinjauan disimpan di periode", async () => {
    const period = (await periodRow(t.db, THIS_PERIOD))!;
    await expect(m11.addPeriodReviewNote(finance(), { periodId: period.id, note: "Catatan oleh Admin Keuangan" })).rejects.toBeInstanceOf(ForbiddenError);
    await m11.addPeriodReviewNote(accountant(), { periodId: period.id, note: "Laporan bulan pertama ditinjau: sesuai bukti TG-8", kind: "tg8" });
    const notes = await t.db.select().from(periodReviewNotes).where(eq(periodReviewNotes.periodId, period.id));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "tg8", createdBy: accountant().userId });
    const detail = await m11.periodDetail(owner(), { periodId: period.id });
    expect(detail.notes[0]!.note).toContain("TG-8");
    expect((await periodRow(t.db, THIS_PERIOD))!.accountantReviewNote).toContain("TG-8");
  });
});
