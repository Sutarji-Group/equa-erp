/**
 * Registri bertipe parameter Lampiran B (PAR-01..PAR-89) + pengaturan non-PAR (`company.identity`, dll.).
 *
 * Setiap entri: skema Zod nilai (jsonb terstruktur), lingkup yang diizinkan (global / tenant / outlet), dan peran
 * terdampak yang diberi tahu saat pemilik mengubahnya (6.2b). Nama, satuan, rujukan, dan nilai bawaan diambil dari
 * `src/db/seed/parameters.ts` (satu sumber kebenaran dengan seed); entri tanpa seed wajib memberi `fallback`.
 *
 * BERKAS BERSAMA — hanya TAMBAH entri baru. Aturan: TIDAK ADA angka aturan di kode modul; modul membaca
 * `params.get(tx, "PAR-xx", tanggal)`.
 */
import { z } from "zod";

import { EXTRA_SETTINGS, LAMPIRAN_B_PARAMETERS, type ParameterSeed } from "@/db/seed/parameters";
import { enumValues, type RoleCode } from "@/lib/labels";
import { zRupiahNonNegative } from "@/lib/money";
import { isBusinessDate } from "@/lib/time";

export type ParamScopeLevel = "global" | "tenant" | "outlet";

export type ParamDef<S extends z.ZodType = z.ZodType> = {
  schema: S;
  /** Lingkup yang diizinkan. Bawaan `["global"]`. */
  scopes?: readonly ParamScopeLevel[];
  /** Peran yang diberi tahu saat nilai berubah (Admin Keuangan selalu diberi tahu, 6.2b). */
  affectedRoles?: readonly RoleCode[];
  /** Nilai bawaan bila tidak ada seed & tidak ada baris di DB (hanya untuk kunci non-seed). */
  fallback?: z.output<S>;
  /** Metadata untuk kunci non-seed. */
  meta?: Pick<ParameterSeed, "name" | "unit" | "reference" | "description">;
};

function defineParam<S extends z.ZodType>(def: ParamDef<S>): ParamDef<S> {
  return def;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pembangun skema
// ---------------------------------------------------------------------------------------------------------------------

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: "Jam harus berformat HH:mm (mis. 15:00)." });
const int = (min = 0) => z.number().int({ error: "Harus bilangan bulat." }).min(min);
const pct = z.number().min(0, { error: "Persen tidak boleh negatif." }).max(100, { error: "Persen maksimal 100." });
const rupiah = zRupiahNonNegative;
const businessDateOrNull = z
  .string()
  .refine(isBusinessDate, { error: "Tanggal harus berformat YYYY-MM-DD." })
  .nullable();
const segment = z.enum(enumValues("customer_segment"));

const amount = () => z.object({ amount: rupiah }).strict();
const amountGt = () => z.object({ amount_gt: rupiah }).strict();
const count = () => z.object({ count: int() }).strict();
const time = () => z.object({ time: hhmm }).strict();
const window = () => z.object({ start: hhmm, end: hhmm }).strict();
const days = () => z.object({ days: int() }).strict();
const weeks = () => z.object({ max_weeks: int(1) }).strict();

// ---------------------------------------------------------------------------------------------------------------------
// Registri
// ---------------------------------------------------------------------------------------------------------------------

