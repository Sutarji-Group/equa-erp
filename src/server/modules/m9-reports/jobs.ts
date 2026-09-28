/**
 * M9 — pekerjaan terjadwal (`/api/cron/tick`, idempoten per slot).
 * - `m9.h0.publish_pending` (5 menit): cadangan terbit H+0 untuk hari kas tertutup yang belum terbit (NFR-04; penanda
 *   terlambat bila > batas `m9.report_rules.h0_publish_minutes`).
 * - `m9.monthly.finalize` (harian 06.30): periode akuntansi Dikunci tanpa versi Final laporan bulanan → simpan versi Final
 *   (cadangan handler `period.locked`, US-M9-02 KP-2).
 */
import "server-only";

import { registerJob } from "@/server/core/jobs";

import { publishPendingSummaries } from "./service/h0";
import { finalizeLockedPeriods } from "./service/monthly";

export function registerJobs(): void {
  registerJob({
    key: "m9.h0.publish_pending",
    description: "Terbitkan ringkasan H+0 untuk hari kas yang sudah ditutup tetapi belum terbit (cadangan, NFR-04)",
    schedule: { kind: "every_5_min" },
    run: async ({ now, db }) => publishPendingSummaries(now, db),
  });
  registerJob({
    key: "m9.monthly.finalize",
    description: "Simpan versi Final laporan laba kotor bulanan untuk periode yang sudah Dikunci (BR-32)",
    schedule: { kind: "daily", at: "06:30" },
    run: async ({ now, db }) => finalizeLockedPeriods(now, db),
  });
}
