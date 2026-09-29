/**
 * Pengerasan basis data (NFR-11, NFR-30, Bab 6.1, Bab 6.7, BR-32, BR-38). Sumber kebenaran: `src/db/sql/hardening.sql`
 * (idempoten) — trigger penolak DELETE/TRUNCATE, tabel append-only (jejak & buku besar), penjaga kolom imutabel
 * transaksi tersimpan/terposting, penjaga jurnal (seimbang, periode, cut-over), dan FK komposit tenant.
 *
 * Dipakai oleh: `pnpm db:push`, `pnpm db:migrate`, dan harness uji (`tests/helpers/db.ts`). Bukan untuk kode aplikasi
 * (membaca berkas dari disk). Tabel baru otomatis tercakup trigger no-delete saat `applyDbHardening()` dijalankan ulang.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";

import type { Db, DbOrTx, DbTransaction } from "./client";

/** Jalur berkas SQL relatif terhadap akar proyek. */
export const HARDENING_SQL_RELATIVE_PATH = "src/db/sql/hardening.sql";

/** Tabel teknis sementara yang BOLEH dihapus barisnya (dikecualikan dari trigger penolak DELETE). */
export const DELETABLE_TECHNICAL_TABLES = [
  "sessions",
  "customer_sessions",
  "otp_codes",
  "push_subscriptions",
  "job_runs",
] as const;

/** Jejak append-only: UPDATE & DELETE ditolak siapa pun (NFR-11, US-M10-05 KP-2). */
export const AUDIT_APPEND_ONLY_TABLES = ["audit_logs", "access_logs", "domain_events"] as const;

/**
 * Buku besar / ledger / alokasi / riwayat aksi lapangan: UPDATE ditolak (EQ002); DELETE sudah ditolak (EQ001).
 * Koreksi = baris pembalik (`reversal_of_id`, jumlah berlawanan). Pengecualian: baris jurnal yang induknya masih
 * Draf/Ditolak boleh diubah (jurnal manual yang sedang disusun).
 */
export const LEDGER_APPEND_ONLY_TABLES = [
  "journal_lines",
  "stock_ledger",
  "outlet_water_ledger",
  "payment_allocations",
  "supplier_payment_allocations",
  "office_cash_movements",
  "trip_status_events",
] as const;

/** Semua tabel bertrigger `equa_append_only` (jejak + buku). */
export const APPEND_ONLY_TABLES = [...AUDIT_APPEND_ONLY_TABLES, ...LEDGER_APPEND_ONLY_TABLES] as const;

/**
 * Penjaga kolom imutabel (trigger `equa_immutable`, EQ003). `immutable` = kolom terkunci; `once` = boleh diisi sekali
 * selama masih NULL; `allowOnly` = HANYA kolom ini yang boleh berubah (kolom lain terkunci); `when` = syarat trigger.
 * Daftar lengkap kolom yang boleh berubah per tabel ada di komentar hardening.sql bagian 3. Harus sinkron dengan
 * hardening.sql (diuji di tests/db/hardening.test.ts).
 */
