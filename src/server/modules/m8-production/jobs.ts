/**
 * M8 — pekerjaan terjadwal (`/api/cron/tick`, idempoten per slot `job_runs`; notifikasi sekali per sumber/tanggal).
 *
 * | Job                        | Jadwal                                           | Isi |
 * |----------------------------|--------------------------------------------------|-----|
 * | `m8.meter.morning_check`   | harian, jam `m8.production_rules.morning_deadline` (08.00) | US-M8-01 KP-3: pembacaan pagi belum ada → pengingat operator + "produksi belum tercatat" ke pemilik; produksi "Belum lengkap". |
 * | `m8.meter.evening_check`   | harian, jam `m8.production_rules.evening_deadline` (23.00) | Sama untuk pembacaan malam + neraca hari itu dibentuk (belum lengkap bila perlu); utilisasi berturut > PAR-19 (PAR-85) diperiksa. |
 * | `m8.quality.reminder`      | harian 07.10                                     | US-M8-06 KP-1: jadwal uji mutu H-7 → pemilik & operator lokasi. |
 */
import "server-only";

import { registerJob } from "@/server/core/jobs";

import { runReadingCheck } from "./service/jobs-logic";
import { runQualityReminders } from "./service/quality";

export function registerJobs(): void {
  registerJob({
    key: "m8.meter.morning_check",
    description: "Pembacaan meter pagi belum tercatat pada jam batas → pengingat operator & notifikasi pemilik (US-M8-01 KP-3).",
    schedule: { kind: "daily", atParam: { key: "m8.production_rules", field: "morning_deadline" } },
    run: ({ now, db }) => runReadingCheck(now, "morning", db),
  });
  registerJob({
    key: "m8.meter.evening_check",
    description: "Pembacaan meter malam belum tercatat → pengingat & notifikasi; neraca hari ini dibentuk (US-M8-01 KP-3, US-M8-04, US-M8-05).",
    schedule: { kind: "daily", atParam: { key: "m8.production_rules", field: "evening_deadline" } },
    run: ({ now, db }) => runReadingCheck(now, "evening", db),
  });
  registerJob({
    key: "m8.quality.reminder",
    description: "Pengingat jadwal uji mutu air H-7 ke pemilik & operator lokasi (US-M8-06 KP-1).",
    schedule: { kind: "daily", at: "07:10" },
    run: ({ now, db }) => runQualityReminders(now, db),
  });
}
