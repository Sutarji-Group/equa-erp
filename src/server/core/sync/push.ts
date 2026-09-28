/**
 * `POST /api/sync/push` (docs/ARCHITECTURE.md §7; US-M3-09 KP-2; US-M6-06 KP-2; NFR-07).
 *
 * Batch ≤ 50 perintah outbox diproses BERURUTAN, masing-masing dalam transaksinya sendiri:
 * 1. `sync_commands` sudah ada (ID klien sama, perangkat sama) → `duplicate` + hasil lama (pengiriman ulang tidak
 *    menggandakan).
 * 2. Pengguna perintah wajib punya sesi lapangan di perangkat ini yang berlaku saat perintah dibuat; bila tidak →
 *    `retry` (tidak disimpan) dengan kode `SESSION_REQUIRED` agar klien meminta login PIN daring.
 * 3. Handler dari `registerSyncHandler(type)`: izin → validasi Zod → `handle(ctx, payload, meta)`; hasil & baris
 *    `sync_commands` di-commit bersama. `DomainError` → `rejected` (pesan Indonesia, disimpan, final); galat tak
 *    terduga → `retry` (tidak disimpan). Satu perintah gagal TIDAK menggagalkan batch.
 * 4. Selisih jam perangkat > PAR-42 → `clock_skew_ms` + `meta.clockSkewFlagged`.
 */
import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { attachments, devices, employees, syncCommands, users } from "@/db/schema";
import { isUuid } from "@/lib/ids";
import { isBusinessDate, toBusinessDate } from "@/lib/time";

import { ensureBootstrapped } from "../bootstrap";
import { getDb, withTx, type Tx } from "../db";
import { DomainError, ForbiddenError, parseInput, toUserMessage } from "../errors";
import { get as getParam } from "../params-read";
import { can, logDenialIfNeeded, permissionDenied } from "../rbac/authorize";
import type { DeviceAuth } from "../auth/device-auth";
import { buildFieldActorContext } from "../auth/field-login";
import { findFieldSessionCovering, isUserUsable } from "../auth/session";
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
  deviceTime: z.iso.datetime({ offset: true, error: "Waktu perangkat tidak valid." }),
  businessDate: z.string().refine(isBusinessDate, { error: "Tanggal bisnis harus YYYY-MM-DD." }),
  attachmentIds: z.array(z.string().refine(isUuid)).max(20).optional().default([]),
});

const pushBodySchema = z.object({
  commands: z.array(z.unknown()).max(MAX_PUSH_BATCH, { error: `Maksimal ${MAX_PUSH_BATCH} perintah per kiriman.` }),
  /** Jam perangkat (mentah, belum dikoreksi) saat mengirim — dasar selisih jam (PAR-42). */
  sentAt: z.iso.datetime({ offset: true }).optional(),
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
        payload: (cmd.payload ?? null) as object,
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

async function userUsable(tx: Tx, userId: string, now: Date): Promise<boolean> {
  const rows = await tx
    .select({ status: users.status, exitDate: employees.exitDate })
    .from(users)
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(eq(users.id, userId))
    .limit(1);
  return !!rows[0] && isUserUsable(rows[0], now);
}

/** Selisih jam perangkat (ms) dari `sentAt` (jam mentah perangkat saat kirim). */
export function computeClockSkewMs(sentAt: Date | null, now: Date): number | null {
  if (!sentAt) return null;
  return sentAt.getTime() - now.getTime();
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
  const cmd: SyncCommandInput = { ...parsed.data, deviceTime: new Date(parsed.data.deviceTime) };
  const now = auth.now;
  const db = getDb();

  const dup = await existingResult(db, auth, cmd.id);
  if (dup) return dup;

  // Selisih jam: dari jam kirim perangkat; bila tidak ada, waktu perangkat di masa depan juga ditandai.
  const futureSkew = cmd.deviceTime.getTime() - now.getTime();
  const clockSkewMs = skew.ms ?? (futureSkew > skew.thresholdMs ? futureSkew : null);
  const clockSkewFlagged = clockSkewMs !== null && Math.abs(clockSkewMs) > skew.thresholdMs;

  const handler = getSyncHandler(cmd.type);
  if (!handler) {
    return storeRejected(auth, cmd, "Jenis data ini tidak dikenal server. Perbarui aplikasi lalu kirim ulang; bila tetap gagal hubungi admin sistem.", clockSkewMs);
  }

  const at = new Date(Math.min(cmd.deviceTime.getTime(), now.getTime()));
  const session = await findFieldSessionCovering(db, cmd.userId, auth.device.id, at);
  if (!session) {
    if (!(await userUsable(db, cmd.userId, now))) {
      return storeRejected(auth, cmd, "Akun pengguna data ini sudah tidak aktif. Admin Keuangan dapat mencatatnya sebagai \"dicatat kantor\".", clockSkewMs);
    }
    return {
      id: cmd.id,
      status: "retry",
      code: "SESSION_REQUIRED",
      message: "Data tersimpan di ponsel. Pemiliknya perlu masuk dengan PIN saat ada sinyal agar data terkirim.",
    };
  }

  if (cmd.attachmentIds.length) {
    const found = await db
      .select({ id: attachments.id, tenantId: attachments.tenantId })
      .from(attachments)
      .where(inArray(attachments.id, cmd.attachmentIds));
    const ok = new Set(found.filter((a) => a.tenantId === auth.device.tenantId).map((a) => a.id));
    const missing = cmd.attachmentIds.filter((id) => !ok.has(id));
    if (missing.length) {
      return { id: cmd.id, status: "retry", code: "ATTACHMENT_MISSING", message: "Foto/lampiran belum terunggah. Akan dikirim ulang otomatis." };
    }
  }

  const holder: { ctx: ActorContext | null } = { ctx: null };
  try {
    const outcome = await withTx(async (tx) => {
      const actor = await buildFieldActorContext(tx, auth.device, cmd.userId, { now, deviceTime: cmd.deviceTime, businessDate: cmd.businessDate });
      holder.ctx = actor;
      if (handler.permission) {
        const perms = typeof handler.permission === "string" ? [handler.permission] : handler.permission;
        if (!perms.some((p) => can(actor, p))) throw permissionDenied(actor, perms[0]!, { objectType: "sync_command", objectId: cmd.id });
      }
      const payload = parseInput(handler.schema, cmd.payload, handler.labels);
      const atts = cmd.attachmentIds.length ? await tx.select().from(attachments).where(inArray(attachments.id, cmd.attachmentIds)) : [];
      const meta: SyncMeta = { tx, command: cmd, device: auth.device, receivedAt: now, clockSkewMs, clockSkewFlagged, attachments: atts };
      const res = (await handler.handle(actor, payload, meta)) ?? {};
      const status = res.status === "conflict" ? "conflict" : "applied";
      await tx.insert(syncCommands).values({
        id: cmd.id,
        tenantId: auth.device.tenantId,
        deviceId: auth.device.id,
        userId: cmd.userId,
        type: cmd.type,
        payload: (cmd.payload ?? null) as object,
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
      } satisfies PushResult;
    });
    return outcome;
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await existingResult(db, auth, cmd.id);
      if (again) return again;
    }
    if (error instanceof ForbiddenError && holder.ctx) await logDenialIfNeeded(holder.ctx, error);
    if (error instanceof DomainError) {
      const res = await storeRejected(auth, cmd, toUserMessage(error), clockSkewMs);
      return { ...res, code: error.code };
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
  const skewMs = computeClockSkewMs(data.sentAt ? new Date(data.sentAt) : null, now);
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
