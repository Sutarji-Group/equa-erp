import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { exportLogs, journals, notifications } from "@/db/schema";
import { EQUA_TENANT_ID, outletId } from "@/db/seed";
import { isHardeningViolation } from "@/db/hardening";
import { newId } from "@/lib/ids";
import { withTx } from "@/server/core/db";
import { ForbiddenError } from "@/server/core/errors";
import { exportReport } from "@/server/core/export";
import * as params from "@/server/core/params";
import * as m11 from "@/server/modules/m11-accounting";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { THIS_PERIOD, TODAY, accountant, at, emitEvent, finance, journalsOfSource, linesOf, owner, setPeriod, shiftMonth, tripPayload } from "./helpers";

describe("M11 pajak PT non-PKP & pemantauan batas PKP (US-M11-08)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());
  const saleId = newId();

  beforeAll(async () => {
    await setPeriod(t.db, THIS_PERIOD, "open");
    await emitEvent("trip.completed", tripPayload({ cashReceived: 250_000 }));
    await emitEvent("pos_sale.recorded", { posSaleId: saleId, outletId: outletId("D01"), outletKind: "depot", shiftId: newId(), method: "cash", total: 100_000, discount: 0, lines: [] });
    await emitEvent("pos_sale.recorded", { posSaleId: newId(), outletId: outletId("TK1"), outletKind: "store", shiftId: newId(), method: "cash", total: 50_000, discount: 0, cogs: 20_000, lines: [] });
    await emitEvent("partner.subscription_invoiced", { invoiceId: newId(), partnerContractId: newId(), partnerTenantId: newId(), amount: 200_000, outletCount: 1 });
    // Transfer internal & pendapatan lain (selisih lebih setoran) bukan omzet luar per lini.
    await emitEvent("water_supply.confirmed", { waterSupplyReceiptId: newId(), outletId: outletId("D01"), volumeSentL: 8000, volumeReceivedL: 8000, transferValue: 400_000, confirmedByOperator: true });
    await emitEvent("deposit.received", { depositId: newId(), sourceType: "driver", expectedAmount: 100_000, receivedAmount: 110_000, discrepancyAmount: 10_000, receivedBy: finance().userId!, late: false });
  });

  it("US-M11-08 KP-1 sistem tidak memungut PPN: jurnal penjualan tanpa komponen pajak; bagan akun tanpa akun PPN", async () => {
    const lines = await linesOf(t.db, (await journalsOfSource(t.db, "pos_sale", saleId))[0]!.id);
    expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([
      ["1-1103", 100_000, 0],
      ["4-1201", 0, 100_000],
    ]);
    const accs = await m11.listAccounts(accountant());
    expect(accs.some((a) => /ppn|pajak keluaran|pajak masukan/i.test(a.name))).toBe(false);
    expect((await m11.taxOverview(accountant())).noVat).toBe(true);
  });

  it("US-M11-08 KP-2 omzet bruto bulanan per lini (pendapatan luar; transfer internal dikecualikan) + estimasi PPh final 0,5% (PAR-64); skema lain diinput Admin Keuangan", async () => {
    const ov = await m11.taxOverview(finance(), { period: THIS_PERIOD });
    expect(ov.revenue).toMatchObject({ L2: 250_000, L3: 100_000, L4: 50_000, L5: 200_000 });
    expect(ov.total).toBe(600_000);
    expect(ov).toMatchObject({ schemeLabel: expect.stringContaining("final"), ratePercent: 0.5, pphEstimate: 3_000 });
    const report = await m11.monthlyRevenueReport(accountant(), { fromPeriod: shiftMonth(THIS_PERIOD, -1), toPeriod: THIS_PERIOD });
    expect(report.at(-1)).toMatchObject({ period: THIS_PERIOD, total: 600_000, pphEstimate: 3_000 });
    expect(report[0]).toMatchObject({ total: 0 });
    const x = await exportReport(accountant(), "m11.revenue_tax", "xlsx", { from: THIS_PERIOD, to: THIS_PERIOD });
    expect(x.rowCount).toBeGreaterThan(0);

    await expect(m11.setTaxScheme(accountant(), { scheme: "non_pkp_other", ratePercent: 1, effectiveFrom: TODAY, notes: "Keputusan konsultan" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(m11.setTaxScheme(finance(), { scheme: "non_pkp_other", effectiveFrom: TODAY, notes: "Keputusan konsultan" })).rejects.toThrow(/tarifnya/);
    await expect(m11.setTaxScheme(finance(), { scheme: "non_pkp_other", ratePercent: 1, effectiveFrom: "2020-01-01", notes: "Keputusan konsultan" })).rejects.toThrow(/hari ini/);
    await m11.setTaxScheme(finance(), { scheme: "non_pkp_other", ratePercent: 1, effectiveFrom: TODAY, notes: "Konsultan menetapkan tarif 1% omzet" });
    const ov2 = await m11.taxOverview(finance(), { period: THIS_PERIOD });
    expect(ov2).toMatchObject({ ratePercent: 1, pphEstimate: 6_000 });
  });

  it("US-M11-08 KP-3 ekspor jurnal/buku besar/omzet ke format konsultan lewat template terkonfigurasi — format dapat diubah tanpa rilis", async () => {
    const templates = await m11.listExportTemplates(accountant());
    expect(templates.some((x) => x.key === "journals-consultant" && x.isActive)).toBe(true);
    const v1 = await m11.exportWithTemplate(accountant(), { templateKey: "journals-consultant", period: THIS_PERIOD, format: "csv" });
    const periodLines = await t.db.select({ id: journals.id }).from(journals).where(eq(journals.tenantId, EQUA_TENANT_ID));
    expect(periodLines.length).toBeGreaterThan(0);
    expect(v1.rowCount).toBeGreaterThanOrEqual(12);
    expect(v1.body.toString("utf8")).toContain("Kode Akun");

    await expect(m11.saveExportTemplate(accountant(), { key: "journals-consultant", name: "Format baru", target: "journals", columns: [{ header: "Tgl", field: "journalDate" }], reason: "Format konsultan" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(m11.saveExportTemplate(finance(), { key: "journals-consultant", name: "Format baru", target: "journals", columns: [{ header: "PPN", field: "vat" }], reason: "Format konsultan" })).rejects.toThrow(/Kolom tidak dikenal/);
    const v2 = await m11.saveExportTemplate(finance(), {
      key: "journals-consultant",
      name: "Jurnal umum — format konsultan (revisi)",
      target: "journals",
      format: "csv",
      columns: [
        { header: "TGL", field: "journalDate" },
        { header: "NO_BUKTI", field: "number" },
        { header: "AKUN", field: "accountCode" },
        { header: "DEBET", field: "debit" },
        { header: "KREDIT", field: "credit" },
      ],
      reason: "Format disepakati konsultan pajak bulan 1",
    });
    expect(v2.version).toBe(2);
    const out = await m11.exportWithTemplate(accountant(), { templateKey: "journals-consultant", period: THIS_PERIOD });
    expect(out.filename).toBe(`journals-consultant-${THIS_PERIOD}.csv`);
    expect(out.body.toString("utf8")).toContain("NO_BUKTI");
    const ledger = await m11.saveExportTemplate(finance(), { key: "ledger-consultant", name: "Neraca saldo konsultan", target: "ledger", columns: [{ header: "Akun", field: "accountCode" }, { header: "Saldo D", field: "closingDebit" }], reason: "Format buku besar konsultan" });
    const lx = await m11.exportWithTemplate(owner(), { templateKey: ledger.key, period: THIS_PERIOD, format: "xlsx" });
    expect(lx.contentType).toContain("spreadsheet");
    const logs = await t.db.select().from(exportLogs).where(eq(exportLogs.reportKey, "m11.template.journals-consultant"));
    expect(logs.length).toBe(2);
  });

  it("US-M11-08 KP-4 pemantauan PKP: omzet 12 bulan berjalan vs PAR-22; peringatan 80% & 90% ke pemilik & Admin Keuangan (sekali per tingkat); proyeksi bulan tercapai", async () => {
    let st = await withTx((tx) => m11.pkpStatus(tx, EQUA_TENANT_ID, TODAY));
    expect(st).toMatchObject({ total: 600_000, threshold: 4_800_000_000, level: null, windowMonths: 12 });
    expect(st.months).toHaveLength(12);
    expect(await m11.runPkpMonitor(at(TODAY, "06:40"))).toBe(0);

    await params.set(owner(), "PAR-22", { threshold: 700_000, warn_percents: [80, 90], window_months: 12 }, TODAY, "Uji ambang PKP");
    st = await withTx((tx) => m11.pkpStatus(tx, EQUA_TENANT_ID, TODAY));
    expect(st).toMatchObject({ level: 80, avg3: 200_000, projectedPeriod: shiftMonth(THIS_PERIOD, 1) });
    expect(st.percent).toBeCloseTo(85.71, 1);
    expect(await m11.runPkpMonitor(at(TODAY, "06:40"))).toBe(1);
    expect(await m11.runPkpMonitor(at(TODAY, "06:41"))).toBe(0);
    const notes = await t.db.select().from(notifications).where(and(eq(notifications.event, "tax.pkp_threshold"), eq(notifications.tenantId, EQUA_TENANT_ID)));
    const recipients = new Set(notes.map((n) => n.recipientUserId));
    expect(recipients.has(owner().userId!)).toBe(true);
    expect(recipients.has(finance().userId!)).toBe(true);

    await params.set(owner(), "PAR-22", { threshold: 650_000, warn_percents: [80, 90], window_months: 12 }, TODAY, "Uji ambang PKP 90%");
    expect(await m11.runPkpMonitor(at(TODAY, "06:42"))).toBe(1);
    expect((await m11.taxOverview(owner())).pkp.level).toBe(90);
  });

  it("US-M11-08 KP-5 retensi pembukuan ≥ 10 tahun (PAR-29): jurnal tidak dapat dihapus", async () => {
    const ov = await m11.taxOverview(accountant());
    expect(ov.retentionYears).toBeGreaterThanOrEqual(10);
    const [j] = await t.db.select().from(journals).where(eq(journals.tenantId, EQUA_TENANT_ID)).limit(1);
    const err = await t.db
      .delete(journals)
      .where(eq(journals.id, j!.id))
      .catch((e: unknown) => e);
    expect(isHardeningViolation(err)).toBe(true);
  });
});
