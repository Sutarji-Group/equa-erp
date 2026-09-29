/**
 * Resolver pelaku (`setActorResolver`, src/server/core/actor.ts) — dipasang sekali oleh `ensureBootstrapped()`
 * lewat `registerCoreAuth()`:
 *
 * - `Authorization: Bearer <JWT perangkat>` → pelaku lapangan/POS dari sesi PIN di klaim `sessionId` (wajib).
 * - Cookie `equa_session` (dari `request` atau `next/headers`) → pelaku web kantor; sesi peran wajib 2FA yang belum
 *   terverifikasi TIDAK menghasilkan pelaku.
 * - Selain itu `null` (route membalas 401).
 */
import "server-only";

import { eq } from "drizzle-orm";

import { users } from "@/db/schema";

import { setActorResolver } from "../actor";
import type { ActorContext } from "../context";
import { getDb, type Tx } from "../db";
import { buildActorContext } from "../actor";
import { ROLE_CATALOG } from "../rbac/roles";
import { authenticateDevice } from "./device-auth";
import { isAuthError } from "./errors";
import { buildFieldActorContext } from "./field-login";
import { SESSION_COOKIE, validateSession, type SessionRow } from "./session";

/** Ambil nilai cookie dari header `Cookie`. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      const raw = part.slice(idx + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

/** Sesi web peran wajib 2FA yang belum melewati TOTP. */
export function isPending2fa(ctx: Pick<ActorContext, "roles">, session: Pick<SessionRow, "totpVerifiedAt">): boolean {
  return !session.totpVerifiedAt && ctx.roles.some((r) => ROLE_CATALOG[r]?.requires2fa);
}

/** Pelaku web dari token sesi (null bila tidak berlaku / menunggu 2FA). */
export async function webActorFromToken(token: string | null | undefined, options: { now?: Date; tx?: Tx } = {}): Promise<ActorContext | null> {
  if (!token) return null;
  const tx = options.tx ?? getDb();
  const now = options.now ?? new Date();
  const v = await validateSession(tx, token, { kind: "web", now });
  if (!v.ok) return null;
  const ctx = await buildActorContext(tx, v.user.id, { source: "web", now });
  if (isPending2fa(ctx, v.session)) return null;
  // B-08: kata sandi sementara wajib diganti dulu — API web menolak pelaku sampai diganti (halaman /akun/kata-sandi).
  const [pw] = await tx.select({ must: users.mustChangePassword }).from(users).where(eq(users.id, v.user.id)).limit(1);
  if (pw?.must) return null;
  return ctx;
}

/** Resolver untuk `getActorContext(request?)`. */
export async function resolveActor(request?: Request): Promise<ActorContext | null> {
  try {
    if (request) {
      if (/^Bearer\s/i.test(request.headers.get("authorization") ?? "")) {
        const auth = await authenticateDevice(request, { requireSession: true });
        return buildFieldActorContext(getDb(), auth.device, auth.user!.id, { now: auth.now });
      }
      return webActorFromToken(readCookie(request.headers.get("cookie"), SESSION_COOKIE));
    }
    let token: string | null = null;
    try {
      const { cookies } = await import("next/headers");
      token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
    } catch {
      // Di luar konteks permintaan Next (skrip/uji) → tanpa pelaku.
      return null;
    }
    return webActorFromToken(token);
  } catch (error) {
    if (isAuthError(error)) return null;
    throw error;
  }
}

let installed = false;

/** Pasang resolver (idempoten). */
export function installActorResolver(): void {
  if (installed) return;
  installed = true;
  setActorResolver(resolveActor);
}
