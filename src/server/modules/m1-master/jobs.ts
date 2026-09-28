/**
 * M1 — pekerjaan terjadwal (idempoten per slot, `/api/cron/tick`):
 * - `m1.zone_table_effective`  harian 00.10 — batas zona yang mulai berlaku: salinan batas diperbarui, alamat berzona
 *                               Otomatis dipetakan ulang, pemilik diberi tahu alamat yang berpindah (US-M1-05 KP-4).
 * - `m1.employee_exit`          harian 00.15 — tanggal keluar tercapai → nonaktif + `employee.exited` (reached) (BR-37).
 * - `m1.store_partner_flags`    harian 01.15 — penanda mitra toko otomatis (US-M1-01 KP-6, BR-18).
 * - `m1.special_price_review`   bulanan tgl 1, 06.50 — notifikasi daftar tinjauan harga khusus (BR-16, PAR-24).
 */
import "server-only";

import { toBusinessDate } from "@/lib/time";
import { withTx } from "@/server/core/db";
import { registerJob } from "@/server/core/jobs";

import { refreshStorePartnerFlags } from "./service/customers";
import { processEmployeeExits } from "./service/org";
import { notifySpecialPriceReviews } from "./service/special-prices";
import { applyEffectiveZoneTables } from "./service/zones";

export function registerJobs(): void {
  registerJob({
    key: "m1.zone_table_effective",
    description: "Terapkan batas zona tarif yang mulai berlaku hari ini & petakan ulang alamat (US-M1-05 KP-4).",
    schedule: { kind: "daily", at: "00:10" },
    run: ({ now, db }) => withTx((tx) => applyEffectiveZoneTables(tx, now, toBusinessDate(now)), { db }),
  });
  registerJob({
    key: "m1.employee_exit",
    description: "Karyawan yang tanggal keluarnya tercapai dinonaktifkan; event employee.exited untuk M10 (BR-37).",
    schedule: { kind: "daily", at: "00:15" },
    run: ({ now, db }) => withTx((tx) => processEmployeeExits(tx, now), { db }),
  });
  registerJob({
    key: "m1.store_partner_flags",
    description: "Penanda mitra toko otomatis untuk depot pihak ketiga yang aktif (US-M1-01 KP-6, BR-18).",
    schedule: { kind: "daily", at: "01:15" },
    run: ({ now, db }) => withTx((tx) => refreshStorePartnerFlags(tx, now), { db }),
  });
  registerJob({
    key: "m1.special_price_review",
    description: "Beri tahu pemilik harga khusus yang lewat tanggal tinjauan (BR-16, PAR-24).",
    schedule: { kind: "monthly", day: 1, at: "06:50" },
    run: ({ now, db }) => withTx((tx) => notifySpecialPriceReviews(tx, now), { db }),
  });
}
