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
 *
 * Keamanan (tinjauan pasca-F3c):
 * - Jenis berkas hanya `ALLOWED_CONTENT_TYPES` (JPEG/PNG/WEBP/PDF/CSV/XLSX) + pemeriksaan magic bytes — tidak ada
 *   HTML/SVG (XSS tersimpan di origin web kantor). Route menyajikan dengan `nosniff` + CSP sandbox; selain gambar
 *   sebagai unduhan (`attachment`).
 * - `readAttachment` = otorisasi PER OBJEK: pengunggah sendiri; jenis ber-PII (`PII_ATTACHMENT_KINDS`) hanya
 *   pemilik/Admin Keuangan; objek terdaftar lewat `registerAttachmentAccess(objectType, { permission, check })`
 *   (modul memetakan objeknya ke izin baca + cek lingkup truk/outlet); objek tak terdaftar hanya pemilik/Admin
 *   Keuangan. Penolakan dicatat di log akses.
 * - `linkAttachment` hanya untuk lampiran yang belum tertaut objek lain.
 */
import "server-only";

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { and, eq, isNull, or } from "drizzle-orm";

import { attachments } from "@/db/schema";
import { serverEnv } from "@/lib/env";
import { isUuid, newId } from "@/lib/ids";

import { isSystem, type ActorContext } from "./context";
import { getDb, type Tx } from "./db";
import { DomainError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { can, recordDenial } from "./rbac/authorize";

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

/** Jenis berkas yang boleh disimpan (allowlist; HTML/SVG/skrip DITOLAK). */
export const ALLOWED_CONTENT_TYPES: readonly string[] = Object.keys(EXT_BY_TYPE);

/** Jenis gambar yang disajikan inline; selain itu sebagai unduhan. */
export const INLINE_CONTENT_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp"];

function startsWith(body: Buffer, bytes: readonly number[], offset = 0): boolean {
  if (body.length < offset + bytes.length) return false;
  return bytes.every((b, i) => body[offset + i] === b);
}

/** Pemeriksaan magic bytes: isi berkas harus sesuai jenis yang diakui. */
export function contentMatchesType(contentType: string, body: Buffer): boolean {
  switch (contentType) {
    case "image/jpeg":
      return startsWith(body, [0xff, 0xd8, 0xff]);
    case "image/png":
      return startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/webp":
      return startsWith(body, [0x52, 0x49, 0x46, 0x46]) && startsWith(body, [0x57, 0x45, 0x42, 0x50], 8);
    case "application/pdf":
      return startsWith(body, [0x25, 0x50, 0x44, 0x46]); // %PDF
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return startsWith(body, [0x50, 0x4b, 0x03, 0x04]); // ZIP
    case "text/csv": {
      const head = body.subarray(0, 4096);
      const text = head.toString("utf8").replace(/^\uFEFF/, "").trimStart().toLowerCase();
      return !head.includes(0) && !text.startsWith("<");
    }
    default:
      return false;
  }
}

/** Jenis lampiran berisi data pribadi (BR-39): hanya pemilik/Admin Keuangan (dan pengunggahnya). */
export const PII_ATTACHMENT_KINDS = new Set<string>(["agreement", "identity", "identity_card", "ktp", "contract", "id_document"]);

export type AttachmentAccessRule = {
  /** Izin baca modul (salah satu bila array). */
  permission: string | readonly string[];
  /** Cek lingkup objek (truk/outlet/sumber) — kembalikan false bila di luar lingkup pelaku. */
  check?: (tx: Tx, ctx: ActorContext, row: AttachmentRow) => Promise<boolean> | boolean;
};

const accessRules = new Map<string, AttachmentAccessRule>();

/**
 * Daftarkan aturan baca lampiran untuk `attachments.object_type` milik modul (dipanggil dari `registerSync()`/
 * `registerReports()` modul atau fungsi register lain — bukan top-level). Contoh M3:
 * `registerAttachmentAccess("trip", { permission: ["m3.trip.read", "m2.trip.read"], check: async (tx, ctx, row) =>
 *    inTruckScope(ctx, (await loadTrip(tx, row.objectId!)).truckId) })`.
 */
export function registerAttachmentAccess(objectType: string, rule: AttachmentAccessRule): () => void {
  accessRules.set(objectType, rule);
  return () => {
    if (accessRules.get(objectType) === rule) accessRules.delete(objectType);
  };
}

const OVERSIGHT_ROLES = ["owner", "finance_admin"] as const;

/** Benar bila pelaku boleh membaca lampiran ini (tanpa efek samping; tenant sudah dicek). */
export async function canReadAttachment(tx: Tx, ctx: ActorContext, row: AttachmentRow): Promise<boolean> {
  if (isSystem(ctx)) return true;
  if (row.uploadedBy && row.uploadedBy === ctx.userId) return true;
  const oversight = ctx.roles.some((r) => (OVERSIGHT_ROLES as readonly string[]).includes(r));
  if (PII_ATTACHMENT_KINDS.has(row.kind)) return oversight;
  const rule = row.objectType ? accessRules.get(row.objectType) : undefined;
  if (rule) {
    const perms = typeof rule.permission === "string" ? [rule.permission] : rule.permission;
    if (!perms.some((p) => can(ctx, p))) return false;
    return rule.check ? await rule.check(tx, ctx, row) : true;
  }
  return oversight;
}

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
  const contentType = String(input.contentType ?? "").toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    throw ValidationError.field("contentType", "Jenis berkas tidak didukung (hanya foto JPEG/PNG/WEBP, PDF, CSV, atau Excel).");
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
  if (!contentMatchesType(contentType, body)) {
    throw ValidationError.field("blob", "Isi berkas tidak sesuai jenisnya. Ambil ulang foto atau pilih berkas lain.");
  }
  const sha256 = createHash("sha256").update(body).digest("hex");
  const now = ctx.now ?? new Date();
  const ext = EXT_BY_TYPE[contentType] ?? "bin";
  const storageKey = `${ctx.tenantId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${id}.${ext}`;

  const driver = storageDriver();
  let url: string | null;
  try {
    ({ url } = await driver.put(storageKey, body, contentType));
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
      contentType,
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

/**
 * Tautkan lampiran ke objek (mis. setelah transaksi lapangan tersinkron). Hanya lampiran yang belum tertaut objek lain
 * (kosong atau masih `sync_command`); menautkan ulang ke objek yang SAMA aman (idempoten).
 */
export async function linkAttachment(tx: Tx, attachmentId: string, objectRef: { type: string; id: string }): Promise<void> {
  const rows = await tx
    .update(attachments)
    .set({ objectType: objectRef.type, objectId: objectRef.id })
    .where(
      and(
        eq(attachments.id, attachmentId),
        or(
          isNull(attachments.objectType),
          eq(attachments.objectType, "sync_command"),
          and(eq(attachments.objectType, objectRef.type), eq(attachments.objectId, objectRef.id)),
        ),
      ),
    )
    .returning({ id: attachments.id });
  if (rows.length === 0) {
    throw new DomainError("ATTACHMENT_ALREADY_LINKED", "Foto/lampiran ini sudah dipakai untuk data lain. Ambil ulang foto.");
  }
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

/**
 * Baca isi berkas (untuk route `/api/attachments/[id]`). Tenant pelaku harus sama, lalu otorisasi per objek
 * (`canReadAttachment`). Ditolak → `ForbiddenError` + log akses.
 */
export async function readAttachment(ctx: ActorContext, id: string, db: Tx = getDb()): Promise<{ row: AttachmentRow; body: Buffer }> {
  const row = await getAttachment(db, id);
  if (!row || (row.tenantId && row.tenantId !== ctx.tenantId && !ctx.scope.tenantIds.includes(row.tenantId))) {
    throw new NotFoundError("Berkas tidak ditemukan.");
  }
  if (!(await canReadAttachment(db, ctx, row))) {
    const error = new ForbiddenError("Anda tidak berhak membuka berkas ini.", { rule: "BR-39", objectType: "attachment", objectId: row.id });
    await recordDenial(ctx, error);
    throw error;
  }
  const body = await storageDriver().get(row.storageKey, row.url);
  if (!body) throw new NotFoundError("Berkas tidak ditemukan di penyimpanan.");
  return { row, body };
}
