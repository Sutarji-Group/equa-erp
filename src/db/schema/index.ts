/**
 * Skema Drizzle EQUA — SATU BERKAS PER MODUL + core.ts (docs/ARCHITECTURE.md §2). Relasi (`relations()`) didefinisikan
 * di berkas pemilik tabel (satu `relations()` per tabel; tipe Drizzle tidak menggabungkan beberapa deklarasi).
 *
 * Aturan impor antar-berkas skema:
 * - `core.ts` tidak mengimpor berkas modul.
 * - Berkas modul hanya memakai enum/pembantu dari `core`/`_columns` + enum miliknya di tingkat atas; tabel modul lain
 *   hanya dirujuk di dalam callback lazy (`.references(() => …)`, `relations(…, () => …)`), sehingga siklus impor aman.
 * - Enum yang dipakai > 1 modul didefinisikan di `core.ts`.
 */
export * from "./core";
export * from "./m1-master";
export * from "./m2-orders";
export * from "./m3-driver";
export * from "./m4-cash";
export * from "./m5-receivables";
export * from "./m6-pos";
export * from "./m7-store";
export * from "./m8-production";
export * from "./m9-reports";
export * from "./m11-accounting";
export * from "./m12-fleet";
export * from "./p2-customer";
export * from "./p3-partner";
