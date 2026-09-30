/**
 * Pull bersyarat — sisi server (D-14 butir 3, B-89). Protokol & format: `src/lib/pull-delta.ts`.
 *
 * Untuk setiap penyedia: hasil `fetch` dihitung PENUH (tanpa `since`), lalu
 * 1. koleksi yang dideklarasikan penyedia (`collections`, jalur → ukuran ember) dipisah dari bagian luar ("base");
 * 2. sidik base = SHA-256(JSON base tanpa `generatedAt`) → 12 karakter base64url;
 * 3. tiap koleksi dipotong menjadi ember berbatas isi (content-defined chunking): batas setelah butir yang hash-nya
 *    habis dibagi B (B = ukuran ember sasaran, membesar ×2 bila butir > 48·B; maks. 4B butir per ember) — penyisipan
 *    di tengah/awal, pengubahan satu butir, atau butir yang keluar dari jendela hanya mengubah ember di sekitarnya;
 * 4. kursor = `2` + sidik base + per koleksi `~` + daftar ember (`<hash 8><jumlah base36>` dipisah `.`; `!` = tidak ada).
 *
 * Keputusan terhadap kursor klien: sama persis → `unchanged` (tanpa isi); kursor tidak ada/tidak sah → `full`; selain
 * itu `patch` (base hanya bila berubah; koleksi berubah dikirim sebagai segmen salin/butir baru). Karena kursor adalah
 * sidik ISI, perubahan data lama (koreksi kantor, void, pembalik) selalu terdeteksi — tidak bergantung waktu.
 */
import "server-only";

import { createHash } from "node:crypto";

import { collectionItems, getPath, PULL_VOLATILE_KEYS, setPath, type PullCollectionPatch, type PullPatch, type PullSegment } from "@/lib/pull-delta";

/** Deklarasi koleksi delta penyedia: jalur bertitik → ukuran ember sasaran (1 = per butir). */
export type PullCollections = Readonly<Record<string, number>>;

const CURSOR_VERSION = "2";
const BASE_HASH_LEN = 12;
const BUCKET_HASH_LEN = 8;
/** Jumlah ember sasaran maksimum per koleksi (kursor tetap pendek walau koleksi besar). */
const MAX_BUCKETS = 48;
const ABSENT = "!";

type Bucket = { hash: string; start: number; count: number };
type CollectionVersion = { path: string; record: boolean; items: unknown[]; buckets: Bucket[] } | { path: string; absent: true };

export type ProviderVersion = {
  cursor: string;
  baseHash: string;
  base: unknown;
  cols: CollectionVersion[];
};

type ParsedCursor = { baseHash: string; cols: (Bucket[] | "absent")[] };

function digest(data: string): Buffer {
  return createHash("sha256").update(data).digest();
}

function b64(buf: Buffer, len: number): string {
  return buf.toString("base64url").slice(0, len);
}

/** JSON stabil untuk sidik: kunci volatil tingkat atas dibuang. */
function baseJson(base: unknown): string {
  if (base && typeof base === "object" && !Array.isArray(base)) {
    const copy: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const key of PULL_VOLATILE_KEYS) delete copy[key];
    return JSON.stringify(copy);
  }
  return JSON.stringify(base ?? null);
}

/** Ukuran ember efektif: B sasaran, dikali 2 sampai jumlah ember ≤ MAX_BUCKETS. */
function effectiveBucket(target: number, n: number): number {
  let b = Math.max(1, Math.floor(target));
  while (n / b > MAX_BUCKETS) b *= 2;
  return b;
}

/** Potong butir menjadi ember berbatas isi. */
function chunk(items: unknown[], target: number): Bucket[] {
  const b = effectiveBucket(target, items.length);
  const buckets: Bucket[] = [];
  let start = 0;
  let parts: Buffer[] = [];
  const close = (end: number) => {
    buckets.push({ hash: b64(digest(Buffer.concat(parts).toString("hex")), BUCKET_HASH_LEN), start, count: end - start });
    start = end;
    parts = [];
  };
  for (let i = 0; i < items.length; i++) {
    const h = digest(JSON.stringify(items[i]) ?? "null");
    parts.push(h.subarray(0, 16));
    const boundary = b === 1 || h.readUInt32BE(16) % b === 0 || i + 1 - start >= 4 * b;
    if (boundary) close(i + 1);
  }
  if (start < items.length) close(items.length);
  return buckets;
}

function encodeBuckets(buckets: Bucket[]): string {
  return buckets.map((bk) => `${bk.hash}${bk.count.toString(36)}`).join(".");
}

