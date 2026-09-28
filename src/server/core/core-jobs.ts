/**
 * Job inti platform (didaftarkan `ensureBootstrapped`):
 * - `core.approvals.expire_due`        tiap 5 menit — tenggat persetujuan (PTB-32, US-M10-04 KP-4).
 * - `core.notifications.push_pending`  tiap 5 menit — cadangan pengiriman web push yang terlewat.
 * - `core.notifications.daily_digest`  harian PAR-55 (22.30) — ringkasan e-mail ke pemilik (US-M9-04 KP-3).
 */
import "server-only";

import { expireDue } from "./approvals/service";
import { registerJob } from "./jobs";
import { sendDailyDigest } from "./notifications/digest";
import { deliverPendingPushes } from "./notifications/service";

export function registerCoreJobs(): void {
  registerJob({
    key: "core.approvals.expire_due",
    description: "Proses permintaan persetujuan yang melewati tenggat (Bab 6.2a).",
    schedule: { kind: "every_5_min" },
    run: ({ now, db }) => expireDue(now, { db }),
  });
  registerJob({
    key: "core.notifications.push_pending",
    description: "Kirim ulang web push yang belum terkirim setelah commit.",
    schedule: { kind: "every_5_min" },
    run: ({ now, db }) => deliverPendingPushes(now, db),
  });
  registerJob({
    key: "core.notifications.daily_digest",
    description: "Ringkasan e-mail harian ke pemilik setelah tutup kas (PAR-55).",
    schedule: { kind: "daily", atParam: { key: "PAR-55", field: "time" } },
    run: ({ now, db }) => sendDailyDigest(now, { db }),
  });
}
