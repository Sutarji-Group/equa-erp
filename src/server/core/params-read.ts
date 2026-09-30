/**
 * Pembacaan parameter Lampiran B (tanpa ketergantungan ke RBAC/notifikasi — dipakai juga oleh notifikasi & job).
 * API publik ada di `./params.ts` (me-reexport berkas ini + `set`).
 *
 * Tambahan v1.0.1 (D-14 butir 4, B-90): `cached(tx)` → `ParamCache` (pembacaan bercache per transaksi/permintaan untuk
 * laporan rentang) + `invalidateParamCaches()`. `get`/`resolve`/`history`/`listCurrent` tidak berubah.
 */
import "server-only";

import { and, desc, eq, lte, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";

import { parameters } from "@/db/schema";
import { isBusinessDate, type BusinessDate } from "@/lib/time";

import { isTransaction, type Tx } from "./db";
import { DomainError } from "./errors";
import {
  isParamKey,
  PARAM_KEYS,
  PARAM_REGISTRY,
  paramMeta,
  type ParamDef,
  type ParamKey,
  type ParamMeta,
  type ParamScopeLevel,
  type ParamValue,
} from "./params-registry";

/** Lingkup pembacaan/penetapan: tenant dan/atau outlet. */
export type ParamScopeRef = { tenantId?: string | null; outletId?: string | null };

export type ParamResolution<K extends ParamKey> = {
  key: K;
  value: ParamValue<K>;
  /** `db` = dari tabel parameters; `default` = nilai bawaan seed/registri. */
  source: "db" | "default";
  scopeLevel: ParamScopeLevel;
  effectiveFrom: string | null;
  rowId: string | null;
};

export function schemaOf(key: ParamKey): z.ZodType {
  return (PARAM_REGISTRY[key] as ParamDef).schema;
}

function scopeCondition(scope: ParamScopeRef): SQL {
  const parts: SQL[] = [sql`(${parameters.tenantId} is null and ${parameters.outletId} is null)`];
  if (scope.tenantId) parts.push(sql`(${parameters.tenantId} = ${scope.tenantId} and ${parameters.outletId} is null)`);
  if (scope.outletId) parts.push(sql`(${parameters.outletId} = ${scope.outletId})`);
  return sql`(${sql.join(parts, sql` or `)})`;
}

function parseStored<K extends ParamKey>(key: K, value: unknown): ParamValue<K> {
  const result = schemaOf(key).safeParse(value);
  if (!result.success) {
    throw new DomainError(
      "PARAM_INVALID",
      `Nilai parameter ${key} di basis data tidak valid. Minta pemilik menetapkan ulang nilainya di Pengaturan > Parameter.`,
      { issues: result.error.issues.map((i) => i.message) },
    );
  }
  return result.data as ParamValue<K>;
}

/**
 * Nilai + asal nilai yang berlaku pada tanggal bisnis. Tanggal WAJIB (tinjauan pasca-F3c): pakai
 * `ctxBusinessDate(ctx)` — bukan jam dinding — agar transaksi offline memakai parameter hari transaksinya dan uji
 * yang mengendalikan waktu lewat `ctx.now` deterministik.
 */
export async function resolve<K extends ParamKey>(
  tx: Tx,
  key: K,
  businessDate: BusinessDate,
  scope: ParamScopeRef = {},
): Promise<ParamResolution<K>> {
  if (!isParamKey(key)) throw new DomainError("PARAM_UNKNOWN", `Parameter tidak dikenal: ${String(key)}.`);
  const date = businessDate;
  if (!isBusinessDate(date)) throw new DomainError("INVALID_DATE", `Tanggal tidak valid: ${date}.`);

  const specificity = sql<number>`case when ${parameters.outletId} is not null then 3 when ${parameters.tenantId} is not null then 2 else 1 end`;
  const rows = await tx
    .select({
      id: parameters.id,
      value: parameters.value,
      effectiveFrom: parameters.effectiveFrom,
      tenantId: parameters.tenantId,
      outletId: parameters.outletId,
    })
    .from(parameters)
    .where(and(eq(parameters.key, key), lte(parameters.effectiveFrom, date), scopeCondition(scope)))
    .orderBy(desc(specificity), desc(parameters.effectiveFrom))
    .limit(1);

  const row = rows[0];
  if (row) {
    return {
      key,
      value: parseStored(key, row.value),
      source: "db",
      scopeLevel: row.outletId ? "outlet" : row.tenantId ? "tenant" : "global",
      effectiveFrom: row.effectiveFrom,
      rowId: row.id,
    };
  }
  const meta = paramMeta(key);
  if (meta.defaultValue === undefined) {
    throw new DomainError(
      "PARAM_MISSING",
      `Parameter ${key} (${meta.name}) belum ditetapkan. Minta pemilik mengisinya di Pengaturan > Parameter.`,
    );
  }
  return {
    key,
    value: parseStored(key, meta.defaultValue),
    source: "default",
    scopeLevel: "global",
    effectiveFrom: null,
    rowId: null,
  };
}

/** Nilai parameter yang berlaku pada tanggal bisnis (bawaan: hari ini WIB). */
export async function get<K extends ParamKey>(
  tx: Tx,
  key: K,
  businessDate: BusinessDate,
  scope: ParamScopeRef = {},
): Promise<ParamValue<K>> {
  return (await resolve(tx, key, businessDate, scope)).value;
}

export type ParamHistoryRow = typeof parameters.$inferSelect;

/** Riwayat nilai parameter (terbaru dulu), opsional per lingkup. */
export async function history(tx: Tx, key: ParamKey, scope?: ParamScopeRef): Promise<ParamHistoryRow[]> {
  const conditions: SQL[] = [eq(parameters.key, key)];
  if (scope) conditions.push(scopeCondition(scope));
  return tx
    .select()
    .from(parameters)
    .where(and(...conditions))
    .orderBy(desc(parameters.effectiveFrom), desc(parameters.createdAt));
}

export type CurrentParam = ParamMeta & { value: unknown; source: "db" | "default"; effectiveFrom: string | null };

/** Semua parameter terdaftar beserta nilai yang berlaku (untuk halaman Pengaturan > Parameter). */
export async function listCurrent(tx: Tx, businessDate: BusinessDate, scope: ParamScopeRef = {}): Promise<CurrentParam[]> {
  const out: CurrentParam[] = [];
  for (const key of PARAM_KEYS) {
    const meta = paramMeta(key);
    try {
      const r = await resolve(tx, key, businessDate, scope);
      out.push({ ...meta, value: r.value, source: r.source, effectiveFrom: r.effectiveFrom });
    } catch {
      out.push({ ...meta, value: null, source: "default", effectiveFrom: null });
    }
  }
  return out;
}

// =====================================================================================================================
// Cache pembacaan per transaksi/permintaan (TAMBAHAN v1.0.1 — D-14 butir 4, B-90). API lama (`get`/`resolve`) TETAP
// membaca DB setiap kali; cache hanya dipakai bila pemanggil memintanya lewat `cached(tx)`.
// =====================================================================================================================

type CandidateRow = { id: string; value: unknown; effectiveFrom: string; tenantId: string | null; outletId: string | null };

/** Generasi global: dinaikkan setiap penetapan parameter → semua cache mengosongkan diri pada pembacaan berikutnya. */
let paramGeneration = 0;

/**
 * Tandai semua cache parameter basi. Dipanggil `params.set` dan penulis parameter lain (M10 ambang sinkron-kesehatan).
 * Cache hidup paling lama satu transaksi/permintaan; ini menjaga pembacaan SESUDAH penulisan di lingkup yang sama.
 */
export function invalidateParamCaches(): void {
  paramGeneration++;
}

/**
 * Pembaca parameter bercache untuk SATU transaksi/permintaan (buat lewat `cached(tx)`): satu kueri per (kunci, tenant,
 * outlet) memuat semua baris kandidat (riwayat nilai semua lingkup yang berlaku), lalu nilai untuk tiap tanggal
 * diselesaikan di memori dengan aturan yang SAMA dengan `resolve` — lingkup paling spesifik menang, lalu
 * `effective_from` terbaru ≤ tanggal; tanpa baris → bawaan registri; galat & pesan sama. Kunci cache memuat tenant &
 * outlet dan tanggal diselesaikan per panggilan, jadi tidak ada kebocoran antar tenant/outlet/tanggal. Nilai di-parse
 * ulang setiap panggilan (objek baru — aman dimutasi pemanggil).
 */
export class ParamCache {
  private readonly rows = new Map<string, Promise<CandidateRow[]>>();
  private generation = paramGeneration;
  /** Jumlah kueri DB yang dijalankan cache ini (pengukuran/uji). */
  queries = 0;

  constructor(private readonly tx: Tx) {}

  private candidates(key: ParamKey, scope: ParamScopeRef): Promise<CandidateRow[]> {
    if (this.generation !== paramGeneration) {
      this.rows.clear();
      this.generation = paramGeneration;
    }
    const cacheKey = `${key}|${scope.tenantId ?? ""}|${scope.outletId ?? ""}`;
    const hit = this.rows.get(cacheKey);
    if (hit) return hit;
    const specificity = sql<number>`case when ${parameters.outletId} is not null then 3 when ${parameters.tenantId} is not null then 2 else 1 end`;
    this.queries++;
    const pending: Promise<CandidateRow[]> = this.tx
      .select({
        id: parameters.id,
        value: parameters.value,
        effectiveFrom: parameters.effectiveFrom,
        tenantId: parameters.tenantId,
        outletId: parameters.outletId,
      })
      .from(parameters)
      .where(and(eq(parameters.key, key), scopeCondition(scope)))
      .orderBy(desc(specificity), desc(parameters.effectiveFrom))
      .then((rows) => rows);
    this.rows.set(cacheKey, pending);
    // Kueri gagal tidak disimpan (pembacaan berikutnya mencoba lagi); galat tetap diteruskan ke pemanggil.
    pending.catch(() => {
      if (this.rows.get(cacheKey) === pending) this.rows.delete(cacheKey);
    });
    return pending;
  }

  /** Sama dengan `resolve(tx, key, tanggal, lingkup)`, tanpa kueri berulang. */
  async resolve<K extends ParamKey>(key: K, businessDate: BusinessDate, scope: ParamScopeRef = {}): Promise<ParamResolution<K>> {
    if (!isParamKey(key)) throw new DomainError("PARAM_UNKNOWN", `Parameter tidak dikenal: ${String(key)}.`);
    const date = businessDate;
    if (!isBusinessDate(date)) throw new DomainError("INVALID_DATE", `Tanggal tidak valid: ${date}.`);
    // Kandidat urut (spesifisitas turun, effective_from turun) → baris pertama yang sudah berlaku = hasil `resolve`.
    const row = (await this.candidates(key, scope)).find((r) => r.effectiveFrom <= date);
    if (row) {
      return {
        key,
        value: parseStored(key, row.value),
        source: "db",
        scopeLevel: row.outletId ? "outlet" : row.tenantId ? "tenant" : "global",
        effectiveFrom: row.effectiveFrom,
        rowId: row.id,
      };
    }
    const meta = paramMeta(key);
    if (meta.defaultValue === undefined) {
      throw new DomainError(
        "PARAM_MISSING",
        `Parameter ${key} (${meta.name}) belum ditetapkan. Minta pemilik mengisinya di Pengaturan > Parameter.`,
      );
    }
    return { key, value: parseStored(key, meta.defaultValue), source: "default", scopeLevel: "global", effectiveFrom: null, rowId: null };
  }

  /** Sama dengan `get(tx, key, tanggal, lingkup)`, tanpa kueri berulang. */
  async get<K extends ParamKey>(key: K, businessDate: BusinessDate, scope: ParamScopeRef = {}): Promise<ParamValue<K>> {
    return (await this.resolve(key, businessDate, scope)).value;
  }
}

const cacheByTx = new WeakMap<object, ParamCache>();

/**
 * Cache parameter TERIKAT ke objek `tx` (tambahan v1.0.1):
 * - `tx` = transaksi/savepoint → satu cache yang sama untuk semua pemanggil dalam transaksi itu, ikut dibuang bersama
 *   objek transaksinya (WeakMap) — tidak pernah terbawa ke permintaan/transaksi lain.
 * - `tx` = instans db tanpa transaksi (`getDb()` dipakai bersama seluruh proses) → cache BARU setiap panggilan dan
 *   TIDAK disimpan; pemanggil memegang referensinya selama satu permintaan (mis. satu render dashboard) lalu dibuang.
 * Contoh: `const pc = params.cached(tx); for (const d of dates) await pc.get("PAR-07", d, { tenantId })` → 1 kueri.
 */
export function cached(tx: Tx): ParamCache {
  if (!isTransaction(tx)) return new ParamCache(tx);
  let cache = cacheByTx.get(tx);
  if (!cache) {
    cache = new ParamCache(tx);
    cacheByTx.set(tx, cache);
  }
  return cache;
}
