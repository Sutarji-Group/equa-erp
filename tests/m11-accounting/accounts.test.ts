import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { accounts, auditLogs, eventAccountMappings, truckFills } from "@/db/schema";
import { EQUA_TENANT_ID, outletId, truckId, waterSourceId } from "@/db/seed";
import { isHardeningViolation } from "@/db/hardening";
import { newId } from "@/lib/ids";
import { ForbiddenError } from "@/server/core/errors";
import * as flags from "@/server/core/flags";
import { withTx } from "@/server/core/db";
import * as m11 from "@/server/modules/m11-accounting";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { THIS_PERIOD, TODAY, acc, accountant, emitEvent, finance, journalOfEvent, linesOf, manualJournal, owner, pair, setPeriod } from "./helpers";

const csv = [
  "Kode,Nama,Jenis,Pusat laba,Induk,Saldo normal,Header,Internal,Kas",
  "6-8000,Beban Program Uji,Beban,,6-0000,,ya,,",
  "6-8001,Beban Pelatihan Sopir,Beban,L2,6-8000,Debit,,,",
  "6-8002,Beban Pelatihan Depot,Beban,L3,6-8000,,,,",
  "1-1101,Kas Kantor (nama akuntan),Aset,UMUM,,,,,ya",
  "6-8003,Akun rusak,Entah,L9,,,,,",
].join("\n");

