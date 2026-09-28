/**
 * `POST /api/sync/upload` (multipart) — unggah lampiran antrean offline SEBELUM perintahnya dikirim (docs/ARCHITECTURE.md
 * §7). Idempoten per `attachmentId` (ID klien UUID): unggah ulang mengembalikan baris yang sama. Berkas lewat
 * `storage.put`. Pengguna pemilik lampiran wajib punya sesi lapangan di perangkat ini.
 *
 * Isian form: `file` (Blob), `attachmentId`, `userId`, `kind` (delivery_photo | signature | meter_photo | …),
 * `capturedAt?` (ISO), `lat?`, `lng?`, `commandId?`.
 */
import "server-only";

import { eq } from "drizzle-orm";

import { attachments } from "@/db/schema";
import { isUuid } from "@/lib/ids";

import { getDb, withTx } from "../db";
import { ValidationError } from "../errors";
import { put, type AttachmentRow } from "../storage";
import type { DeviceAuth } from "../auth/device-auth";
import { AuthError } from "../auth/errors";
import { buildFieldActorContext } from "../auth/field-login";
import { findFieldSessionCovering } from "../auth/session";

/** Batas unggah lapangan (foto sudah dikompresi ≤ PAR-38 di perangkat; tanda tangan PNG kecil). */
export const MAX_FIELD_UPLOAD_BYTES = 5 * 1024 * 1024;
export const FIELD_UPLOAD_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

export type UploadResult = { ok: true; attachmentId: string; duplicate: boolean; sizeBytes: number };

function num(value: FormDataEntryValue | null): number | null {
  if (value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function processUpload(auth: DeviceAuth, form: FormData): Promise<UploadResult> {
  const file = form.get("file");
  const attachmentId = String(form.get("attachmentId") ?? "");
  const userId = String(form.get("userId") ?? "");
  const kind = String(form.get("kind") ?? "").trim();
  if (!isUuid(attachmentId)) throw ValidationError.field("attachmentId", "ID lampiran tidak valid.");
  if (!isUuid(userId)) throw ValidationError.field("userId", "Pengguna lampiran tidak valid.");
  if (!/^[a-z0-9_]{2,40}$/.test(kind)) throw ValidationError.field("kind", "Jenis lampiran tidak valid.");
  if (!(file instanceof Blob)) throw ValidationError.field("file", "Berkas tidak ditemukan dalam kiriman.");
  const contentType = (file.type || "application/octet-stream").toLowerCase();
  if (!FIELD_UPLOAD_TYPES.has(contentType)) throw ValidationError.field("file", "Jenis berkas tidak didukung (hanya foto JPEG/PNG/WEBP atau PDF).");
  if (file.size > MAX_FIELD_UPLOAD_BYTES) throw ValidationError.field("file", "Berkas terlalu besar (maksimal 5 MB). Ambil ulang foto.");

  const db = getDb();
  const existing = await db.select().from(attachments).where(eq(attachments.id, attachmentId)).limit(1);
  if (existing[0]) {
    if (existing[0].tenantId !== auth.device.tenantId) throw ValidationError.field("attachmentId", "ID lampiran bentrok. Ambil ulang foto.");
    return { ok: true, attachmentId, duplicate: true, sizeBytes: existing[0].sizeBytes };
  }

  const capturedRaw = form.get("capturedAt");
  const capturedAt = typeof capturedRaw === "string" && capturedRaw ? new Date(capturedRaw) : null;
  const at = new Date(Math.min(capturedAt && !Number.isNaN(capturedAt.getTime()) ? capturedAt.getTime() : auth.now.getTime(), auth.now.getTime()));
  const session = await findFieldSessionCovering(db, userId, auth.device.id, at);
  if (!session) throw new AuthError("SESSION_REQUIRED", "Pemilik foto perlu masuk dengan PIN saat ada sinyal agar foto terkirim.");

  const row: AttachmentRow = await withTx(async (tx) => {
    const ctx = await buildFieldActorContext(tx, auth.device, userId, { now: auth.now, deviceTime: capturedAt ?? undefined });
    const commandId = String(form.get("commandId") ?? "");
    return put(tx, ctx, {
      id: attachmentId,
      blob: file,
      contentType,
      kind,
      originalName: file instanceof File ? file.name || null : null,
      capturedAt: capturedAt && !Number.isNaN(capturedAt.getTime()) ? capturedAt : null,
      lat: num(form.get("lat")),
      lng: num(form.get("lng")),
      objectRef: isUuid(commandId) ? { type: "sync_command", id: commandId } : null,
    });
  });
  return { ok: true, attachmentId: row.id, duplicate: false, sizeBytes: row.sizeBytes };
}
