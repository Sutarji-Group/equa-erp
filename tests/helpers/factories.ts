/**
 * Pembuat data uji (docs/ARCHITECTURE.md §10). Semua fungsi menerima `db` (atau transaksi) dan menulis baris nyata.
 *
 * ```ts
 * const t = useTestDb();                                   // skema kosong
 * const owner = await createTestUser(t.db, { role: "owner" });
 * await approvals.decide(owner.ctx, id, "approve");
 * ```
 */
import { eq } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import { employees, tenants, userRoles, users, userScopes } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import { newId } from "@/lib/ids";
import type { RoleCode, ScopeType } from "@/lib/labels";
import type { ActorContext, ActorScope } from "@/server/core/context";

import { testContext } from "./context";

let counter = 0;

/** Pastikan tenant ada (bawaan tenant EQUA). */
export async function ensureTenant(db: DbOrTx, id: string = EQUA_TENANT_ID, code = "EQUA", kind: "owner" | "partner" = "owner"): Promise<string> {
  const existing = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, id)).limit(1);
  if (!existing[0]) await db.insert(tenants).values({ id, code, name: code, kind }).onConflictDoNothing();
  return id;
}

export type CreateTestUserOptions = {
  role?: RoleCode;
  roles?: RoleCode[];
  username?: string;
  fullName?: string;
  tenantId?: string;
  scope?: Partial<ActorScope>;
  status?: "active" | "inactive" | "locked" | "pending_approval";
  /** Masa berlaku peran (multi-peran/akuntan). */
  roleValidUntil?: string | null;
  now?: Date;
};

export type TestUser = { userId: string; employeeId: string; username: string; roles: RoleCode[]; ctx: ActorContext };

/** Buat karyawan + akun + peran aktif + lingkup aktif. Peran kantor bawaan berlingkup tenant. */
export async function createTestUser(db: DbOrTx, options: CreateTestUserOptions = {}): Promise<TestUser> {
  counter++;
  const roles = options.roles ?? [options.role ?? "owner"];
  const tenantId = await ensureTenant(db, options.tenantId ?? EQUA_TENANT_ID);
  const username = options.username ?? `uji_${roles.join("_")}_${counter}_${Math.random().toString(36).slice(2, 7)}`;
  const empId = newId();
  const userId = newId();
  await db.insert(employees).values({
    id: empId,
    tenantId,
    employeeNo: `UJI-${counter}-${empId.slice(-6)}`,
    fullName: options.fullName ?? `Pengguna Uji ${counter}`,
    position: roles.join(", "),
    intendedRoles: roles,
  });
  await db.insert(users).values({
    id: userId,
    tenantId,
    employeeId: empId,
    username,
    status: options.status ?? "active",
  });
  await db.insert(userRoles).values(
    roles.map((role) => ({
      userId,
      role,
      status: "active" as const,
      validFrom: "2025-01-01",
      validUntil: options.roleValidUntil ?? null,
      reason: "Data uji",
    })),
  );

  const ctx = testContext({ roles, userId, employeeId: empId, tenantId, scope: options.scope, now: options.now });
  const scopeRows: { scopeType: ScopeType; refId: string }[] = [
    ...ctx.scope.truckIds.map((refId) => ({ scopeType: "truck" as const, refId })),
    ...ctx.scope.outletIds.map((refId) => ({ scopeType: "outlet" as const, refId })),
    ...ctx.scope.sourceIds.map((refId) => ({ scopeType: "water_source" as const, refId })),
    ...ctx.scope.tenantIds.map((refId) => ({ scopeType: "tenant" as const, refId })),
  ];
  if (scopeRows.length) {
    await db.insert(userScopes).values(scopeRows.map((s) => ({ userId, ...s, status: "active" as const, validFrom: "2025-01-01" })));
  }
  return { userId, employeeId: empId, username, roles, ctx };
}

/** Satu pengguna untuk setiap peran yang diminta (kunci = kode peran). */
export async function createUsersForRoles<R extends RoleCode>(db: DbOrTx, roles: readonly R[]): Promise<Record<R, TestUser>> {
  const out = {} as Record<R, TestUser>;
  for (const role of roles) out[role] = await createTestUser(db, { role });
  return out;
}
