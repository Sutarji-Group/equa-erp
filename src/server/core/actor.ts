/**
 * Membangun `ActorContext` dari pengguna di DB dan menyelesaikan pelaku untuk route handler / Server Action.
 *
 * - `buildActorContext(tx, userId, { source, deviceId?, … })` — memuat peran & lingkup AKTIF (masa berlaku mencakup
 *   hari ini). Dipakai lapisan autentikasi (F3c) setelah sesi/token perangkat diverifikasi.
 * - `getActorContext(request?)` — pelaku permintaan saat ini lewat resolver yang dapat diganti.
 *   TODO(auth): F3c memanggil `setActorResolver(...)` (mis. di modul auth yang dimuat bootstrap) untuk membaca cookie
 *   `equa_session` / token perangkat lalu `buildActorContext`. Sampai itu, resolver bawaan mengembalikan `null`
 *   (route membalas 401).
 */
import "server-only";

import { and, eq, gte, isNull, lte, or } from "drizzle-orm";

import { userRoles, users, userScopes } from "@/db/schema";
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
    .select({ id: users.id, tenantId: users.tenantId, employeeId: users.employeeId, status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const user = rows[0];
  if (!user) throw new NotFoundError("Pengguna tidak ditemukan.");
  if (user.status !== "active") {
    throw new ForbiddenError("Akun Anda tidak aktif. Hubungi admin sistem.", { rule: "BR-37", objectType: "user", objectId: userId });
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

// TODO(auth): diganti F3c lewat setActorResolver (sesi web `equa_session`, token perangkat JWT).
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
