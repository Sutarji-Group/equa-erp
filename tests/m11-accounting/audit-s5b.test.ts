/**
 * Uji regresi temuan audit S5-B (Paket B, M11/M9): pasokan air dijurnal sekali per penerimaan, alokasi susulan, rekonsiliasi
 * basi & kas sopir nol, aset impor lewat penyesuaian saldo awal, pelepasan aset berlampiran + persetujuan, penghapusan
 * piutang selalu disetujui pemilik, sumber air pada jurnal manual L1, konsolidasi M9 = M11, ekspor Final identik.
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, dataSignoffs, eventAccountMappings, exportLogs, fixedAssets, invoices, journals, truckFills } from "@/db/schema";
import { EQUA_TENANT_ID, outletId, seedId, truckId, waterSourceId } from "@/db/seed";
import { newId } from "@/lib/ids";
import { addDays } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { withTx } from "@/server/core/db";
import { ValidationError } from "@/server/core/errors";
import { exportReport } from "@/server/core/export";
import * as m11 from "@/server/modules/m11-accounting";
import { saveFinalSnapshots } from "@/server/modules/m11-accounting/service/statements";
import * as m5 from "@/server/modules/m5-receivables";
import * as m9 from "@/server/modules/m9-reports";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { creditCustomer, invoiceFor } from "../m5-receivables/helpers";
import {
  THIS_PERIOD,
  TODAY,
  acc,
  accountant,
  at,
  emitEvent,
  evidence,
  finance,
  journalOfEvent,
  journalsOfSource,
  linesOf,
  manualJournal,
  owner,
  pair,
  periodRow,
  queueOfEvent,
  setPeriod,
  shiftMonth,
  tripPayload,
} from "./helpers";

const BANK = seedId("bank_account:operasional");
const assetCsv = (rows: string[]) =>
  ["Kode,Nama,Kategori,Tanggal perolehan,Nilai perolehan,Nilai sisa,Umur (bulan),Pusat laba,Kode outlet,Kode truk,Akumulasi penyusutan", ...rows].join("\n");

describe("M11/M9 — regresi temuan audit S5-B", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());
  beforeAll(async () => {
    await setPeriod(t.db, THIS_PERIOD, "open");
  });

  it("US-M11-02 KP-1 BR-33 pasokan air diterima otomatis lalu konfirmasi operator terlambat → buku memuat SATU nilai bersih per penerimaan (hanya selisih yang dijurnal)", async () => {
    const receiptId = newId();
    const base = { waterSupplyReceiptId: receiptId, outletId: outletId("D01"), volumeSentL: 5000 };
    const auto = await emitEvent("water_supply.confirmed", { ...base, volumeReceivedL: 5000, transferValue: 200_000, confirmedByOperator: false, autoAccepted: true });
    expect((await linesOf(t.db, (await journalOfEvent(t.db, auto.id))!.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([
      ["5-1201", 200_000, 0],
      ["4-1501", 0, 200_000],
    ]);
    // Konfirmasi operator (dibuat luring) dengan volume sama → tidak dijurnal ulang, tidak masuk daftar tunggu.
    const same = await emitEvent("water_supply.confirmed", { ...base, volumeReceivedL: 5000, transferValue: 200_000, confirmedByOperator: true });
    expect(await journalOfEvent(t.db, same.id)).toBeNull();
    expect(await queueOfEvent(t.db, same.id)).toBeNull();
    // Konfirmasi dengan volume berbeda (4.500 L) → hanya selisih −20.000 (arah dibalik).
    const less = await emitEvent("water_supply.confirmed", { ...base, volumeReceivedL: 4500, transferValue: 180_000, confirmedByOperator: true });
    expect((await linesOf(t.db, (await journalOfEvent(t.db, less.id))!.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([
      ["4-1501", 20_000, 0],
      ["5-1201", 0, 20_000],
    ]);
    const all = await journalsOfSource(t.db, "water_supply_receipt", receiptId);
    expect(all).toHaveLength(2);
    let expense = 0;
    for (const j of all) for (const l of await linesOf(t.db, j.id)) if (l.code === "5-1201") expense += l.debit - l.credit;
    expect(expense).toBe(180_000);
  });

  it("US-M11-01 KP-3 US-M11-10 KP-1 biaya L1 susulan setelah alokasi → sisa belum dialokasikan menahan prasyarat tutup; run tambahan mengalokasikan sisanya", async () => {
    const period = (await periodRow(t.db, THIS_PERIOD))!;
    const fa = finance();
    await manualJournal(fa, { date: TODAY, description: "Listrik pompa sumber SA1", lines: pair("6-1301", "1-1101", 1_000_000, { debit: "L1", waterSourceId: waterSourceId("SA1") }) });
    await t.db.insert(truckFills).values([
      { tenantId: EQUA_TENANT_ID, waterSourceId: waterSourceId("SA1"), truckId: truckId("T1"), businessDate: TODAY, volumeL: 30_000, filledAt: new Date(), isDepotSupply: false },
      { tenantId: EQUA_TENANT_ID, waterSourceId: waterSourceId("SA1"), truckId: truckId("T2"), businessDate: TODAY, volumeL: 10_000, filledAt: new Date(), isDepotSupply: true },
    ]);
    await m11.runCostAllocation(fa, { periodId: period.id, kind: "l1_allocation" });
    const done = await m11.allocationStatus(fa, { periodId: period.id });
    expect(done.l1).toMatchObject({ required: false, remaining: 0 });
    expect(done.l1.allocated).toBe(done.l1.total);

    // Tagihan listrik susulan 400.000 diposting SETELAH alokasi.
    await manualJournal(fa, { date: TODAY, description: "Tagihan listrik susulan SA1", lines: pair("6-1301", "1-1101", 400_000, { debit: "L1", waterSourceId: waterSourceId("SA1") }) });
    const stale = await m11.allocationStatus(fa, { periodId: period.id });
    expect(stale.l1).toMatchObject({ required: true, remaining: 400_000, shares: { L2: 300_000, L3: 100_000 } });
    expect(stale.l1.posted).not.toBeNull();
    const pre = (await m11.periodDetail(fa, { periodId: period.id })).prerequisites.find((p) => p.key === "allocations_posted")!;
    expect(pre.ok).toBe(false);
    expect(pre.detail).toMatch(/alokasi L1: sisa .*400\.000 belum dialokasikan/);

    const extra = await m11.runCostAllocation(fa, { periodId: period.id, kind: "l1_allocation" });
    expect(extra.journal).toMatchObject({ kind: "allocation", status: "posted", totalDebit: 400_000 });
    expect(extra.journal.description).toMatch(/tambahan atas biaya susulan/);
    expect(extra.run.totalAmount).toBe(done.l1.allocated + 400_000);
    const after = await m11.allocationStatus(fa, { periodId: period.id });
    expect(after.l1).toMatchObject({ required: false, remaining: 0 });
    expect((await m11.periodDetail(fa, { periodId: period.id })).prerequisites.find((p) => p.key === "allocations_posted")).toMatchObject({ ok: true });
    await expect(m11.runCostAllocation(fa, { periodId: period.id, kind: "l1_allocation" })).rejects.toThrow(/sudah mencakup seluruh biaya/);
  });

  it("US-M11-06 KP-1 KP-2 rekonsiliasi 'nol selisih' dievaluasi ulang saat saldo buku berubah; kas di tangan sopir wajib nol", async () => {
    const period = (await periodRow(t.db, THIS_PERIOD))!;
    const fa = finance();
    // Kas di tangan sopir: rit tunai 250.000 belum disetor → tidak dapat diakui "nol selisih".
    await emitEvent("trip.completed", tripPayload({ cashReceived: 250_000, price: 250_000 }));
    let view = await m11.reconciliationOverview(fa, { periodId: period.id });
    const driver = view.cash.find((c) => c.kind === "driver_cash")!;
    expect(driver.systemBalance).toBeGreaterThan(0);
    await expect(m11.saveCashReconciliation(fa, { periodId: period.id, kind: "driver_cash", physicalBalance: driver.systemBalance })).rejects.toThrow(/harus nol/);
    await m11.saveCashReconciliation(fa, { periodId: period.id, kind: "driver_cash", physicalBalance: 0, reason: "Setoran sopir belum diterima" });
    view = await m11.reconciliationOverview(fa, { periodId: period.id });
    expect(view.cash.find((c) => c.kind === "driver_cash")).toMatchObject({ zero: false });
    // Setoran diterima M4 → saldo sopir nol → simpan ulang = nol selisih.
    await emitEvent("deposit.received", { depositId: newId(), sourceType: "driver", expectedAmount: driver.systemBalance, receivedAmount: driver.systemBalance, discrepancyAmount: 0, receivedBy: fa.userId!, late: false });
    await m11.saveCashReconciliation(fa, { periodId: period.id, kind: "driver_cash", physicalBalance: 0 });
    view = await m11.reconciliationOverview(fa, { periodId: period.id });
    expect(view.cash.find((c) => c.kind === "driver_cash")).toMatchObject({ systemBalance: 0, zero: true, stale: false });

    // Kas kantor nol selisih → rit terlambat sinkron + setoran sesudahnya mengubah saldo → basi, prasyarat tidak lolos.
    const office = view.cash.find((c) => c.kind === "office_cash")!;
    await m11.saveCashReconciliation(fa, { periodId: period.id, kind: "office_cash", physicalBalance: office.systemBalance });
    expect((await m11.reconciliationOverview(fa, { periodId: period.id })).cash.find((c) => c.kind === "office_cash")).toMatchObject({ zero: true, stale: false });
    await emitEvent("trip.completed", tripPayload({ cashReceived: 300_000, price: 300_000, lateSync: true }));
    await emitEvent("deposit.received", { depositId: newId(), sourceType: "driver", expectedAmount: 300_000, receivedAmount: 300_000, discrepancyAmount: 0, receivedBy: fa.userId!, late: true });
    view = await m11.reconciliationOverview(fa, { periodId: period.id });
    expect(view.cash.find((c) => c.kind === "office_cash")).toMatchObject({ zero: false, stale: true });
    expect(view.cashOk).toBe(false);
    expect((await m11.periodDetail(fa, { periodId: period.id })).prerequisites.find((p) => p.key === "cash_reconciled")).toMatchObject({ ok: false });

    // Bank: nol selisih lalu biaya bank dibukukan → basi.
    await manualJournal(fa, { date: TODAY, description: "Setor tunai ke rekening", lines: pair("1-1201", "1-1101", 500_000) });
    let bank = (await m11.reconciliationOverview(fa, { periodId: period.id })).bank.find((b) => b.bankAccountId === BANK)!;
    const items = bank.autoItems.reduce((s, i) => s + i.amount, 0);
    await m11.saveBankReconciliation(fa, { periodId: period.id, bankAccountId: BANK, statementBalance: bank.bookBalance + items });
    bank = (await m11.reconciliationOverview(fa, { periodId: period.id })).bank.find((b) => b.bankAccountId === BANK)!;
    expect(bank).toMatchObject({ zero: true, stale: false });
    await manualJournal(fa, { date: TODAY, description: "Biaya administrasi bank", lines: pair("6-9101", "1-1201", 15_000) });
    bank = (await m11.reconciliationOverview(fa, { periodId: period.id })).bank.find((b) => b.bankAccountId === BANK)!;
    expect(bank).toMatchObject({ zero: false, stale: true });
  });

  it("US-M11-09 KP-3 PTB-44 NFR-34 nilai perolehan aset impor diubah → penyesuaian saldo awal menunggu persetujuan pemilik + catatan akuntan; daftar aset ditandatangani ulang; BR-35 US-M11-05 KP-4 pelepasan wajib bukti & persetujuan", async () => {
    await m11.setCutoverDate(owner(), { date: `${THIS_PERIOD}-01`, reason: "Cut-over tanggal 1 bulan berjalan" });
    const fa = finance();
    const imported = await m11.importAssets(fa, { fileName: "aset.csv", content: assetCsv([`AST-T9,Truk tangki T9,truk,${THIS_PERIOD}-01,240000000,0,96,,,T1,0`]), commit: true });
    await m11.signAssetRegister(owner(), { signoffId: imported.signoffId!, note: "Sesuai daftar notaris" });
    const [asset] = await t.db.select().from(fixedAssets).where(eq(fixedAssets.code, "AST-T9"));

    await expect(m11.updateAssetEstimate(fa, { assetId: asset!.id, acquisitionCost: 320_000_000, reason: "Nilai notaris direvisi" })).rejects.toThrow(/catatan akuntan/);
    const req = await m11.updateAssetEstimate(fa, { assetId: asset!.id, acquisitionCost: 320_000_000, reason: "Nilai notaris direvisi", accountantNote: "Nilai wajar truk per laporan penilai 2026" });
    expect(req.pendingApprovalId).toBeTruthy();
    // Belum berlaku sebelum pemilik menyetujui: nilai aset tetap, jurnal Diajukan (bukan terposting).
    expect((await t.db.select().from(fixedAssets).where(eq(fixedAssets.id, asset!.id)))[0]!.acquisitionCost).toBe(240_000_000);
    const [ap] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, req.pendingApprovalId!));
    expect(ap).toMatchObject({ type: "opening_balance_adjustment", amount: 80_000_000, status: "submitted" });
    const [pendingJ] = await t.db.select().from(journals).where(eq(journals.id, ap!.objectId));
    expect(pendingJ).toMatchObject({ kind: "opening_adjustment", status: "submitted" });
    await expect(m11.updateAssetEstimate(fa, { assetId: asset!.id, acquisitionCost: 330_000_000, reason: "Revisi lagi", accountantNote: "Catatan revisi kedua" })).rejects.toThrow(/menunggu keputusan pemilik/);

    await approvals.decide(owner(), req.pendingApprovalId!, "approve", "Sesuai laporan penilai");
    expect((await t.db.select().from(fixedAssets).where(eq(fixedAssets.id, asset!.id)))[0]!.acquisitionCost).toBe(320_000_000);
    expect((await t.db.select().from(journals).where(eq(journals.id, ap!.objectId)))[0]).toMatchObject({ status: "posted", approvalRequestId: req.pendingApprovalId });
    expect((await t.db.select().from(dataSignoffs).where(eq(dataSignoffs.id, imported.signoffId!)))[0]!.status).toBe("draft");

    // Lewat jendela PAR-62 (3 bulan setelah cut-over) → ditolak, arahkan ke jurnal manual biasa.
    const late = finance(at(`${shiftMonth(THIS_PERIOD, 3)}-02`));
    await expect(m11.updateAssetEstimate(late, { assetId: asset!.id, acquisitionCost: 300_000_000, reason: "Terlambat", accountantNote: "Catatan terlambat" })).rejects.toThrow(/jurnal manual biasa/);

    // Pelepasan: bukti wajib; akun penerimaan hanya kas/bank/piutang; > PAR-20 → menunggu pemilik, aset belum dilepas.
    await expect(m11.disposeAsset(fa, { assetId: asset!.id, date: TODAY, proceeds: 0, reason: "Truk rusak total" } as never)).rejects.toBeInstanceOf(ValidationError);
    const bukti = await evidence(fa);
    await expect(m11.disposeAsset(fa, { assetId: asset!.id, date: TODAY, proceeds: 1_000_000, proceedsAccountId: acc("6-1301"), reason: "Dijual rongsok", attachmentId: bukti })).rejects.toThrow(/kas, bank, atau piutang/);
    const res = await m11.disposeAsset(fa, { assetId: asset!.id, date: TODAY, proceeds: 0, reason: "Truk rusak total", attachmentId: bukti });
    expect(res).toMatchObject({ status: "submitted", gainLoss: -320_000_000 });
    expect(res.journal).toMatchObject({ kind: "manual", status: "submitted", attachmentId: bukti });
    const [dap] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, res.approvalId!));
    expect(dap).toMatchObject({ type: "manual_journal", status: "submitted" });
    expect((await t.db.select().from(fixedAssets).where(eq(fixedAssets.id, asset!.id)))[0]!.status).toBe("active");
    await expect(m11.disposeAsset(fa, { assetId: asset!.id, date: TODAY, proceeds: 0, reason: "Ajukan ganda", attachmentId: await evidence(fa) })).rejects.toThrow(/menunggu keputusan pemilik/);
    await approvals.decide(owner(), res.approvalId!, "reject", "Truk masih bisa diperbaiki");
    expect((await t.db.select().from(fixedAssets).where(eq(fixedAssets.id, asset!.id)))[0]!.status).toBe("active");
  });

  it("PTB-28 BR-38 US-M5-03 KP-3 penghapusan piutang lewat jurnal manual ≤ PAR-20 tetap menunggu persetujuan pemilik; tanpa persetujuan m5.writeOffInvoice ditolak", async () => {
    const fa = finance();
    const c = await creditCustomer(t.db);
    const inv = await invoiceFor(t.db, c.id, { amount: 900_000, issueDate: addDays(TODAY, -60), dueDate: addDays(TODAY, -30) });
    const draft = await m11.createManualJournal(fa, {
      date: TODAY,
      description: "Hapus buku piutang pelanggan tutup usaha",
      lines: [...pair("6-9101", "1-1401", 900_000)],
      attachmentId: await evidence(fa),
      writeOff: { invoiceId: inv.id, amount: 900_000 },
    });
    const sub = await m11.submitManualJournal(fa, { journalId: draft.id });
    expect(sub.status).toBe("submitted");
    const [invBefore] = await t.db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(invBefore).toMatchObject({ writtenOffAmount: 0, outstandingAmount: 900_000 });
    await expect(withTx((tx) => m5.writeOffInvoice(tx, { ctx: fa, invoiceId: inv.id, reason: "Tanpa persetujuan" }))).rejects.toThrow(/wajib disetujui pemilik/);

    await approvals.decide(owner(), (sub as { approvalId: string }).approvalId, "approve", "Pelanggan tutup usaha, disetujui");
    const [invAfter] = await t.db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(invAfter).toMatchObject({ writtenOffAmount: 900_000, outstandingAmount: 0 });
    expect((await t.db.select().from(journals).where(eq(journals.id, draft.id)))[0]).toMatchObject({ status: "posted" });
  });

  it("US-M9-02 KP-6 PTB-39 K22 jurnal manual beban L1 wajib bersumber air (atau 'gabungan' eksplisit); biaya per liter per sumber M9 memakai sumber dari jurnal manual", async () => {
    const fa = finance();
    const noSource = [
      { accountId: acc("5-1401"), profitCenter: "L1" as const, debit: 100_000, credit: 0 },
      { accountId: acc("1-1101"), profitCenter: "SHARED" as const, debit: 0, credit: 100_000 },
    ];
    await expect(m11.createManualJournal(fa, { date: TODAY, description: "Pemeliharaan pompa", lines: noSource, attachmentId: await evidence(fa) })).rejects.toThrow(/wajib memilih sumber air/);

    const before = await m9.getMonthlyReport(owner(), { month: THIS_PERIOD });
    const costOf = (r: typeof before, code: string) => r.waterCost.perSource.find((s) => s.code === code)?.cost ?? 0;
    await manualJournal(fa, { date: TODAY, description: "Listrik pompa SA1", lines: pair("5-1401", "1-1101", 600_000, { debit: "L1", waterSourceId: waterSourceId("SA1") }) });
    await manualJournal(fa, { date: TODAY, description: "Servis pompa SA2", lines: pair("5-1401", "1-1101", 400_000, { debit: "L1", waterSourceId: waterSourceId("SA2") }) });
    const after = await m9.getMonthlyReport(owner(), { month: THIS_PERIOD });
    expect(costOf(after, "SA1") - costOf(before, "SA1")).toBe(600_000);
    expect(costOf(after, "SA2") - costOf(before, "SA2")).toBe(400_000);
    const lines = await t.db.select().from(journals).where(and(eq(journals.tenantId, EQUA_TENANT_ID), eq(journals.description, "Servis pompa SA2")));
    expect((await linesOf(t.db, lines[0]!.id))[0]).toMatchObject({ code: "5-1401", profitCenter: "L1" });
  });

  it("US-M9-02 KP-2 BR-33 KPI-09 laba gabungan laporan bulanan M9 = laba bersih konsolidasi M11 (transfer bahan toko → depot, markup terpakai dieliminasi)", async () => {
    const m9Net = (r: Awaited<ReturnType<typeof m9.getMonthlyReport>>) => r.consolidated.grossProfit - r.consolidated.operatingExpense;
    const b9 = await m9.getMonthlyReport(owner(), { month: THIS_PERIOD });
    const b11 = (await m11.getStatements(accountant(), { period: THIS_PERIOD })).profitLoss;
    await emitEvent("internal_transfer.sent", { internalTransferId: newId(), fromOutletId: outletId("TK1"), toOutletId: outletId("D03"), totalValue: 100_000, totalCost: 70_000 });
    await emitEvent("consumable.usage_posted", { shiftId: newId(), outletId: outletId("D03"), totalValue: 40_000, lines: [] });
    const a9 = await m9.getMonthlyReport(owner(), { month: THIS_PERIOD });
    const a11 = (await m11.getStatements(accountant(), { period: THIS_PERIOD })).profitLoss;
    expect(a11.consolidated.net - b11.consolidated.net).toBe(-28_000);
    expect(m9Net(a9) - m9Net(b9)).toBe(-28_000);
    expect(a9.consolidated.revenue - b9.consolidated.revenue).toBe(0);
  });

  it("US-M11-04 KP-2 US-M9-03 KP-4 laporan keuangan Final diekspor ulang → berkas IDENTIK (pengekspor & jam berbeda); tiap unduhan tetap tercatat", async () => {
    const P = shiftMonth(THIS_PERIOD, -2);
    const p = await setPeriod(t.db, P, "locked");
    await withTx((tx) => saveFinalSnapshots(tx, owner(), p));
    expect(await m11.getStatements(accountant(), { period: P })).toMatchObject({ status: "final" });
    const logsBefore = (await t.db.select().from(exportLogs)).length;
    for (const format of ["xlsx", "pdf", "csv"] as const) {
      const first = await exportReport(owner(at(TODAY, "08:00")), "m11.profit_loss", format, { period: P });
      const second = await exportReport(accountant(at(TODAY, "16:45")), "m11.profit_loss", format, { period: P });
      expect(second.sha256).toBe(first.sha256);
      expect(Buffer.compare(second.body, first.body)).toBe(0);
      expect(second.filename).toBe(first.filename);
    }
    expect((await t.db.select().from(exportLogs)).length - logsBefore).toBe(6);
    // Laporan Sementara (periode berjalan) tetap dirender ulang (tidak disimpan sebagai Final).
    const prov = await exportReport(owner(at(TODAY, "08:00")), "m11.profit_loss", "csv", { period: THIS_PERIOD });
    expect(prov.filename).not.toMatch(/final/);
  });
});

describe("M11 — aktivasi jurnal otomatis menuntut pemetaan wajib lengkap (US-M11-01 KP-2)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());
  beforeAll(async () => {
    await setPeriod(t.db, THIS_PERIOD, "open");
  });
  const mapping = (event: string, entry: string) => and(eq(eventAccountMappings.eventKey, event), eq(eventAccountMappings.entryKey, entry));

  it("US-M11-01 KP-2 flag bawaan menyala tetapi pemetaan wajib belum lengkap → M11 BELUM aktif (peristiwa dilewati untuk dibangkitkan retroaktif, layar 'Belum aktif', M9 memakai angka operasional); setelah pemilik mengaktifkan, pemetaan yang kelak hilang → daftar tunggu", async () => {
    // Seed melengkapi semua pemetaan wajib → aktif walau pemilik belum pernah mengaktifkan.
    expect(await withTx((tx) => m11.accountingActivation(tx, EQUA_TENANT_ID, TODAY))).toEqual({ active: true, flagOn: true, activatedByOwner: false, complete: true });

    await t.db.update(eventAccountMappings).set({ isActive: false }).where(mapping("stock.adjusted", "depot"));
    const view = await m11.listMappings(accountant());
    expect(view).toMatchObject({ active: false, activation: { flagOn: true, activatedByOwner: false, complete: false } });
    const skipped = await emitEvent("trip.completed", tripPayload());
    expect(await journalOfEvent(t.db, skipped.id)).toBeNull();
    expect(await queueOfEvent(t.db, skipped.id)).toBeNull();
    expect(await withTx((tx) => m11.isAccountingActive(tx, EQUA_TENANT_ID, TODAY))).toBe(false);
    await expect(m11.setAccountingActive(owner(), { enabled: true, reason: "Aktifkan jurnal otomatis" })).rejects.toThrow(/belum dapat diaktifkan.*Penyesuaian opname depot/);

    await t.db.update(eventAccountMappings).set({ isActive: true }).where(mapping("stock.adjusted", "depot"));
    await m11.setAccountingActive(owner(), { enabled: true, reason: "Pemetaan wajib lengkap & ditinjau akuntan" });
    expect(await withTx((tx) => m11.accountingActivation(tx, EQUA_TENANT_ID, TODAY))).toMatchObject({ active: true, activatedByOwner: true });

    // Setelah aktivasi pemilik: pemetaan yang hilang tidak menghentikan M11 — peristiwanya masuk daftar tunggu.
    await t.db.update(eventAccountMappings).set({ isActive: false }).where(mapping("trip.completed", "transfer"));
    const queued = await emitEvent("trip.completed", tripPayload({ paymentMethod: "transfer", cashReceived: 0, transferAmount: 300_000 }));
    expect(await queueOfEvent(t.db, queued.id)).toMatchObject({ status: "pending", reason: "mapping_missing" });
    await t.db.update(eventAccountMappings).set({ isActive: true }).where(mapping("trip.completed", "transfer"));
  });
});
