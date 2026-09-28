/**
 * Pembantu kolom Drizzle yang dipakai seluruh skema (konvensi docs/ARCHITECTURE.md §3 & CLAUDE.md aturan 6):
 * - PK `uuid` diisi aplikasi dengan UUID v7 (`newId`) — ID dapat dibuat di perangkat untuk antrean offline.
 * - Waktu = `timestamptz` (UTC); tanggal bisnis = `date` string 'YYYY-MM-DD' (WIB, src/lib/time.ts).
 * - Uang = `bigint` mode number (rupiah bulat); volume = `integer` liter; jarak = `integer` meter.
 * - Koordinat = `double precision` (derajat desimal WGS84).
 *
 * Berkas ini sengaja memakai impor relatif (bukan alias `@/`) agar dapat dimuat drizzle-kit CLI.
 * Kolom yang merujuk tabel inti (users, devices) ada di `core.ts` (`createdBy`, `fieldMeta`, `deactivation`).
 */
import { bigint, date, doublePrecision, integer, numeric, timestamp, uuid } from "drizzle-orm/pg-core";

import { newId } from "../../lib/ids";

/** Kolom PK `id uuid` — diisi UUID v7 oleh aplikasi (atau ID klien untuk perintah offline). */
export const pk = () => uuid("id").primaryKey().$defaultFn(newId);

/** Kolom `timestamptz` (mode Date). */
export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** `created_at` + `updated_at` (timestamptz, diisi otomatis; `updated_at` diperbarui Drizzle saat UPDATE). */
export const timestamps = () => ({
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Hanya `created_at` — untuk tabel catatan yang tidak pernah diperbarui (log, riwayat). */
export const createdAtOnly = () => ({
  createdAt: tstz("created_at").notNull().defaultNow(),
});

/** Uang: rupiah bulat (`bigint`, mode number — aman sampai 2^53). */
export const money = (name: string) => bigint(name, { mode: "number" });

/** Volume air dalam liter bulat. */
export const liters = (name: string) => integer(name);

/** Pembacaan meter kumulatif dalam liter (dapat melampaui 2^31). */
export const meterLiters = (name: string) => bigint(name, { mode: "number" });

/** Jarak dalam meter bulat. */
export const meters = (name: string) => integer(name);

/** Tanggal bisnis/kalender WIB 'YYYY-MM-DD'. Bawaan nama kolom `business_date`. */
export const businessDate = (name = "business_date") => date(name, { mode: "string" });

/** Tanggal kalender biasa 'YYYY-MM-DD'. */
export const dateStr = (name: string) => date(name, { mode: "string" });

/** Lintang/bujur (derajat desimal). */
export const coord = (name: string) => doublePrecision(name);

/** Persentase dengan 2 desimal (mis. susut 5,25%) — mode number. */
export const percent = (name: string) => numeric(name, { precision: 7, scale: 2, mode: "number" });

/** Kolom FK uuid tanpa `.references()` (dipakai bila rujukan bersifat polimorfik: object_type + object_id). */
export const refId = (name: string) => uuid(name);
