/**
 * Potret katalog skema Postgres `public` (S5-C, migrasi produksi) — dipakai untuk MEMBANDINGKAN dua basis data secara
 * otomatis: hasil `pnpm db:migrate` (migrasi `drizzle/` + pengerasan) vs hasil `pnpm db:push` (pre-push + push +
 * pengerasan). Uji: `tests/db/migrations.test.ts`; alat produksi: `pnpm db:verify` (DB terkonfigurasi vs PGlite segar).
 *
 * Yang dipotret: enum (+ urutan label), kolom (tipe, NULL, bawaan, identitas/generated), constraint (definisi lengkap,
 * deferrable), indeks (definisi), trigger (definisi, aktif), fungsi (definisi), urutan (sequence), view. Skema
 * `drizzle` (tabel jurnal migrasi `__drizzle_migrations`) sengaja DIABAIKAN karena hanya ada pada DB hasil migrasi.
 * Urutan kolom (ordinal) juga diabaikan: DB lama yang ditambah kolom lewat ALTER boleh berbeda urutan.
 *
 * Bukan untuk kode aplikasi (hanya skrip & uji).
 */
import { sql } from "drizzle-orm";

import type { DbOrTx } from "./client";

export type SchemaSnapshot = {
  enums: Record<string, string[]>;
  columns: Record<string, string>;
  constraints: Record<string, string>;
  indexes: Record<string, string>;
  triggers: Record<string, string>;
  functions: Record<string, string>;
  sequences: string[];
  views: Record<string, string>;
};

type Row = Record<string, unknown>;

async function rows<T extends Row>(db: DbOrTx, query: ReturnType<typeof sql>): Promise<T[]> {
  const res = await db.execute<T>(query);
  return res.rows as unknown as T[];
}

