import { and, eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it } from "vitest";

import { accessLogs, accountingPeriods, exportLogs } from "@/db/schema";
import { EQUA_TENANT_ID, userIdByUsername } from "@/db/seed";
import { exportReport, getReport } from "@/server/core/export";
import * as m11 from "@/server/modules/m11-accounting";
import * as m9 from "@/server/modules/m9-reports";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { accountant, at, dispatcher, finance, makeTrip, owner, postJ } from "./helpers";

const M = "2026-05";
const NOW = at("2026-06-20", "09:00");

/** Laporan M9 terdaftar + filter satu bulan data. */
const M9_EXPORTS: { key: string; filters: Record<string, unknown>; ctx: () => ReturnType<typeof owner> }[] = [
  { key: "m9.daily_summary", filters: { date: "2026-05-12" }, ctx: () => owner(NOW) },
  { key: "m9.daily_summaries", filters: { from: "2026-05-01", to: "2026-05-31" }, ctx: () => owner(NOW) },
  { key: "m9.monthly_gross_profit", filters: { month: M }, ctx: () => owner(NOW) },
  { key: "m9.water_cost_per_liter", filters: { month: M }, ctx: () => owner(NOW) },
  { key: "m9.gross_revenue_pkp", filters: { month: M }, ctx: () => owner(NOW) },
  { key: "m9.trip_realization", filters: { from: "2026-05-01", to: "2026-05-31" }, ctx: () => owner(NOW) },
  { key: "m9.performance_drivers", filters: { month: M }, ctx: () => owner(NOW) },
  { key: "m9.performance_outlets", filters: { month: M }, ctx: () => owner(NOW) },
  { key: "m9.trend_weekly", filters: { to: "2026-05-31" }, ctx: () => owner(NOW) },
  { key: "m9.trend_monthly", filters: { to: "2026-05-31" }, ctx: () => owner(NOW) },
  { key: "m9.kpi", filters: { month: M }, ctx: () => owner(NOW) },
  { key: "m9.parallel_run_checks", filters: { from: "2026-05-01", to: "2026-05-31" }, ctx: () => owner(NOW) },
];