/** Versi (kursor + bagian) data penyedia. */
export function versionOf(payload: unknown, collections: PullCollections = {}): ProviderVersion {
  const paths = Object.keys(collections).sort();
  let base: unknown = payload;
  const cols: CollectionVersion[] = [];
  for (const path of paths) {
    const value = getPath(payload, path);
    const c = value === undefined || value === null ? null : collectionItems(value);
    if (!c) {
      cols.push({ path, absent: true });
      continue;
    }
    cols.push({ path, record: c.record, items: c.items, buckets: chunk(c.items, collections[path]!) });
    base = setPath(base, path, c.record ? {} : []);
  }
  const baseHash = b64(digest(baseJson(base)), BASE_HASH_LEN);
  const cursor = CURSOR_VERSION + baseHash + cols.map((c) => `~${"absent" in c ? ABSENT : encodeBuckets(c.buckets)}`).join("");
  return { cursor, baseHash, base, cols };
}

/** Uraikan kursor klien; `null` bila bukan format ini atau jumlah koleksi berbeda. */
function parseCursor(cursor: string, expectedCols: number): ParsedCursor | null {
  if (!cursor.startsWith(CURSOR_VERSION) || cursor.length < 1 + BASE_HASH_LEN) return null;
  const baseHash = cursor.slice(1, 1 + BASE_HASH_LEN);
  const rest = cursor.slice(1 + BASE_HASH_LEN);
  const parts = rest === "" ? [] : rest.split("~").slice(1);
  if (rest !== "" && !rest.startsWith("~")) return null;
  if (parts.length !== expectedCols) return null;
  const cols: ParsedCursor["cols"] = [];
  for (const part of parts) {
    if (part === ABSENT) {
      cols.push("absent");
      continue;
    }
    const buckets: Bucket[] = [];
    let start = 0;
    for (const entry of part === "" ? [] : part.split(".")) {
      if (entry.length <= BUCKET_HASH_LEN) return null;
      const count = Number.parseInt(entry.slice(BUCKET_HASH_LEN), 36);
      if (!Number.isInteger(count) || count <= 0) return null;
      buckets.push({ hash: entry.slice(0, BUCKET_HASH_LEN), start, count });
      start += count;
    }
    cols.push(buckets);
  }
  return { baseHash, cols };
}

function sameBuckets(a: Bucket[], b: Bucket[]): boolean {
  return a.length === b.length && a.every((x, i) => x.hash === b[i]!.hash && x.count === b[i]!.count);
}

/** Segmen koleksi baru terhadap ember lama klien (salin ember yang sama, kirim sisanya). */
function collectionPatch(current: Extract<CollectionVersion, { buckets: Bucket[] }>, old: Bucket[] | "absent"): PullCollectionPatch {
  const oldBuckets = old === "absent" ? [] : old;
  const byHash = new Map<string, Bucket>();
  for (const bk of oldBuckets) if (!byHash.has(`${bk.hash}:${bk.count}`)) byHash.set(`${bk.hash}:${bk.count}`, bk);
  const segs: PullSegment[] = [];
  for (const bk of current.buckets) {
    const hit = byHash.get(`${bk.hash}:${bk.count}`);
    const last = segs[segs.length - 1];
    if (hit) {
      if (last && "copy" in last && last.copy[0] + last.copy[1] === hit.start) last.copy[1] += hit.count;
      else segs.push({ copy: [hit.start, hit.count] });
    } else {
      const items = current.items.slice(bk.start, bk.start + bk.count);
      if (last && "items" in last) last.items.push(...items);
      else segs.push({ items });
    }
  }
  return { from: oldBuckets.reduce((n, bk) => n + bk.count, 0), segs, ...(current.record ? { record: true as const } : {}) };
}

export type ConditionalResult = { kind: "full" } | { kind: "unchanged" } | { kind: "patch"; patch: PullPatch };

/** Bandingkan versi data dengan kursor klien. */
export function compareWithCursor(version: ProviderVersion, clientCursor: string | undefined): ConditionalResult {
  if (!clientCursor) return { kind: "full" };
  if (clientCursor === version.cursor) return { kind: "unchanged" };
  const parsed = parseCursor(clientCursor, version.cols.length);
  if (!parsed) return { kind: "full" };
  const baseSame = parsed.baseHash === version.baseHash;
  const cols: Record<string, PullCollectionPatch> = {};
  let reused = false;
  version.cols.forEach((col, i) => {
    if ("absent" in col) return;
    const old = parsed.cols[i]!;
    if (baseSame && old !== "absent" && sameBuckets(col.buckets, old)) return;
    const patch = collectionPatch(col, old);
    if (patch.segs.some((s) => "copy" in s)) reused = true;
    cols[col.path] = patch;
  });
  if (baseSame && Object.keys(cols).length === 0) return { kind: "unchanged" };
  // Tidak ada yang dapat dipakai ulang & bagian luar berubah → kirim penuh (lebih sederhana bagi klien).
  if (!baseSame && !reused) return { kind: "full" };
  return { kind: "patch", patch: baseSame ? { cols } : { base: version.base, cols } };
}