export const PARAM_REGISTRY = {
  "PAR-01": defineParam({ schema: amount(), affectedRoles: ["owner"] }),
  "PAR-02": defineParam({ schema: amount(), scopes: ["global", "tenant", "outlet"], affectedRoles: ["depot_operator"] }),
  "PAR-03": defineParam({
    schema: count(),
    scopes: ["global", "tenant", "outlet"],
    affectedRoles: ["depot_operator", "store_cashier"],
  }),
  "PAR-04": defineParam({
    schema: amountGt(),
    scopes: ["global", "tenant", "outlet"],
    affectedRoles: ["depot_operator", "store_cashier"],
  }),
  "PAR-05": defineParam({ schema: time(), affectedRoles: ["dispatcher"] }),
  "PAR-06": defineParam({ schema: time(), affectedRoles: ["driver", "depot_operator", "store_cashier"] }),
  "PAR-07": defineParam({ schema: window(), affectedRoles: ["dispatcher", "driver", "depot_operator"] }),
  "PAR-08": defineParam({ schema: days(), affectedRoles: ["dispatcher"] }),
  "PAR-09": defineParam({ schema: days(), affectedRoles: ["dispatcher"] }),
  "PAR-10": defineParam({
    schema: z
      .object({ cash_only_segments: z.array(segment), limits: z.partialRecord(segment, rupiah) })
      .strict(),
    affectedRoles: ["dispatcher"],
  }),
  "PAR-11": defineParam({
    schema: z
      .object({
        min_months_since_first_completed: int(),
        min_completed_orders: int(),
        combine: z.enum(["or", "and"]),
        also_requires: z.string(),
      })
      .strict(),
    affectedRoles: ["dispatcher"],
  }),
  "PAR-12": defineParam({
    schema: z
      .object({ issue_day: int(1).max(28), issue_month_offset: int(), due_day: int(1).max(28), due_month_offset: int() })
      .strict(),
  }),
  "PAR-13": defineParam({ schema: z.object({ days_before_due: int(), days_after_due: int() }).strict() }),
  "PAR-14": defineParam({ schema: z.object({ max_percent: pct }).strict(), affectedRoles: ["store_cashier"] }),
  "PAR-15": defineParam({ schema: z.object({ liters: int(1) }).strict(), affectedRoles: ["driver", "dispatcher"] }),
  "PAR-16": defineParam({
    schema: z.object({ reason_required_gt_m: int(), owner_review_gt_m: int() }).strict(),
    affectedRoles: ["driver", "dispatcher", "owner"],
  }),
  "PAR-17": defineParam({ schema: count(), affectedRoles: ["dispatcher"] }),
  "PAR-18": defineParam({ schema: z.object({ max_percent: pct }).strict(), affectedRoles: ["production_operator", "owner"] }),
  "PAR-19": defineParam({ schema: z.object({ percent_gt: pct }).strict(), affectedRoles: ["owner"] }),
  "PAR-20": defineParam({ schema: amountGt(), affectedRoles: ["owner"] }),
  "PAR-21": defineParam({ schema: amountGt(), affectedRoles: ["owner"] }),
  "PAR-22": defineParam({
    schema: z.object({ threshold: rupiah, warn_percents: z.array(pct), window_months: int(1) }).strict(),
    affectedRoles: ["owner", "accountant"],
  }),
  "PAR-23": defineParam({ schema: z.object({ day_of_next_month: int(1).max(28) }).strict(), affectedRoles: ["owner"] }),
  "PAR-24": defineParam({ schema: z.object({ months: int(1) }).strict(), affectedRoles: ["dispatcher", "owner"] }),
  "PAR-25": defineParam({ schema: z.object({ minutes: int(1) }).strict(), affectedRoles: ["system_admin", "dispatcher"] }),
  "PAR-26": defineParam({ schema: z.object({ max_interval_minutes: int(1) }).strict(), affectedRoles: ["system_admin"] }),
  "PAR-27": defineParam({ schema: z.object({ days_gt: int() }).strict(), affectedRoles: ["depot_operator"] }),
  "PAR-28": defineParam({ schema: weeks(), affectedRoles: ["system_admin"] }),
  "PAR-29": defineParam({
    schema: z.object({ accounting_years: int(10), photo_years: int(1), access_log_years: int(1) }).strict(),
    affectedRoles: ["system_admin"],
  }),
  "PAR-30": defineParam({
    schema: z.object({ min_queue_days: int(1), sync_max_minutes: int(1) }).strict(),
    affectedRoles: ["system_admin"],
  }),
  "PAR-31": defineParam({ schema: z.object({ max_mb_per_month: int(1) }).strict(), affectedRoles: ["system_admin"] }),
  "PAR-32": defineParam({
    schema: z.object({ depot: z.enum(["weekly", "monthly"]), store: z.enum(["weekly", "monthly"]) }).strict(),
    affectedRoles: ["depot_operator", "store_cashier"],
  }),
  "PAR-33": defineParam({ schema: z.object({ trips: int(1) }).strict(), affectedRoles: ["dispatcher"] }),
  "PAR-34": defineParam({ schema: z.object({ days_before: int(0) }).strict(), affectedRoles: ["dispatcher"] }),
  "PAR-35": defineParam({
    schema: z
      .object({
        subscription_per_outlet: rupiah,
        royalty_percent_min: pct,
        royalty_percent_max: pct,
        exclusive_radius_m_option_b: int(),
        exclusive_radius_m_option_a_min: int(),
        exclusive_radius_m_option_a_max: int(),
        water_discount_percent_min: pct,
        water_discount_percent_max: pct,
      })
      .strict(),
    affectedRoles: ["regional_coach"],
  }),
  "PAR-36": defineParam({
    schema: z.object({ max_attempts: int(1), lock_minutes: int(1) }).strict(),
    affectedRoles: ["system_admin"],
  }),
  "PAR-37": defineParam({ schema: z.object({ idle_minutes: int(1) }).strict(), affectedRoles: ["system_admin"] }),
  "PAR-38": defineParam({ schema: z.object({ max_kb: int(50) }).strict(), affectedRoles: ["system_admin"] }),
  "PAR-39": defineParam({ schema: z.object({ days_gt: int() }).strict() }),
  "PAR-40": defineParam({ schema: z.object({ iso_weekday: int(1).max(7), time: hhmm }).strict(), affectedRoles: ["owner"] }),
  "PAR-41": defineParam({
    schema: z.object({ max_months_since_go_live: int(0), go_live_date: businessDateOrNull }).strict(),
    affectedRoles: ["dispatcher"],
  }),
  "PAR-42": defineParam({ schema: z.object({ minutes_gt: int(1) }).strict(), affectedRoles: ["system_admin"] }),
  "PAR-43": defineParam({ schema: amountGt(), affectedRoles: ["owner"] }),
  "PAR-44": defineParam({ schema: z.object({ hours_gt: int() }).strict(), affectedRoles: ["driver"] }),
  "PAR-45": defineParam({ schema: z.object({ max_days: int(1) }).strict() }),
  "PAR-46": defineParam({
    schema: z.object({ idle_minutes: int(1), max_hours: int(1) }).strict(),
    affectedRoles: ["system_admin"],
  }),
  "PAR-47": defineParam({
    schema: z.object({ frequency: z.enum(["quarterly"]) }).strict(),
    affectedRoles: ["owner", "system_admin"],
  }),
  "PAR-48": defineParam({ schema: z.object({ minutes_gt: int(1) }).strict(), affectedRoles: ["dispatcher"] }),
  "PAR-49": defineParam({ schema: z.object({ min_minutes: int(1) }).strict(), affectedRoles: ["dispatcher"] }),
  "PAR-50": defineParam({
    schema: z.object({ distance_m_gt: int(), minutes_gt: int() }).strict(),
    affectedRoles: ["dispatcher", "driver", "owner"],
  }),
  "PAR-51": defineParam({ schema: z.object({ minutes_gt: int(1) }).strict(), affectedRoles: ["dispatcher", "driver"] }),
  "PAR-52": defineParam({ schema: z.object({ months: int(1) }).strict(), affectedRoles: ["system_admin"] }),
  "PAR-53": defineParam({
    schema: z
      .object({
        consumption_l_per_km: z.number().positive().nullable(),
        fuel_price_per_l: rupiah.nullable(),
        configured: z.boolean(),
      })
      .strict(),
    affectedRoles: ["owner"],
  }),
  "PAR-54": defineParam({
    schema: z.object({ water_source_m: int(10), outlet_m: int(10), pool_m: int(10) }).strict(),
    affectedRoles: ["dispatcher", "system_admin"],
  }),
  "PAR-55": defineParam({ schema: time(), affectedRoles: ["owner"] }),
  "PAR-56": defineParam({ schema: window() }),
  "PAR-57": defineParam({
    schema: amount(),
    scopes: ["global", "tenant", "outlet"],
    affectedRoles: ["depot_operator", "store_cashier"],
  }),
  "PAR-58": defineParam({
    schema: z.object({ units_per_material: int() }).strict(),
    scopes: ["global", "tenant", "outlet"],
    affectedRoles: ["depot_operator"],
  }),
  "PAR-59": defineParam({
    schema: z.object({ percent: pct }).strict(),
    scopes: ["global", "tenant", "outlet"],
    affectedRoles: ["depot_operator", "owner"],
  }),
  "PAR-60": defineParam({ schema: z.object({ rule: z.enum(["open_shift_only"]) }).strict(), affectedRoles: ["depot_operator"] }),
  "PAR-61": defineParam({
    schema: z.object({ rule: z.enum(["until_next_shift_close"]) }).strict(),
    affectedRoles: ["depot_operator"],
  }),
  "PAR-62": defineParam({ schema: z.object({ max_months_after_cutover: int(0) }).strict(), affectedRoles: ["accountant"] }),
  "PAR-63": defineParam({
    schema: z
      .object({
        method: z.enum(["straight_line"]),
        useful_life_months_by_category: z.record(z.string(), int(1)).nullable(),
      })
      .strict(),
    affectedRoles: ["accountant"],
  }),
  "PAR-64": defineParam({ schema: z.object({ percent: pct }).strict(), affectedRoles: ["accountant"] }),
  "PAR-65": defineParam({ schema: z.object({ basis: z.enum(["fill_volume_monthly"]) }).strict(), affectedRoles: ["accountant"] }),
  "PAR-66": defineParam({ schema: z.object({ days_without_sale: int(1) }).strict(), affectedRoles: ["store_cashier", "owner"] }),
  "PAR-67": defineParam({ schema: days() }),
  "PAR-68": defineParam({
    schema: z.object({ percent_gt: pct, window_days: int(1) }).strict(),
    affectedRoles: ["production_operator"],
  }),
  "PAR-69": defineParam({
    schema: z.object({ percent: pct }).strict(),
    affectedRoles: ["dispatcher", "production_operator", "depot_operator"],
  }),
  "PAR-70": defineParam({
    schema: z.object({ frequency_days: int(1).nullable(), configured: z.boolean() }).strict(),
    affectedRoles: ["production_operator", "owner"],
  }),
  "PAR-71": defineParam({ schema: z.object({ days_of_next_month: z.array(int(1).max(28)) }).strict() }),
  "PAR-72": defineParam({ schema: z.object({ rule: z.enum(["until_trip_departed"]) }).strict(), affectedRoles: ["dispatcher"] }),
  "PAR-73": defineParam({
    schema: z
      .object({ slots: z.array(z.object({ key: z.string().min(1), start: hhmm, end: hhmm }).strict()).min(1) })
      .strict(),
    affectedRoles: ["dispatcher"],
  }),
  "PAR-74": defineParam({
    schema: z.object({ digits: int(4).max(8), valid_minutes: int(1), max_attempts: int(1) }).strict(),
    affectedRoles: ["system_admin"],
  }),
  "PAR-75": defineParam({
    schema: z
      .object({ order_confirm_hours: int(1), complaint_response_hours: int(1), service_hours_only: z.boolean() })
      .strict(),
    affectedRoles: ["dispatcher"],
  }),
  "PAR-76": defineParam({
    schema: z.object({ water_delivery_hours: int(1), support_response_hours: int(1) }).strict(),
    affectedRoles: ["dispatcher", "regional_coach"],
  }),
  "PAR-77": defineParam({ schema: z.object({ months: int(1) }).strict(), affectedRoles: ["regional_coach"] }),
  "PAR-78": defineParam({ schema: z.object({ option_b_years: int(1), option_a_years: int(1) }).strict() }),
  "PAR-79": defineParam({ schema: z.object({ percent: pct }).strict(), affectedRoles: ["regional_coach"] }),
  "PAR-80": defineParam({ schema: z.object({ percent: pct }).strict(), affectedRoles: ["regional_coach"] }),
  "PAR-81": defineParam({ schema: count(), affectedRoles: ["regional_coach"] }),
  "PAR-82": defineParam({
    schema: z
      .object({
        max_underpayments_overdue_7d: int(),
        max_transfers_not_found: int(),
        max_rejected_disputes: int(),
        max_failed_trips_customer_refused: int(),
      })
      .strict(),
    affectedRoles: ["dispatcher"],
  }),
  "PAR-83": defineParam({
    schema: z.object({ enabled: z.boolean(), amount_gte: rupiah }).strict(),
    affectedRoles: ["dispatcher", "driver"],
  }),
  "PAR-84": defineParam({
    schema: z
      .object({
        last_operating_days: int(1),
        recorded_at_source_percent: pct,
        max_unexplained_discrepancies: int(),
        deadline_day: int(1),
      })
      .strict(),
    affectedRoles: ["system_admin"],
  }),
  "PAR-85": defineParam({
    schema: z.object({ consecutive_days: int(1), threshold_parameter: z.string() }).strict(),
    affectedRoles: ["owner"],
  }),
  "PAR-86": defineParam({ schema: window(), affectedRoles: ["system_admin"] }),
  "PAR-87": defineParam({ schema: weeks(), affectedRoles: ["system_admin"] }),
  "PAR-88": defineParam({ schema: weeks(), affectedRoles: ["system_admin"] }),
  "PAR-89": defineParam({ schema: z.object({ max_days: int(1) }).strict() }),

  // --- Pengaturan non-PAR (D-04 & kebutuhan modul) ---
  "company.identity": defineParam({
    schema: z
      .object({
        name: z.string().min(1, { error: "Nama usaha wajib diisi." }),
        legal_name: z.string().nullable(),
        address: z.string().nullable(),
        phone: z.string().nullable(),
        npwp: z.string().nullable(),
      })
      .strict(),
    scopes: ["global", "tenant"],
    affectedRoles: ["dispatcher"],
  }),
  "accounting.cutover_date": defineParam({
    schema: z
      .object({
        date: businessDateOrNull.refine((d) => d === null || d.endsWith("-01"), {
          error: "Tanggal cut-over akuntansi hanya boleh tanggal 1 (NFR-36).",
        }),
      })
      .strict(),
    affectedRoles: ["accountant"],
  }),
  "app.min_supported_version": defineParam({
    schema: z
      .object({ version: z.string().regex(/^\d+\.\d+\.\d+$/, { error: "Versi harus berformat X.Y.Z." }) })
      .strict(),
    affectedRoles: ["system_admin"],
  }),
  /** Penerima e-mail ringkasan harian (PAR-55). Tidak ada kolom e-mail pengguna di Tahap 1 → diatur pemilik di sini. */
  "notifications.digest_recipients": defineParam({
    schema: z.object({ emails: z.array(z.email({ error: "Alamat e-mail tidak valid." })) }).strict(),
    fallback: { emails: [] },
    meta: {
      name: "Penerima e-mail ringkasan harian",
      unit: null,
      reference: "US-M9-04 KP-3, PTB-05, PAR-55",
      description: "Daftar alamat e-mail pemilik yang menerima ringkasan harian setelah tutup kas.",
    },
  }),
  /** Aturan data master M1 yang ditandai [USULAN] di PRD tetapi bukan PAR Lampiran B (tambahan agen M1). */
  "m1.master_rules": defineParam({
    schema: z
      .object({
        /** US-M1-01 KP-6 [USULAN]: depot pihak ketiga "aktif" = ≥ 1 pesanan Selesai dalam N hari terakhir. */
        store_partner_active_days: int(1),
        /** US-M1-06 KP-5 (BRD 10.3): koordinat kosong dilengkapi dari GPS sopir dalam N hari pertama. */
        coordinate_completion_days: int(1),
        /** US-M1-01 KP-7: kemiripan nama minimal (0–100%) untuk kandidat duplikat nama + alamat. */
        duplicate_name_min_similarity_pct: pct,
      })
      .strict(),
    affectedRoles: ["dispatcher"],
    fallback: { store_partner_active_days: 90, coordinate_completion_days: 30, duplicate_name_min_similarity_pct: 60 },
    meta: {
      name: "Aturan data master (mitra toko, kelengkapan koordinat, duplikat)",
      unit: null,
      reference: "US-M1-01 KP-6/KP-7, US-M1-06 KP-5",
      description:
        "Jendela aktif penanda mitra toko otomatis (hari), jendela pelengkapan koordinat data awal (hari), dan ambang kemiripan nama untuk peringatan duplikat pelanggan.",
    },
  }),

  // --- Tambahan modul M10 (Pengguna, Hak Akses & Jejak Audit) — hanya tambah ---
  "access.review_inactive_days": defineParam({
    schema: z.object({ days: int(1) }).strict(),
    affectedRoles: ["owner", "system_admin"],
    fallback: { days: 60 },
    meta: {
      name: "Tinjauan hak akses: batas hari tanpa login",
      unit: "hari",
      reference: "US-M10-01 KP-6, R09, PAR-47",
      description: "Pengguna tanpa login lebih dari nilai ini ditandai pada tinjauan hak akses kuartalan.",
    },
  }),
  "monitoring.mass_sync_failure": defineParam({
    schema: z.object({ devices_gt: int(0), minutes_gt: int(1) }).strict(),
    affectedRoles: ["system_admin"],
    fallback: { devices_gt: 3, minutes_gt: 30 },
    meta: {
      name: "Sinkron gagal massal → peringatan tim IT",
      unit: "perangkat / menit (jam layanan)",
      reference: "US-M10-07 KP-2, NFR-28",
      description: "Lebih dari N perangkat dengan antrean belum terkirim dan tidak sinkron lebih dari M menit pada jam layanan → insiden.",
    },
  }),
  "monitoring.service_down": defineParam({
    schema: z.object({ minutes_gt: int(1) }).strict(),
    affectedRoles: ["system_admin"],
    fallback: { minutes_gt: 15 },
    meta: {
      name: "Layanan tidak dapat diakses → peringatan tim IT",
      unit: "menit tanpa denyut pemantauan (jam layanan)",
      reference: "US-M10-07 KP-2, NFR-28, NFR-02",
      description: "Jeda denyut pemantauan terjadwal lebih dari nilai ini pada jam layanan dicatat sebagai insiden layanan tidak dapat diakses.",
    },
  }),
  "monitoring.incident_targets": defineParam({
    schema: z.object({ response_minutes: int(1), recovery_hours: int(1) }).strict(),
    affectedRoles: ["system_admin"],
    fallback: { response_minutes: 30, recovery_hours: 4 },
    meta: {
      name: "Target tanggap & pulih insiden",
      unit: "menit / jam",
      reference: "US-M10-07 KP-2, NFR-31",
      description: "Insiden kritis ditanggapi paling lama N menit dan pulih paling lama M jam.",
    },
  }),
  "backup.policy": defineParam({
    schema: z.object({ daily_max_age_hours: int(1), restore_tests_per_year: int(1) }).strict(),
    affectedRoles: ["system_admin", "owner"],
    fallback: { daily_max_age_hours: 26, restore_tests_per_year: 2 },
    meta: {
      name: "Kebijakan status cadangan & uji pemulihan",
      unit: "jam / kali per tahun",
      reference: "US-M10-06 KP-4, NFR-13, NFR-14",
      description: "Cadangan harian terakhir lebih tua dari N jam ditandai; uji pemulihan minimal M kali per 12 bulan.",
    },
  }),

  // --- Tambahan modul M6 (Penjualan Depot / kerangka POS) — hanya tambah ---
  /** Aturan POS yang bukan PAR Lampiran B (angka yang disebut PRD M6 tanpa nomor PAR). */
  "m6.pos_rules": defineParam({
    schema: z
      .object({
        /** 6.2a void POS "sampai akhir shift": tenggat persetujuan = jam ini (WIB) pada tanggal bisnis shift. */
        void_approval_deadline_time: hhmm,
        /** US-M6-02 KP-6: riwayat shift milik operator (hari). */
        operator_history_days: int(1),
        /** US-M6-01 KP-1: tombol produk di kisi POS. */
        grid_max_products: int(1),
        /** Batas baris & jumlah per baris satu transaksi (penjaga salah ketik). */
        max_sale_lines: int(1),
        max_quantity_per_line: int(1),
      })
      .strict(),
    scopes: ["global", "tenant", "outlet"],
    affectedRoles: ["depot_operator", "store_cashier"],
    fallback: {
      void_approval_deadline_time: "23:59",
      operator_history_days: 90,
      grid_max_products: 12,
      max_sale_lines: 20,
      max_quantity_per_line: 999,
    },
    meta: {
      name: "Aturan POS depot & toko (tenggat void, riwayat operator, kisi produk)",
      unit: null,
      reference: "US-M6-01 KP-1, US-M6-02 KP-6, US-M6-03 KP-2, 6.2a",
      description:
        "Jam tenggat persetujuan void pada tanggal bisnis shift (lewat → dianggap ditolak), lama riwayat shift yang dilihat operator, jumlah tombol produk di kisi POS, serta batas baris/jumlah per transaksi.",
    },
  }),

  // --- Tambahan modul M3 (Aplikasi Sopir) — hanya tambah ---
  /** Aturan aplikasi sopir yang bukan PAR Lampiran B (angka yang disebut PRD M3 tanpa nomor PAR). */
  "m3.driver_rules": defineParam({
    schema: z
      .object({
        /** US-M3-07 KP-6: riwayat setoran & selisih sopir sendiri (hari). */
        history_days: int(1),
        /** US-M3-02 KP-5: interval rekam GPS ponsel cadangan selama rit aktif (detik). */
        gps_phone_interval_s: int(10),
        /** PTB-19: tenggat keputusan Dispatcher atas permintaan tempo di lokasi (menit). */
        field_credit_wait_minutes: int(1),
        /** PTB-19 "hanya saat daring": permintaan yang tiba di server lebih lambat dari ini (menit) ditolak. */
        field_credit_max_delay_minutes: int(1),
        /** US-M3-03 KP-1: jumlah foto bukti kirim maksimal per rit. */
        max_delivery_photos: int(1),
      })
      .strict(),
    affectedRoles: ["driver", "helper", "dispatcher"],
    fallback: { history_days: 90, gps_phone_interval_s: 60, field_credit_wait_minutes: 30, field_credit_max_delay_minutes: 10, max_delivery_photos: 3 },
    meta: {
      name: "Aturan aplikasi sopir (riwayat, GPS ponsel cadangan, permintaan tempo di lokasi, foto bukti)",
      unit: null,
      reference: "US-M3-02 KP-5, US-M3-03 KP-1, US-M3-04 KP-4, US-M3-07 KP-6, PTB-19",
      description:
        "Lama riwayat setoran sopir, interval rekam GPS ponsel cadangan, tenggat & batas keterlambatan permintaan tunai → tempo di lokasi, serta jumlah foto bukti kirim per rit.",
    },
  }),

  // --- Tambahan modul M7 (Penjualan Toko & Stok) — hanya tambah ---
  /** Angka aturan toko yang disebut PRD 7.7 tanpa nomor PAR. */
  "m7.store_rules": defineParam({
    schema: z
      .object({
        /** US-M7-05 KP-4: opname bulan lalu belum dilakukan sampai tanggal ini → ditandai ke pemilik. */
        stock_count_deadline_day: int(1).max(28),
        /** US-M7-08 KP-1: pengingat utang pemasok H-N sebelum jatuh tempo. */
        payable_reminder_days_before: int(0),
        /** PTB-42: tempo yang tiba di server > N menit setelah dicatat di perangkat dianggap dicatat offline. */
        credit_offline_after_minutes: int(1),
        /** US-M7-07 KP-1: kelompok "laris" = N% barang teratas menurut omzet. */
        fast_moving_top_percent: pct,
        /** US-M7-03 KP-1: rata-rata penjualan harian dihitung atas N hari terakhir. */
        average_sales_days: int(1),
      })
      .strict(),
    scopes: ["global", "tenant"],
    affectedRoles: ["store_cashier", "finance_admin"],
    fallback: {
      stock_count_deadline_day: 5,
      payable_reminder_days_before: 3,
      credit_offline_after_minutes: 5,
      fast_moving_top_percent: 30,
      average_sales_days: 30,
    },
    meta: {
      name: "Aturan toko (tenggat opname, pengingat utang, tempo offline, laris, rata-rata jual)",
      unit: null,
      reference: "US-M7-03 KP-1, US-M7-04 KP-4, US-M7-05 KP-4, US-M7-07 KP-1, US-M7-08 KP-1",
      description:
        "Tanggal batas opname toko bulan lalu, jarak hari pengingat utang pemasok sebelum jatuh tempo, ambang menit tempo dianggap dicatat offline (PTB-42), persentase barang laris, dan jangka rata-rata penjualan untuk daftar pesan ulang.",
    },
  }),

  // --- Tambahan modul M4 (Kas & Setoran) — hanya tambah ---
  /** Angka aturan kas yang disebut PRD 7.4 tanpa nomor PAR. */
  "m4.cash_rules": defineParam({
    schema: z
      .object({
        /** KPI-03 / 6.2a: selisih belum Selesai lebih dari N jam ditonjolkan; setoran tertunda (PTB-21) wajib diterima ≤ N jam. */
        discrepancy_follow_up_hours: int(1),
        /** US-M4-03 KP-5: pemilik membuka kembali selisih di bawah ambang yang ditutup Admin Keuangan ≤ N hari. */
        discrepancy_reopen_days: int(1),
        /** US-M4-04 KP-3: usulan pasangan mutasi — tanggal ± N hari. */
        statement_match_days: int(0),
        /** US-M4-05 KP-2: rekonsiliasi fisik kas kecil setiap N hari (mingguan). */
        petty_cash_count_days: int(1),
        /** US-M4-03 KP-6 (BR-12): insentif nihil selisih — N bulan tanpa selisih. */
        zero_discrepancy_months: int(1),
      })
      .strict(),
    scopes: ["global", "tenant"],
    affectedRoles: ["finance_admin"],
    fallback: {
      discrepancy_follow_up_hours: 24,
      discrepancy_reopen_days: 7,
      statement_match_days: 1,
      petty_cash_count_days: 7,
      zero_discrepancy_months: 3,
    },
    meta: {
      name: "Aturan kas (tenggat tindak lanjut selisih, buka kembali, pencocokan mutasi, hitung kas kecil, nihil selisih)",
      unit: null,
      reference: "US-M4-03 KP-1/KP-5/KP-6, US-M4-04 KP-3, US-M4-05 KP-2, US-M4-06 KP-2, KPI-03",
      description:
        "Batas jam selisih dianggap lewat tindak lanjut (KPI-03) dan setoran tertunda harus diterima, batas hari pemilik membuka kembali selisih di bawah ambang, toleransi tanggal usulan pasangan mutasi bank, jarak hari rekonsiliasi fisik kas kecil, dan jumlah bulan nihil selisih untuk insentif.",
    },
  }),
} as const satisfies Record<string, ParamDef>;