describe("M9 — katalog laporan & ekspor Excel/PDF (US-M9-03)", () => {
  const t = useTestDb({ seed: true });

  beforeAll(async () => {
    bootstrapForTests();
    const trip = await makeTrip(t.db, { date: "2026-05-12", price: 500_000 });
    await postJ({ date: "2026-05-12", sourceObject: { type: "trip", id: trip.id }, lines: [["1-1102", 500_000, 0], ["4-1101", 0, 500_000]] });
  });

  it("US-M9-03 KP-1 setiap baris katalog 7.9.4 punya laporan terdaftar; ekspor Excel (Data + Ringkasan) dan PDF satu bulan data ≤ 30 detik", async () => {
    expect(m9.missingCatalogReports()).toEqual([]);
    // Setiap baris katalog PRD 7.9.4 terwakili (18 baris + ekspor jurnal konsultan M11).
    expect(m9.REPORT_CATALOG).toHaveLength(19);
    for (const e of m9.REPORT_CATALOG) expect(e.reportKeys.length + (e.pendingKeys?.length ?? 0)).toBeGreaterThan(0);
    const catalog = await m9.getReportCatalog(owner(NOW));
    expect(catalog.find((c) => c.id === "gross_profit")!.reports[0]).toMatchObject({ key: "m9.monthly_gross_profit", registered: true, allowed: true });
    expect(catalog.find((c) => c.id === "h0")!.reports[0]!.needsFilters).toEqual([]);

    for (const r of M9_EXPORTS) {
      expect(getReport(r.key), r.key).toBeTruthy();
      const started = Date.now();
      const xlsx = await exportReport(r.ctx(), r.key, "xlsx", r.filters);
      const pdf = await exportReport(r.ctx(), r.key, "pdf", r.filters);
      expect(Date.now() - started, r.key).toBeLessThan(30_000);
      expect(xlsx.body.subarray(0, 2).toString()).toBe("PK");
      expect(pdf.body.subarray(0, 4).toString()).toBe("%PDF");
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(xlsx.body as unknown as ArrayBuffer);
      expect(wb.worksheets.map((w) => w.name)).toEqual(["Data", "Ringkasan"]);
    }
    // Isi laporan bulanan memuat pusat laba + eliminasi + konsolidasi.
    const monthly = await exportReport(owner(NOW), "m9.monthly_gross_profit", "xlsx", { month: M });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(monthly.body as unknown as ArrayBuffer);
    const col = wb.getWorksheet("Data")!.getColumn(1).values.map(String);
    expect(col).toEqual(expect.arrayContaining(["Konsolidasi", "Eliminasi transfer internal (BR-33)"]));
    const summary = wb.getWorksheet("Ringkasan")!;
    const text = summary.getSheetValues().flat().map(String).join(" ");
    expect(text).toMatch(/Sementara/);
  });

  it("US-M9-03 KP-2 setiap ekspor tercatat (siapa, kapan, laporan, filter); data pribadi hanya pemilik/Admin Keuangan dengan tujuan, peran lain versi tanpa WA/alamat (BR-39)", async () => {
    const res = await exportReport(owner(NOW), "m9.monthly_gross_profit", "pdf", { month: M });
    const [log] = await t.db.select().from(exportLogs).where(eq(exportLogs.id, res.exportLogId));
    expect(log).toMatchObject({ userId: userIdByUsername("pemilik"), reportKey: "m9.monthly_gross_profit", format: "pdf", filters: { month: M }, containsPersonalData: false, fileSha256: res.sha256 });
    expect(log!.createdAt).toBeInstanceOf(Date);
    const access = await t.db.select().from(accessLogs).where(and(eq(accessLogs.event, "export"), eq(accessLogs.objectId, "m9.monthly_gross_profit")));
    expect(access.length).toBeGreaterThan(0);

    // Laporan berisi data pribadi (daftar pesanan M2): Dispatcher → versi tanpa WA/alamat; pemilik wajib tujuan.
    const stripped = await exportReport(dispatcher(NOW), "m2.orders", "xlsx", { from: "2026-05-01", to: "2026-05-31" });
    expect(stripped).toMatchObject({ piiStripped: true, containsPersonalData: false });
    await expect(exportReport(owner(NOW), "m2.orders", "xlsx", { from: "2026-05-01", to: "2026-05-31" })).rejects.toThrow(/Tujuan ekspor wajib/);
    const full = await exportReport(owner(NOW), "m2.orders", "xlsx", { from: "2026-05-01", to: "2026-05-31" }, "Bahan rapat penagihan bulanan");
    expect(full).toMatchObject({ piiStripped: false, containsPersonalData: true });
    const [fullLog] = await t.db.select().from(exportLogs).where(eq(exportLogs.id, full.exportLogId));
    expect(fullLog).toMatchObject({ containsPersonalData: true, purpose: "Bahan rapat penagihan bulanan" });
    // Katalog menandai laporan PII & hak versi lengkap.
    const fa = await m9.getReportCatalog(finance(NOW));
    const disp = await m9.getReportCatalog(dispatcher(NOW));
    expect(fa.find((c) => c.id === "orders")!.reports.find((r) => r.key === "m2.orders")).toMatchObject({ containsPii: true });
    expect(disp.find((c) => c.id === "orders")!.reports.find((r) => r.key === "m2.orders")).toMatchObject({ containsPii: true, piiFull: false, allowed: true });
    // Peran tanpa izin laporan ditolak.
    await expect(exportReport(dispatcher(NOW), "m9.monthly_gross_profit", "xlsx", { month: M })).rejects.toThrow(/tidak diizinkan/);
  });

  it("US-M9-03 KP-3 ekspor jurnal format konsultan (M11) memakai mekanisme & log ekspor yang sama", async () => {
    // Integrasi M9+M11: baris katalog memakai laporan terdaftar M11 (tanpa kunci "menyusul").
    const catalog = await m9.getReportCatalog(accountant(NOW));
    const entry = catalog.find((c) => c.id === "journal_export")!;
    expect(entry.pendingKeys ?? []).toEqual([]);
    expect(entry).toMatchObject({ screen: "/akuntansi/pajak", canOpenScreen: true });
    expect(entry.reports[0]).toMatchObject({ key: "m11.journals", registered: true, allowed: true });
    const statements = catalog.find((c) => c.id === "gross_profit")!.reports.map((r) => r.key);
    expect(statements).toEqual(["m9.monthly_gross_profit", "m11.profit_loss", "m11.balance_sheet", "m11.cash_flow"]);

    // Ekspor generik (`/api/export/m11.journals`) → log ekspor & log akses yang sama dengan laporan M9.
    const res = await exportReport(accountant(NOW), "m11.journals", "xlsx", { period: M });
    const [log] = await t.db.select().from(exportLogs).where(eq(exportLogs.id, res.exportLogId));
    expect(log).toMatchObject({ reportKey: "m11.journals", userId: userIdByUsername("akuntan"), filters: { period: M } });

    // Format konsultan (template terkonfigurasi M11, `/akuntansi/pajak/ekspor`) juga tercatat di log ekspor & akses.
    const out = await m11.exportWithTemplate(accountant(NOW), { templateKey: "journals-consultant", period: M, format: "csv" });
    const tplLogs = await t.db.select().from(exportLogs).where(and(eq(exportLogs.reportKey, "m11.template.journals-consultant"), eq(exportLogs.fileSha256, out.sha256)));
    expect(tplLogs).toHaveLength(1);
    expect(tplLogs[0]).toMatchObject({ userId: userIdByUsername("akuntan"), format: "csv", filters: { period: M } });
    const access = await t.db.select().from(accessLogs).where(and(eq(accessLogs.event, "export"), eq(accessLogs.objectId, "m11.template.journals-consultant")));
    expect(access.length).toBeGreaterThan(0);
  });

  it("US-M9-03 KP-4 laporan Final menghasilkan berkas identik saat diekspor ulang; Sementara dirender ulang", async () => {
    const draft = await m9.exportMonthlyReport(owner(NOW), { month: M, format: "xlsx" });
    expect(draft).toMatchObject({ final: false, reused: false });
    const [p] = await t.db.select().from(accountingPeriods).where(and(eq(accountingPeriods.tenantId, EQUA_TENANT_ID), eq(accountingPeriods.period, M)));
    await t.db.update(accountingPeriods).set({ status: "locked", lockedAt: at("2026-06-09", "10:00") }).where(eq(accountingPeriods.id, p!.id));
    const first = await m9.exportMonthlyReport(owner(at("2026-06-21", "09:00")), { month: M, format: "xlsx" });
    const second = await m9.exportMonthlyReport(owner(at("2026-06-22", "15:30")), { month: M, format: "xlsx" });
    const byAccountant = await m9.exportMonthlyReport(accountant(at("2026-06-23", "08:00")), { month: M, format: "xlsx" });
    expect(first).toMatchObject({ final: true, reused: false });
    expect(second).toMatchObject({ final: true, reused: true, sha256: first.sha256, filename: first.filename });
    expect(Buffer.compare(second.body, first.body)).toBe(0);
    expect(byAccountant.sha256).toBe(first.sha256);
    const pdf1 = await m9.exportMonthlyReport(owner(at("2026-06-21", "10:00")), { month: M, format: "pdf" });
    const pdf2 = await m9.exportMonthlyReport(owner(at("2026-06-24", "10:00")), { month: M, format: "pdf" });
    expect(pdf2).toMatchObject({ reused: true, sha256: pdf1.sha256 });
    // Tetap tercatat setiap kali (KP-2).
    const logs = await t.db.select().from(exportLogs).where(and(eq(exportLogs.reportKey, "m9.monthly_gross_profit"), eq(exportLogs.fileSha256, first.sha256)));
    expect(logs.length).toBeGreaterThanOrEqual(3);
    await expect(m9.exportMonthlyReport(dispatcher(NOW), { month: M, format: "xlsx" })).rejects.toThrow(/tidak diizinkan/);
  });
});
