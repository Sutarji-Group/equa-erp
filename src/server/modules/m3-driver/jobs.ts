/**
 * M3 — pekerjaan terjadwal (`/api/cron/tick`, idempoten per slot):
 * - `m3.deposit.reminder` pada PAR-06 (22.00) — setoran sopir yang bekerja hari ini belum Diajukan → pengingat ke sopir
 *   (aplikasi) + Admin Keuangan (US-M3-07 KP-5). Setoran tetap dapat diajukan setelahnya dengan penanda terlambat.
 * - `m3.travel_explanation.missing` pada PAR-06 (tutup kas) — tugas keterangan perjalanan BR-25 yang belum diisi →
 *   pemilik (6.3).
 * Permintaan tunai → tempo lewat tenggat ditangani job inti `core.approvals.expire_due` (handler `onExpired`).
 */
import "server-only";

import { registerJob } from "@/server/core/jobs";

import { runDepositReminder, runTravelExplanationCheck } from "./service/jobs-logic";

export function registerJobs(): void {
  registerJob({
    key: "m3.deposit.reminder",
    description: "Setoran sopir belum diajukan pada PAR-06 → pengingat sopir + Admin Keuangan (US-M3-07 KP-5).",
    schedule: { kind: "daily", atParam: { key: "PAR-06", field: "time" } },
    run: ({ now, db }) => runDepositReminder(now, db),
  });
  registerJob({
    key: "m3.travel_explanation.missing",
    description: "Keterangan perjalanan (BR-25) belum diisi saat tutup kas → pemilik.",
    schedule: { kind: "daily", atParam: { key: "PAR-06", field: "time" } },
    run: ({ now, db }) => runTravelExplanationCheck(now, db),
  });
}