describe("M11 bagan akun, pemetaan & pusat laba (US-M11-01)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M11-01 KP-1 bagan akun diimpor dari template akuntan (pratinjau → komit) dengan kode, nama, jenis, pusat laba; perubahan berjejak", async () => {
    const fa = finance();
    const preview = await m11.importChartOfAccounts(fa, { fileName: "coa.csv", content: csv });
    expect(preview.committed).toBe(false);
    expect(preview.rows.map((r) => [r.code, r.action])).toEqual([
      ["6-8000", "create"],
      ["6-8001", "create"],
      ["6-8002", "create"],
      ["1-1101", "update"],
      ["6-8003", "error"],
    ]);
    expect(preview.rows[4]!.errors.join(" ")).toMatch(/Jenis "entah" tidak dikenal.*Pusat laba "L9"/);
    await expect(m11.importChartOfAccounts(fa, { fileName: "coa.csv", content: csv, commit: true, reason: "Template akuntan K9" })).rejects.toThrow(/baris bermasalah/);

    const clean = csv.split("\n").slice(0, 5).join("\n");
    const done = await m11.importChartOfAccounts(fa, { fileName: "coa.csv", content: clean, commit: true, reason: "Template akuntan K9 versi 1" });
    expect(done).toMatchObject({ committed: true, created: 3, updated: 1, errors: 0 });
    const rows = await m11.listAccounts(accountant());
    const byCode = new Map(rows.map((r) => [r.code, r]));
    expect(byCode.get("6-8000")).toMatchObject({ isPostable: false, type: "expense" });
    expect(byCode.get("6-8001")).toMatchObject({ profitCenter: "L2", type: "expense", isPostable: true });
    expect(byCode.get("1-1101")).toMatchObject({ name: "Kas Kantor (nama akuntan)", profitCenter: "SHARED", isCash: true });
    const [child] = await t.db.select().from(accounts).where(and(eq(accounts.tenantId, EQUA_TENANT_ID), eq(accounts.code, "6-8001")));
    expect(child!.parentId).toBe(byCode.get("6-8000")!.id);
    const trail = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "account"), eq(auditLogs.objectId, acc("1-1101"))));
    expect(trail.some((a) => a.action === "update" && (a.before as { name?: string })?.name !== (a.after as { name?: string })?.name)).toBe(true);

    // Pusat laba L1–L5 + umum/kantor tersedia.
    const centers = await m11.listProfitCenters(accountant());
    expect(centers.map((c) => c.code).sort()).toEqual(["L1", "L2", "L3", "L4", "L5", "SHARED"]);

    const upd = await m11.updateAccount(fa, { accountId: child!.id, name: "Beban Pelatihan Sopir & Kernet", reason: "Nama disesuaikan akuntan" });
    expect(upd.name).toBe("Beban Pelatihan Sopir & Kernet");
    await expect(m11.updateAccount(fa, { accountId: child!.id, name: "Tanpa alasan", reason: "" })).rejects.toThrow(/Alasan/);
    // Akuntan meninjau (baca-saja): tidak dapat menambah akun.
    await expect(m11.createAccount(accountant(), { code: "6-8009", name: "Akun akuntan", type: "expense" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("US-M11-01 KP-1 akun dinonaktifkan, tidak dihapus; akun yang masih dipetakan ditolak dinonaktifkan", async () => {
    const fa = finance();
    await expect(m11.deactivateAccount(fa, { accountId: acc("4-1101"), reason: "Coba nonaktifkan" })).rejects.toThrow(/masih dipakai pemetaan/);
    const a = await m11.createAccount(fa, { code: "6-8100", name: "Beban Sementara", type: "expense", profitCenter: "SHARED" });
    const off = await m11.deactivateAccount(fa, { accountId: a.id, reason: "Tidak dipakai lagi" });
    expect(off).toMatchObject({ isActive: false, deactivationReason: "Tidak dipakai lagi" });
    expect((await m11.listAccounts(fa, { includeInactive: false })).some((r) => r.id === a.id)).toBe(false);
    expect((await m11.listAccounts(fa)).find((r) => r.id === a.id)).toMatchObject({ isActive: false });
    const del = await t.db
      .delete(accounts)
      .where(eq(accounts.id, a.id))
      .catch((e: unknown) => e);
    expect(isHardeningViolation(del)).toBe(true);
    // Akun nonaktif tidak dapat dipakai jurnal manual.
    await expect(
      m11.createManualJournal(fa, { date: TODAY, description: "Pakai akun nonaktif", lines: [{ accountId: a.id, profitCenter: "SHARED", debit: 10_000 }, { accountId: acc("1-1101"), profitCenter: "SHARED", credit: 10_000 }] }),
    ).rejects.toThrow(/nonaktif/);
  });

  it("US-M11-01 KP-2 pemetaan peristiwa → akun dikelola Admin Keuangan (ke depan, berjejak), akuntan meninjau; M11 tidak dapat diaktifkan bila ada peristiwa tanpa pemetaan", async () => {
    const view = await m11.listMappings(accountant());
    expect(view.missingCount).toBe(0);
    expect(view.mappings.length).toBe(m11.REQUIRED_MAPPINGS.length);
    const fa = finance();
    const base = { eventKey: "expense.verified", entryKey: "fuel", description: "BBM rit", debitAccountId: acc("5-1301"), creditAccountId: acc("1-1102"), debitProfitCenter: "L2" as const, creditProfitCenter: "L2" as const, reason: "Tinjauan akuntan" };
    await expect(m11.saveMapping(fa, { ...base, effectiveFrom: "2020-01-01" })).rejects.toThrow(/berlaku ke depan/);
    await expect(m11.saveMapping(accountant(), { ...base, effectiveFrom: TODAY })).rejects.toBeInstanceOf(ForbiddenError);
    const saved = await m11.saveMapping(fa, { ...base, effectiveFrom: TODAY });
    const [log] = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "event_account_mapping"), eq(auditLogs.objectId, saved.mapping.id)));
    expect(log).toMatchObject({ reason: "Tinjauan akuntan" });
    expect(log!.after).toMatchObject({ debit: "5-1301", credit: "1-1102" });

    // Hilangkan satu pemetaan wajib → aktivasi ditolak (pemilik), dan hanya pemilik yang mengaktifkan.
    await t.db
      .update(eventAccountMappings)
      .set({ isActive: false })
      .where(and(eq(eventAccountMappings.eventKey, "stock.adjusted"), eq(eventAccountMappings.entryKey, "depot")));
    expect((await m11.listMappings(accountant())).mappings.find((m) => m.event === "stock.adjusted" && m.entry === "depot")!.status).toBe("missing");
    await expect(m11.setAccountingActive(owner(), { enabled: true, reason: "Aktifkan jurnal otomatis" })).rejects.toThrow(/belum dapat diaktifkan.*stock\.adjusted\/depot/);
    await expect(m11.setAccountingActive(fa, { enabled: true, reason: "Aktifkan jurnal otomatis" })).rejects.toBeInstanceOf(ForbiddenError);
    await m11.saveMapping(fa, { eventKey: "stock.adjusted", entryKey: "depot", description: "Selisih opname depot", debitAccountId: acc("6-1701"), creditAccountId: acc("1-1502"), debitProfitCenter: "L3", creditProfitCenter: "L3", profitCenterRule: "from_outlet", effectiveFrom: TODAY, reason: "Dilengkapi" });
    await expect(m11.setAccountingActive(owner(), { enabled: true, reason: "Aktifkan jurnal otomatis" })).resolves.toMatchObject({ enabled: true });
    expect(await withTx((tx) => flags.isEnabled(tx, "accounting.m11_active", { tenantId: EQUA_TENANT_ID }))).toBe(true);
  });

  it("US-M11-01 KP-3 L1 = pusat biaya dialokasikan ke L2 & L3 menurut volume pengisian bulan itu (PAR-65); alokasi tampil terpisah di laba rugi per lini", async () => {
    const period = await setPeriod(t.db, THIS_PERIOD, "open");
    await manualJournal(finance(), { date: TODAY, description: "Listrik pompa sumber air SA1", lines: pair("6-1301", "1-1101", 1_000_000, { debit: "L1" }) });
    const day = TODAY;
    await t.db.insert(truckFills).values([
      { tenantId: EQUA_TENANT_ID, waterSourceId: waterSourceId("SA1"), truckId: truckId("T1"), businessDate: day, volumeL: 30_000, filledAt: new Date(), isDepotSupply: false },
      { tenantId: EQUA_TENANT_ID, waterSourceId: waterSourceId("SA1"), truckId: truckId("T2"), businessDate: day, volumeL: 10_000, filledAt: new Date(), isDepotSupply: true },
    ]);
    const st = await m11.allocationStatus(finance(), { periodId: period.id });
    expect(st.l1).toMatchObject({ total: 1_000_000, required: true, shares: { L2: 750_000, L3: 250_000 }, posted: null });
    expect(st.l1.basis).toMatchObject({ customerL: 30_000, depotL: 10_000 });
    await expect(m11.runCostAllocation(accountant(), { periodId: period.id, kind: "l1_allocation" })).rejects.toBeInstanceOf(ForbiddenError);
    const res = await m11.runCostAllocation(finance(), { periodId: period.id, kind: "l1_allocation" });
    expect(res.journal).toMatchObject({ kind: "allocation", status: "posted", totalDebit: 1_000_000 });
    expect((await linesOf(t.db, res.journal.id)).map((l) => [l.code, l.profitCenter, l.debit, l.credit])).toEqual([
      ["5-1501", "L2", 750_000, 0],
      ["5-1501", "L3", 250_000, 0],
      ["5-1502", "L1", 0, 1_000_000],
    ]);
    await expect(m11.runCostAllocation(finance(), { periodId: period.id, kind: "l1_allocation" })).rejects.toThrow(/sudah terposting/);

    const st2 = await m11.getStatements(accountant(), { period: THIS_PERIOD });
    const pl = st2.profitLoss;
    expect(pl.centers.L1.allocationL1).toBe(1_000_000);
    expect(pl.centers.L2.allocationL1).toBe(-750_000);
    expect(pl.centers.L3.allocationL1).toBe(-250_000);
    expect(pl.centers.L1.net).toBe(pl.centers.L1.beforeAllocation + 1_000_000);
    expect(pl.rows.filter((r) => r.allocation === "l1").map((r) => r.section)).toEqual(["Alokasi biaya produksi air (L1)", "Alokasi biaya produksi air (L1)"]);
  });

  it("US-M11-01 KP-4 transfer internal memakai akun pendapatan/beban internal berpasangan → konsolidasi mengeliminasi otomatis", async () => {
    const before = (await m11.getStatements(accountant(), { period: THIS_PERIOD })).profitLoss;
    const ev = await emitEvent("water_supply.confirmed", {
      waterSupplyReceiptId: newId(),
      outletId: outletId("D01"),
      volumeSentL: 8000,
      volumeReceivedL: 8000,
      transferValue: 400_000,
      confirmedByOperator: true,
    });
    const j = await journalOfEvent(t.db, ev.id);
    expect((await linesOf(t.db, j!.id)).map((l) => [l.code, l.profitCenter, l.debit, l.credit])).toEqual([
      ["5-1201", "L3", 400_000, 0],
      ["4-1501", "L2", 0, 400_000],
    ]);
    const after = (await m11.getStatements(accountant(), { period: THIS_PERIOD })).profitLoss;
    expect(after.centers.L2.revenue - before.centers.L2.revenue).toBe(400_000);
    expect(after.consolidated.eliminatedRevenue - before.consolidated.eliminatedRevenue).toBe(400_000);
    expect(after.consolidated.eliminatedExpense - before.consolidated.eliminatedExpense).toBe(400_000);
    // Laba konsolidasi tidak berubah oleh transfer internal.
    expect(after.consolidated.net).toBe(before.consolidated.net);
    expect(after.consolidated.revenue).toBe(before.consolidated.revenue);
  });

  it("US-M11-01 KP-5 biaya bersama dibiarkan di pusat biaya bersama (bawaan) atau dialokasikan menurut kunci pemilik (tetap/omzet)", async () => {
    const period = await setPeriod(t.db, THIS_PERIOD, "open");
    await manualJournal(finance(), { date: TODAY, description: "Gaji Admin Keuangan & IT (kantor)", lines: pair("6-1101", "1-1201", 2_000_000) });
    const none = await m11.allocationStatus(finance(), { periodId: period.id });
    expect(none.shared).toMatchObject({ required: false, total: 0 });
    expect(none.shared.message).toMatch(/dibiarkan di pusat biaya bersama/);
    await expect(m11.runCostAllocation(finance(), { periodId: period.id, kind: "shared_costs" })).rejects.toThrow(/dibiarkan/);

    await expect(m11.setSharedCostKey(finance(), { basis: "fixed", fixedPercents: { L2: 40, L3: 30, L4: 20, L5: 10 }, reason: "Kunci tetap" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(m11.setSharedCostKey(owner(), { basis: "fixed", fixedPercents: { L2: 50, L3: 30, L4: 10, L5: 0 }, reason: "Kunci tetap" })).rejects.toThrow(/100/);
    await m11.setSharedCostKey(owner(), { basis: "fixed", fixedPercents: { L2: 40, L3: 30, L4: 20, L5: 10 }, reason: "Kunci tetap dari pemilik" });
    const fixed = await m11.allocationStatus(finance(), { periodId: period.id });
    expect(fixed.shared.required).toBe(true);
    const total = fixed.shared.total;
    expect(total).toBeGreaterThanOrEqual(2_000_000);
    expect(Object.values(fixed.shared.shares).reduce((s, n) => s + n, 0)).toBe(total);
    expect(fixed.shared.shares.L2).toBe(Math.floor(total * 0.4) + (total - ["L2", "L3", "L4", "L5"].reduce((s, k, i) => s + Math.floor((total * [40, 30, 20, 10][i]!) / 100), 0)));
    const res = await m11.runCostAllocation(finance(), { periodId: period.id, kind: "shared_costs" });
    const pl = (await m11.getStatements(accountant(), { period: THIS_PERIOD })).profitLoss;
    expect(pl.centers.SHARED.allocationShared).toBe(total);
    expect(pl.centers.L3.allocationShared).toBe(-fixed.shared.shares.L3!);
    expect(res.run).toMatchObject({ kind: "shared_costs", status: "posted", totalAmount: total });
  });
});
