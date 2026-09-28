/**
 * M2 — pekerjaan terjadwal (idempoten per slot, `/api/cron/tick`):
 * - `m2.recurring_generate`   harian 00.20 — pesanan langganan untuk tanggal kirim s.d. H+PAR-34 (US-M2-06 KP-2);
 *                              idempoten per langganan+tanggal; gagal (kredit/kurang bayar/nonaktif) → daftar gagal.
 * - `m2.unscheduled_morning`  harian pada awal jam layanan (PAR-07) — rit hari ini yang belum terjadwal/terbit →
 *                              notifikasi Dispatcher (6.3 "Pesanan belum terjadwal").
 */
import "server-only";

import { withTx } from "@/server/core/db";
import { registerJob } from "@/server/core/jobs";

import { notifyUnscheduledToday } from "./service/field";
import { generateRecurringOrders } from "./service/recurring";

export function registerJobs(): void {
  registerJob({
    key: "m2.recurring_generate",
    description: "Buat pesanan langganan H-PAR-34 (US-M2-06 KP-2); yang gagal kontrol kredit masuk daftar gagal (KP-4).",
    schedule: { kind: "daily", at: "00:20" },
    run: ({ now, db }) => generateRecurringOrders(now, { db }),
  });
  registerJob({
    key: "m2.unscheduled_morning",
    description: "Pagi H: rit untuk hari ini yang belum terjadwal/terbit → notifikasi Dispatcher (6.3, FR-M2-03).",
    schedule: { kind: "daily", atParam: { key: "PAR-07", field: "start" } },
    run: ({ now, db }) => withTx((tx) => notifyUnscheduledToday(tx, now), { db }),
  });
}
