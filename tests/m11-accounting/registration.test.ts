import { and, eq, like, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { fixedAssets, journals, recurringJournals } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import { seedDemoM11Accounting } from "@/db/seed/demo-m11-accounting";
import { monthOf, toBusinessDate } from "@/lib/time";
import { getApprovalHandlers } from "@/server/core/approvals";
import { withTx } from "@/server/core/db";
import { listHandlers } from "@/server/core/events";
import { exportReport, listReports } from "@/server/core/export";
import { listJobs, runJobNow } from "@/server/core/jobs";
import { PERMISSIONS } from "@/server/core/rbac/permissions";
import * as m11 from "@/server/modules/m11-accounting";
import { allNavItems } from "@/components/shared/nav/registry";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { THIS_PERIOD, accountant, finance, owner } from "./helpers";

describe("M11 — registrasi modul (event, persetujuan, job, laporan, izin, navigasi)", () => {
  useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M11-02 KP-1 handler jurnal otomatis terdaftar untuk SETIAP peristiwa 7.11.4 yang dijurnal", () => {
    for (const type of m11.JOURNALED_EVENTS) expect(listHandlers(type), type).toContain(`m11-accounting:journal:${type}`);
    expect(m11.JOURNALED_EVENTS.length).toBeGreaterThanOrEqual(30);
    // Setiap pasangan peristiwa/entri yang dipakai punya pemetaan wajib (US-M11-01 KP-2).
    const events = new Set(m11.REQUIRED_MAPPINGS.map((m) => m.event));
    for (const e of ["trip.completed", "deposit.received", "pos_sale.recorded", "water_supply.confirmed", "asset.depreciated", "m11.allocation", "m11.opening_balance"]) expect(events.has(e), e).toBe(true);
  });

  it("US-M11-03 KP-2 persetujuan jurnal manual, koreksi jurnal, kunci periode, penyesuaian saldo awal terdaftar", () => {
    expect(getApprovalHandlers("manual_journal", "journal")?.onApproved).toBeTypeOf("function");
    expect(getApprovalHandlers("manual_journal", "journal")?.onRejected).toBeTypeOf("function");
    expect(getApprovalHandlers("correction", "journal")?.onApproved).toBeTypeOf("function");
    expect(getApprovalHandlers("period_lock", "accounting_period")?.onApproved).toBeTypeOf("function");
    expect(getApprovalHandlers("opening_balance_adjustment", "opening_adjustment_journal")?.onApproved).toBeTypeOf("function");
  });

  it("US-M11-05 KP-2 job M11 terdaftar & berjalan (penyusutan, akrual, jurnal berulang, PKP, pengingat periode & utang, antrean)", async () => {
    const keys = listJobs().map((j) => j.key);
    const mine = ["m11.depreciation.monthly", "m11.accrual.reverse", "m11.recurring.drafts", "m11.pkp.monitor", "m11.period.reminders", "m11.payable.reminders", "m11.queue.retry"];
    expect(keys).toEqual(expect.arrayContaining(mine));
    for (const k of mine) {
      const r = await runJobNow(k, new Date());
      expect(r.status, `${k}: ${r.error ?? ""}`).toBe("succeeded");
    }
  });

  it("US-M11-04 KP-4 setiap laporan M11 dapat diekspor Excel & PDF oleh pemilik/Admin Keuangan/akuntan", async () => {
    const reports = listReports().filter((r) => r.key.startsWith("m11."));
    expect(reports.map((r) => r.key).sort()).toEqual(
      [
        "m11.accounts",
        "m11.assets",
        "m11.balance_sheet",
        "m11.bank_reconciliations",
        "m11.cash_flow",
        "m11.cash_reconciliations",
        "m11.daily_reconciliation",
        "m11.it_costs",
        "m11.journal_queue",
        "m11.journals",
        "m11.ledger",
        "m11.mappings",
        "m11.opening_balances",
        "m11.payables",
        "m11.periods",
        "m11.profit_loss",
        "m11.revenue_tax",
        "m11.trial_balance",
      ].sort(),
    );
    for (const r of reports.filter((x) => x.key !== "m11.ledger")) {
      const x = await exportReport(accountant(), r.key, "xlsx", {});
      expect(x.body.length, r.key).toBeGreaterThan(0);
      const p = await exportReport(owner(), r.key, "pdf", {});
      expect(p.contentType, r.key).toContain("pdf");
    }
  });

  it("US-M11-02 KP-5 akuntan baca-saja: semua izin baca M11, tanpa izin tulis; navigasi Akuntansi memakai izin baca", () => {
    const m11Perms = PERMISSIONS.filter((p) => p.key.startsWith("m11."));
    const readKeys = m11Perms.filter((p) => p.key.endsWith(".read")).map((p) => p.key);
    for (const k of readKeys) expect(m11Perms.find((p) => p.key === k)!.roles, k).toContain("accountant");
    const writesForAccountant = m11Perms.filter((p) => p.roles.includes("accountant") && !/\.(read|export)$/.test(p.key)).map((p) => p.key);
    expect(writesForAccountant.sort()).toEqual(["m11.opening_balance.attest", "m11.period.review_note", "m11.retroactive.attest"].sort());
    const nav = allNavItems().filter((i) => i.href.startsWith("/akuntansi"));
    expect(nav.length).toBeGreaterThanOrEqual(8);
    for (const i of nav) expect(i.permission, i.href).toMatch(/^m11\./);
  });
});

