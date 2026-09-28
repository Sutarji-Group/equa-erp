import { existsSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { NAV_GROUPS } from "@/components/shared/nav/registry";
import { toBusinessDate } from "@/lib/time";
import { listHandlers } from "@/server/core/events";
import { exportReport, listReports } from "@/server/core/export";
import { listJobs, runJobNow } from "@/server/core/jobs";
import { can } from "@/server/core/rbac";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";

const M12_JOBS = ["m12.devices.health", "m12.detection.travel", "m12.geofence.visits", "m12.summaries.daily", "m12.gps.retention", "m12.zone_check.monthly"];
const M12_REPORTS = [
  "m12.device_outages",
  "m12.fleet_events",
  "m12.fuel_monthly",
  "m12.fuel_trucks",
  "m12.fuel_zones",
  "m12.gps_devices",
  "m12.location_patterns",
  "m12.stops",
  "m12.trips",
  "m12.truck_days",
  "m12.zone_check",
];

describe("M12 — registrasi modul (event, job, laporan, navigasi)", () => {
  useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M12-01 KP-4 US-M12-04 KP-1 US-M12-06 KP-2 US-M12-05 KP-4 handler event M12 terdaftar (titik status, Selesai, pengisian, tutup kas)", () => {
    expect(listHandlers("trip.departed")).toContain("m12-fleet:trip_status_point");
    expect(listHandlers("trip.arrived")).toContain("m12-fleet:trip_status_point");
    expect(listHandlers("trip.failed")).toContain("m12-fleet:trip_status_point");
    expect(listHandlers("trip.completed")).toContain("m12-fleet:trip_completed");
    expect(listHandlers("truck_fill.recorded")).toContain("m12-fleet:fill_geofence");
    expect(listHandlers("cash_day.closed")).toContain("m12-fleet:unexplained_at_cash_close");
  });

  it("US-M12-05 KP-1 US-M12-08 KP-1 job M12 terdaftar (tiap 5 menit / harian / bulanan) dan berjalan idempoten", async () => {
    const keys = listJobs().map((j) => j.key);
    expect(keys).toEqual(expect.arrayContaining(M12_JOBS));
    const now = new Date();
    for (const key of M12_JOBS) {
      const first = await runJobNow(key, now);
      expect(first.status, `${key}: ${first.error ?? ""}`).toBe("succeeded");
      const again = await runJobNow(key, now);
      expect(again.status).toBe("skipped");
    }
  });

  it("US-M12-03 KP-3 laporan M12 dapat diekspor Excel & PDF oleh pemilik (posisi mentah tidak diekspor)", async () => {
    expect(
      listReports()
        .filter((r) => r.key.startsWith("m12."))
        .map((r) => r.key)
        .sort(),
    ).toEqual(M12_REPORTS);
    const owner = seededContext("pemilik");
    const today = toBusinessDate(new Date());
    for (const key of M12_REPORTS) {
      const filters = key.startsWith("m12.fuel_") ? { month: today.slice(0, 7) } : {};
      // Laporan pemeriksaan zona memuat alamat (data pribadi, BR-39) → tujuan ekspor wajib.
      const xlsx = await exportReport(owner, key, "xlsx", filters, "Uji ekspor laporan armada");
      expect(xlsx.contentType, key).toContain("spreadsheet");
      const pdf = await exportReport(owner, key, "pdf", filters, "Uji ekspor laporan armada");
      expect(pdf.contentType, key).toContain("pdf");
    }
  });

  it("US-M12-02 KP-4 navigasi Armada: setiap menu punya halaman dan izin; sopir/kernet tidak melihat menu armada", () => {
    const group = NAV_GROUPS.find((g) => g.id === "m12")!;
    expect(group.items.map((i) => i.href)).toEqual(["/armada/peta", "/armada/riwayat", "/armada/kejadian", "/armada/perangkat", "/armada/bbm"]);
    for (const item of group.items) {
      const file = path.join(process.cwd(), "src/app/(office)", item.href, "page.tsx");
      expect(existsSync(file), `${item.href} → ${file}`).toBe(true);
    }
    for (const role of ["sopir1", "kernet1", "depot01", "kasir"]) {
      const ctx = seededContext(role);
      expect(group.items.filter((i) => typeof i.permission === "string" && can(ctx, i.permission)).map((i) => i.href), role).toEqual([]);
    }
    const dispatcher = seededContext("dispatcher1");
    expect(group.items.filter((i) => typeof i.permission === "string" && can(dispatcher, i.permission)).map((i) => i.href)).toEqual(["/armada/peta", "/armada/riwayat", "/armada/kejadian", "/armada/perangkat"]);
  });
});