export const IMMUTABLE_COLUMN_GUARDS = {
  journals: {
    when: "OLD.status = 'posted'",
    allowOnly: ["owner_reviewed_at", "owner_reviewed_by", "auto_reverse_on", "updated_at"],
  },
  trip_payments: {
    immutable: [
      "tenant_id",
      "trip_id",
      "customer_id",
      "driver_user_id",
      "method",
      "original_method",
      "expected_amount",
      "received_amount",
      "underpayment_amount",
      "business_date",
      "reversal_of_id",
      "device_time",
      "recorded_by_office",
    ],
  },
  customer_payments: {
    immutable: [
      "tenant_id",
      "customer_id",
      "channel",
      "method",
      "amount",
      "advance_amount",
      "business_date",
      "trip_id",
      "driver_user_id",
      "reversal_of_id",
      "device_time",
      "recorded_by_office",
    ],
  },
  pos_sales: {
    immutable: [
      "tenant_id",
      "outlet_id",
      "shift_id",
      "local_number",
      "device_seq",
      "device_id",
      "operator_user_id",
      "customer_id",
      "price_kind",
      "business_date",
      "sold_at",
      "subtotal",
      "discount_percent",
      "discount_amount",
      "total",
      "payment_method",
      "cash_received",
      "change_amount",
      "replaces_sale_id",
      "reversal_of_id",
      "is_reversal",
      "device_time",
      "recorded_by_office",
    ],
    once: ["number"],
  },
  pos_sale_lines: {
    immutable: [
      "pos_sale_id",
      "tenant_id",
      "outlet_id",
      "business_date",
      "line_no",
      "product_id",
      "product_price_id",
      "quantity",
      "unit_price",
      "line_total",
      "gallon_size_l",
    ],
    once: ["unit_cost"],
  },
  meter_readings: {
    immutable: [
      "tenant_id",
      "water_source_id",
      "water_meter_id",
      "business_date",
      "phase",
      "reading_l",
      "read_at",
      "device_time",
      "recorded_by_office",
    ],
  },
  truck_fills: {
    immutable: [
      "tenant_id",
      "water_source_id",
      "truck_id",
      "business_date",
      "volume_l",
      "filled_at",
      "reversal_of_id",
      "device_time",
      "recorded_by_office",
    ],
    once: ["trip_id"],
  },
  invoices: {
    immutable: ["tenant_id", "kind", "customer_id", "amount", "issue_date", "is_opening_balance"],
    once: ["trip_id", "pos_sale_id"],
  },
  // Tambahan S5 (B-59, US-M9-01 KP-6, 7.9.7): ringkasan H+0 yang sudah TERBIT terkunci — koreksi/terlambat sinkron
  // hanya lewat addendum (`daily_summary_addenda`). Boleh berubah: status (Terbit → Ditinjau pemilik), reviewed_by,
  // reviewed_at, updated_at.
  daily_summaries: {
    when: "OLD.status <> 'running'",
    immutable: ["tenant_id", "business_date", "snapshot", "cash_day_id", "cash_closed_at", "published_at", "published_late"],
  },
} as const satisfies Record<
  string,
  { when?: string; immutable?: readonly string[]; once?: readonly string[]; allowOnly?: readonly string[] }
>;

/**
 * FK komposit tenant (NFR-30) yang dikelola hardening.sql (bukan drizzle-kit). Tujuan: `(id, tenant_id)` tabel rujukan
 * (indeks unik `outlets_id_tenant_uq`, `employees_id_tenant_uq`, `shifts_id_tenant_uq`).
 */
export const TENANT_FOREIGN_KEYS = [
  { table: "users", name: "users_employee_tenant_fk", columns: ["employee_id", "tenant_id"], references: "employees" },
  { table: "shifts", name: "shifts_outlet_tenant_fk", columns: ["outlet_id", "tenant_id"], references: "outlets" },
  { table: "shift_stock_counts", name: "shift_stock_counts_outlet_tenant_fk", columns: ["outlet_id", "tenant_id"], references: "outlets" },
  { table: "shift_stock_counts", name: "shift_stock_counts_shift_tenant_fk", columns: ["shift_id", "tenant_id"], references: "shifts" },
  { table: "pos_sales", name: "pos_sales_outlet_tenant_fk", columns: ["outlet_id", "tenant_id"], references: "outlets" },
  { table: "pos_sales", name: "pos_sales_shift_tenant_fk", columns: ["shift_id", "tenant_id"], references: "shifts" },
  { table: "pos_sale_lines", name: "pos_sale_lines_outlet_tenant_fk", columns: ["outlet_id", "tenant_id"], references: "outlets" },
  { table: "stock_ledger", name: "stock_ledger_outlet_tenant_fk", columns: ["outlet_id", "tenant_id"], references: "outlets" },
  { table: "stock_balances", name: "stock_balances_outlet_tenant_fk", columns: ["outlet_id", "tenant_id"], references: "outlets" },
  { table: "stock_counts", name: "stock_counts_outlet_tenant_fk", columns: ["outlet_id", "tenant_id"], references: "outlets" },
  { table: "consumable_receipts", name: "consumable_receipts_outlet_tenant_fk", columns: ["outlet_id", "tenant_id"], references: "outlets" },
  { table: "water_supply_receipts", name: "water_supply_receipts_outlet_tenant_fk", columns: ["outlet_id", "tenant_id"], references: "outlets" },
  { table: "outlet_water_ledger", name: "outlet_water_ledger_outlet_tenant_fk", columns: ["outlet_id", "tenant_id"], references: "outlets" },
  { table: "deposits", name: "deposits_outlet_tenant_fk", columns: ["outlet_id", "tenant_id"], references: "outlets" },
  { table: "deposits", name: "deposits_shift_tenant_fk", columns: ["shift_id", "tenant_id"], references: "shifts" },
  { table: "purchase_receipts", name: "purchase_receipts_outlet_tenant_fk", columns: ["outlet_id", "tenant_id"], references: "outlets" },
  { table: "reorder_items", name: "reorder_items_outlet_tenant_fk", columns: ["outlet_id", "tenant_id"], references: "outlets" },
  { table: "quality_checklists", name: "quality_checklists_outlet_tenant_fk", columns: ["outlet_id", "tenant_id"], references: "outlets" },
  { table: "product_prices", name: "product_prices_outlet_tenant_fk", columns: ["outlet_id", "tenant_id"], references: "outlets" },
  { table: "internal_transfers", name: "internal_transfers_from_outlet_tenant_fk", columns: ["from_outlet_id", "tenant_id"], references: "outlets" },
  { table: "internal_transfers", name: "internal_transfers_to_outlet_tenant_fk", columns: ["to_outlet_id", "tenant_id"], references: "outlets" },
] as const;

