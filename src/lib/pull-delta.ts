/**
 * Pull bersyarat — protokol sinkron v2 (D-14 butir 3, B-89; isomorfik: server `src/server/core/sync/conditional.ts`,
 * klien `src/client/offline/pull.ts`).
 *
 * Permintaan: `GET /api/sync/pull?v=2&c.<kunci>=<kursor>&…` — `v=2` menandai klien yang paham pull bersyarat; setiap
 * `c.<kunci>` membawa kursor penyedia yang datanya sudah tersimpan di perangkat (klien lama tanpa `v=2` tetap menerima
 * data penuh seperti v1).
 *
 * Kursor = SIDIK ISI (hash SHA-256 terpotong) dari data penyedia sebagaimana dihitung server — bukan waktu perangkat,
 * bukan waktu server. Karena dibandingkan dengan isi data saat ini, perubahan apa pun (koreksi kantor, void, pembalik,
 * data terlambat sinkron, parameter berubah) PASTI membuat kursor berbeda: tidak ada perubahan yang terlewat. Kunci
 * tingkat atas `generatedAt` tidak ikut sidik (berubah tiap panggilan).
 *
 * Respons per penyedia (selain `data[kunci]` penuh):
 * - `unchanged: [kunci]` — isi sama dengan kursor klien: TANPA isi; klien hanya menyegarkan `generatedAt`.
 * - `patches[kunci] = { base?, cols }` — delta: `base` (bagian luar tanpa isi koleksi) hanya bila berubah; `cols` per
 *   koleksi (larik/objek yang tumbuh, mis. penjualan shift terbuka POS) berisi segmen: salin rentang dari data lama
 *   klien (`copy: [awal, jumlah]`) atau butir baru (`items`). Koleksi dipotong menjadi "ember" berbatas isi (CDC) —
 *   penyisipan/pengubahan/penghapusan hanya mengirim ulang ember yang tersentuh.
 * - `cursors[kunci]` — kursor baru untuk data penuh/delta (tidak dikirim untuk `unchanged`).
 *
 * Klien memvalidasi panjang data lama (`from`); bila tidak cocok → tarik penuh kunci itu (tanpa kursor).
 */

/** Versi protokol pull bersyarat (`?v=2`). */
export const PULL_PROTOCOL_VERSION = 2;

/** Kunci tingkat atas yang tidak ikut sidik & disegarkan klien ke `serverTime` saat "tidak berubah". */
export const PULL_VOLATILE_KEYS: readonly string[] = ["generatedAt"];

/** Awalan nama parameter kursor per penyedia. */
export const PULL_CURSOR_PARAM_PREFIX = "c.";

/** Batas pertahanan: jumlah kursor per permintaan & panjang satu kursor. */
export const MAX_PULL_CURSORS = 64;
export const MAX_PULL_CURSOR_LENGTH = 4096;

const KEY_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_.~!-]+$/;

/** Segmen koleksi: salin dari data lama klien, atau butir baru. */
export type PullSegment = { copy: [start: number, count: number] } | { items: unknown[] };

/** Delta satu koleksi. `from` = panjang koleksi lama yang diharapkan; `record` = koleksi berupa objek (entri). */
export type PullCollectionPatch = { from: number; segs: PullSegment[]; record?: true };

export type PullPatch = {
  /** Data baru dengan koleksi dikosongkan — hanya bila bagian luar berubah. */
  base?: unknown;
  /** Koleksi yang berubah (jalur bertitik). Bila `base` dikirim, SEMUA koleksi yang ada disertakan. */
  cols: Record<string, PullCollectionPatch>;
};

export class PullPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullPatchError";
  }
}

/** Query string kursor untuk klien: `v=2&c.<kunci>=<kursor>…` (hanya karakter aman URL, tanpa escape). */
export function pullCursorQuery(cursors: Iterable<readonly [string, string]>): string {
  const parts = [`v=${PULL_PROTOCOL_VERSION}`];
  let n = 0;
  for (const [key, cursor] of cursors) {
    if (n >= MAX_PULL_CURSORS) break;
    if (!KEY_PATTERN.test(key) || !cursor || cursor.length > MAX_PULL_CURSOR_LENGTH || !CURSOR_PATTERN.test(cursor)) continue;
    parts.push(`${PULL_CURSOR_PARAM_PREFIX}${key}=${cursor}`);
    n++;
  }
  return parts.join("&");
}

