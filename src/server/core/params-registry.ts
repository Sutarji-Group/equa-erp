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
  /** Aturan laporan M9 yang bukan PAR Lampiran B (tambahan agen M9, hanya tambah). */
  "m9.report_rules": defineParam({
    schema: z
      .object({
        /** NFR-04 / KPI-08: H+0 terbit paling lambat N menit setelah kas ditutup; lewat → penanda terlambat. */
        h0_publish_minutes: int(1),
        /** Job cadangan menerbitkan H+0 untuk hari kas yang sudah ditutup dalam N hari terakhir. */
        h0_catch_up_days: int(1),
        /** US-M9-06 KP-1: jumlah periode tren (minggu/bulan). */
        trend_periods: int(2),
        /** US-M9-05 KP-1 [USULAN]: rit tepat waktu = Selesai dalam ± N menit dari jam diminta. */
        on_time_window_minutes: int(1),
        /** US-M9-04 KP-2: jendela rit gagal & kejadian yang tampil di kotak masuk (hari). */
        inbox_lookback_days: int(1),
        /** US-M9-02 KP-6: jumlah bulan tren biaya produksi air per liter. */
        water_cost_trend_months: int(1),
        /** US-M9-07 KP-1: awal riwayat KPI (tanggal mulai pilot); kosong → 12 bulan terakhir. */
        pilot_start_date: businessDateOrNull,
      })
      .strict(),
    fallback: {
      h0_publish_minutes: 30,
      h0_catch_up_days: 7,
      trend_periods: 13,
      on_time_window_minutes: 60,
      inbox_lookback_days: 7,
      water_cost_trend_months: 6,
      pilot_start_date: null,
    },
    affectedRoles: ["owner"],
    meta: {
      name: "Aturan laporan & dashboard (terbit H+0, tren, tepat waktu, kotak masuk, awal pilot)",
      unit: null,
      reference: "US-M9-01 KP-2, US-M9-02 KP-6, US-M9-04 KP-2, US-M9-05 KP-1, US-M9-06 KP-1, US-M9-07 KP-1, NFR-04",
      description:
        "Batas terbit H+0 setelah tutup kas (KPI-08), jangka job cadangan penerbitan, jumlah periode tren, jendela ketepatan waktu rit, jangka kotak masuk, bulan tren biaya air per liter, dan tanggal mulai pilot untuk riwayat KPI.",
    },
  }),
  /** Target KPI program BRD 2.3 (US-M9-07 KP-1) — KPI-04 memakai `m5.receivable_rules.kpi04_target_percent`. */
  "m9.kpi_targets": defineParam({
    schema: z
      .object({
        kpi01_min_percent: pct,
        kpi02_max_minutes: int(0),
        kpi03_max_count: int(0),
        kpi05_min_percent: pct,
        kpi06_max_count: int(0),
        kpi08_min_percent: pct,
        kpi11_min_percent: pct,
      })
      .strict(),
    fallback: {
      kpi01_min_percent: 100,
      kpi02_max_minutes: 15,
      kpi03_max_count: 0,
      kpi05_min_percent: 100,
      kpi06_max_count: 0,
      kpi08_min_percent: 100,
      kpi11_min_percent: 100,
    },
    affectedRoles: ["owner"],
    meta: {
      name: "Target KPI program (KPI-01–KPI-11)",
      unit: null,
      reference: "BRD 2.3, PRD 1.3, US-M9-07 KP-1",
      description:
        "Target KPI-01 (100% tercatat di sumber), KPI-02 (≤ 15 menit), KPI-03 (0/bulan), KPI-05 (100%), KPI-06 (0/bulan), KPI-08 (100% hari H+0 ≤ batas terbit), KPI-11 (100% adopsi). KPI-07 & KPI-10 baseline; KPI-04 dari aturan piutang M5; KPI-09 dari PAR-23.",
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

  // --- Tambahan S5-B (audit PRD) M6 — hanya tambah ---
  /** US-M6-01 KP-1 / US-M6-06 KP-4: harga perangkat diterima hanya bila sama dengan harga master yang berlaku dalam jendela offline. */
  "m6.price_rules": defineParam({
    schema: z
      .object({
        /** Harga master versi lama masih diterima bila berlaku dalam N hari sebelum tanggal transaksi (katalog perangkat offline). */
        offline_price_grace_days: int(0),
      })
      .strict(),
    scopes: ["global", "tenant"],
    affectedRoles: ["depot_operator", "store_cashier"],
    fallback: { offline_price_grace_days: 3 },
    meta: {
      name: "Jendela harga katalog offline POS",
      unit: "hari",
      reference: "US-M6-01 KP-1, US-M6-06 KP-4, BR-15, BR-17, BR-18",
      description:
        "Transaksi POS memakai harga di perangkat saat itu; server menerimanya hanya bila sama dengan harga master (jenis harga yang berlaku) pada salah satu hari dalam N hari terakhir. Harga lain ditolak agar harga master, batas diskon, dan harga mitra tidak dapat dilewati.",
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

  // --- Tambahan modul M5 (Piutang & Penagihan) — hanya tambah ---
  /** Angka aturan piutang yang disebut PRD 7.5 / PTB-18 / FR-M5-04 tanpa nomor PAR. */
  "m5.receivable_rules": defineParam({
    schema: z
      .object({
        /** PTB-18: faktur kurang bayar lapangan jatuh tempo H+N (bawaan H+0). */
        underpayment_due_days: int(0),
        /** FR-M5-04: batas atas kelompok umur lewat tempo pertama (1–N hari). */
        aging_first_bucket_days: int(1),
        /** FR-M5-04: batas atas kelompok umur lewat tempo kedua (… – N hari); di atasnya = kelompok terakhir. */
        aging_second_bucket_days: int(1),
        /** US-M5-04 KP-3: "akan Ditahan" = faktur yang akan melewati PAR-09 dalam N hari. */
        hold_warning_days: int(0),
        /** US-M5-04 KP-2: rentang bawaan kartu piutang (hari ke belakang). */
        statement_default_days: int(1),
        /** KPI-04: sasaran % piutang lewat tempo terhadap total piutang (ditampilkan di umur piutang & ringkasan mingguan). */
        kpi04_target_percent: z.number().min(0).max(100),
      })
      .strict(),
    affectedRoles: ["finance_admin", "dispatcher"],
    fallback: {
      underpayment_due_days: 0,
      aging_first_bucket_days: 7,
      aging_second_bucket_days: 30,
      hold_warning_days: 3,
      statement_default_days: 90,
      kpi04_target_percent: 5,
    },
    meta: {
      name: "Aturan piutang (jatuh tempo kurang bayar, kelompok umur, peringatan Ditahan, kartu piutang, sasaran KPI-04)",
      unit: null,
      reference: "PTB-18, FR-M5-04, US-M5-04 KP-1/KP-2/KP-3, KPI-04",
      description:
        "Jatuh tempo faktur kurang bayar lapangan (H+N), batas kelompok umur piutang (1–7 / 8–30 / > 30 hari), jendela hari \"akan Ditahan\" pada daftar tindakan harian, rentang bawaan kartu piutang, dan sasaran % piutang lewat tempo (KPI-04, bawaan < 5%).",
    },
  }),

  // --- Tambahan modul M8 (Produksi & Stok Air) — hanya tambah ---
  /** Angka aturan produksi yang disebut PRD 7.8 tanpa nomor PAR ([USULAN jam] US-M8-01 KP-3, H-7 US-M8-06 KP-1, dst.). */
  "m8.production_rules": defineParam({
    schema: z
      .object({
        /** US-M8-01 KP-3: pembacaan pagi belum ada pada jam ini → pengingat operator + notifikasi pemilik. */
        morning_deadline: hhmm,
        /** US-M8-01 KP-3: pembacaan malam belum ada pada jam ini → pengingat + neraca "belum lengkap". */
        evening_deadline: hhmm,
        /** US-M8-04 KP-3 (PTB-41): rata-rata susut N hari sebagai informasi. */
        loss_average_days: int(1),
        /** US-M8-05 KP-3: ekspor data harian utilisasi N bulan terakhir dalam satu berkas. */
        utilization_export_months: int(1),
        /** US-M8-06 KP-1: pengingat jadwal uji mutu H-N ke pemilik & operator. */
        quality_reminder_days_before: int(0),
        /** Riwayat pembacaan & pengisian yang tersedia offline di aplikasi operator (hari). */
        operator_history_days: int(1),
      })
      .strict(),
    scopes: ["global", "tenant"],
    affectedRoles: ["production_operator", "owner", "finance_admin"],
    fallback: {
      morning_deadline: "08:00",
      evening_deadline: "23:00",
      loss_average_days: 7,
      utilization_export_months: 6,
      quality_reminder_days_before: 7,
      operator_history_days: 7,
    },
    meta: {
      name: "Aturan produksi air (jam batas pembacaan meter, rata-rata susut, ekspor utilisasi, pengingat uji mutu)",
      unit: null,
      reference: "US-M8-01 KP-3, US-M8-04 KP-3, US-M8-05 KP-3, US-M8-06 KP-1, US-M8-07 KP-1",
      description:
        "Jam batas pembacaan meter pagi (08.00) dan malam (23.00) sebelum pengingat & notifikasi \"produksi belum tercatat\", jangka rata-rata susut informasi (7 hari), lama data harian utilisasi yang diekspor (6 bulan), jarak hari pengingat uji mutu (H-7), dan lama riwayat di aplikasi operator.",
      },
    }),

  // --- Tambahan modul M12 (Pelacakan Armada / GPS) — hanya tambah ---
  /** Angka aturan armada yang disebut PRD 7.12 tanpa nomor PAR (ambang [USULAN] & batas teknis penilaian jejak GPS). */
  "m12.fleet_rules": defineParam({
    schema: z
      .object({
        /** US-M12-01 KP-5: posisi berakurasi lebih buruk dari N m tetap disimpan tetapi tidak dipakai mendeteksi kejadian. */
        max_accuracy_m: int(1),
        /** Kecepatan (km/jam) minimal dianggap bergerak (status peta & waktu bergerak). */
        moving_speed_kmh: int(1),
        /** Radius (m) titik dianggap diam di tempat — batas getar GPS untuk titik berhenti (PAR-49/PAR-51). */
        stop_radius_m: int(5),
        /** Gerak lebih pendek dari N m dianggap getar GPS (bukan perjalanan). */
        min_move_m: int(10),
        /** Lompatan posisi yang menyiratkan kecepatan > N km/jam diabaikan dari jarak (posisi pencilan). */
        max_plausible_speed_kmh: int(20),
        /** 7.12.6: jeda antar-posisi lebih dari N menit ditandai "celah jejak" pada riwayat. */
        track_gap_minutes: int(1),
        /** US-M12-04 KP-2: titik Selesai ponsel vs posisi perangkat GPS berbeda > N m → sumber lokasi tidak konsisten. */
        source_inconsistent_gt_m: int(1),
        /** US-M12-04 KP-2: posisi perangkat GPS dicari dalam ± N menit dari waktu Selesai. */
        inconsistency_window_minutes: int(1),
        /** US-M12-06 KP-2: pengisian tanpa masuk geofence sumber dalam ± N menit → ditandai. */
        fill_geofence_window_minutes: int(1),
        /** US-M12-06 KP-2: truk di geofence sumber lebih dari N menit tanpa pengisian tercatat → ditandai. */
        source_dwell_without_fill_minutes: int(1),
        /** Histeresis keluar geofence (m di luar radius) agar getar GPS di tepi tidak membuat masuk/keluar berulang. */
        geofence_exit_margin_m: int(0),
        /** US-M12-08 KP-2: perangkat mati/dicabut lebih dari N menit dalam sehari tampil di H+0. */
        device_dead_h0_minutes: int(1),
        /** US-M12-08 KP-3: pola berulang = minimal N kejadian perangkat mati/dicabut … */
        repeat_outage_count: int(2),
        /** … dalam N hari terakhir per truk → dilaporkan ke pemilik. */
        repeat_outage_days: int(1),
        /** 7.12.6: semua perangkat basi sekaligus (minimal N perangkat) = gangguan vendor sistemik → hanya tim IT. */
        vendor_outage_min_devices: int(2),
        /** US-M12-02 KP-2: kecepatan rata-rata (km/jam) untuk perkiraan waktu tiba dari jarak rute. */
        eta_avg_speed_kmh: int(1),
        /** US-M12-02 KP-5: putar ulang N jam terakhir. */
        replay_hours: int(1),
        /** US-M12-07 KP-2: rata-rata jarak GPS N rit terakhir per alamat untuk pemeriksaan zona. */
        zone_check_trip_count: int(1),
        /** Jendela (jam ke belakang) penilaian jejak oleh job deteksi tiap 5 menit. */
        detection_lookback_hours: int(1),
      })
      .strict(),
    affectedRoles: ["dispatcher", "owner", "system_admin"],
    fallback: {
      max_accuracy_m: 100,
      moving_speed_kmh: 5,
      stop_radius_m: 60,
      min_move_m: 200,
      max_plausible_speed_kmh: 130,
      track_gap_minutes: 5,
      source_inconsistent_gt_m: 200,
      inconsistency_window_minutes: 5,
      fill_geofence_window_minutes: 30,
      source_dwell_without_fill_minutes: 10,
      geofence_exit_margin_m: 25,
      device_dead_h0_minutes: 120,
      repeat_outage_count: 3,
      repeat_outage_days: 7,
      vendor_outage_min_devices: 3,
      eta_avg_speed_kmh: 30,
      replay_hours: 24,
      zone_check_trip_count: 3,
      detection_lookback_hours: 12,
    },
    meta: {
      name: "Aturan armada/GPS (akurasi, titik berhenti, konsistensi lokasi, geofence pengisian, perangkat mati, putar ulang, pemeriksaan zona)",
      unit: null,
      reference: "US-M12-01 KP-5, US-M12-02 KP-2/KP-5, US-M12-03, US-M12-04 KP-2, US-M12-06 KP-2, US-M12-07 KP-2, US-M12-08 KP-2/KP-3, 7.12.6",
      description:
        "Batas akurasi posisi yang dipakai deteksi, kecepatan & radius diam, jarak gerak minimal, penyaring lompatan posisi, celah jejak, ambang sumber lokasi tidak konsisten (± menit), jendela geofence pengisian & lama di sumber tanpa pengisian, histeresis geofence, perangkat mati yang tampil di H+0, pola perangkat mati berulang, gangguan vendor sistemik, kecepatan rata-rata perkiraan tiba, jangka putar ulang, jumlah rit pemeriksaan zona, dan jendela penilaian job deteksi.",
    },
  }),
  // --- Tambahan modul M11 (Akuntansi & Pajak) — hanya tambah ---
  /** Kunci alokasi biaya bersama ditetapkan pemilik (US-M11-01 KP-5 [USULAN]): dibiarkan / omzet / persentase tetap. */
  "m11.shared_cost_allocation": defineParam({
    schema: z
      .object({
        basis: z.enum(["none", "revenue", "fixed"]),
        /** Persentase tetap per lini (jumlah 100) — hanya untuk `fixed`. */
        fixed_percents: z.record(z.enum(["L2", "L3", "L4", "L5"]), pct).nullable(),
      })
      .strict()
      .refine((v) => v.basis !== "fixed" || (v.fixed_percents !== null && Math.abs(Object.values(v.fixed_percents).reduce((s, n) => s + (n ?? 0), 0) - 100) < 0.01), {
        error: "Persentase tetap per lini harus berjumlah 100%.",
      }),
    scopes: ["global", "tenant"],
    affectedRoles: ["finance_admin", "accountant"],
    fallback: { basis: "none", fixed_percents: null },
    meta: {
      name: "Kunci alokasi biaya bersama",
      unit: null,
      reference: "US-M11-01 KP-5",
      description: "Biaya pusat biaya bersama (kantor, Admin Keuangan, IT) dialokasikan ke lini menurut omzet, persentase tetap, atau dibiarkan.",
    },
  }),
  /** Aturan akuntansi M11 yang bukan PAR Lampiran B (penyusutan, pengingat utang jurnal manual). */
  "m11.accounting_rules": defineParam({
    schema: z
      .object({
        /** Penyusutan dimulai bulan perolehan bila diperoleh ≤ tanggal ini; setelahnya mulai bulan berikutnya. */
        depreciation_same_month_until_day: int(1).max(31),
        /** Pengingat utang jurnal manual N hari sebelum jatuh tempo (Bab 6.3). */
        payable_reminder_days_before: int(0),
        /** Penutupan periode pertama setelah cut-over wajib catatan tinjauan akuntan (TG-8). */
        first_close_requires_accountant_note: z.boolean(),
      })
      .strict(),
    affectedRoles: ["finance_admin", "accountant"],
    fallback: { depreciation_same_month_until_day: 15, payable_reminder_days_before: 3, first_close_requires_accountant_note: true },
    meta: {
      name: "Aturan akuntansi (penyusutan, pengingat utang, tutup buku pertama)",
      unit: null,
      reference: "US-M11-05 KP-2, US-M11-07 KP-3, US-M11-10 KP-5",
      description: "Awal penyusutan menurut tanggal perolehan, pengingat utang jurnal manual, dan syarat catatan akuntan pada tutup buku pertama (TG-8).",
    },
  }),
  /** Tambahan S5 (B-67, NFR-29): laporan biaya komunikasi/cloud/aplikasi bulanan M11 + anggaran. */
  "m11.it_cost_report": defineParam({
    schema: z
      .object({
        /** Kode akun beban komunikasi, cloud & aplikasi (termasuk anak akun) yang dijurnal manual bulanan. */
        account_codes: z.array(z.string().trim().min(1)).min(1, { error: "Isi minimal satu kode akun." }),
        /** Anggaran bulanan biaya komunikasi/cloud/aplikasi (0 = tanpa anggaran). */
        monthly_budget: rupiah,
      })
      .strict(),
    scopes: ["global", "tenant"],
    affectedRoles: ["owner", "finance_admin"],
    fallback: { account_codes: ["6-2001"], monthly_budget: 0 },
    meta: {
      name: "Laporan biaya komunikasi, cloud & WhatsApp bulanan",
      unit: null,
      reference: "NFR-29, US-P2-08 KP-3",
      description: "Akun beban yang dihitung sebagai biaya cloud/peta/GPS/aplikasi dan anggaran bulanannya; biaya pesan WhatsApp Business API dibaca dari catatan per pesan.",
    },
  }),
  // --- Tambahan modul P3 (Kemitraan RL-7 & Tahap 3) — hanya tambah ---
  "p3.partner_rules": defineParam({
    schema: z
      .object({
        /** Ruang kapasitas air untuk mitra (K22), rit/bulan. */
        capacity_room_trips_per_month: z.number().min(0),
        /** Komitmen air per mitra aktif (±11,4 rit/bulan, US-P3-01 KP-1). */
        commitment_trips_per_partner: z.number().min(0),
        /** Tunggakan langganan > N hari setelah teguran → mode baca-saja (US-P3-02 KP-4). */
        read_only_overdue_days: int(1),
        /** Batas pengajuan sengketa tagihan mitra sejak faktur terbit (US-P3-04 KP-2). */
        dispute_window_days: int(1),
        /** Pengingat sebelum kontrak berakhir (US-P3-01 KP-5). */
        contract_expiry_reminder_days: int(1),
        /** Ekspor data outlet untuk mitra yang berakhir (PTB-58). */
        data_export_days: int(1),
        /** Tanggal terbit laporan bulanan mitra (US-P3-10 KP-3). */
        monthly_report_day: int(1).max(28),
        /** Frekuensi audit pembina bawaan (bulan, BRD 9.5 "pembinaan bulanan"). */
        audit_interval_months: int(1),
        /** Tenggat tindak lanjut temuan audit (hari). */
        audit_follow_up_days: int(1),
        /** Uji air tidak lulus berturut → pemicu sanksi (US-P3-05 KP-3). */
        consecutive_failed_tests: int(1),
        /** Batas harga jual mitra terhadap harga anjuran EQUA (US-P3-02 KP-1, PTB-56). */
        price_min_percent_of_recommended: pct,
        price_max_percent_of_recommended: z.number().min(0).max(1000),
        /** Kas awal tetap maksimal yang boleh diatur mitra (US-P3-02 KP-1). */
        opening_cash_max: rupiah,
        /** Ambang void minimal/maksimal yang boleh diatur mitra. */
        void_threshold_min: rupiah,
        void_threshold_max: rupiah,
        /** POS tidak dipakai N hari → pemicu sanksi (US-P3-07 KP-1). */
        pos_unused_days: int(1),
        /** Butir daftar periksa mutu harian yang wajib berfoto bukti (US-P3-05 KP-1; kunci label `partner_quality_item`). */
        quality_photo_items: z.array(z.string().min(1)).max(20),
      })
      .strict(),
    affectedRoles: ["regional_coach", "finance_admin"],
    fallback: {
      capacity_room_trips_per_month: 57,
      commitment_trips_per_partner: 11.4,
      read_only_overdue_days: 30,
      dispute_window_days: 7,
      contract_expiry_reminder_days: 60,
      data_export_days: 30,
      monthly_report_day: 5,
      audit_interval_months: 1,
      audit_follow_up_days: 14,
      consecutive_failed_tests: 2,
      price_min_percent_of_recommended: 80,
      price_max_percent_of_recommended: 150,
      opening_cash_max: 500_000,
      void_threshold_min: 20_000,
      void_threshold_max: 200_000,
      pos_unused_days: 3,
      quality_photo_items: ["sterilization", "reservoir"],
    },
    meta: {
      name: "Aturan kemitraan (kapasitas, baca-saja, sengketa, kontrak, laporan bulanan, audit, batas pengaturan mitra)",
      unit: null,
      reference: "US-P3-01..11, BRD 9.5–9.9, K22, PTB-56, PTB-58",
      description:
        "Ruang kapasitas air mitra & komitmen per mitra (K22), mode baca-saja setelah teguran, jendela sengketa, pengingat kontrak berakhir, ekspor data saat berakhir, tanggal laporan bulanan, audit & uji air, serta batas harga/kas awal/ambang void yang boleh diatur mitra.",
    },
  }),
  "p3.quality_weights": defineParam({
    schema: z.object({ checklist: pct, audit: pct, test: pct }).strict(),
    affectedRoles: ["regional_coach"],
    fallback: { checklist: 30, audit: 40, test: 30 },
    meta: {
      name: "Bobot skor mutu mitra (daftar periksa / audit / uji air)",
      unit: "%",
      reference: "US-P3-05 KP-4",
      description: "Skor mutu bulanan per outlet = gabungan berbobot; bobot ditetapkan pemilik (jumlah bobot dinormalisasi).",
    },
  }),
  "p3.economics_illustration": defineParam({
    schema: z
      .object({
        /** Ilustrasi pendapatan EQUA per mitra per bulan (BRD 9.7) — pembanding ekonomi kemitraan (US-P3-06 KP-3). */
        water_per_month: rupiah,
        spare_part_per_month: rupiah,
        subscription_per_month: rupiah,
        royalty_per_month: rupiah,
      })
      .strict(),
    affectedRoles: ["owner"],
    fallback: { water_per_month: 3_420_000, spare_part_per_month: 500_000, subscription_per_month: 150_000, royalty_per_month: 0 },
    meta: {
      name: "Ilustrasi ekonomi kemitraan per mitra per bulan (BRD 9.7)",
      unit: "Rp/bulan",
      reference: "US-P3-06 KP-3, BRD 9.7",
      description: "Pendapatan EQUA yang diharapkan per mitra per bulan (air, spare part, langganan, royalti) sebagai pembanding angka nyata di dashboard ekonomi kemitraan.",
    },
  }),

  // --- Tambahan modul P2 (Aplikasi Pelanggan, Tahap 2) — hanya tambah ---
  /** Angka aturan aplikasi pelanggan yang disebut PRD Bab 8 tanpa nomor PAR (8.6, US-P2-01..06). */
  "p2.customer_app_rules": defineParam({
    schema: z
      .object({
        /** 8.6: sesi pelanggan berlaku N hari. */
        session_days: int(1),
        /** 8.6: pembayaran wajib verifikasi ulang OTP dalam N menit terakhir. */
        payment_reverify_minutes: int(1),
        /** Jeda minimal kirim ulang OTP (detik). */
        otp_resend_seconds: int(0),
        /** Batas permintaan OTP per nomor per jam (cegah penyalahgunaan). */
        otp_max_requests_per_hour: int(1),
        /** US-P2-01 KP-2: nama yang diketik pelanggan dianggap cocok dengan pelanggan M1 bila kemiripan ≥ N%. */
        name_match_min_pct: pct,
        /** US-P2-02 KP-2: tanggal kirim yang dapat dipesan dari aplikasi (hari ke depan). */
        order_horizon_days: int(1),
        /** US-P2-04 KP-1: riwayat pesanan N bulan. */
        history_months: int(1),
        /** US-P2-05 KP-2: minimal N pesanan selesai sebelum rata-rata jarak antar pesanan dipakai. */
        refill_min_orders: int(2),
        /** US-P2-05 KP-2: pengingat dikirim H-N dari perkiraan tanggal pesan berikutnya. */
        refill_days_before: int(0),
        /** US-P2-03: interval penyegaran posisi truk di aplikasi (detik). */
        tracking_refresh_seconds: int(5),
        /** US-P2-01 KP-5: versi naskah persetujuan UU PDP yang ditampilkan saat daftar. */
        consent_version: z.string().min(1),
        /** US-P2-03 KP-3: nomor telepon kantor (Dispatcher) untuk tombol "Hubungi kantor". */
        office_phone: z.string().min(5),
      })
      .strict(),
    affectedRoles: ["dispatcher", "owner"],
    fallback: {
      session_days: 30,
      payment_reverify_minutes: 15,
      otp_resend_seconds: 60,
      otp_max_requests_per_hour: 5,
      name_match_min_pct: 60,
      order_horizon_days: 14,
      history_months: 24,
      refill_min_orders: 3,
      refill_days_before: 2,
      tracking_refresh_seconds: 30,
      consent_version: "2026-09",
      office_phone: "0263-000000",
    },
    meta: {
      name: "Aturan aplikasi pelanggan (sesi, OTP, pemesanan, riwayat, pengingat isi ulang, kontak kantor)",
      unit: null,
      reference: "PRD 8.6, US-P2-01 KP-2/KP-5, US-P2-02 KP-2, US-P2-03 KP-3, US-P2-04 KP-1, US-P2-05 KP-2",
      description:
        "Sesi pelanggan 30 hari dengan verifikasi ulang OTP untuk pembayaran, pembatasan permintaan OTP, ambang kemiripan nama saat menautkan nomor WA ke pelanggan lama, jangkauan tanggal pemesanan, riwayat 24 bulan, pengingat isi ulang H-2, dan nomor telepon kantor untuk tombol \"Hubungi kantor\".",
    },
  }),
  /** Pembayaran digital (PTB-50): biaya gerbang dibukukan sebagai beban; masa berlaku QRIS/VA. */
  "p2.payment_rules": defineParam({
    schema: z
      .object({
        /** Biaya gerbang QRIS (% dari nilai transaksi). */
        qris_fee_percent: pct,
        /** Biaya gerbang virtual account per transaksi (Rp). */
        va_fee_amount: rupiah,
        /** Masa berlaku QRIS/VA (menit). */
        intent_valid_minutes: int(5),
        /** Bank virtual account bawaan (kode Midtrans: bca, bni, bri, permata). */
        va_bank: z.enum(["bca", "bni", "bri", "permata"]),
      })
      .strict(),
    affectedRoles: ["finance_admin", "owner"],
    fallback: { qris_fee_percent: 0.7, va_fee_amount: 4_000, intent_valid_minutes: 60, va_bank: "bca" },
    meta: {
      name: "Pembayaran digital pelanggan (biaya gerbang, masa berlaku QRIS/VA)",
      unit: null,
      reference: "PTB-50, US-P2-04 KP-3",
      description: "Biaya gerbang pembayaran (QRIS % / VA per transaksi) dibukukan sebagai beban (M11); masa berlaku kode bayar; bank VA bawaan.",
    },
  }),
  /** Tarif per pesan WhatsApp Business API per kategori Meta (NFR-29, US-P2-08 KP-3). */
  "p2.wa_pricing": defineParam({
    schema: z.object({ utility: rupiah, authentication: rupiah, marketing: rupiah, service: rupiah }).strict(),
    affectedRoles: ["owner", "finance_admin"],
    fallback: { utility: 320, authentication: 480, marketing: 660, service: 0 },
    meta: {
      name: "Tarif pesan WhatsApp Business API per kategori",
      unit: "Rp per pesan",
      reference: "NFR-29, US-P2-08 KP-3",
      description: "Dipakai mencatat biaya per pesan tertagih dari status webhook WhatsApp Cloud API; sesuaikan dengan tagihan Meta.",
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