/** Indeks unik (id, tenant_id) tujuan FK komposit tenant (dikelola hardening.sql). */
export const TENANT_UNIQUE_INDEXES = ["outlets_id_tenant_uq", "employees_id_tenant_uq", "shifts_id_tenant_uq"] as const;

/**
 * Constraint/indeks yang dibuat hardening.sql di luar skema Drizzle. `scripts/db-push.ts` mengabaikan usulan drizzle-kit
 * untuk men-DROP objek ini (drizzle-kit tidak mengenalnya) agar `db:push` idempoten.
 */
export const HARDENING_MANAGED_CONSTRAINTS: readonly string[] = [
  ...TENANT_FOREIGN_KEYS.map((fk) => fk.name),
  ...TENANT_UNIQUE_INDEXES,
];

/**
 * Tabel yang boleh dihapus job retensi (US-M10-06 KP-3) bila transaksi menjalankan
 * `SET LOCAL equa.retention_purge = 'on'` (lihat `withRetentionPurge`).
 */
export const RETENTION_PURGE_TABLES = ["access_logs", "gps_positions"] as const;

/** SQLSTATE pelanggaran: penghapusan ditolak. */
export const SQLSTATE_NO_DELETE = "EQ001";
/** SQLSTATE pelanggaran: catatan append-only (jejak / baris buku) diubah atau dihapus. */
export const SQLSTATE_APPEND_ONLY = "EQ002";
/** SQLSTATE pelanggaran: kolom imutabel transaksi tersimpan/terposting diubah. */
export const SQLSTATE_IMMUTABLE = "EQ003";
/** SQLSTATE pelanggaran: jurnal terposting tidak seimbang (dicek saat COMMIT). */
export const SQLSTATE_JOURNAL_UNBALANCED = "EQ004";
/** SQLSTATE pelanggaran: posting ke periode akuntansi Ditutup/Dikunci. */
export const SQLSTATE_PERIOD_CLOSED = "EQ005";
/** SQLSTATE pelanggaran: jurnal bertanggal sebelum cut-over akuntansi (selain saldo awal). */
export const SQLSTATE_BEFORE_CUTOVER = "EQ006";

/** Semua SQLSTATE trigger pengerasan beserta pesan tindakan (Bahasa Indonesia) untuk lapisan layanan/UI. */
export const HARDENING_SQLSTATES = {
  [SQLSTATE_NO_DELETE]: "Data tidak boleh dihapus. Lakukan koreksi dengan transaksi pembalik beralasan atau nonaktifkan datanya.",
  [SQLSTATE_APPEND_ONLY]: "Catatan ini tidak dapat diubah. Lakukan koreksi dengan baris pembalik beralasan.",
  [SQLSTATE_IMMUTABLE]: "Nilai transaksi yang sudah tersimpan tidak dapat diubah. Lakukan koreksi dengan transaksi pembalik beralasan.",
  [SQLSTATE_JOURNAL_UNBALANCED]: "Jurnal tidak seimbang: total debit harus sama dengan total kredit. Periksa baris jurnal.",
  [SQLSTATE_PERIOD_CLOSED]: "Periode akuntansi sudah ditutup atau dikunci. Posting ke periode terbuka pertama.",
  [SQLSTATE_BEFORE_CUTOVER]: "Tanggal jurnal sebelum cut-over akuntansi; hanya jurnal saldo awal yang diizinkan.",
} as const;