describe("seed demo M11 (Akuntansi & Pajak)", () => {
  const t = useTestDb({ seed: true });
  const now = new Date();
  beforeAll(async () => {
    bootstrapForTests();
    await seedDemoM11Accounting(t.db, now, { force: true });
  });

  it("US-M11-01 KP-2 seed melengkapi pemetaan wajib 7.11.4 (M11 dapat diaktifkan) + jurnal/aset/jurnal berulang demo; idempoten", async () => {
    const comp = await withTx((tx) => m11.mappingCompleteness(tx, EQUA_TENANT_ID, toBusinessDate(now)));
    expect(comp.missing).toEqual([]);
    expect(comp.inactive).toEqual([]);
    const count = async () => ({
      journals: Number((await t.db.select({ n: sql<number>`count(*)` }).from(journals).where(like(journals.number, "JD-%")))[0]!.n),
      assets: Number((await t.db.select({ n: sql<number>`count(*)` }).from(fixedAssets))[0]!.n),
      recurring: Number((await t.db.select({ n: sql<number>`count(*)` }).from(recurringJournals))[0]!.n),
    });
    const before = await count();
    expect(before.journals).toBeGreaterThanOrEqual(8);
    expect(before.assets).toBe(2);
    expect(before.recurring).toBe(1);
    expect((await seedDemoM11Accounting(t.db, now, { force: true })).journals).toBe(0);
    expect(await count()).toEqual(before);
  });

  it("US-M11-04 KP-1 laporan demo periode berjalan seimbang (neraca saldo & neraca) dengan pendapatan per lini", async () => {
    const s = await m11.getStatements(finance(), { period: monthOf(toBusinessDate(now)) });
    expect(s.trialBalance.balanced).toBe(true);
    expect(s.profitLoss.centers.L2.revenue).toBeGreaterThan(0);
    expect(s.profitLoss.centers.L3.revenue).toBeGreaterThan(0);
    expect(s.profitLoss.centers.L4.revenue).toBeGreaterThan(0);
    const review = await t.db.select().from(journals).where(and(eq(journals.requiresOwnerReview, true), like(journals.number, "JD-%")));
    expect(review.length).toBeGreaterThan(0);
    expect(THIS_PERIOD).toBe(monthOf(toBusinessDate(now)));
  });
});
