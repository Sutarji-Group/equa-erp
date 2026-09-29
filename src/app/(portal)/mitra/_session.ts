/**
 * Sesi portal pemilik mitra (RL-7 US-P3-10 KP-1; D-07). Memakai sesi web yang sama (`equa_session`, dibuat
 * `loginWithPassword(..., { interface: "portal" })`), tetapi HANYA peran berantarmuka `portal` (Pemilik mitra) yang
 * diterima — akun web kantor diarahkan ke /masuk, akun mitra tidak pernah masuk web kantor (`getOfficeSession`
 * menolaknya). Pelaku = `source: "partner_portal"`, tenant = tenant mitra pemilik akun (lingkup tenant sendiri).
 */
import "server-only";

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { employees, tenants, users } from "@/db/schema";
import { buildActorContext } from "@/server/core/actor";
import { FORCED_CHANGE_PASSWORD_URL, rolesAllowInterface, SESSION_COOKIE, validateSession } from "@/server/core/auth";
import { ensureBootstrapped } from "@/server/core/bootstrap";
import type { ActorContext } from "@/server/core/context";
import { getDb } from "@/server/core/db";

export type PortalSession = {
  ctx: ActorContext;
  user: { id: string; name: string; username: string };
  tenant: { id: string; code: string; name: string; readOnly: boolean; isActive: boolean };
};

export type PortalSessionState = { state: "active"; session: PortalSession } | { state: "none"; reason: "no_session" | "not_portal" | "inactive" | "must_change_password" };

/** Status sesi portal untuk permintaan ini (di-cache per permintaan). */
export const getPortalSession = cache(async (): Promise<PortalSessionState> => {
  ensureBootstrapped();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const db = getDb();
  const v = await validateSession(db, token, { kind: "web" });
  if (!v.ok) return { state: "none", reason: "no_session" };
  let ctx: ActorContext;
  try {
    ctx = await buildActorContext(db, v.user.id, { source: "partner_portal" });
  } catch {
    return { state: "none", reason: "inactive" };
  }
  if (!ctx.roles.length) return { state: "none", reason: "inactive" };
  if (!rolesAllowInterface(ctx.roles, "portal")) return { state: "none", reason: "not_portal" };
  const [row] = await db
    .select({ username: users.username, name: employees.fullName, tenantId: tenants.id, code: tenants.code, tenantName: tenants.name, readOnly: tenants.readOnly, isActive: tenants.isActive, mustChangePassword: users.mustChangePassword })
    .from(users)
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(eq(users.id, v.user.id))
    .limit(1);
  if (!row) return { state: "none", reason: "inactive" };
  // B-08: kata sandi sementara wajib diganti dulu (halaman /akun/kata-sandi, sama dengan web kantor).
  if (row.mustChangePassword) return { state: "none", reason: "must_change_password" };
  return {
    state: "active",
    session: {
      ctx,
      user: { id: v.user.id, name: row.name, username: row.username },
      tenant: { id: row.tenantId, code: row.code, name: row.tenantName, readOnly: row.readOnly, isActive: row.isActive },
    },
  };
});

/** Wajib sesi portal aktif; bila tidak → /mitra/masuk (dengan alasan). */
export async function requirePortalSession(): Promise<PortalSession> {
  const s = await getPortalSession();
  if (s.state === "active") return s.session;
  if (s.reason === "must_change_password") return redirect(FORCED_CHANGE_PASSWORD_URL);
  return redirect(s.reason === "not_portal" ? "/mitra/masuk?alasan=bukan-portal" : s.reason === "inactive" ? "/mitra/masuk?alasan=akun-nonaktif" : "/mitra/masuk");
}