/**
 * Baca kursor dari parameter URL (server). `null` = klien lama (tanpa `v=2`) → perilaku v1. Kursor tidak sah diabaikan
 * (penyedia itu dikirim penuh).
 */
export function readPullCursors(params: URLSearchParams): Record<string, string> | null {
  if (params.get("v") !== String(PULL_PROTOCOL_VERSION)) return null;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [name, value] of params) {
    if (!name.startsWith(PULL_CURSOR_PARAM_PREFIX)) continue;
    const key = name.slice(PULL_CURSOR_PARAM_PREFIX.length);
    if (n >= MAX_PULL_CURSORS) break;
    if (!KEY_PATTERN.test(key) || !value || value.length > MAX_PULL_CURSOR_LENGTH || !CURSOR_PATTERN.test(value)) continue;
    out[key] = value;
    n++;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Nilai pada jalur bertitik (`"openShift.sales"`); `undefined` bila induk tidak ada/bukan objek. */
export function getPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.split(".")) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Salinan `value` dengan `path` diganti `next` (klon dangkal sepanjang jalur; induk wajib objek). */
export function setPath<T>(value: T, path: string, next: unknown): T {
  const parts = path.split(".");
  const walk = (cur: unknown, i: number): unknown => {
    if (!isPlainObject(cur)) throw new PullPatchError(`Jalur ${path} tidak ada pada data lokal.`);
    const key = parts[i]!;
    return { ...cur, [key]: i === parts.length - 1 ? next : walk(cur[key], i + 1) };
  };
  return walk(value, 0) as T;
}

/** Butir koleksi: larik apa adanya; objek → entri `[kunci, nilai]`. `null` bila bukan koleksi. */
export function collectionItems(value: unknown): { record: boolean; items: unknown[] } | null {
  if (Array.isArray(value)) return { record: false, items: value };
  if (isPlainObject(value)) return { record: true, items: Object.entries(value) };
  return null;
}

/** Segarkan kunci volatil (`generatedAt`) data yang tidak berubah ke waktu server pull ini. */
export function touchVolatile<T>(data: T, serverTime: string): T {
  if (!isPlainObject(data)) return data;
  let out: Record<string, unknown> | null = null;
  for (const key of PULL_VOLATILE_KEYS) {
    if (typeof data[key] === "string") {
      out ??= { ...data };
      out[key] = serverTime;
    }
  }
  return (out ?? data) as T;
}

/**
 * Terapkan delta ke data lama (murni). Galat (`PullPatchError`) bila data lama tidak cocok dengan kursor yang dikirim
 * (panjang koleksi, rentang salin, jalur) — pemanggil lalu menarik penuh.
 */
export function applyPullPatch(old: unknown, patch: PullPatch, serverTime: string): unknown {
  let next: unknown = patch.base !== undefined ? patch.base : touchVolatile(old, serverTime);
  for (const [path, col] of Object.entries(patch.cols ?? {})) {
    const prev = getPath(old, path);
    const prevItems = prev === undefined || prev === null ? [] : (collectionItems(prev)?.items ?? null);
    if (!prevItems) throw new PullPatchError(`Koleksi ${path} pada data lokal bukan larik/objek.`);
    if (prevItems.length !== col.from) throw new PullPatchError(`Koleksi ${path}: data lokal ${prevItems.length} butir, server mengharapkan ${col.from}.`);
    const items: unknown[] = [];
    for (const seg of col.segs) {
      if ("copy" in seg) {
        const [start, count] = seg.copy;
        if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 || start + count > prevItems.length) {
          throw new PullPatchError(`Koleksi ${path}: rentang salin di luar data lokal.`);
        }
        for (let i = start; i < start + count; i++) items.push(prevItems[i]);
      } else if (Array.isArray(seg.items)) {
        for (const item of seg.items) items.push(item);
      } else {
        throw new PullPatchError(`Koleksi ${path}: segmen tidak dikenal.`);
      }
    }
    if (col.record && items.some((e) => !Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string")) {
      throw new PullPatchError(`Koleksi ${path}: entri objek tidak sah.`);
    }
    next = setPath(next, path, col.record ? Object.fromEntries(items as [string, unknown][]) : items);
  }
  return next;
}
