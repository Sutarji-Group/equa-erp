/**
 * M11 — pekerjaan terjadwal (`/api/cron/tick`, idempoten per slot):
 * - `m11.depreciation.monthly` (tanggal 1, 01.30): penyusutan bulan lalu diposting otomatis (US-M11-05 KP-2).
 * - `m11.accrual.reverse` (harian 00.30): jurnal akrual dibalik otomatis tanggal 1 periode berikutnya (US-M11-03 KP-6).
 * - `m11.recurring.drafts` (harian 06.00): draf jurnal berulang bulan berjalan (idempoten per bulan; US-M11-03 KP-4).
 * - `m11.pkp.monitor` (harian 06.40): peringatan batas PKP 80%/90% (US-M11-08 KP-4).
 * - `m11.period.reminders` (harian 07.15): pengingat tutup periode PAR-71 & terlambat PAR-23 (US-M11-10 KP-2).
 * - `m11.payable.reminders` (harian 07.20): utang jurnal manual jatuh tempo (US-M11-07 KP-3).
 * - `m11.queue.retry` (harian 05.00): proses ulang daftar tunggu jurnal (setelah pemetaan dilengkapi).
 */
import "server-only";

import { journalQueue } from "@/db/schema";
import { toBusinessDate } from "@/lib/time";

import { registerJob } from "@/server/core/jobs";

import { runMonthlyDepreciation } from "./service/assets";
import { inJobTx } from "./service/common";
import { runAccrualReversals, runRecurringDrafts } from "./service/manual";
import { runJournalPayableReminders } from "./service/payables";
import { runPeriodReminders } from "./service/periods";
import { retryPendingQueue } from "./service/queue";
import { runPkpMonitor } from "./service/tax";

export function registerJobs(): void {
  registerJob({
    key: "m11.depreciation.monthly",
    description: "Penyusutan aset tetap bulan lalu diposting otomatis (US-M11-05 KP-2)",
    schedule: { kind: "monthly", day: 1, at: "01:30" },
    run: ({ now, db }) => runMonthlyDepreciation(now, { db }),
  });
  registerJob({
    key: "m11.accrual.reverse",
    description: "Jurnal akrual dibalik otomatis tanggal 1 periode berikutnya (US-M11-03 KP-6)",
    schedule: { kind: "daily", at: "00:30" },
    run: ({ now, db }) => runAccrualReversals(now, { db }),
  });
  registerJob({
    key: "m11.recurring.drafts",
    description: "Draf jurnal berulang bulanan (US-M11-03 KP-4)",
    schedule: { kind: "daily", at: "06:00" },
    run: ({ now, db }) => runRecurringDrafts(now, { db }),
  });
  registerJob({
    key: "m11.pkp.monitor",
    description: "Pemantauan batas PKP 12 bulan berjalan (US-M11-08 KP-4, BR-29)",
    schedule: { kind: "daily", at: "06:40" },
    run: ({ now, db }) => runPkpMonitor(now, { db }),
  });
  registerJob({
    key: "m11.period.reminders",
    description: "Pengingat tutup periode tanggal 5 & 8, terlambat setelah tanggal 10 (US-M11-10 KP-2)",
    schedule: { kind: "daily", at: "07:15" },
    run: ({ now, db }) => runPeriodReminders(now, { db }),
  });
  registerJob({
    key: "m11.payable.reminders",
    description: "Pengingat utang jurnal manual jatuh tempo (US-M11-07 KP-3)",
    schedule: { kind: "daily", at: "07:20" },
    run: ({ now, db }) => runJournalPayableReminders(now, { db }),
  });
  registerJob({
    key: "m11.queue.retry",
    description: "Proses ulang daftar tunggu jurnal otomatis (US-M11-02 KP-3)",
    schedule: { kind: "daily", at: "05:00" },
    run: async ({ now, db }) => {
      const run = async (tx: Parameters<typeof retryPendingQueue>[0]) => {
        const tenants = await tx.selectDistinct({ tenantId: journalQueue.tenantId }).from(journalQueue);
        let posted = 0;
        for (const { tenantId } of tenants) posted += (await retryPendingQueue(tx, tenantId, { today: toBusinessDate(now) })).posted;
        return posted;
      };
      return inJobTx(db, run);
    },
  });
}
