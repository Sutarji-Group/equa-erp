/**
 * M4 — pekerjaan terjadwal (`/api/cron/tick`, idempoten per slot).
 *
 * - `m4.transfer.not_found_check` (harian 06.50): transfer Belum dicocokkan > PAR-39 hari → Tidak ditemukan +
 *   notifikasi pemilik & Admin Keuangan + `transfer.not_found` (US-M4-04 KP-4).
 * - `m4.transfer.slip_sweep` (tiap 5 menit): setoran setor bank dengan slip tanpa transfer tercatat → dicatat
 *   (serah setoran akhir shift lewat slip di M6 tidak memancarkan event).
 * - `m4.deposit.not_submitted_check` (tiap 5 menit): setoran sopir belum Diajukan > PAR-44 jam setelah rit terakhir
 *   Selesai → `deposit.not_submitted` ke Admin Keuangan (sekali per setoran; US-M4-01 KP-4).
 * - `m4.cash_close_exception.due_check` (tiap 5 menit): setoran tertunda (PTB-21) belum diterima lewat N jam setelah tutup
 *   kas → Selisih + notifikasi (US-M4-06 KP-2).
 * Keterlambatan setoran depot (PAR-27) dimiliki M6 (`m6.deposit.late_check`, D-09 butir 4) — M4 hanya menyorotnya.
 */
import "server-only";

import { registerJob } from "@/server/core/jobs";

import { runPendingDepositDueCheck } from "./service/cash-day";
import { runDriverNotSubmittedCheck } from "./service/events-logic";
import { runTransferNotFoundCheck, sweepSlipDeposits } from "./service/transfers";

export function registerJobs(): void {
  registerJob({
    key: "m4.transfer.not_found_check",
    description: "Transfer tanpa mutasi > PAR-39 hari → Tidak ditemukan (US-M4-04 KP-4)",
    schedule: { kind: "daily", at: "06:50" },
    run: ({ now, db }) => runTransferNotFoundCheck(now, { db }),
  });
  registerJob({
    key: "m4.transfer.slip_sweep",
    description: "Setoran setor bank dengan slip → transfer masuk untuk dicocokkan (PTB-23)",
    schedule: { kind: "every_5_min" },
    run: ({ now, db }) => sweepSlipDeposits(now, { db }),
  });
  registerJob({
    key: "m4.deposit.not_submitted_check",
    description: "Setoran sopir belum diajukan > PAR-44 jam setelah rit terakhir Selesai (US-M4-01 KP-4)",
    schedule: { kind: "every_5_min" },
    run: ({ now, db }) => runDriverNotSubmittedCheck(now, { db }),
  });
  registerJob({
    key: "m4.cash_close_exception.due_check",
    description: "Setoran tertunda lewat batas setelah tutup kas → selisih (PTB-21, US-M4-06 KP-2)",
    schedule: { kind: "every_5_min" },
    run: ({ now, db }) => runPendingDepositDueCheck(now, { db }),
  });
}
