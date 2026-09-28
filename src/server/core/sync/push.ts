/**
 * `POST /api/sync/push` (docs/ARCHITECTURE.md §7; US-M3-09 KP-2; US-M6-06 KP-2; NFR-07; Bab 5.3, 6.4).
 *
 * Batch ≤ 50 perintah outbox diproses BERURUTAN, masing-masing dalam transaksinya sendiri:
 * 1. `sync_commands` sudah ada (ID klien sama, perangkat sama) → `duplicate` + hasil lama (pengiriman ulang tidak
 *    menggandakan).
 * 2. IDENTITAS: setiap perintah membawa `sessionId` (sesi PIN pemiliknya di perangkat ini) dan `sig` (HMAC kunci
 *    perintah sesi itu, `src/lib/sync-signature.ts`). Sesi harus milik `userId` perintah & perangkat ini; tanda tangan
 *    salah → ditolak (tidak disimpan, dicatat log akses). Pengguna lain di perangkat yang sama tidak dapat memalsukan.
 *    Sesi dicabut / waktu perangkat di luar masa sesi / tanpa tanda tangan → `retry` `SESSION_REQUIRED` (klien
 *    mengikat ulang antrean pemiliknya ke sesi baru saat ia login PIN daring — `reboundFrom` = sesi asal).
 * 3. BR-37: akun nonaktif / lewat tanggal keluar → semua sesinya dicabut & perintah `rejected` (final).
 * 4. Bab 5.3: `businessDate` WAJIB = tanggal WIB `deviceTime` (toleransi ±PAR-42 di batas tengah malam), selain itu
 *    `rejected`. `late_sync` dihitung di sini (diterima pada hari WIB setelah tanggal bisnisnya, atau hari kas tanggal
 *    itu sudah ditutup) dan diteruskan di `meta.lateSync`.
 * 5. Selisih jam: `sentAt` WAJIB (jam mentah perangkat saat kirim); |selisih| > PAR-42, waktu perangkat di masa depan,
 *    atau waktu perangkat sebelum sesi asal dibuat → `meta.clockSkewFlagged`.
 * 6. Lampiran: `attachmentIds` + `attachmentHashes` ikut ditandatangani; baris `attachments` wajib diunggah perangkat
 *    ini oleh pemilik perintah, hash sama, dan belum tertaut objek lain.
 * 7. Handler dari `registerSyncHandler(type)`: validasi Zod → kondisi izin (`conditions`, mis. kernet pengganti) →
 *    izin → `handle(ctx, payload, meta)`; hasil & baris `sync_commands` di-commit bersama. `DomainError` → `rejected`
 *    (pesan Indonesia, disimpan, final); galat tak terduga → `retry` (tidak disimpan). Satu perintah gagal TIDAK
 *    menggagalkan batch.
 */
import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { attachments, cashDays, devices, employees, syncCommands, users } from "@/db/schema";
import { isUuid } from "@/lib/ids";
import { commandSigningString } from "@/lib/sync-signature";
import { isBusinessDate, toBusinessDate } from "@/lib/time";

import { logAccess } from "../access-log";
import { ensureBootstrapped } from "../bootstrap";
import { getDb, withTx, type Tx } from "../db";
import { DomainError, ForbiddenError, isHardeningViolation, parseInput, toUserMessage } from "../errors";
import { get as getParam } from "../params-read";
import { can, logDenialIfNeeded, permissionDenied } from "../rbac/authorize";
import type { DeviceAuth } from "../auth/device-auth";
import { verifyFieldCommand } from "../auth/crypto";
import { buildFieldActorContext } from "../auth/field-login";
import { isUserUsable, loadSessionById, revokeAllSessions, type SessionRow } from "../auth/session";
import type { ActorContext } from "../context";
import { getSyncHandler, type SyncCommandInput, type SyncMeta } from "./registry";
import { recordHealth, type HealthReport } from "./health";

export const MAX_PUSH_BATCH = 50;

export type PushResultStatus = "applied" | "duplicate" | "rejected" | "conflict" | "retry";

export type PushResult = {
  id: string;
  status: PushResultStatus;
  /** Untuk `duplicate`: status asli (`applied`/`rejected`/`conflict`). */
  originalStatus?: "applied" | "rejected" | "conflict";
  code?: string;
  message?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  result?: unknown;
  clockSkewFlagged?: boolean;
  lateSync?: boolean;
};