/** Normalisasi spasi agar perbedaan format pencetakan tidak dianggap perbedaan skema. */
function norm(text: unknown): string {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Potret katalog skema `public` (lihat komentar berkas). */
export async function describeSchema(db: DbOrTx): Promise<SchemaSnapshot> {
  const enums: Record<string, string[]> = {};
  for (const r of await rows<{ name: string; label: string }>(
    db,
    sql`select t.typname as name, e.enumlabel as label
          from pg_type t
          join pg_enum e on e.enumtypid = t.oid
          join pg_namespace n on n.oid = t.typnamespace
         where n.nspname = 'public'
         order by t.typname, e.enumsortorder`,
  )) {
    (enums[r.name] ??= []).push(r.label);
  }

  const columns: Record<string, string> = {};
  for (const r of await rows<{
    table_name: string;
    column_name: string;
    data_type: string;
    udt_name: string;
    is_nullable: string;
    column_default: string | null;
    character_maximum_length: number | null;
    numeric_precision: number | null;
    numeric_scale: number | null;
    is_identity: string;
    is_generated: string;
    generation_expression: string | null;
  }>(
    db,
    sql`select c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default,
               c.character_maximum_length, c.numeric_precision, c.numeric_scale, c.is_identity, c.is_generated,
               c.generation_expression
          from information_schema.columns c
          join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
         where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
         order by c.table_name, c.column_name`,
  )) {
    columns[`${r.table_name}.${r.column_name}`] = [
      r.data_type,
      r.udt_name,
      r.is_nullable === "YES" ? "null" : "not null",
      `default=${norm(r.column_default)}`,
      r.character_maximum_length != null ? `len=${r.character_maximum_length}` : "",
      r.data_type === "numeric" ? `num=${r.numeric_precision},${r.numeric_scale}` : "",
      r.is_identity === "YES" ? "identity" : "",
      r.is_generated === "ALWAYS" ? `generated=${norm(r.generation_expression)}` : "",
    ]
      .filter(Boolean)
      .join(" | ");
  }

  const constraints: Record<string, string> = {};
  for (const r of await rows<{ table_name: string; name: string; type: string; def: string; deferrable: boolean; deferred: boolean }>(
    db,
    sql`select cl.relname as table_name, co.conname as name, co.contype::text as type,
               pg_get_constraintdef(co.oid, true) as def, co.condeferrable as deferrable, co.condeferred as deferred
          from pg_constraint co
          join pg_class cl on cl.oid = co.conrelid
          join pg_namespace n on n.oid = cl.relnamespace
         where n.nspname = 'public'
         order by cl.relname, co.conname`,
  )) {
    constraints[`${r.table_name}.${r.name}`] = `${r.type} ${norm(r.def)}${r.deferrable ? ` DEFERRABLE${r.deferred ? " INITIALLY DEFERRED" : ""}` : ""}`;
  }

  const indexes: Record<string, string> = {};
  for (const r of await rows<{ tablename: string; indexname: string; indexdef: string }>(
    db,
    sql`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by tablename, indexname`,
  )) {
    indexes[`${r.tablename}.${r.indexname}`] = norm(r.indexdef);
  }

  const triggers: Record<string, string> = {};
  for (const r of await rows<{ table_name: string; name: string; def: string; enabled: string }>(
    db,
    sql`select cl.relname as table_name, tg.tgname as name, pg_get_triggerdef(tg.oid, true) as def, tg.tgenabled::text as enabled
          from pg_trigger tg
          join pg_class cl on cl.oid = tg.tgrelid
          join pg_namespace n on n.oid = cl.relnamespace
         where n.nspname = 'public' and not tg.tgisinternal
         order by cl.relname, tg.tgname`,
  )) {
    triggers[`${r.table_name}.${r.name}`] = `${norm(r.def)} [${r.enabled}]`;
  }

  const functions: Record<string, string> = {};
  for (const r of await rows<{ name: string; args: string; def: string }>(
    db,
    sql`select p.proname as name, pg_get_function_identity_arguments(p.oid) as args, pg_get_functiondef(p.oid) as def
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prokind in ('f', 'p')
         order by p.proname, 2`,
  )) {
    functions[`${r.name}(${r.args})`] = norm(r.def);
  }

  const sequences = (
    await rows<{ name: string }>(
      db,
      sql`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'S' order by 1`,
    )
  ).map((r) => r.name);

  const views: Record<string, string> = {};
  for (const r of await rows<{ name: string; def: string }>(
    db,
    sql`select c.relname as name, pg_get_viewdef(c.oid, true) as def from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('v', 'm') order by 1`,
  )) {
    views[r.name] = norm(r.def);
  }

  return { enums, columns, constraints, indexes, triggers, functions, sequences, views };
}

export type SchemaDifference = { kind: keyof SchemaSnapshot; key: string; expected: string | null; actual: string | null };

/**
 * Bandingkan dua potret. `expected` = acuan (mis. hasil push/PGlite segar), `actual` = yang diperiksa. Kosong = identik.
 */
export function diffSchemas(expected: SchemaSnapshot, actual: SchemaSnapshot): SchemaDifference[] {
  const out: SchemaDifference[] = [];
  const kinds = Object.keys(expected) as (keyof SchemaSnapshot)[];
  for (const kind of kinds) {
    const a = toRecord(expected[kind]);
    const b = toRecord(actual[kind]);
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const ea = a[key] ?? null;
      const eb = b[key] ?? null;
      if (ea !== eb) out.push({ kind, key, expected: ea, actual: eb });
    }
  }
  return out.sort((x, y) => (x.kind === y.kind ? x.key.localeCompare(y.key) : x.kind.localeCompare(y.kind)));
}

function toRecord(value: SchemaSnapshot[keyof SchemaSnapshot]): Record<string, string> {
  if (Array.isArray(value)) return Object.fromEntries(value.map((v) => [v, "ada"]));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v]));
}

/** Ringkasan perbedaan yang mudah dibaca (untuk pesan uji / keluaran `pnpm db:verify`). */
export function formatSchemaDifferences(diffs: readonly SchemaDifference[], limit = 40): string {
  const lines = diffs
    .slice(0, limit)
    .map((d) => `- [${d.kind}] ${d.key}\n    acuan : ${d.expected ?? "(tidak ada)"}\n    diuji : ${d.actual ?? "(tidak ada)"}`);
  if (diffs.length > limit) lines.push(`… dan ${diffs.length - limit} perbedaan lain`);
  return lines.join("\n");
}

/** Jumlah objek per jenis (untuk laporan singkat). */
export function schemaObjectCounts(snapshot: SchemaSnapshot): Record<keyof SchemaSnapshot, number> {
  return {
    enums: Object.keys(snapshot.enums).length,
    columns: Object.keys(snapshot.columns).length,
    constraints: Object.keys(snapshot.constraints).length,
    indexes: Object.keys(snapshot.indexes).length,
    triggers: Object.keys(snapshot.triggers).length,
    functions: Object.keys(snapshot.functions).length,
    sequences: snapshot.sequences.length,
    views: Object.keys(snapshot.views).length,
  };
}
