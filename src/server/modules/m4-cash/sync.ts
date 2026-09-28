/**
 * M4 — sinkron lapangan. M4 tidak memiliki perintah lapangan (penerimaan setoran & tutup kas di web kantor; "Setor"
 * dicatat M3/M6/M7). Penyedia pull `m4.my_cash` (sopir, kernet, operator depot, kasir): hasil penerimaan setoran &
 * keputusan selisih milik sendiri (US-M4-02 KP-8) dan saldo ganti rugi karyawan bersangkutan (US-M4-03 KP-3).
 */
import "server-only";

import { registerPullProvider } from "@/server/core/sync";

import { buildMyCash } from "./service/pull";

export function registerSync(): void {
  registerPullProvider("m4.my_cash", {
    roles: ["driver", "helper", "depot_operator", "store_cashier"],
    fetch: ({ ctx, tx, since, now }) => buildMyCash(tx, ctx, since, now),
  });
}
