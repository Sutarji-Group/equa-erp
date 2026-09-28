/**
 * Sesi web kantor untuk Server Component / Server Action / route handler (Next.js 16). Bergantung `next/headers` &
 * `next/navigation` — JANGAN diimpor dari uji Vitest atau skrip; logika murni ada di `./session.ts` & `./web-login.ts`.
 *
 * ```ts
 * // Halaman (Server Component)
 * const { ctx, user, permissions } = await requirePermission("m10.audit_log.read");
 * // Server Action
 * "use server";
 * export async function simpan(formData: FormData) {
 *   const { ctx } = await requireOfficeSession();
 *   await layananModul(ctx, { … });   // authorize di dalam layanan
 *   revalidatePath("/…");
 * }
 * ```
 */
import "server-only";

import { eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { employees, users } from "@/db/schema";
import { serverEnv } from "@/lib/env";
import { label, type RoleCode } from "@/lib/labels";

import { buildActorContext } from "../actor";
import { ensureBootstrapped } from "../bootstrap";
import type { ActorContext } from "../context";
import { getDb } from "../db";
import { can, recordDenial, permissionDenied } from "../rbac/authorize";
import { permissionsForRoles } from "../rbac/matrix";
import { requestIp } from "./device-auth";
import { isPending2fa } from "./resolver";
import { SESSION_COOKIE, validateSession, type SessionInvalidReason, type SessionRow } from "./session";
import { rolesAllowInterface } from "../rbac/roles";
import type { RequestMeta } from "./web-login";
import { loginUrl, reasonParam } from "./login-urls";

export { LOGIN_REASON_MESSAGES, loginUrl, safeNextPath } from "./login-urls";

export type OfficeUser = {
  id: string;
  username: string;
  name: string;
  roles: RoleCode[];
  roleLabels: string[];
};

export type ActiveOfficeSession = {
  state: "active";
  ctx: ActorContext;
  session: SessionRow;
  user: OfficeUser;
  /** Izin dari matriks RBAC untuk peran aktif (menu kantor, tombol). */
  permissions: string[];
};

export type OfficeSessionState =
  | ActiveOfficeSession
  | { state: "totp" | "totp_enroll"; session: SessionRow; user: OfficeUser }
  | { state: "none"; reason: OfficeSessionInvalidReason };

/** Alasan tanpa sesi kantor: sesi tidak berlaku, atau peran tanpa antarmuka `web` (Kasir → POS, mitra → portal). */
export type OfficeSessionInvalidReason = SessionInvalidReason | "no_web_access";

async function officeUser(userId: string, roles: RoleCode[]): Promise<OfficeUser> {
  const rows = await getDb()
    .select({ username: users.username, fullName: employees.fullName })
    .from(users)
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(eq(users.id, userId))
    .limit(1);
  return {
    id: userId,
    username: rows[0]?.username ?? "",
    name: rows[0]?.fullName ?? "Pengguna",
    roles,
    roleLabels: roles.map((r) => label("role", r)),
  };
}

/** Status sesi web kantor untuk permintaan ini (di-cache per permintaan). */
export const getOfficeSession = cache(async (): Promise<OfficeSessionState> => {
  // Registri modul (laporan, handler sinkron, label/objek keuangan audit) harus terisi sebelum halaman kantor membacanya.
  ensureBootstrapped();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const db = getDb();
  const v = await validateSession(db, token, { kind: "web" });
  if (!v.ok) return { state: "none", reason: v.reason };
  let ctx: ActorContext;
  try {
    ctx = await buildActorContext(db, v.user.id, { source: "web" });
  } catch {
    return { state: "none", reason: "user_inactive" };
  }
  const user = await officeUser(v.user.id, ctx.roles);
  if (isPending2fa(ctx, v.session)) {
    const rows = await db.select({ totpEnabled: users.totpEnabled }).from(users).where(eq(users.id, v.user.id)).limit(1);
    return { state: rows[0]?.totpEnabled ? "totp" : "totp_enroll", session: v.session, user };
  }
  if (ctx.roles.length === 0) return { state: "none", reason: "user_inactive" };
  // Hanya peran berantarmuka web kantor (ROLE_CATALOG.interfaces; keputusan D-07): Kasir/lapangan → POS/aplikasi
  // lapangan, pemilik mitra → portal.
  if (!rolesAllowInterface(ctx.roles, "web")) return { state: "none", reason: "no_web_access" };
  return { state: "active", ctx, session: v.session, user, permissions: permissionsForRoles(ctx.roles) };
});

/** Wajib sesi aktif; bila tidak → redirect ke /masuk (dengan alasan) atau langkah 2FA. */
export async function requireOfficeSession(): Promise<ActiveOfficeSession> {
  const s = await getOfficeSession();
  if (s.state === "active") return s;
  if (s.state === "none") return redirect(loginUrl(reasonParam(s.reason)));
  return redirect(s.state === "totp" ? "/masuk/2fa" : "/masuk/atur-2fa");
}

/**
 * Wajib sesi aktif + izin (salah satu bila array). Ditolak → dicatat di log akses dan diarahkan ke /beranda dengan
 * pesan (bukan halaman galat).
 */
export async function requirePermission(permission: string | readonly string[]): Promise<ActiveOfficeSession> {
  const s = await requireOfficeSession();
  const perms = typeof permission === "string" ? [permission] : permission;
  if (perms.some((p) => can(s.ctx, p))) return s;
  await recordDenial(s.ctx, permissionDenied(s.ctx, perms[0]!));
  return redirect("/beranda?ditolak=1");
}

/** IP & user-agent permintaan (untuk log akses). */
export async function getRequestMeta(): Promise<RequestMeta> {
  const h = await headers();
  return { ip: requestIp(h), userAgent: h.get("user-agent")?.slice(0, 500) ?? null };
}

/** Pasang cookie sesi (Server Action / route handler). */
export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: serverEnv().NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Token sesi dari cookie (untuk langkah 2FA/keluar). */
export async function currentSessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}
