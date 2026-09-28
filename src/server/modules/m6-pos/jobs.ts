/**
 * M6 — pekerjaan terjadwal (`/api/cron/tick`, idempoten per slot):
 * - `m6.stock_count.weekly_check` Minggu 20.00 — opname minggu berjalan belum dilakukan → Admin Keuangan (PAR-32).
 * - `m6.water_balance.weekly` Senin 06.15 — neraca air minggu lalu > PAR-59 → pemilik (US-M6-05 KP-4).
 * - `m6.water_balance.monthly` tanggal 1 06.20 — neraca air bulan lalu > PAR-59 → pemilik.
 * - `m6.deposit.late_check` harian 08.10 — setoran shift belum diterima > PAR-27 hari → Admin Keuangan.
 * Persetujuan void lewat tenggat ditangani job inti `core.approvals.expire_due` (handler `onExpired`).
 */
import "server-only";

import { registerJob } from "@/server/core/jobs";

import { runLateDepositCheck, runStockCountCheck } from "./service/jobs-logic";
import { runWaterBalanceCheck } from "./service/water";

export function registerJobs(): void {
  registerJob({
    key: "m6.stock_count.weekly_check",
    description: "Tandai depot yang belum opname mingguan (BR-27, PAR-32) ke Admin Keuangan.",
    schedule: { kind: "weekly", isoWeekday: 7, at: "20:00" },
    run: ({ now, db }) => runStockCountCheck(now, db),
  });
  registerJob({
    key: "m6.water_balance.weekly",
    description: "Neraca air outlet minggu lalu: galon terjual vs air tersedia > PAR-59 → pemilik.",
    schedule: { kind: "weekly", isoWeekday: 1, at: "06:15" },
    run: ({ now, db }) => runWaterBalanceCheck(now, "week", db),
  });
  registerJob({
    key: "m6.water_balance.monthly",
    description: "Neraca air outlet bulan lalu > PAR-59 → pemilik.",
    schedule: { kind: "monthly", day: 1, at: "06:20" },
    run: ({ now, db }) => runWaterBalanceCheck(now, "month", db),
  });
  registerJob({
    key: "m6.deposit.late_check",
    description: "Setoran shift depot/toko belum diterima > PAR-27 hari → Admin Keuangan.",
    schedule: { kind: "daily", at: "08:10" },
    run: ({ now, db }) => runLateDepositCheck(now, db),
  });
}