export type HardeningSqlState = keyof typeof HARDENING_SQLSTATES;

/** Baca isi `hardening.sql`. `rootDir` bawaan = direktori kerja proses (akar proyek untuk skrip & uji). */
export function readHardeningSql(rootDir: string = process.cwd()): string {
  return readFileSync(path.join(rootDir, HARDENING_SQL_RELATIVE_PATH), "utf8");
}

/** Pecah skrip SQL pada penanda `--> statement-breakpoint` (konvensi drizzle-kit). */
export function splitSqlStatements(script: string): string[] {
  return script
    .split(/^-->\s*statement-breakpoint\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.replace(/--.*$/gm, "").trim().length > 0);
}

/** Terapkan trigger pengerasan ke basis data (idempoten). */
export async function applyDbHardening(db: DbOrTx, options: { rootDir?: string } = {}): Promise<void> {
  for (const statement of splitSqlStatements(readHardeningSql(options.rootDir))) {
    await db.execute(sql.raw(statement));
  }
}

/** Jalur skrip perbaikan data pra-push relatif terhadap akar proyek. */
export const PRE_PUSH_SQL_RELATIVE_PATH = "src/db/sql/pre-push.sql";

/**
 * Perbaikan data SEBELUM drizzle-kit push pada DB dev yang sudah berisi data (idempoten; no-op pada DB kosong):
 * menambah kolom NOT NULL baru beserta isinya (mis. `tenant_id` tabel anak) agar push tidak mengusulkan TRUNCATE.
 * Dipakai `scripts/db-push.ts`.
 */
export async function applyPrePushFixups(db: DbOrTx, options: { rootDir?: string } = {}): Promise<void> {
  const script = readFileSync(path.join(options.rootDir ?? process.cwd(), PRE_PUSH_SQL_RELATIVE_PATH), "utf8");
  for (const statement of splitSqlStatements(script)) {
    await db.execute(sql.raw(statement));
  }
}

/**
 * Benar bila pernyataan DDL usulan drizzle-kit hanya men-DROP objek yang dikelola hardening.sql
 * (`HARDENING_MANAGED_CONSTRAINTS`) — dipakai `scripts/db-push.ts` untuk menyaringnya.
 */
export function isHardeningManagedDrop(statement: string): boolean {
  const m = /^\s*(?:ALTER TABLE\s+"[^"]+"\s+DROP CONSTRAINT|DROP INDEX(?: IF EXISTS)?)\s+"(?:[^"]+"\.")?([^"]+)"\s*;?\s*$/i.exec(
    statement,
  );
  return Boolean(m && HARDENING_MANAGED_CONSTRAINTS.includes(m[1]!));
}

/**
 * Jalankan `fn` di dalam transaksi yang mengizinkan penghapusan retensi pada `RETENTION_PURGE_TABLES`
 * (akses log > PAR-29, posisi GPS mentah > PAR-52). Tabel lain tetap menolak DELETE.
 */
export async function withRetentionPurge<T>(db: Db, fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('equa.retention_purge', 'on', true)`);
    return fn(tx);
  });
}

/** SQLSTATE pengerasan (EQ001..EQ006) dari galat Drizzle/PGlite/pg, atau `undefined`. */
export function hardeningViolationCode(error: unknown): HardeningSqlState | undefined {
  const code = extractSqlState(error);
  return code && code in HARDENING_SQLSTATES ? (code as HardeningSqlState) : undefined;
}

/** Benar bila galat berasal dari trigger pengerasan (untuk dipetakan ke DomainError oleh lapisan layanan). */
export function isHardeningViolation(error: unknown): boolean {
  return hardeningViolationCode(error) !== undefined;
}

function extractSqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
