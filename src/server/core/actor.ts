/**
 * Membangun `ActorContext` dari pengguna di DB dan menyelesaikan pelaku untuk route handler / Server Action.
 *
 * - `buildActorContext(tx, userId, { source, deviceId?, … })` — memuat peran & lingkup AKTIF (masa berlaku mencakup
 *   hari ini); menolak akun nonaktif ATAU lewat tanggal keluar (BR-37). Dipakai lapisan autentikasi (F3c) setelah
 *   sesi/token perangkat diverifikasi.
 * - `getActorContext(request?)` — pelaku permintaan saat ini lewat resolver yang dapat diganti. F3c memasang
 *   resolver (`src/server/core/auth/resolver.ts`, lewat `ensureBootstrapped` → `registerCoreAuth`): cookie
 *   `equa_session` (web kantor, 2FA wajib terverifikasi) atau `Authorization: Bearer <JWT perangkat>` (lapangan).
 */
import "server-only";

import { and, eq, gte, isNull, lte, or } from "drizzle-orm";

import { employees, userRoles, users, userScopes } from "@/db/schema";
import type { ActorSource, RoleCode } from "@/lib/labels";
import { toBusinessDate } from "@/lib/time";

import { ensureBootstrapped } from "./bootstrap";
import type { ActorContext, ActorScope } from "./context";
import type { Tx } from "./db";
import { ForbiddenError, NotFoundError } from "./errors";

export type BuildActorOptions = {
  source: ActorSource;
  deviceId?: string | null;
  now?: Date;
  deviceTime?: Date;
  businessDate?: string;
};

/** Konteks pelaku untuk pengguna aktif (peran & lingkup aktif hari ini). */
export async function buildActorContext(tx: Tx, userId: string, options: BuildActorOptions): Promise<ActorContext> {
  const now = options.now ?? new Date();
  const today = toBusinessDate(now);
  const rows = await tx
    .select({ id: users.id, tenantId: users.tenantId, employeeId: users.employeeId, status: users.status, exitDate: employees.exitDate })
    .from(users)
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(eq(users.id, userId))
    .limit(1);
  const user = rows[0];
  if (!user) throw new NotFoundError("Pengguna tidak ditemukan.");
  if (user.status !== "active") {
    throw new ForbiddenError("Akun Anda tidak aktif. Hubungi admin sistem.", { rule: "BR-37", objectType: "user", objectId: userId });
  }
  // BR-37: tanggal keluar tiba → akun tidak dapat bertindak dari sumber mana pun (web, lapangan, POS, sinkron).
  if (user.exitDate && user.exitDate <= today) {
    throw new ForbiddenError("Akun Anda sudah dinonaktifkan (tanggal keluar). Hubungi admin sistem bila ini keliru.", {
      rule: "BR-37",
      objectType: "user",
      objectId: userId,
    });
  }

  const roleRows = await tx
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(
      and(
        eq(userRoles.userId, userId),
        eq(userRoles.status, "active"),
        or(isNull(userRoles.validFrom), lte(userRoles.validFrom, today)),
        or(isNull(userRoles.validUntil), gte(userRoles.validUntil, today)),
      ),
    );
  const scopeRows = await tx
    .select({ type: userScopes.scopeType, refId: userScopes.refId })
    .from(userScopes)
    .where(
      and(
        eq(userScopes.userId, userId),
        eq(userScopes.status, "active"),
        or(isNull(userScopes.validFrom), lte(userScopes.validFrom, today)),
        or(isNull(userScopes.validUntil), gte(userScopes.validUntil, today)),
      ),
    );

  const scope: ActorScope = { truckIds: [], outletIds: [], sourceIds: [], tenantIds: [] };
  for (const s of scopeRows) {
    if (s.type === "truck") scope.truckIds.push(s.refId);
    else if (s.type === "outlet") scope.outletIds.push(s.refId);
    else if (s.type === "water_source") scope.sourceIds.push(s.refId);
    else if (s.type === "tenant") scope.tenantIds.push(s.refId);
  }

  return {
    userId: user.id,
    employeeId: user.employeeId,
    roles: Array.from(new Set(roleRows.map((r) => r.role as RoleCode))),
    scope,
    tenantId: user.tenantId,
    deviceId: options.deviceId ?? null,
    source: options.source,
    now,
    deviceTime: options.deviceTime,
    businessDate: options.businessDate,
  };
}

export type ActorResolver = (request?: Request) => Promise<ActorContext | null>;

// Bawaan tanpa sesi; F3c memasang resolver nyata saat bootstrap (setActorResolver).
const defaultResolver: ActorResolver = async () => null;

let resolver: ActorResolver = defaultResolver;

/** Pasang resolver pelaku (F3c). `null` = kembali ke bawaan (tanpa sesi). */
export function setActorResolver(fn: ActorResolver | null): void {
  resolver = fn ?? defaultResolver;
}

/** Pelaku permintaan saat ini, atau `null` bila belum masuk. */
export async function getActorContext(request?: Request): Promise<ActorContext | null> {
  ensureBootstrapped();
  return resolver(request);
}
