import { beforeAll, describe, expect, it } from "vitest";

import { getApprovalHandlers } from "@/server/core/approvals";
import { listHandlers } from "@/server/core/events";
import { listReports } from "@/server/core/export";
import { listJobs, runJobNow } from "@/server/core/jobs";
import { listPullProviders } from "@/server/core/sync";
import { allNavItems } from "@/components/shared/nav/registry";
import * as m9 from "@/server/modules/m9-reports";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";

describe("M9 — registrasi modul (event, persetujuan, job, laporan, navigasi)", () => {
  useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M9-01 KP-2 US-M9-01 KP-6 US-M9-02 KP-2 handler event: cash_day.closed → terbit H+0; transaksi terlambat/koreksi → addendum; period.locked → Final", () => {
    expect(listHandlers("cash_day.closed")).toContain("m9-reports:publish_h0");
    expect(listHandlers("period.locked")).toContain("m9-reports:monthly_final");
    for (const type of m9.ADDENDUM_EVENT_TYPES) expect(listHandlers(type), type).toContain(`m9-reports:addenda:${type}`);
    expect(m9.ADDENDUM_EVENT_TYPES).toEqual(expect.arrayContaining(["trip.completed", "pos_sale.recorded", "pos_sale.voided", "credit_note.issued"]));
  });

  it("US-M9-07 KP-2 persetujuan paper_withdrawal_early punya handler setujui/tolak/kedaluwarsa/batal", async () => {
    const h = getApprovalHandlers("paper_withdrawal_early")!;
    expect(h.onApproved).toBeTypeOf("function");
    expect(h.onRejected).toBeTypeOf("function");
    expect(h.onExpired).toBeTypeOf("function");
    expect(h.onCancelled).toBeTypeOf("function");
    // Kedaluwarsa → nota kertas ditarik pada hari ke-14 lewat jalur biasa (tanpa perubahan data).
    const res = await h.onExpired!({} as never);
    expect(res).toMatchObject({ note: expect.stringMatching(/hari ke-14/) });
  });

  it("US-M9-01 KP-2 US-M9-02 KP-2 job cadangan terbit H+0 & versi Final bulanan terdaftar dan berjalan idempoten", async () => {
    const jobs = listJobs().map((j) => j.key);
    expect(jobs).toEqual(expect.arrayContaining(["m9.h0.publish_pending", "m9.monthly.finalize"]));
    for (const key of ["m9.h0.publish_pending", "m9.monthly.finalize"]) {
      const r1 = await runJobNow(key, new Date());
      expect(r1.status, `${key}: ${r1.error ?? ""}`).toBe("succeeded");
      const r2 = await runJobNow(key, new Date());
      expect(["succeeded", "skipped"]).toContain(r2.status);
    }
  });

  it("US-M9-03 KP-1 laporan M9 terdaftar di mekanisme ekspor inti; M9 tanpa aksi lapangan (web kantor daring)", () => {
    const keys = listReports().filter((r) => r.module === "m9").map((r) => r.key).sort();
    expect(keys).toEqual(
      [
        "m9.daily_summaries",
        "m9.daily_summary",
        "m9.gross_revenue_pkp",
        "m9.kpi",
        "m9.monthly_gross_profit",
        "m9.parallel_run_checks",
        "m9.performance_drivers",
        "m9.performance_outlets",
        "m9.trend_monthly",
        "m9.trend_weekly",
        "m9.trip_realization",
        "m9.water_cost_per_liter",
      ].sort(),
    );
    expect(listPullProviders().filter(([k]) => k.startsWith("m9."))).toEqual([]);
    const nav = allNavItems().filter((n) => n.href.startsWith("/laporan") || n.href === "/kotak-masuk");
    expect(nav.map((n) => n.href)).toEqual(expect.arrayContaining(["/laporan/hari-ini", "/laporan/bulanan", "/laporan/katalog", "/laporan/kinerja", "/laporan/tren", "/laporan/kpi", "/laporan/periode-paralel", "/kotak-masuk"]));
  });
});