export type PushResponse = {
  ok: true;
  serverTime: string;
  results: PushResult[];
};

const commandSchema = z.object({
  id: z.string().refine(isUuid, { error: "ID perintah harus UUID." }),
  type: z.string().trim().min(1).max(100),
  payload: z.unknown(),
  userId: z.string().refine(isUuid, { error: "ID pengguna tidak valid." }),
  /** Sesi PIN pemilik perintah di perangkat ini (diikat saat dicatat). */
  sessionId: z.string().refine(isUuid).nullable().optional(),
  /** HMAC-SHA256 kunci perintah sesi (base64url). */
  sig: z.string().min(16).max(200).nullable().optional(),
  /** Sesi asal bila perintah diikat ulang setelah login ulang. */
  reboundFrom: z.string().refine(isUuid).nullable().optional(),
  deviceTime: z.iso.datetime({ offset: true, error: "Waktu perangkat tidak valid." }),
  businessDate: z.string().refine(isBusinessDate, { error: "Tanggal bisnis harus YYYY-MM-DD." }),
  attachmentIds: z.array(z.string().refine(isUuid)).max(20).optional().default([]),
  attachmentHashes: z
    .array(z.string().regex(/^[0-9a-f]{64}$/i))
    .max(20)
    .optional()
    .default([]),
});

