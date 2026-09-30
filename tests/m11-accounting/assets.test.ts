import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { auditLogs, dataSignoffs, depreciationEntries, fixedAssets, journals } from "@/db/schema";
import { EQUA_TENANT_ID, outletId, truckId, waterSourceId } from "@/db/seed";
import * as approvals from "@/server/core/approvals";
import { ForbiddenError } from "@/server/core/errors";
import { exportReport } from "@/server/core/export";
import * as m11 from "@/server/modules/m11-accounting";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { THIS_PERIOD, TODAY, acc, accountant, at, evidence, finance, linesOf, manualJournal, notificationsOf, owner, pair, periodRow, setPeriod, shiftMonth } from "./helpers";

const PREV = shiftMonth(THIS_PERIOD, -1);
const NEXT = shiftMonth(THIS_PERIOD, 1);

const assetCsv = (rows: string[]) =>
  ["Kode,Nama,Kategori,Tanggal perolehan,Nilai perolehan,Nilai sisa,Umur (bulan),Pusat laba,Kode outlet,Kode truk,Akumulasi penyusutan", ...rows].join("\n");

describe("M11 aset tetap & penyusutan otomatis (US-M11-05)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());
  beforeAll(async () => {
    await setPeriod(t.db, PREV, "open");
    await setPeriod(t.db, THIS_PERIOD, "open");
  });

  it("US-M11-05 KP-1 daftar aset diimpor dari template (kategori, tanggal & nilai perolehan, umur, metode, pusat laba pemakai, nilai sisa) dan ditandatangani pemilik sebelum disusutkan", async () => {
    const fa = finance();
    const bad = await m11.importAssets(fa, {
      fileName: "aset.csv",
      content: assetCsv(["AST-X,Aset rusak,pesawat,31-31-2020,0,0,12,,,,", `AST-Y,Truk tidak ada,truk,01/03/2024,100000000,0,60,,,T99,0`]),
    });
    expect(bad.errors).toBe(2);
    expect(bad.rows[0]!.errors.join(" ")).toMatch(/Kategori "pesawat".*Tanggal perolehan.*Nilai perolehan/);
    expect(bad.rows[1]!.errors.join(" ")).toMatch(/Truk T99 tidak ditemukan/);

    const csv = assetCsv([
      `AST-T1,Truk tangki T1,truk,${PREV}-03,240.000.000,0,96,,,T1,30.000.000`,
      `AST-SA1,Pompa & pipa sumber Cugenang,instalasi,${PREV}-20,60000000,0,120,,,,0`,
      `AST-D01,Mesin RO depot D01,peralatan depot,15/01/2025,36000000,6000000,60,,D01,,5000000`,
    ]);
    const preview = await m11.importAssets(fa, { fileName: "aset.csv", content: csv });
    expect(preview).toMatchObject({ errors: 0, count: 3, totalCost: 336_000_000, committed: false });
    await expect(m11.importAssets(accountant(), { fileName: "aset.csv", content: csv, commit: true })).rejects.toBeInstanceOf(ForbiddenError);
    const done = await m11.importAssets(fa, { fileName: "aset.csv", content: csv, commit: true });
    expect(done.committed).toBe(true);
    const rows = await t.db.select().from(fixedAssets).where(eq(fixedAssets.tenantId, EQUA_TENANT_ID));
    const byCode = new Map(rows.map((r) => [r.code, r]));
    expect(byCode.get("AST-T1")).toMatchObject({ category: "truck", profitCenter: "L2", truckId: truckId("T1"), usefulLifeMonths: 96, depreciationMethod: "straight_line", source: "import" });
    expect(byCode.get("AST-SA1")).toMatchObject({ category: "water_installation", profitCenter: "L1" });
    expect(byCode.get("AST-D01")).toMatchObject({ category: "depot_equipment", profitCenter: "L3", outletId: outletId("D01"), residualValue: 6_000_000 });
    expect((await notificationsOf(t.db, "asset.signoff_pending", done.signoffId!)).length).toBeGreaterThan(0);

    // Belum ditandatangani → tidak disusutkan.
    const reg = await m11.assetRegister(accountant(), { period: THIS_PERIOD });
    expect(reg.pendingSignoff?.id).toBe(done.signoffId);
    expect(reg.rows.filter((r) => r.source === "import").every((r) => !r.signed)).toBe(true);
    const period = (await periodRow(t.db, PREV))!;
    expect((await m11.runDepreciation(fa, { periodId: period.id })).entries).toBe(0);

    await expect(m11.signAssetRegister(fa, { signoffId: done.signoffId! })).rejects.toBeInstanceOf(ForbiddenError);
    await m11.signAssetRegister(owner(), { signoffId: done.signoffId!, note: "Sesuai daftar notaris" });
    const [s] = await t.db.select().from(dataSignoffs).where(eq(dataSignoffs.id, done.signoffId!));
    expect(s).toMatchObject({ status: "signed", group: "fixed_assets" });
    await expect(m11.signAssetRegister(owner(), { signoffId: done.signoffId! })).rejects.toThrow(/sudah ditandatangani/);

    // Umur ekonomis wajib dari akuntan (PAR-63 belum menetapkan umur per kategori).
    await expect(m11.createAsset(fa, { code: "AST-NOLIFE", name: "Tanpa umur", category: "building", acquisitionDate: TODAY, acquisitionCost: 10_000_000 })).rejects.toThrow(/Umur ekonomis/);
    await expect(m11.createAsset(fa, { code: "AST-NOOUT", name: "Peralatan tanpa outlet", category: "depot_equipment", acquisitionDate: TODAY, acquisitionCost: 10_000_000, usefulLifeMonths: 24 })).rejects.toThrow(/outlet pemakai/);
  });

  it("US-M11-05 KP-2 penyusutan bulanan diposting otomatis (satu jurnal per periode, per pusat laba, idempoten) dan dihitung ulang bila umur/nilai diubah akuntan dengan jurnal penyesuaian berjejak", async () => {
    const fa = finance();
    const prev = (await periodRow(t.db, PREV))!;
    const res = await m11.runDepreciation(fa, { periodId: prev.id });
    // T1: (240jt) / 96 = 2.500.000 (diperoleh tgl 3 → mulai bulan itu); SA1 tgl 20 → mulai bulan berikutnya; D01: (36jt − 6jt)/60 = 500.000.
    expect(res).toMatchObject({ entries: 2, total: 3_000_000 });
    expect((await linesOf(t.db, res.journalId!)).map((l) => [l.code, l.profitCenter, l.debit, l.credit])).toEqual([
      ["6-1501", "L3", 500_000, 0],
      ["1-2302", "L3", 0, 500_000],
      ["6-1501", "L2", 2_500_000, 0],
      ["1-2102", "L2", 0, 2_500_000],
    ]);
    expect((await m11.runDepreciation(fa, { periodId: prev.id })).entries).toBe(0);

    // Job tanggal 1 bulan berikutnya: periode berjalan disusutkan (SA1 mulai: 60jt/120 = 500.000).
    expect(await m11.runMonthlyDepreciation(at(`${NEXT}-01`, "01:30"))).toBe(3);
    expect(await m11.runMonthlyDepreciation(at(`${NEXT}-01`, "01:31"))).toBe(0);
    const cur = (await periodRow(t.db, THIS_PERIOD))!;
    const curEntries = await t.db.select().from(depreciationEntries).where(eq(depreciationEntries.periodId, cur.id));
    expect(curEntries.reduce((s, e) => s + e.amount, 0)).toBe(2_500_000 + 500_000 + 500_000);

    // Akuntan mengubah umur truk 96 → 48 bulan: akumulasi seharusnya (2 bulan × 240jt/48 = 10jt) − terposting (5jt) = 5jt.
    const [truck] = await t.db.select().from(fixedAssets).where(eq(fixedAssets.code, "AST-T1"));
    await expect(m11.updateAssetEstimate(fa, { assetId: truck!.id, usefulLifeMonths: 48, reason: "" })).rejects.toThrow(/Alasan/);
    const upd = await m11.updateAssetEstimate(fa, { assetId: truck!.id, usefulLifeMonths: 48, reason: "Umur truk ditetapkan ulang akuntan" });
    expect(upd.adjustment).toBe(5_000_000);
    expect(upd.journalNumber).toMatch(/^J-/);
    const adj = await t.db.select().from(depreciationEntries).where(and(eq(depreciationEntries.fixedAssetId, truck!.id), eq(depreciationEntries.isAdjustment, true)));
    expect(adj[0]).toMatchObject({ amount: 5_000_000, accumulatedAfter: 40_000_000 });
    const trail = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "fixed_asset"), eq(auditLogs.objectId, truck!.id), eq(auditLogs.action, "update")));
    expect(trail[0]).toMatchObject({ reason: "Umur truk ditetapkan ulang akuntan" });
  });

  it("US-M11-05 KP-3 aset milik pribadi yang disewakan ke PT (K15) tidak masuk daftar aset — sewanya jurnal berulang", async () => {
    await expect(
      m11.createAsset(finance(), { code: "AST-SEWA", name: "Truk pribadi disewa PT", category: "truck", acquisitionDate: TODAY, acquisitionCost: 200_000_000, usefulLifeMonths: 96, ownedByCompany: false }),
    ).rejects.toThrow(/tidak masuk daftar aset.*jurnal berulang/);
    expect((await t.db.select().from(fixedAssets).where(eq(fixedAssets.code, "AST-SEWA"))).length).toBe(0);
    const rec = await m11.saveRecurringJournal(finance(), { name: "Sewa truk pribadi (K15)", template: "rent", description: "Sewa truk milik pribadi ke PT", lines: [...pair("6-1201", "1-1201", 3_000_000, { debit: "L2" })] });
    expect(rec).toMatchObject({ template: "rent", isActive: true });
  });

  it("US-M11-05 KP-4 penambahan aset dari nota/jurnal manual; pelepasan/penjualan dengan laba-rugi pelepasan otomatis; riwayat per aset", async () => {
    const fa = finance();
    const draft = await m11.createManualJournal(fa, { date: TODAY, description: "Pembelian pompa cadangan", lines: [...pair("1-2201", "1-1201", 4_800_000, { debit: "L1" })] });
    await expect(
      m11.createAsset(fa, { code: "AST-PMP", name: "Pompa cadangan SA2", category: "water_installation", acquisitionDate: TODAY, acquisitionCost: 4_800_000, usefulLifeMonths: 48, waterSourceId: waterSourceId("SA2"), source: "manual_journal", acquisitionJournalId: draft.id }),
    ).rejects.toThrow(/belum terposting/);
    const bought = await manualJournal(fa, { date: TODAY, description: "Pembelian pompa cadangan (nota)", lines: pair("1-2201", "1-1201", 4_800_000, { debit: "L1" }) });
    const asset = await m11.createAsset(fa, {
      code: "AST-PMP",
      name: "Pompa cadangan SA2",
      category: "water_installation",
      acquisitionDate: TODAY,
      acquisitionCost: 4_800_000,
      usefulLifeMonths: 48,
      waterSourceId: waterSourceId("SA2"),
      source: "manual_journal",
      acquisitionJournalId: bought.draft.id,
    });
    expect(asset).toMatchObject({ profitCenter: "L1", source: "manual_journal", status: "active" });

    // Jual mesin RO D01: nilai buku = 36jt − (5jt saldo awal + 2 × 500rb) = 30jt; dijual 32jt → laba 2jt.
    const [ro] = await t.db.select().from(fixedAssets).where(eq(fixedAssets.code, "AST-D01"));
    const bukti = await evidence(fa);
    await expect(m11.disposeAsset(fa, { assetId: ro!.id, date: TODAY, proceeds: 32_000_000, reason: "Dijual ke mitra", attachmentId: bukti })).rejects.toThrow(/akun penerimaan/);
    // BR-35: jurnal pelepasan = jurnal manual berlampiran; > PAR-20 menunggu persetujuan pemilik, aset dilepas setelahnya.
    const sold = await m11.disposeAsset(fa, { assetId: ro!.id, date: TODAY, proceeds: 32_000_000, proceedsAccountId: acc("1-1201"), reason: "Dijual ke mitra", attachmentId: bukti });
    expect(sold).toMatchObject({ bookValue: 30_000_000, gainLoss: 2_000_000, status: "submitted" });
    expect((await t.db.select().from(fixedAssets).where(eq(fixedAssets.id, ro!.id)))[0]!.status).toBe("active");
    await approvals.decide(owner(), sold.approvalId!, "approve", "Penjualan disetujui");
    expect((await linesOf(t.db, sold.journal.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([
      ["1-2301", 0, 36_000_000],
      ["1-2302", 6_000_000, 0],
      ["1-1201", 32_000_000, 0],
      ["4-9201", 0, 2_000_000],
    ]);
    await expect(m11.disposeAsset(fa, { assetId: ro!.id, date: TODAY, reason: "Lepas lagi", attachmentId: await evidence(fa) })).rejects.toThrow(/sudah dilepas/);
    const detail = await m11.assetDetail(accountant(), ro!.id);
    expect(detail.asset).toMatchObject({ status: "disposed", disposalGainLoss: 2_000_000 });
    expect(detail.entries.length).toBe(2);
    const disposalJournal = (await t.db.select().from(journals).where(eq(journals.id, sold.journal.id)))[0]!;
    expect(disposalJournal).toMatchObject({ sourceObjectType: "fixed_asset", sourceObjectId: ro!.id });
  });

  it("US-M11-05 KP-5 laporan daftar aset & akumulasi penyusutan per periode untuk akuntan dan pajak", async () => {
    const reg = await m11.assetRegister(accountant(), { period: PREV });
    const t1 = reg.rows.find((r) => r.code === "AST-T1")!;
    expect(t1).toMatchObject({ cost: 240_000_000, accumulated: 32_500_000, bookValue: 207_500_000, depreciationThisPeriod: 2_500_000, signed: true });
    expect(reg.rows.some((r) => r.code === "AST-PMP")).toBe(false);
    const cur = await m11.assetRegister(accountant(), { period: THIS_PERIOD });
    expect(cur.rows.find((r) => r.code === "AST-D01")).toMatchObject({ status: "disposed", bookValue: 0 });
    expect(cur.totals.cost).toBe(cur.rows.reduce((s, r) => s + r.cost, 0));
    const x = await exportReport(accountant(), "m11.assets", "xlsx", { period: PREV });
    expect(x.rowCount).toBe(reg.rows.length);
  });
});
