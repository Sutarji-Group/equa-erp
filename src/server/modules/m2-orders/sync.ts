/**
 * M2 — sinkron lapangan. M2 tidak punya perintah lapangan (Dispatcher bekerja daring, 7.2.6); M2 menyediakan data
 * referensi offline untuk aplikasi sopir (M3):
 *
 * - pull `m2.schedule` (sopir, kernet): rit TERBIT truk-truk dalam lingkup harian pelaku (jadwal kru US-M2-10/11) untuk
 *   hari ini, urut rencana BR-21, dengan catatan khusus pelanggan/alamat/pesanan (US-M2-08 KP-2), tagih kurang bayar
 *   (PTB-18), penanda kunci BR-10 (rit tampil tetapi terkunci), dan revisi jadwal (US-M2-03 KP-5). `undefined` bila
 *   tidak berubah sejak `since`. Rit yang ditarik kantor hilang dari daftar pada pull berikutnya; bila sudah dikerjakan
 *   offline, perintah M3 tetap sah dan M2 menandainya konflik (Bab 6.4).
 */
import "server-only";

import { ctxBusinessDate } from "@/server/core/context";
import { registerPullProvider } from "@/server/core/sync";

import { driverSchedule } from "./service/field";

export function registerSync(): void {
  registerPullProvider("m2.schedule", {
    roles: ["driver", "helper"],
    fetch: ({ ctx, tx, since }) => driverSchedule(tx, ctx, ctxBusinessDate(ctx), since),
    // Pull bersyarat v1.0.1 (D-14 butir 3): rit berubah per butir → hanya rit yang berubah dikirim ulang.
    collections: { trips: 1, revision: 4 },
  });
}
