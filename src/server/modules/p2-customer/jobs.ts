/**
 * P2 — pekerjaan terjadwal (`/api/cron/tick`, idempoten per slot; notifikasi idempoten per kejadian).
 *
 * | Job | Jadwal | Isi |
 * |---|---|---|
 * | `p2.app_orders.overdue` | tiap 5 menit | Pesanan aplikasi belum dikonfirmasi/ditolak lewat PAR-75 → notifikasi Dispatcher & pemilik (US-P2-02 KP-4). |
 * | `p2.complaints.overdue` | tiap 5 menit | Keluhan belum ditanggapi lewat PAR-75 → notifikasi kotak & pemilik (US-P2-06 KP-2). |
 * | `p2.payments.expire` | tiap 5 menit | Kode bayar QRIS/VA lewat masa berlaku → Kedaluwarsa (US-P2-04 KP-3). |
 * | `p2.refill.reminders` | harian 08.10 | Pengingat isi ulang H-2 dari rata-rata jarak antar pesanan (US-P2-05 KP-2). |
 * | `p2.recurring.failures` | harian 06.05 | Pesanan langganan gagal dibuat → pemberitahuan pelanggan + tindakan (US-P2-05 KP-3). |
 */
import "server-only";

import { withTx } from "@/server/core/db";
import { registerJob } from "@/server/core/jobs";

import { notifyOverdueComplaints } from "./service/feedback";
import { notifyOverdueConfirmations } from "./service/orders";
import { expirePendingIntents } from "./service/payments";
import { notifyRecurringFailures, sendRefillReminders } from "./service/subscriptions";

export function registerJobs(): void {
  registerJob({
    key: "p2.app_orders.overdue",
    description: "Pesanan aplikasi pelanggan belum dikonfirmasi/ditolak melewati tenggat PAR-75 → notifikasi Dispatcher & pemilik (US-P2-02 KP-4).",
    schedule: { kind: "every_5_min" },
    run: ({ now, db }) => withTx((tx) => notifyOverdueConfirmations(tx, now), { db }),
  });
  registerJob({
    key: "p2.complaints.overdue",
    description: "Keluhan pelanggan belum ditanggapi melewati tenggat PAR-75 → notifikasi kotak keluhan & pemilik (US-P2-06 KP-2).",
    schedule: { kind: "every_5_min" },
    run: ({ now, db }) => withTx((tx) => notifyOverdueComplaints(tx, now), { db }),
  });
  registerJob({
    key: "p2.payments.expire",
    description: "Kode bayar QRIS/VA pelanggan yang lewat masa berlaku → Kedaluwarsa (US-P2-04 KP-3).",
    schedule: { kind: "every_5_min" },
    run: ({ now, db }) => withTx((tx) => expirePendingIntents(tx, now), { db }),
  });
  registerJob({
    key: "p2.refill.reminders",
    description: "Pengingat isi ulang H-2 dari rata-rata jarak antar pesanan, dengan pesan ulang satu ketukan (US-P2-05 KP-2).",
    schedule: { kind: "daily", at: "08:10" },
    run: ({ now, db }) => withTx((tx) => sendRefillReminders(tx, now), { db }),
  });
  registerJob({
    key: "p2.recurring.failures",
    description: "Pesanan langganan yang gagal dibuat (mis. kredit ditahan) → pemberitahuan pelanggan dengan tindakan yang disarankan (US-P2-05 KP-3).",
    schedule: { kind: "daily", at: "06:05" },
    run: ({ now, db }) => withTx((tx) => notifyRecurringFailures(tx, now), { db }),
  });
}
