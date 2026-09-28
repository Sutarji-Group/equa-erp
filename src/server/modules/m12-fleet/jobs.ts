/**
 * M12 — pekerjaan terjadwal (`/api/cron/tick`, idempoten per slot; setiap kejadian idempoten per `dedupe_key`):
 * - `m12.devices.health` (tiap 5 menit): perangkat GPS tanpa posisi > PAR-25 menit pada jam layanan → Mati + peringatan
 *   tim IT & Dispatcher + insiden + GPS ponsel cadangan; gangguan vendor sistemik → tim IT saja (US-M12-08, 7.12.6).
 * - `m12.detection.travel` (tiap 5 menit): perjalanan di luar jadwal/jam & berhenti tidak dikenal (US-M12-05); konsistensi
 *   sumber lokasi rit Selesai beberapa jam terakhir (US-M12-04 KP-2, posisi perangkat dapat tiba terlambat).
 * - `m12.geofence.visits` (tiap 5 menit): masuk/keluar geofence, pengisian/pasokan tanpa geofence (US-M12-06).
 * - `m12.summaries.daily` (00.40): jejak rit & ringkasan truk per hari kemarin (+ 2 hari tertinggal), estimasi BBM
 *   (US-M12-03, US-M12-07 KP-1).
 * - `m12.gps.retention` (02.20): ringkasan dipastikan ada lalu posisi mentah > PAR-52 bulan dihapus lewat
 *   `withRetentionPurge` (US-M12-01 KP-6; job M10 `m10.retention.daily` 02.30 tetap sebagai cadangan idempoten).
 * - `m12.zone_check.monthly` (tanggal 1, 07.10): alamat yang jarak GPS aktualnya masuk zona lain → pemilik (US-M12-07 KP-2).
 */
import "server-only";

import { registerJob } from "@/server/core/jobs";

import { withTx } from "@/server/core/db";

import { recheckRecentCompletions } from "./service/completion";
import { tenantsWithTrucks } from "./service/common";
import { runTravelDetection } from "./service/detection";
import { runDeviceHealthCheck } from "./service/devices";
import { runZoneCheckMonthly } from "./service/fuel";
import { runGeofenceProcessing } from "./service/geofence";
import { purgeExpiredPositions, runDailySummaries } from "./service/history";

export function registerJobs(): void {
  registerJob({
    key: "m12.devices.health",
    description: "Perangkat GPS tanpa posisi > PAR-25 menit pada jam layanan → Mati, peringatan tim IT & Dispatcher, GPS ponsel cadangan (US-M12-08).",
    schedule: { kind: "every_5_min" },
    run: ({ now, db }) => runDeviceHealthCheck(now, db),
  });
  registerJob({
    key: "m12.detection.travel",
    description: "Perjalanan di luar jadwal/jam & berhenti tidak dikenal (US-M12-05); konsistensi sumber lokasi Selesai (US-M12-04 KP-2).",
    schedule: { kind: "every_5_min" },
    run: async ({ now, db }) => {
      const travel = await runTravelDetection(now, db);
      const recheck = await withTx(
        async (tx) => {
          let flagged = 0;
          for (const tenantId of await tenantsWithTrucks(tx)) flagged += await recheckRecentCompletions(tx, tenantId, now);
          return flagged;
        },
        { db },
      );
      return { trucks: travel.length, created: travel.reduce((s, r) => s + r.created, 0), inconsistent: recheck };
    },
  });
  registerJob({
    key: "m12.geofence.visits",
    description: "Masuk/keluar geofence sumber, depot, pool; pengisian/pasokan tanpa geofence (US-M12-06).",
    schedule: { kind: "every_5_min" },
    run: ({ now, db }) => runGeofenceProcessing(now, db),
  });
  registerJob({
    key: "m12.summaries.daily",
    description: "Jejak rit & ringkasan truk per hari kemarin, estimasi biaya BBM (US-M12-03, US-M12-07).",
    schedule: { kind: "daily", at: "00:40" },
    run: ({ now, db }) => runDailySummaries(now, db),
  });
  registerJob({
    key: "m12.gps.retention",
    description: "Ringkasan per rit/hari dipastikan lalu posisi GPS mentah > PAR-52 bulan dihapus (US-M12-01 KP-6).",
    schedule: { kind: "daily", at: "02:20" },
    run: ({ now, db }) => purgeExpiredPositions(now, db),
  });
  registerJob({
    key: "m12.zone_check.monthly",
    description: "Pemeriksaan zona: jarak GPS aktual alamat masuk zona lain → daftar ke pemilik (US-M12-07 KP-2).",
    schedule: { kind: "monthly", day: 1, at: "07:10" },
    run: ({ now, db }) => runZoneCheckMonthly(now, db),
  });
}