const pushBodySchema = z.object({
  commands: z.array(z.unknown()).max(MAX_PUSH_BATCH, { error: `Maksimal ${MAX_PUSH_BATCH} perintah per kiriman.` }),
  /** Jam perangkat (mentah, belum dikoreksi) saat mengirim — dasar selisih jam (PAR-42). WAJIB. */
  sentAt: z.iso.datetime({ offset: true, error: "Jam kirim perangkat (sentAt) wajib diisi. Perbarui aplikasi." }),
  health: z.record(z.string(), z.unknown()).optional(),
});

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let i = 0; i < 5 && current && typeof current === "object"; i++) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function existingResult(tx: Tx, auth: DeviceAuth, id: string): Promise<PushResult | null> {
  const rows = await tx.select().from(syncCommands).where(eq(syncCommands.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.deviceId !== auth.device.id) {
    return { id, status: "rejected", code: "ID_CONFLICT", message: "ID data bentrok dengan perangkat lain. Hubungi admin sistem." };
  }
  return {
    id,
    status: "duplicate",
    originalStatus: row.status as PushResult["originalStatus"],
    message: row.message,
    objectType: row.objectType,
    objectId: row.objectId,
    result: row.result ?? undefined,
  };
}

/** Simpan penolakan final. Hanya dipanggil SETELAH identitas perintah terverifikasi (sesi + tanda tangan). */
async function storeRejected(auth: DeviceAuth, cmd: SyncCommandInput, message: string, clockSkewMs: number | null): Promise<PushResult> {
  try {
    await getDb()
      .insert(syncCommands)
      .values({
        id: cmd.id,
        tenantId: auth.device.tenantId,
        deviceId: auth.device.id,
        userId: cmd.userId,
        type: cmd.type,
        payload: (cmd.payload ?? {}) as object,
        deviceTime: cmd.deviceTime,
        businessDate: cmd.businessDate,
        receivedAt: auth.now,
        processedAt: auth.now,
        status: "rejected",
        message,
        clockSkewMs,
      });
  } catch (error) {
    if (isUniqueViolation(error)) return (await existingResult(getDb(), auth, cmd.id))!;
    throw error;
  }
  return { id: cmd.id, status: "rejected", message };
}

/** Selisih jam perangkat (ms) dari `sentAt` (jam mentah perangkat saat kirim). */
export function computeClockSkewMs(sentAt: Date | null, now: Date): number | null {
  if (!sentAt) return null;
  return sentAt.getTime() - now.getTime();
}

/** Tanggal bisnis yang sah untuk waktu perangkat (Bab 5.3) dengan toleransi ±`toleranceMs` di batas tengah malam. */
export function allowedBusinessDates(deviceTime: Date, toleranceMs: number): string[] {
  return Array.from(
    new Set([
      toBusinessDate(deviceTime),
      toBusinessDate(new Date(deviceTime.getTime() - toleranceMs)),
      toBusinessDate(new Date(deviceTime.getTime() + toleranceMs)),
    ]),
  );
}

/** Bab 5.3: tersinkron setelah hari WIB tanggal bisnisnya, atau hari kas tanggal itu sudah ditutup. */
async function computeLateSync(tx: Tx, tenantId: string, businessDate: string, now: Date): Promise<boolean> {
  if (businessDate < toBusinessDate(now)) return true;
  const rows = await tx
    .select({ status: cashDays.status })
    .from(cashDays)
    .where(and(eq(cashDays.tenantId, tenantId), eq(cashDays.businessDate, businessDate)))
    .limit(1);
  return rows[0]?.status === "closed";
}

const RETRY_SESSION: Omit<PushResult, "id"> = {
  status: "retry",
  code: "SESSION_REQUIRED",
  message: "Data tersimpan di ponsel. Pemiliknya perlu masuk dengan PIN saat ada sinyal agar data terkirim.",
};

type Verified = { ok: true; session: SessionRow; beforeSessionStart: boolean } | { ok: false; result: PushResult };

async function denyForged(auth: DeviceAuth, cmd: SyncCommandInput, reason: string): Promise<PushResult> {
  await logAccess(getDb(), {
    event: "action_denied",
    success: false,
    tenantId: auth.device.tenantId,
    deviceId: auth.device.id,
    ip: auth.ip,
    userAgent: auth.userAgent,
    rule: "SYNC_IDENTITY",
    objectType: "sync_command",
    objectId: cmd.id,
    reason,
    details: { claimedUserId: cmd.userId, sessionId: cmd.sessionId ?? null, type: cmd.type },
    occurredAt: auth.now,
  });
  return {
    id: cmd.id,
    status: "rejected",
    code: "SESSION_MISMATCH",
    message: "Data antrean ini tidak dapat dipastikan milik pengguna di perangkat ini. Laporkan ke admin sistem.",
  };
}

/** Verifikasi identitas perintah: sesi pemilik di perangkat ini + tanda tangan + masa sesi. */
async function verifyIdentity(auth: DeviceAuth, cmd: SyncCommandInput, toleranceMs: number): Promise<Verified> {
  if (!cmd.sessionId || !cmd.sig) return { ok: false, result: { id: cmd.id, ...RETRY_SESSION } };
  const db = getDb();
  const session = await loadSessionById(db, cmd.sessionId);
  if (!session || session.kind !== "device" || session.deviceId !== auth.device.id || session.userId !== cmd.userId) {
    return { ok: false, result: await denyForged(auth, cmd, "Sesi perintah bukan milik pengguna/perangkat ini") };
  }
  const signing = commandSigningString({ ...cmd, deviceTime: cmd.deviceTimeRaw, sessionId: session.id });
  if (!verifyFieldCommand(session.id, signing, cmd.sig)) {
    return { ok: false, result: await denyForged(auth, cmd, "Tanda tangan perintah tidak valid") };
  }
  let origin: SessionRow | null = session;
  if (cmd.reboundFrom) {
    origin = await loadSessionById(db, cmd.reboundFrom);
    if (origin && (origin.kind !== "device" || origin.deviceId !== auth.device.id || origin.userId !== cmd.userId)) {
      return { ok: false, result: await denyForged(auth, cmd, "Sesi asal perintah bukan milik pengguna/perangkat ini") };
    }
  }
  if (session.revokedAt || cmd.deviceTime.getTime() > session.expiresAt.getTime() + toleranceMs) {
    return { ok: false, result: { id: cmd.id, ...RETRY_SESSION } };
  }
  // Waktu perangkat sebelum sesi (asal) dibuat: jam perangkat mundur / dimundurkan → ditandai (bukan ditolak; identitas
  // sudah terbukti lewat tanda tangan). Sesi asal yang sudah dibersihkan (≥ 30 hari) juga ditandai.
  const beforeSessionStart = !origin || cmd.deviceTime.getTime() < origin.createdAt.getTime() - toleranceMs;
  return { ok: true, session, beforeSessionStart };
}

async function loadUserState(tx: Tx, userId: string) {
  const rows = await tx
    .select({ status: users.status, exitDate: employees.exitDate })
    .from(users)
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

async function processOne(auth: DeviceAuth, raw: unknown, skew: { ms: number | null; thresholdMs: number }): Promise<PushResult> {
  const rawId = (raw as { id?: unknown } | null)?.id;
  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      id: typeof rawId === "string" ? rawId : "",
      status: "rejected",
      code: "INVALID_COMMAND",
      message: "Data antrean rusak dan tidak dapat diproses. Laporkan ke admin sistem.",
    };
  }
  const cmd: SyncCommandInput = {
    ...parsed.data,
    sessionId: parsed.data.sessionId ?? null,
    sig: parsed.data.sig ?? null,
    reboundFrom: parsed.data.reboundFrom ?? null,
    deviceTime: new Date(parsed.data.deviceTime),
    deviceTimeRaw: parsed.data.deviceTime,
  };
  const now = auth.now;
  const db = getDb();

  const dup = await existingResult(db, auth, cmd.id);
  if (dup) return dup;

  // 1) Identitas: sesi pemilik + tanda tangan.
  const verified = await verifyIdentity(auth, cmd, skew.thresholdMs);
  if (!verified.ok) return verified.result;

  // Selisih jam: dari jam kirim perangkat; waktu perangkat di masa depan / sebelum sesi juga ditandai.
  const futureSkew = cmd.deviceTime.getTime() - now.getTime();
  const clockSkewMs = skew.ms ?? (futureSkew > skew.thresholdMs ? futureSkew : null);
  const clockSkewFlagged =
    (clockSkewMs !== null && Math.abs(clockSkewMs) > skew.thresholdMs) || futureSkew > skew.thresholdMs || verified.beforeSessionStart;

  // 2) BR-37: akun nonaktif / lewat tanggal keluar → sesi dicabut, perintah ditolak final.
  const user = await loadUserState(db, cmd.userId);
  if (!user || !isUserUsable(user, now)) {
    await revokeAllSessions(cmd.userId, user?.status === "active" ? "exit_date" : "user_inactive", { now });
    const res = await storeRejected(
      auth,
      cmd,
      'Akun pengguna data ini sudah tidak aktif (nonaktif/tanggal keluar). Admin Keuangan dapat mencatatnya sebagai "dicatat kantor".',
      clockSkewMs,
    );
    return { ...res, code: "USER_INACTIVE" };
  }

  // 3) Bab 5.3: tanggal bisnis = tanggal WIB saat dicatat di perangkat.
  const allowed = allowedBusinessDates(cmd.deviceTime, skew.thresholdMs);
  if (!allowed.includes(cmd.businessDate)) {
    const res = await storeRejected(
      auth,
      cmd,
      `Tanggal bisnis data (${cmd.businessDate}) tidak sesuai waktu pencatatan di ponsel (${allowed[0]}). Periksa tanggal & jam ponsel lalu catat ulang.`,
      clockSkewMs,
    );
    return { ...res, code: "BUSINESS_DATE_MISMATCH" };
  }

  const handler = getSyncHandler(cmd.type);
  if (!handler) {
    return storeRejected(auth, cmd, "Jenis data ini tidak dikenal server. Perbarui aplikasi lalu kirim ulang; bila tetap gagal hubungi admin sistem.", clockSkewMs);
  }

  // 4) Lampiran: diunggah perangkat ini oleh pemilik perintah, isi (hash) sama dengan yang ditandatangani.
  let atts: SyncMeta["attachments"] = [];
  if (cmd.attachmentIds.length) {
    atts = await db.select().from(attachments).where(inArray(attachments.id, cmd.attachmentIds));
    const byId = new Map(atts.map((a) => [a.id, a]));
    if (cmd.attachmentIds.some((id) => !byId.has(id))) {
      return { id: cmd.id, status: "retry", code: "ATTACHMENT_MISSING", message: "Foto/lampiran belum terunggah. Akan dikirim ulang otomatis." };
    }
    const mismatch = cmd.attachmentIds.some((id, i) => {
      const a = byId.get(id)!;
      const hash = cmd.attachmentHashes[i];
      return (
        a.tenantId !== auth.device.tenantId ||
        a.deviceId !== auth.device.id ||
        a.uploadedBy !== cmd.userId ||
        (hash !== undefined && (a.sha256 ?? "").toLowerCase() !== hash.toLowerCase()) ||
        (a.objectType !== null && !(a.objectType === "sync_command" && a.objectId === cmd.id))
      );
    });
    if (cmd.attachmentHashes.length !== cmd.attachmentIds.length || mismatch) {
      const res = await storeRejected(auth, cmd, "Foto/lampiran tidak cocok dengan data ini (berbeda isi atau milik pengguna lain). Ambil ulang foto lalu catat ulang.", clockSkewMs);
      return { ...res, code: "ATTACHMENT_MISMATCH" };
    }
    atts = cmd.attachmentIds.map((id) => byId.get(id)!);
  }

  const lateSync = await computeLateSync(db, auth.device.tenantId, cmd.businessDate, now);

  const holder: { ctx: ActorContext | null } = { ctx: null };
  try {
    const outcome = await withTx(async (tx) => {
      const actor = await buildFieldActorContext(tx, auth.device, cmd.userId, { now, deviceTime: cmd.deviceTime, businessDate: cmd.businessDate });
      holder.ctx = actor;
      const payload = parseInput(handler.schema, cmd.payload, handler.labels);
      const meta: SyncMeta = {
        tx,
        command: cmd,
        device: auth.device,
        receivedAt: now,
        clockSkewMs,
        clockSkewFlagged,
        lateSync,
        attachments: atts,
      };
      if (handler.permission) {
        const perms = typeof handler.permission === "string" ? [handler.permission] : handler.permission;
        // Izin bersyarat (CONDITIONAL_GRANTS, mis. kernet pengganti US-M2-11) dihitung handler dari payload.
        const conditions = handler.conditions ? await handler.conditions(actor, payload, meta) : {};
        if (!perms.some((p) => can(actor, p, conditions))) throw permissionDenied(actor, perms[0]!, { objectType: "sync_command", objectId: cmd.id });
      }
      const res = (await handler.handle(actor, payload, meta)) ?? {};
      const status = res.status === "conflict" ? "conflict" : "applied";
      await tx.insert(syncCommands).values({
        id: cmd.id,
        tenantId: auth.device.tenantId,
        deviceId: auth.device.id,
        userId: cmd.userId,
        type: cmd.type,
        payload: (cmd.payload ?? {}) as object,
        deviceTime: cmd.deviceTime,
        businessDate: cmd.businessDate,
        receivedAt: now,
        processedAt: new Date(),
        status,
        result: res.result ?? null,
        message: res.message ?? null,
        objectType: res.objectType ?? null,
        objectId: res.objectId ?? null,
        clockSkewMs,
      });
      return {
        id: cmd.id,
        status,
        message: res.message ?? null,
        objectType: res.objectType ?? null,
        objectId: res.objectId ?? null,
        result: res.result,
        clockSkewFlagged,
        lateSync,
      } satisfies PushResult;
    });
    return outcome;
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await existingResult(db, auth, cmd.id);
      if (again) return again;
      // Pelanggaran unik tabel bisnis (bukan ID perintah): data yang sama sudah tercatat → final, tidak diulang.
      const res = await storeRejected(
        auth,
        cmd,
        "Data ini bentrok dengan data yang sudah tercatat (mungkin sudah dikirim dari perangkat lain). Admin Keuangan/Dispatcher akan memeriksanya.",
        clockSkewMs,
      );
      return { ...res, code: "DUPLICATE_DATA" };
    }
    if (error instanceof ForbiddenError && holder.ctx) await logDenialIfNeeded(holder.ctx, error);
    if (error instanceof DomainError || isHardeningViolation(error)) {
      const res = await storeRejected(auth, cmd, toUserMessage(error), clockSkewMs);
      return { ...res, code: error instanceof DomainError ? error.code : "HARDENING" };
    }
    console.error(`[equa] perintah sinkron ${cmd.type} (${cmd.id}) gagal:`, error);
    return { id: cmd.id, status: "retry", code: "SERVER_ERROR", message: "Server sedang bermasalah. Data tetap tersimpan di ponsel dan akan dikirim ulang." };
  }
}

/** Proses satu kiriman batch. */
export async function processPush(auth: DeviceAuth, body: unknown): Promise<PushResponse> {
  ensureBootstrapped(); // handler modul terdaftar lewat registerSync()
  const data = parseInput(pushBodySchema, body);
  const now = auth.now;
  const { minutes_gt } = await getParam(getDb(), "PAR-42", toBusinessDate(now));
  const skewMs = computeClockSkewMs(new Date(data.sentAt), now);
  const results: PushResult[] = [];
  for (const raw of data.commands) {
    results.push(await processOne(auth, raw, { ms: skewMs, thresholdMs: minutes_gt * 60_000 }));
  }
  await getDb()
    .update(devices)
    .set({ lastSyncAt: now, lastSeenAt: now, ...(auth.user ? { lastUserId: auth.user.id } : {}) })
    .where(and(eq(devices.id, auth.device.id)));
  if (data.health) await recordHealth(auth, data.health as HealthReport, { silent: true });
  return { ok: true, serverTime: now.toISOString(), results };
}