export type ParamKey = keyof typeof PARAM_REGISTRY;
export type ParamValue<K extends ParamKey> = z.output<(typeof PARAM_REGISTRY)[K]["schema"]>;

export const PARAM_KEYS = Object.keys(PARAM_REGISTRY) as ParamKey[];

const SEED_BY_KEY = new Map<string, ParameterSeed>(
  [...LAMPIRAN_B_PARAMETERS, ...EXTRA_SETTINGS].map((p) => [p.key, p]),
);

export type ParamMeta = {
  key: ParamKey;
  name: string;
  unit: string | null;
  reference: string;
  description?: string;
  scopes: readonly ParamScopeLevel[];
  affectedRoles: readonly RoleCode[];
  /** Nilai bawaan (seed Lampiran B / fallback). */
  defaultValue: unknown;
};

export function isParamKey(key: string): key is ParamKey {
  return Object.prototype.hasOwnProperty.call(PARAM_REGISTRY, key);
}

/** Metadata parameter (nama, satuan, rujukan, lingkup, peran terdampak, nilai bawaan). */
export function paramMeta(key: ParamKey): ParamMeta {
  const def = PARAM_REGISTRY[key] as ParamDef;
  const seed = SEED_BY_KEY.get(key);
  const meta = seed ?? def.meta;
  return {
    key,
    name: meta?.name ?? key,
    unit: meta?.unit ?? null,
    reference: meta?.reference ?? "",
    description: meta?.description,
    scopes: def.scopes ?? ["global"],
    affectedRoles: def.affectedRoles ?? [],
    defaultValue: seed ? seed.value : def.fallback,
  };
}
