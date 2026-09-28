/**
 * M10 — pekerjaan terjadwal (`/api/cron/tick`, idempoten per slot; waktu WIB).
 *
 * | Kunci                       | Jadwal        | Isi                                                                   |
 * |-----------------------------|---------------|-----------------------------------------------------------------------|
 * | m10.users.exit_date         | harian 00.10  | nonaktifkan akun yang tanggal keluar karyawannya tiba (BR-37)         |
 * | m10.monitor.health          | tiap 5 menit  | sinkron gagal massal, layanan tidak dapat diakses, GPS mati → insiden |
 * | m10.support.unanswered      | harian 08.00  | laporan lapangan belum dijawab > PAR-87 → admin sistem                |
 * | m10.access.daily_summary    | harian 22.15  | ringkasan perubahan akses → pemilik (sebelum e-mail PAR-55)           |
 * | m10.access_review.reminder  | bulanan tgl 1 | bulan terakhir kuartal: tinjauan akses belum dilakukan → pemilik      |
 * | m10.retention.daily         | harian 02.30  | retensi PAR-29/PAR-52: log akses & GPS mentah dihapus, foto diarsip   |
 * | m10.anonymization.deferred  | harian 07.00  | permintaan ditunda yang piutangnya lunas → admin sistem ajukan ulang  |
 */
import "server-only";

import { registerJob } from "@/server/core/jobs";

import { dailyAccessSummary, remindAccessReview } from "./service/access-review";
import { remindDeferredAnonymizations } from "./service/anonymization";
import { runExitDateSweep } from "./service/exits";
import { MONITOR_JOB_KEY, runMonitoring } from "./service/monitoring";
import { runRetention } from "./service/retention";
import { remindUnansweredTickets } from "./service/support";

export function registerJobs(): void {
  registerJob({
    key: "m10.users.exit_date",
    description: "Nonaktifkan akun karyawan yang tanggal keluarnya tiba (BR-37).",
    schedule: { kind: "daily", at: "00:10" },
    run: ({ now, db }) => runExitDateSweep(now, db),
  });
  registerJob({
    key: MONITOR_JOB_KEY,
    description: "Pemantauan: sinkron gagal massal, layanan tidak dapat diakses, perangkat GPS mati (NFR-28).",
    schedule: { kind: "every_5_min" },
    run: ({ now, db }) => runMonitoring(now, db),
  });
  registerJob({
    key: "m10.support.unanswered",
    description: "Laporan lapangan belum dijawab melewati PAR-87 → admin sistem.",
    schedule: { kind: "daily", at: "08:00" },
    run: ({ now, db }) => remindUnansweredTickets(now, db),
  });
  registerJob({
    key: "m10.access.daily_summary",
    description: "Ringkasan perubahan pengguna/peran/lingkup/perangkat hari ini ke pemilik (US-M10-01 KP-7).",
    schedule: { kind: "daily", at: "22:15" },
    run: ({ now, db }) => dailyAccessSummary(now, db),
  });
  registerJob({
    key: "m10.access_review.reminder",
    description: "Pengingat tinjauan hak akses kuartalan (PAR-47).",
    schedule: { kind: "monthly", day: 1, at: "08:00" },
    run: ({ now, db }) => remindAccessReview(now, db),
  });
  registerJob({
    key: "m10.retention.daily",
    description: "Retensi PAR-29/PAR-52: log akses 1 tahun, posisi GPS mentah 12 bulan, foto diarsipkan setelah 2 tahun.",
    schedule: { kind: "daily", at: "02:30" },
    run: ({ now, db }) => runRetention(now, db),
  });
  registerJob({
    key: "m10.anonymization.deferred",
    description: "Permintaan anonimisasi yang ditunda karena piutang: beri tahu bila sudah lunas (PTB-36).",
    schedule: { kind: "daily", at: "07:00" },
    run: ({ now, db }) => remindDeferredAnonymizations(now, db),
  });
}
