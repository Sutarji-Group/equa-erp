/**
 * P2 — sinkron lapangan. Aplikasi pelanggan bukan aplikasi lapangan (daring; PWA pelanggan tidak memakai outbox).
 *
 * Pull `p2.prepaid_trips` (sopir, kernet): rit hari ini pada truk dalam lingkup harian pelaku yang SUDAH DIBAYAR di
 * muka lewat pembayaran digital (US-P2-04 KP-4) → aplikasi sopir menampilkan "sudah dibayar" dan tidak menagih tunai
 * (perubahan kecil M3 — lihat docs/dev/modules/p2-customer.md). Cara bayar rit juga sudah menjadi `digital` di M2.
 */
import "server-only";

import { registerPullProvider } from "@/server/core/sync";

import { prepaidTripsPull } from "./service/overview";

export function registerSync(): void {
  registerPullProvider("p2.prepaid_trips", {
    roles: ["driver", "helper"],
    fetch: ({ ctx, tx }) => prepaidTripsPull(tx, ctx),
  });
}
