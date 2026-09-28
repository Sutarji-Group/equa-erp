/**
 * Penyimpanan berkas (foto bukti kirim, meter, nota, slip, tanda tangan, perjanjian…) → baris `attachments`.
 *
 * Driver (dipilih otomatis):
 * - **Vercel Blob** (`BLOB_READ_WRITE_TOKEN` terisi) — akses PRIVAT; berkas dilayani lewat `/api/attachments/[id]`
 *   setelah pemeriksaan sesi & tenant.
 * - **Disk** (dev) — `.data/uploads/YYYY/MM/<id>.<ext>`.
 * - **Memori** (uji, `NODE_ENV=test`).
 *
 * `put(tx, ctx, { blob, contentType, kind, objectRef, id? })` idempoten per `id` klien (unggah ulang dari antrean
 * offline tidak menggandakan berkas). `getUrl(attachment)` → URL yang aman ditampilkan.
 */
import "server-only";

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";

import { attachments } from "@/db/schema";
import { serverEnv } from "@/lib/env";
import { isUuid, newId } from "@/lib/ids";

import type { ActorContext } from "./context";
import { getDb, type Tx } from "./db";
import { DomainError, NotFoundError, ValidationError } from "./errors";

export type AttachmentRow = typeof attachments.$inferSelect;

export type StorageDriverName = "vercel_blob" | "disk" | "memory";

export interface StorageDriver {
  readonly name: StorageDriverName;
  put(key: string, body: Buffer, contentType: string): Promise<{ url: string | null }>;
  get(key: string, url: string | null): Promise<Buffer | null>;
}

const memoryStore = new Map<string, Buffer>();

const memoryDriver: StorageDriver = {
  name: "memory",
  async put(key, body) {
    memoryStore.set(key, Buffer.from(body));
    return { url: null };
  },
  async get(key) {
    return memoryStore.get(key) ?? null;
  },
};

function diskRoot(): string {
  return path.join(process.cwd(), ".data", "uploads");
}

