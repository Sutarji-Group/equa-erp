/**
 * M10 — handler event domain milik modul ini.
 *
 * - `employee.exited` (dari M1): tanggal keluar ≤ hari ini → akun dinonaktifkan seketika oleh "Sistem" (BR-37,
 *   US-M10-01 KP-5): sesi diputus, perangkat yang dipegang diblokir, permintaan akses terbuka dibatalkan. Tanggal keluar
 *   di masa depan ditangani job harian `m10.users.exit_date`. Terisolasi savepoint (bawaan): bila gagal, perubahan M1
 *   tetap tersimpan, insiden dicatat, dan job harian mengulang penonaktifan.
 */
import "server-only";

import { on } from "@/server/core/events";

import { handleEmployeeExited } from "./service/exits";

export function registerEvents(): void {
  on(
    "employee.exited",
    async (event, tx) => {
      await handleEmployeeExited(tx, event.payload, event.occurredAt ?? new Date());
    },
    { name: "m10-access:employee-exited" },
  );
}
