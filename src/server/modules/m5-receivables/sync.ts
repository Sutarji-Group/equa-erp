/**
 * M5 — sinkron lapangan. M5 TIDAK punya perintah lapangan sendiri: pelunasan lewat sopir dicatat perintah M3
 * `m3.collection.create` (M5 menerapkan alokasinya dari `collection.recorded`), penjualan tempo toko lewat
 * `m6.pos_sale.create` (M5 menerbitkan faktur dari `pos_sale.recorded`).
 *
 * Pull `m5.customer_credit` (sopir/kernet): status kredit, saldo piutang, dan eksposur pelanggan rit hari ini pada truk
 * pelaku (US-M5-01 KP-3 "tampil di … aplikasi sopir (data sinkron)"); `undefined` bila tidak berubah sejak kursor.
 */
import "server-only";

import { registerPullProvider } from "@/server/core/sync";

import { customerCreditPull } from "./service/pull";

export function registerSync(): void {
  registerPullProvider("m5.customer_credit", { roles: ["driver", "helper"], fetch: (pc) => customerCreditPull(pc) });
}
