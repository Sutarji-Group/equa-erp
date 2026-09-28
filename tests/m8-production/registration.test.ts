import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { allNavItems } from "@/components/shared/nav/registry";
import { isFieldPath } from "@/lib/field-routes";
import { toBusinessDate } from "@/lib/time";
import { ForbiddenError } from "@/server/core/errors";
import { exportReport, listReports } from "@/server/core/export";
import { listJobs } from "@/server/core/jobs";
import { listPullProviders, listSyncHandlerTypes } from "@/server/core/sync";

import { M8_COMMANDS, M8_REFS } from "@/client/m8-production/contract";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { dispatcher, finance, owner } from "./helpers";

const M8_REPORTS = [
  "m8.daily_production",
  "m8.depot_supply",
  "m8.depot_supply_summary",
  "m8.fills_vs_schedule",
  "m8.meter_readings",
  "m8.quality_tests",
  "m8.truck_fills",
  "m8.utilization_daily",
  "m8.utilization_monthly",
  "m8.water_balance_daily",
  "m8.water_balance_monthly",
];

describe("M8 registrasi modul (sinkron, pull, job, laporan, menu)", () => {
  useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M8-07 KP-1 semua aksi lapangan operator produksi terdaftar sebagai perintah sinkron offline + penyedia pull m8.today", () => {
    const types = listSyncHandlerTypes();
    for (const type of Object.values(M8_COMMANDS)) expect(types).toContain(type);
    const providers = new Map(listPullProviders());
    expect(providers.get(M8_REFS.today)?.roles).toEqual(["production_operator"]);
  });

  it("US-M8-01 KP-3 pemeriksaan pembacaan pagi/malam terjadwal pada jam batas parameter; US-M8-06 KP-1 pengingat uji mutu harian", () => {
    const jobs = new Map(listJobs().map((j) => [j.key, j]));
    expect(jobs.get("m8.meter.morning_check")?.schedule).toMatchObject({ kind: "daily", atParam: { key: "m8.production_rules", field: "morning_deadline" } });
    expect(jobs.get("m8.meter.evening_check")?.schedule).toMatchObject({ kind: "daily", atParam: { key: "m8.production_rules", field: "evening_deadline" } });
    expect(jobs.has("m8.quality.reminder")).toBe(true);
  });

  it("US-M8-04 KP-4 setiap daftar/laporan M8 dapat diekspor Excel/PDF sesuai izin; peran lain ditolak", async () => {
    const keys = listReports()
      .map((r) => r.key)
      .filter((k) => k.startsWith("m8."))
      .sort();
    expect(keys).toEqual(M8_REPORTS);
    const today = toBusinessDate(new Date());
    for (const key of keys) {
      const filters = key.endsWith("_monthly") ? { month: today.slice(0, 7) } : key === "m8.fills_vs_schedule" ? { date: today } : key === "m8.utilization_daily" ? {} : { from: today, to: today };
      const x = await exportReport(owner(), key, "xlsx", filters);
      expect(x.body.length, key).toBeGreaterThan(0);
    }
    const pdf = await exportReport(finance(), "m8.water_balance_daily", "pdf", { from: today, to: today });
    expect(pdf.contentType).toBe("application/pdf");
    await expect(exportReport(dispatcher(), "m8.water_balance_daily", "xlsx", {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(exportReport(seededContext("kasir"), "m8.truck_fills", "xlsx", {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("US-M8-04 KP-4 menu kantor M8 berfungsi: setiap entri navigasi punya halaman, izin, dan rute kantor (bukan rute aplikasi lapangan)", () => {
    const items = allNavItems().filter((i) => i.id.startsWith("m8."));
    expect(items.map((i) => i.href).sort()).toEqual(
      ["/produksi/kelola-meter", "/produksi/mutu", "/produksi/neraca-air", "/produksi/neraca-air/rincian", "/produksi/pengisian", "/produksi/utilisasi"].sort(),
    );
    for (const item of items) {
      expect(item.permission, item.href).not.toBeNull();
      expect(existsSync(resolve(__dirname, `../../src/app/(office)${item.href}/page.tsx`)), item.href).toBe(true);
      expect(isFieldPath(item.href), item.href).toBe(false);
    }
    // Aplikasi operator produksi tetap di /produksi (PWA lapangan).
    expect(isFieldPath("/produksi")).toBe(true);
    expect(existsSync(resolve(__dirname, "../../src/app/(field)/produksi/page.tsx"))).toBe(true);
  });
});