const diskDriver: StorageDriver = {
  name: "disk",
  async put(key, body) {
    const file = path.join(diskRoot(), key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    return { url: null };
  },
  async get(key) {
    try {
      return await readFile(path.join(diskRoot(), key));
    } catch {
      return null;
    }
  },
};

const vercelBlobDriver: StorageDriver = {
  name: "vercel_blob",
  async put(key, body, contentType) {
    const { put } = await import("@vercel/blob");
    const res = await put(key, body, {
      access: "private",
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
      token: serverEnv().BLOB_READ_WRITE_TOKEN,
    });
    return { url: res.url };
  },
  async get(key, url) {
    const { get } = await import("@vercel/blob");
    const res = await get(url ?? key, { access: "private", token: serverEnv().BLOB_READ_WRITE_TOKEN });
    if (!res || res.statusCode !== 200) return null;
    return Buffer.from(await new Response(res.stream).arrayBuffer());
  },
};

let overrideDriver: StorageDriver | null = null;

/** Driver aktif. */
export function storageDriver(): StorageDriver {
  if (overrideDriver) return overrideDriver;
  const env = serverEnv();
  if (env.BLOB_READ_WRITE_TOKEN) return vercelBlobDriver;
  if (env.NODE_ENV === "test") return memoryDriver;
  return diskDriver;
}

/** Ganti driver (khusus uji). `null` = kembali otomatis. */
export function setStorageDriverForTests(driver: StorageDriver | null): void {
  overrideDriver = driver;
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/csv": "csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

/** Batas ukuran unggahan (foto sudah dikompresi ≤ PAR-38 di perangkat; dokumen PDF lebih besar). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type PutAttachmentInput = {
  blob: Blob | Buffer | Uint8Array | ArrayBuffer;
  contentType: string;
  /** delivery_photo | signature | meter_photo | receipt_note | transfer_proof | deposit_slip | agreement | … */
  kind: string;
  objectRef?: { type: string; id: string } | null;
  /** ID klien (UUID) untuk unggah idempoten dari antrean offline. */
  id?: string;
  originalName?: string | null;
  capturedAt?: Date | null;
  lat?: number | null;
  lng?: number | null;
};

async function toBuffer(blob: PutAttachmentInput["blob"]): Promise<Buffer> {
  if (Buffer.isBuffer(blob)) return blob;
  if (blob instanceof Uint8Array) return Buffer.from(blob);
  if (blob instanceof ArrayBuffer) return Buffer.from(new Uint8Array(blob));
  return Buffer.from(await blob.arrayBuffer());
}

/** Simpan berkas & catat baris `attachments` di transaksi pemanggil. */
export async function put(tx: Tx, ctx: ActorContext, input: PutAttachmentInput): Promise<AttachmentRow> {
  if (!input.contentType || !/^[a-z]+\/[a-z0-9.+-]+$/i.test(input.contentType)) {
    throw ValidationError.field("contentType", "Jenis berkas tidak dikenal.");
  }
  if (!input.kind) throw ValidationError.field("kind", "Jenis lampiran wajib diisi.");
  if (input.id !== undefined && !isUuid(input.id)) throw ValidationError.field("id", "ID lampiran tidak valid.");

  const id = input.id ?? newId();
  if (input.id) {
    const existing = await tx.select().from(attachments).where(eq(attachments.id, id)).limit(1);
    if (existing[0]) return existing[0];
  }
  const body = await toBuffer(input.blob);
  if (body.length === 0) throw ValidationError.field("blob", "Berkas kosong. Ambil ulang foto/berkasnya.");
  if (body.length > MAX_UPLOAD_BYTES) {
    throw ValidationError.field("blob", "Berkas terlalu besar (maksimal 10 MB). Kompres atau pilih berkas lain.");
  }
  const sha256 = createHash("sha256").update(body).digest("hex");
  const now = ctx.now ?? new Date();
  const ext = EXT_BY_TYPE[input.contentType.toLowerCase()] ?? "bin";
  const storageKey = `${ctx.tenantId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${id}.${ext}`;

  const driver = storageDriver();
  let url: string | null;
  try {
    ({ url } = await driver.put(storageKey, body, input.contentType));
  } catch (error) {
    console.error("[equa] gagal menyimpan berkas:", error);
    throw new DomainError("STORAGE_FAILED", "Berkas gagal disimpan. Coba kirim ulang; data lain tetap tersimpan.");
  }

  const [row] = await tx
    .insert(attachments)
    .values({
      id,
      tenantId: ctx.tenantId,
      storageKey,
      url,
      contentType: input.contentType,
      sizeBytes: body.length,
      sha256,
      kind: input.kind,
      originalName: input.originalName ?? null,
      objectType: input.objectRef?.type ?? null,
      objectId: input.objectRef?.id ?? null,
      capturedAt: input.capturedAt ?? null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      uploadedBy: ctx.userId,
      deviceId: ctx.deviceId,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const again = await tx.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  return again[0]!;
}

/** Tautkan lampiran ke objek (mis. setelah transaksi lapangan tersinkron). */
export async function linkAttachment(tx: Tx, attachmentId: string, objectRef: { type: string; id: string }): Promise<void> {
  await tx.update(attachments).set({ objectType: objectRef.type, objectId: objectRef.id }).where(eq(attachments.id, attachmentId));
}

/** URL tampilan lampiran — selalu lewat route terautentikasi (Blob privat). */
export function getUrl(attachment: Pick<AttachmentRow, "id">): string {
  return `/api/attachments/${attachment.id}`;
}

/** Ambil metadata lampiran. */
export async function getAttachment(tx: Tx, id: string): Promise<AttachmentRow | null> {
  if (!isUuid(id)) return null;
  const rows = await tx.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Baca isi berkas (untuk route `/api/attachments/[id]`). Tenant pelaku harus sama. */
export async function readAttachment(ctx: ActorContext, id: string, db: Tx = getDb()): Promise<{ row: AttachmentRow; body: Buffer }> {
  const row = await getAttachment(db, id);
  if (!row || (row.tenantId && row.tenantId !== ctx.tenantId && !ctx.scope.tenantIds.includes(row.tenantId))) {
    throw new NotFoundError("Berkas tidak ditemukan.");
  }
  const body = await storageDriver().get(row.storageKey, row.url);
  if (!body) throw new NotFoundError("Berkas tidak ditemukan di penyimpanan.");
  return { row, body };
}
