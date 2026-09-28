/**
 * Inti harness DB uji tanpa ketergantungan `vitest` (dipakai juga oleh `tests/global-setup.ts`).
 * DDL skema dibangkitkan SEKALI, lalu datadir PGlite di-dump ke berkas cache
 * `node_modules/.cache/equa-test-db/<hash>-{schema|seed}.tar`; setiap DB uji memuat snapshot itu (±0,5 detik).
 * Hash = isi `src/db/**`, `src/lib/**`, berkas harness, dan versi paket DB — perubahan skema/seed otomatis membangun
 * ulang snapshot. API publik untuk uji ada di `tests/helpers/db.ts`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import type { Db } from "@/db/client";
import { generateSchemaDdl } from "@/db/ddl";
import { applyDbHardening } from "@/db/hardening";
import * as schema from "@/db/schema";
import { runSeed } from "@/db/seed";

export type TestDb = {
  db: Db;
  client: PGlite;
  close: () => Promise<void>;
};

export type CreateTestDbOptions = {
  /** Muat data demo lengkap (`runSeed`). Bawaan: false (skema kosong + hardening). */
  seed?: boolean;
};

export type SnapshotKind = "schema" | "seed";

/** Naikkan bila logika pembangunan snapshot berubah secara tidak terlihat dari hash berkas. */
const HARNESS_VERSION = "1";

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, "node_modules", ".cache", "equa-test-db");
const HASHED_DIRS = ["src/db", "src/lib"];
const HASHED_FILES = ["tests/helpers/db-snapshot.ts"];
const VERSIONED_PACKAGES = ["drizzle-orm", "drizzle-kit", "@electric-sql/pglite"];

function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full));
    else if (/\.(ts|sql|json)$/.test(entry)) out.push(full);
  }
  return out;
}

let cachedKey: string | undefined;

/** Kunci cache snapshot (hash isi sumber skema/seed/lib + versi paket). */
export function testDbSnapshotKey(): string {
  if (cachedKey) return cachedKey;
  const h = createHash("sha256").update(`harness:${HARNESS_VERSION}\n`);
  const files = [
    ...HASHED_DIRS.flatMap((d) => listFilesRecursive(path.join(ROOT, d))),
    ...HASHED_FILES.map((f) => path.join(ROOT, f)),
  ];
  for (const file of files) {
    if (!existsSync(file)) continue;
    h.update(path.relative(ROOT, file)).update("\0").update(readFileSync(file)).update("\0");
  }
  for (const pkg of VERSIONED_PACKAGES) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(ROOT, "node_modules", pkg, "package.json"), "utf8")) as {
        version?: string;
      };
      h.update(`${pkg}@${manifest.version ?? "?"}\n`);
    } catch {
      h.update(`${pkg}@missing\n`);
    }
  }
  cachedKey = h.digest("hex").slice(0, 16);
  return cachedKey;
}

function snapshotPath(kind: SnapshotKind): string {
  return path.join(CACHE_DIR, `${testDbSnapshotKey()}-${kind}.tar.gz`);
}

/** Hapus snapshot dari hash lama (hemat disk; aman karena hanya berkas cache). */
function pruneStaleSnapshots(): void {
  if (!existsSync(CACHE_DIR)) return;
  const key = testDbSnapshotKey();
  for (const entry of readdirSync(CACHE_DIR)) {
    if (!entry.startsWith(key) && !entry.endsWith(".tmp")) {
      try {
        unlinkSync(path.join(CACHE_DIR, entry));
      } catch {
        // berkas sedang dipakai proses lain — abaikan
      }
    }
  }
}

/** Bungkus klien PGlite menjadi instans Drizzle bertipe `Db` (skema lengkap + relasi). */
export function wrapPglite(client: PGlite): Db {
  return drizzle({ client, schema });
}

/** Bangun snapshot datadir: DDL skema → hardening → (seed). */
async function buildSnapshot(kind: SnapshotKind): Promise<Uint8Array> {
  const client = new PGlite();
  try {
    const db = wrapPglite(client);
    const ddl = await generateSchemaDdl();
    await client.exec(ddl.join("\n"));
    await applyDbHardening(db, { rootDir: ROOT });
    if (kind === "seed") await runSeed(db);
    const dump = await client.dumpDataDir("none");
    return new Uint8Array(await dump.arrayBuffer());
  } finally {
    await client.close();
  }
}

async function ensureSnapshot(kind: SnapshotKind): Promise<string> {
  const file = snapshotPath(kind);
  if (existsSync(file)) return file;
  const bytes = await buildSnapshot(kind);
  mkdirSync(CACHE_DIR, { recursive: true });
  pruneStaleSnapshots();
  // Tulis atomik (worker paralel boleh membangun bersamaan; yang terakhir menang, isinya setara).
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, gzipSync(bytes, { level: 1 }));
  renameSync(tmp, file);
  return file;
}

/** Siapkan snapshot (dipanggil `tests/global-setup.ts`). */
export async function ensureTestDbSnapshots(kinds: SnapshotKind[] = ["schema", "seed"]): Promise<void> {
  for (const kind of kinds) await ensureSnapshot(kind);
}

/** PGlite in-memory baru dengan skema lengkap + hardening (+ seed bila `seed: true`). */
export async function createTestDb(options: CreateTestDbOptions = {}): Promise<TestDb> {
  const file = await ensureSnapshot(options.seed ? "seed" : "schema");
  const client = new PGlite({ loadDataDir: new Blob([gunzipSync(readFileSync(file))]) });
  await client.waitReady;
  const db = wrapPglite(client);
  return { db, client, close: () => client.close() };
}
