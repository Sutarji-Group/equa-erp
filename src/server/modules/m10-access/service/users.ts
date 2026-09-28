/**
 * M10 — pengguna, peran & lingkup (US-M10-01; BR-36, BR-37; PRD 6.2a "akun/peran/lingkup", 7.10.6).
 *
 * - `createUser` — akun dari TEPAT SATU karyawan M1 (BR-36; tanpa karyawan ditolak, akun kedua ditolak), satu peran
 *   dari katalog tetap, lingkup sesuai peran (KP-3). Akun berstatus "Menunggu persetujuan" dan AKTIF hanya setelah
 *   pemilik menyetujui permintaan `account_create` (KP-8), kecuali mode akun awal go-live (disetujui sekaligus lewat
 *   tanda tangan data awal `initial_accounts`, lihat `initial-accounts.ts`).
 * - `requestRoleChange` — pindah peran (`role_grant`, akun tetap, peran lama dicabut saat disetujui) atau peran
 *   tambahan (`multi_role`, WAJIB alasan + masa berlaku). Kombinasi terlarang PTB-31 TIDAK DAPAT DIAJUKAN.
 * - `requestScopeExtension` — perluasan lingkup lewat persetujuan pemilik (`scope_extension`).
 * - Pencabutan seketika TANPA persetujuan (BR-37): `revokeRole`, `revokeScope`, `deactivateUser` (sesi diputus, perangkat
 *   yang dipegang diblokir, data lama tetap merujuk namanya).
 * - Reset kredensial oleh admin sistem dengan pemberitahuan ke pemilik: `resetPin`, `issueInitialPin`, `resetPassword`,
 *   `resetTwoFactor` (pemilik yang kehilangan akses juga diberi tahu lewat e-mail — kanal lain, 7.10.6).
 */
import "server-only";

import { randomInt } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { accessLogs, approvalRequests, dataSignoffs, devices, employees, outlets, sessions, trucks, userRoles, users, userScopes, waterSources } from "@/db/schema";
import { enumValues, label, ROLE_CODES, type RoleCode, type ScopeType } from "@/lib/labels";
import { isBusinessDate, toBusinessDate } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { logAccess } from "@/server/core/access-log";
import { record as auditRecord } from "@/server/core/audit";
import { blockDevice, hashPassword, issuePinEnrollment, resetTotp, revokeAllSessions } from "@/server/core/auth";
import { ctxBusinessDate, isSystem, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, onAfterCommit, type Tx } from "@/server/core/db";
import { ConflictError, DomainError, parseInput, ValidationError } from "@/server/core/errors";
import { notify, sendEmail } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, authorizeAny, rolesAllowInterface, runService, sod } from "@/server/core/rbac";

import {
  activeRolesOf,
  assertNotOwnAccount,
  loadUserWithEmployee,
  normalizeScopes,
  scopeLabels,
  userNames,
  type ScopeInput,
  type UserRoleRow,
  type UserRow,
  type UserScopeRow,
} from "./shared";

// ---------------------------------------------------------------------------------------------------------------------
// Skema masukan
// ---------------------------------------------------------------------------------------------------------------------

const scopeSchema = z.object({
  type: z.enum(enumValues("scope_type"), { error: "Jenis lingkup tidak dikenal." }),
  refId: z.uuid({ error: "Unit lingkup tidak valid." }),
});
const reasonSchema = z.string().trim().min(5, { error: "Alasan wajib diisi (minimal 5 karakter)." }).max(500);
const roleSchema = z.enum(ROLE_CODES, { error: "Peran harus dipilih dari katalog peran tetap (US-M10-01 KP-1)." });

export const createUserSchema = z.object({
  employeeId: z.uuid({ error: "Pilih karyawan dari master karyawan (M1). Akun wajib terikat satu karyawan (BR-36)." }),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, { error: "Nama pengguna minimal 3 karakter." })
    .max(40, { error: "Nama pengguna maksimal 40 karakter." })
    .regex(/^[a-z0-9._-]+$/, { error: "Nama pengguna hanya huruf kecil, angka, titik, garis bawah, atau strip." }),
  role: roleSchema,
  scopes: z.array(scopeSchema).default([]),
  reason: reasonSchema,
  /** Mode akun awal go-live (US-M10-01 KP-8): disetujui sekaligus lewat tanda tangan daftar akun awal. */
  initialLoad: z.boolean().optional().default(false),
});
export type CreateUserInput = z.input<typeof createUserSchema>;

export const roleChangeSchema = z
  .object({
    userId: z.uuid({ error: "Pengguna tidak valid." }),
    role: roleSchema,
    /** `replace` = pindah/ubah peran (akun tetap); `add` = peran tambahan (multi-peran). */
    mode: z.enum(["replace", "add"], { error: "Pilih jenis permintaan: pindah peran atau peran tambahan." }),
    validUntil: z.string().refine(isBusinessDate, { error: "Masa berlaku harus tanggal (YYYY-MM-DD)." }).nullable().optional(),
    scopes: z.array(scopeSchema).default([]),
    reason: reasonSchema,
  })
  .refine((v) => v.mode !== "add" || !!v.validUntil, {
    error: "Peran tambahan wajib diberi masa berlaku (US-M10-01 KP-4).",
    path: ["validUntil"],
  });
export type RoleChangeInput = z.input<typeof roleChangeSchema>;

export const scopeExtensionSchema = z.object({
  userId: z.uuid({ error: "Pengguna tidak valid." }),
  scopes: z.array(scopeSchema).min(1, { error: "Pilih minimal satu unit lingkup." }),
  validUntil: z.string().refine(isBusinessDate, { error: "Masa berlaku harus tanggal (YYYY-MM-DD)." }).nullable().optional(),
  reason: reasonSchema,
});
export type ScopeExtensionInput = z.input<typeof scopeExtensionSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// Pembuatan akun (KP-1, KP-2, KP-3, KP-8)
// ---------------------------------------------------------------------------------------------------------------------

/** Benar bila daftar akun awal go-live tenant ini sudah ditandatangani pemilik (mode akun awal ditutup). */
export async function initialAccountsSigned(tx: Tx, tenantId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: dataSignoffs.id })
    .from(dataSignoffs)
    .where(and(eq(dataSignoffs.tenantId, tenantId), eq(dataSignoffs.group, "initial_accounts"), eq(dataSignoffs.status, "signed")))
    .limit(1);
  return rows.length > 0;
}

export type CreateUserResult = { user: UserRow; approval: approvals.ApprovalRow | null };

/** Buat akun dari karyawan (admin sistem). Aktif setelah disetujui pemilik (6.2a) atau lewat tanda tangan akun awal. */
export async function createUser(ctx: ActorContext, input: CreateUserInput, opts: { tx?: Tx } = {}): Promise<CreateUserResult> {
  await authorize(ctx, "m10.user.create", { tx: opts.tx, objectType: "user" });
  const data = parseInput(createUserSchema, input, { employeeId: "Karyawan", username: "Nama pengguna", role: "Peran", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const today = ctxBusinessDate(ctx);
    const empRows = await tx.select().from(employees).where(eq(employees.id, data.employeeId)).limit(1);
    const employee = empRows[0];
    if (!employee || employee.tenantId !== ctx.tenantId) {
      throw ValidationError.field("employeeId", "Karyawan tidak ditemukan di master karyawan (M1). Setiap akun wajib terikat satu karyawan (BR-36).");
    }
    if (!employee.isActive || (employee.exitDate && employee.exitDate <= today)) {
      throw ValidationError.field("employeeId", "Karyawan sudah keluar atau nonaktif; akun tidak dapat dibuat (BR-37).");
    }
    const existing = await tx.select({ id: users.id, username: users.username }).from(users).where(eq(users.employeeId, employee.id)).limit(1);
    if (existing[0]) {
      throw new ConflictError(
        "EMPLOYEE_HAS_ACCOUNT",
        `Karyawan ini sudah memiliki akun (${existing[0].username}). Satu orang satu akun (BR-36) — ubah peran akun yang ada lewat permintaan pindah peran.`,
      );
    }
    const taken = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.username}) = ${data.username}`).limit(1);
    if (taken[0]) throw ValidationError.field("username", "Nama pengguna sudah dipakai. Pilih nama lain (akun bersama tidak diizinkan, BR-36).");

    const scopes = await normalizeScopes(tx, ctx, [data.role], data.scopes as ScopeInput[]);
    if (data.initialLoad && (await initialAccountsSigned(tx, ctx.tenantId))) {
      throw new DomainError(
        "INITIAL_LOAD_CLOSED",
        "Daftar akun awal go-live sudah ditandatangani pemilik. Akun baru sekarang wajib lewat persetujuan pemilik satu per satu.",
      );
    }

    const [user] = await tx
      .insert(users)
      .values({ tenantId: ctx.tenantId, employeeId: employee.id, username: data.username, status: "pending_approval", createdBy: ctx.userId })
      .returning();
    const [roleRow] = await tx
      .insert(userRoles)
      .values({ userId: user!.id, role: data.role, status: "pending", validFrom: today, reason: data.reason, createdBy: ctx.userId })
      .returning();
    const scopeRows = scopes.length
      ? await tx
          .insert(userScopes)
          .values(scopes.map((s) => ({ userId: user!.id, scopeType: s.type, refId: s.refId, status: "pending" as const, validFrom: today, reason: data.reason, createdBy: ctx.userId })))
          .returning()
      : [];

    let approval: approvals.ApprovalRow | null = null;
    if (!data.initialLoad) {
      const labels = await scopeLabels(tx, scopes);
      approval = await approvals.submit(
        ctx,
        {
          type: "account_create",
          objectType: "user",
          objectId: user!.id,
          reason: data.reason,
          payload: {
            mode: "create",
            username: data.username,
            employeeName: employee.fullName,
            employeeNo: employee.employeeNo,
            role: data.role,
            roleLabel: label("role", data.role),
            scopes: scopes.map((s) => ({ ...s, label: labels.get(`${s.type}:${s.refId}`) })),
            link: `/akses/pengguna/${user!.id}`,
          },
        },
        { tx },
      );
      await linkApproval(tx, approval.id, { userId: user!.id, roleIds: [roleRow!.id], scopeIds: scopeRows.map((s) => s.id), account: true });
    }

    await auditRecord(tx, {
      ctx,
      objectType: "user",
      objectId: user!.id,
      action: "create",
      after: {
        username: data.username,
        employeeNo: employee.employeeNo,
        role: data.role,
        scopes,
        status: "pending_approval",
        initialLoad: data.initialLoad,
        approval: approval?.number ?? null,
      },
      reason: data.reason,
    });
    return { user: user!, approval };
  });
}

async function linkApproval(
  tx: Tx,
  approvalId: string,
  refs: { userId: string; roleIds?: string[]; scopeIds?: string[]; account?: boolean },
): Promise<void> {
  if (refs.account) await tx.update(users).set({ approvalRequestId: approvalId }).where(eq(users.id, refs.userId));
  if (refs.roleIds?.length) await tx.update(userRoles).set({ approvalRequestId: approvalId }).where(inArray(userRoles.id, refs.roleIds));
  if (refs.scopeIds?.length) await tx.update(userScopes).set({ approvalRequestId: approvalId }).where(inArray(userScopes.id, refs.scopeIds));
}

/**
 * Ajukan pengaktifan kembali akun nonaktif (karyawan kembali bekerja / permintaan akun sebelumnya ditolak): peran &
 * lingkup baru menunggu persetujuan pemilik (`account_create`, mode `reactivate`).
 */
export async function requestReactivation(
  ctx: ActorContext,
  input: { userId: string; role: RoleCode; scopes?: ScopeInput[]; reason: string },
  opts: { tx?: Tx } = {},
): Promise<approvals.ApprovalRow> {
  await authorize(ctx, "m10.user.create", { tx: opts.tx, objectType: "user", objectId: input.userId });
  const data = parseInput(
    z.object({ userId: z.uuid(), role: roleSchema, scopes: z.array(scopeSchema).default([]), reason: reasonSchema }),
    input,
    { role: "Peran", reason: "Alasan" },
  );
  return runService(ctx, opts, async (tx) => {
    const { user, employee } = await loadUserWithEmployee(tx, ctx, data.userId);
    assertNotOwnAccount(ctx, user.id, "mengaktifkan kembali akses");
    const today = ctxBusinessDate(ctx);
    if (user.status !== "inactive") throw ValidationError.field("userId", "Hanya akun nonaktif yang dapat diajukan aktif kembali.");
    if (employee.exitDate && employee.exitDate <= today) {
      throw ValidationError.field("userId", "Karyawan sudah keluar (tanggal keluar di master M1). Hapus tanggal keluar di master karyawan dulu bila karyawan kembali bekerja.");
    }
    await assertNoPendingGrants(tx, user.id);
    const scopes = await normalizeScopes(tx, ctx, [data.role], data.scopes as ScopeInput[]);
    const [roleRow] = await tx
      .insert(userRoles)
      .values({ userId: user.id, role: data.role, status: "pending", validFrom: today, reason: data.reason, createdBy: ctx.userId })
      .returning();
    const scopeRows = await insertPendingScopes(tx, ctx, user.id, scopes, data.reason, null);
    const labels = await scopeLabels(tx, scopes);
    const approval = await approvals.submit(
      ctx,
      {
        type: "account_create",
        objectType: "user",
        objectId: user.id,
        reason: data.reason,
        payload: {
          mode: "reactivate",
          username: user.username,
          employeeName: employee.fullName,
          role: data.role,
          roleLabel: label("role", data.role),
          scopes: scopes.map((s) => ({ ...s, label: labels.get(`${s.type}:${s.refId}`) })),
          link: `/akses/pengguna/${user.id}`,
        },
      },
      { tx },
    );
    await linkApproval(tx, approval.id, { userId: user.id, roleIds: [roleRow!.id], scopeIds: scopeRows.map((s) => s.id), account: true });
    await auditRecord(tx, { ctx, objectType: "user", objectId: user.id, action: "submit", after: { reactivate: true, role: data.role, approval: approval.number }, reason: data.reason });
    return approval;
  });
}

async function assertNoPendingGrants(tx: Tx, userId: string): Promise<void> {
  const pendingRoles = await tx.select({ id: userRoles.id }).from(userRoles).where(and(eq(userRoles.userId, userId), eq(userRoles.status, "pending"))).limit(1);
  if (pendingRoles[0]) {
    throw new ConflictError("ACCESS_REQUEST_OPEN", "Masih ada permintaan peran untuk pengguna ini yang menunggu keputusan pemilik. Tunggu keputusannya dulu.");
  }
}

async function insertPendingScopes(tx: Tx, ctx: ActorContext, userId: string, scopes: ScopeInput[], reason: string, validUntil: string | null): Promise<UserScopeRow[]> {
  if (scopes.length === 0) return [];
  const live = await tx
    .select({ type: userScopes.scopeType, refId: userScopes.refId })
    .from(userScopes)
    .where(and(eq(userScopes.userId, userId), inArray(userScopes.status, ["pending", "active"])));
  const liveKeys = new Set(live.map((s) => `${s.type}:${s.refId}`));
  const fresh = scopes.filter((s) => !liveKeys.has(`${s.type}:${s.refId}`));
  if (fresh.length === 0) return [];
  return tx
    .insert(userScopes)
    .values(
      fresh.map((s) => ({
        userId,
        scopeType: s.type,
        refId: s.refId,
        status: "pending" as const,
        validFrom: ctxBusinessDate(ctx),
        validUntil,
        reason,
        createdBy: ctx.userId,
      })),
    )
    .returning();
}

// ---------------------------------------------------------------------------------------------------------------------
// Peran (KP-4, KP-8, 7.10.6 pindah peran)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Ajukan perubahan peran: pindah peran (`role_grant`; akun tetap, peran lama dicabut saat disetujui, lingkup diubah)
 * atau peran tambahan (`multi_role`; alasan + masa berlaku wajib). Kombinasi PTB-31 ditolak SEBELUM diajukan.
 */
export async function requestRoleChange(ctx: ActorContext, input: RoleChangeInput, opts: { tx?: Tx } = {}): Promise<approvals.ApprovalRow> {
  await authorize(ctx, "m10.role.request", { tx: opts.tx, objectType: "user", objectId: input.userId });
  const data = parseInput(roleChangeSchema, input, { role: "Peran", validUntil: "Masa berlaku", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const { user, employee } = await loadUserWithEmployee(tx, ctx, data.userId);
    assertNotOwnAccount(ctx, user.id, "mengajukan perubahan peran");
    if (user.status !== "active") throw ValidationError.field("userId", "Akun belum aktif atau nonaktif; ajukan lewat permintaan akun.");
    const today = ctxBusinessDate(ctx);
    if (data.validUntil && data.validUntil < today) throw ValidationError.field("validUntil", "Masa berlaku tidak boleh sebelum hari ini.");
    await assertNoPendingGrants(tx, user.id);
    const current = (await activeRolesOf(tx, [user.id], today)).get(user.id) ?? [];
    if (current.includes(data.role)) throw ValidationError.field("role", `Pengguna sudah memegang peran ${label("role", data.role)}.`);
    const resulting = data.mode === "add" ? [...current, data.role] : [data.role];
    // PTB-31: kombinasi terlarang tidak dapat diajukan sama sekali (US-M10-01 KP-4).
    sod.assertRoleCombination(resulting, { objectType: "user", objectId: user.id });

    // Peran yang sama yang sudah lewat masa berlaku (masih tercatat aktif) ditutup dulu agar tidak dobel.
    await tx
      .update(userRoles)
      .set({ status: "revoked", revokedAt: ctx.now, revokedBy: ctx.userId, revokeReason: "Masa berlaku berakhir", updatedAt: ctx.now })
      .where(and(eq(userRoles.userId, user.id), eq(userRoles.role, data.role), eq(userRoles.status, "active"), lt(userRoles.validUntil, today)));

    const activeScopes = await tx
      .select({ type: userScopes.scopeType, refId: userScopes.refId })
      .from(userScopes)
      .where(and(eq(userScopes.userId, user.id), eq(userScopes.status, "active")));
    const required = await normalizeScopes(tx, ctx, [data.role], [
      ...activeScopes.filter((s) => (data.scopes as ScopeInput[]).length === 0 && sameKind(data.role, s.type)).map((s) => ({ type: s.type, refId: s.refId })),
      ...(data.scopes as ScopeInput[]),
    ]);
    const [roleRow] = await tx
      .insert(userRoles)
      .values({
        userId: user.id,
        role: data.role,
        status: "pending",
        validFrom: today,
        validUntil: data.mode === "add" ? (data.validUntil ?? null) : null,
        reason: data.reason,
        createdBy: ctx.userId,
      })
      .returning();
    const scopeRows = await insertPendingScopes(tx, ctx, user.id, required, data.reason, null);
    const labels = await scopeLabels(tx, required);
    const approval = await approvals.submit(
      ctx,
      {
        type: data.mode === "add" ? "multi_role" : "role_grant",
        objectType: "user",
        objectId: user.id,
        reason: data.reason,
        payload: {
          mode: data.mode,
          username: user.username,
          employeeName: employee.fullName,
          role: data.role,
          roleLabel: label("role", data.role),
          currentRoles: current,
          validUntil: data.validUntil ?? null,
          scopes: required.map((s) => ({ ...s, label: labels.get(`${s.type}:${s.refId}`) })),
          link: `/akses/pengguna/${user.id}`,
        },
      },
      { tx },
    );
    await linkApproval(tx, approval.id, { userId: user.id, roleIds: [roleRow!.id], scopeIds: scopeRows.map((s) => s.id) });
    await auditRecord(tx, {
      ctx,
      objectType: "user_role",
      objectId: roleRow!.id,
      action: "submit",
      after: { userId: user.id, role: data.role, mode: data.mode, validUntil: data.validUntil ?? null, approval: approval.number },
      reason: data.reason,
    });
    return approval;
  });
}

function sameKind(role: RoleCode, type: ScopeType): boolean {
  const kinds: Record<string, ScopeType> = { truck: "truck", outlet: "outlet", water_source: "water_source", tenant: "tenant" };
  const want = role === "driver" || role === "helper" ? "truck" : role === "depot_operator" || role === "store_cashier" ? "outlet" : role === "production_operator" ? "water_source" : "tenant";
  return kinds[type] === want;
}

/** Ajukan perluasan lingkup (persetujuan pemilik, 6.2a). */
export async function requestScopeExtension(ctx: ActorContext, input: ScopeExtensionInput, opts: { tx?: Tx } = {}): Promise<approvals.ApprovalRow> {
  await authorize(ctx, "m10.scope.request", { tx: opts.tx, objectType: "user", objectId: input.userId });
  const data = parseInput(scopeExtensionSchema, input, { scopes: "Lingkup", reason: "Alasan", validUntil: "Masa berlaku" });
  return runService(ctx, opts, async (tx) => {
    const { user, employee } = await loadUserWithEmployee(tx, ctx, data.userId);
    assertNotOwnAccount(ctx, user.id, "mengajukan perluasan lingkup");
    if (user.status !== "active") throw ValidationError.field("userId", "Akun belum aktif atau nonaktif.");
    const today = ctxBusinessDate(ctx);
    const roles = (await activeRolesOf(tx, [user.id], today)).get(user.id) ?? [];
    if (roles.length === 0) throw ValidationError.field("userId", "Pengguna belum memegang peran aktif.");
    const pendingScopes = await tx.select({ id: userScopes.id }).from(userScopes).where(and(eq(userScopes.userId, user.id), eq(userScopes.status, "pending"))).limit(1);
    if (pendingScopes[0]) throw new ConflictError("ACCESS_REQUEST_OPEN", "Masih ada permintaan lingkup yang menunggu keputusan pemilik.");
    const activeScopes = await tx
      .select({ type: userScopes.scopeType, refId: userScopes.refId })
      .from(userScopes)
      .where(and(eq(userScopes.userId, user.id), eq(userScopes.status, "active")));
    await normalizeScopes(tx, ctx, roles, [...activeScopes.map((s) => ({ type: s.type, refId: s.refId })), ...(data.scopes as ScopeInput[])]);
    const rows = await insertPendingScopes(tx, ctx, user.id, data.scopes as ScopeInput[], data.reason, data.validUntil ?? null);
    if (rows.length === 0) throw ValidationError.field("scopes", "Semua unit yang dipilih sudah ada di lingkup pengguna.");
    const labels = await scopeLabels(tx, rows.map((r) => ({ type: r.scopeType, refId: r.refId })));
    const approval = await approvals.submit(
      ctx,
      {
        type: "scope_extension",
        objectType: "user",
        objectId: user.id,
        reason: data.reason,
        payload: {
          username: user.username,
          employeeName: employee.fullName,
          scopes: rows.map((r) => ({ type: r.scopeType, refId: r.refId, label: labels.get(`${r.scopeType}:${r.refId}`) })),
          validUntil: data.validUntil ?? null,
          link: `/akses/pengguna/${user.id}`,
        },
      },
      { tx },
    );
    await linkApproval(tx, approval.id, { userId: user.id, scopeIds: rows.map((r) => r.id) });
    await auditRecord(tx, {
      ctx,
      objectType: "user_scope",
      objectId: rows[0]!.id,
      action: "submit",
      after: { userId: user.id, scopes: rows.map((r) => ({ type: r.scopeType, refId: r.refId })), approval: approval.number },
      reason: data.reason,
    });
    return approval;
  });
}

/** Cabut peran aktif seketika tanpa persetujuan (BR-37). */
export async function revokeRole(ctx: ActorContext, input: { userId: string; roleId: string; reason: string }, opts: { tx?: Tx } = {}): Promise<UserRoleRow> {
  await authorize(ctx, "m10.role.revoke", { tx: opts.tx, objectType: "user_role", objectId: input.roleId });
  const reason = parseInput(reasonSchema, input.reason, { "": "Alasan" });
  return runService(ctx, opts, async (tx) => {
    await loadUserWithEmployee(tx, ctx, input.userId);
    const rows = await tx.select().from(userRoles).where(and(eq(userRoles.id, input.roleId), eq(userRoles.userId, input.userId))).limit(1);
    const row = rows[0];
    if (!row || row.status !== "active") throw ValidationError.field("roleId", "Peran tidak aktif atau tidak ditemukan.");
    const [updated] = await tx
      .update(userRoles)
      .set({ status: "revoked", revokedAt: ctx.now, revokedBy: ctx.userId, revokeReason: reason, updatedAt: ctx.now })
      .where(eq(userRoles.id, row.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "user_role", objectId: row.id, action: "revoke", before: { status: "active", role: row.role }, after: { status: "revoked", role: row.role, userId: row.userId }, reason, rule: "BR-37" });
    return updated!;
  });
}

/** Kurangi lingkup seketika tanpa persetujuan (BR-37). */
export async function revokeScope(ctx: ActorContext, input: { userId: string; scopeId: string; reason: string }, opts: { tx?: Tx } = {}): Promise<UserScopeRow> {
  await authorize(ctx, "m10.scope.revoke", { tx: opts.tx, objectType: "user_scope", objectId: input.scopeId });
  const reason = parseInput(reasonSchema, input.reason, { "": "Alasan" });
  return runService(ctx, opts, async (tx) => {
    await loadUserWithEmployee(tx, ctx, input.userId);
    const rows = await tx.select().from(userScopes).where(and(eq(userScopes.id, input.scopeId), eq(userScopes.userId, input.userId))).limit(1);
    const row = rows[0];
    if (!row || row.status !== "active") throw ValidationError.field("scopeId", "Lingkup tidak aktif atau tidak ditemukan.");
    const [updated] = await tx
      .update(userScopes)
      .set({ status: "revoked", revokedAt: ctx.now, revokedBy: ctx.userId, revokeReason: reason, updatedAt: ctx.now })
      .where(eq(userScopes.id, row.id))
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "user_scope",
      objectId: row.id,
      action: "revoke",
      before: { status: "active", scopeType: row.scopeType, refId: row.refId },
      after: { status: "revoked", scopeType: row.scopeType, refId: row.refId, userId: row.userId },
      reason,
      rule: "BR-37",
    });
    return updated!;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Penonaktifan (KP-5, BR-37)
// ---------------------------------------------------------------------------------------------------------------------

export type DeactivationResult = { userId: string; alreadyInactive: boolean; sessionsRevoked: number; devicesBlocked: string[]; requestsCancelled: number };

/**
 * Nonaktifkan akun seketika (admin sistem, tanpa persetujuan — BR-37): sesi aktif diputus, perangkat yang dipegangnya
 * diblokir, permintaan akses yang masih terbuka dibatalkan. Data yang pernah dibuatnya tetap utuh & merujuk namanya.
 */
export async function deactivateUser(ctx: ActorContext, input: { userId: string; reason: string }, opts: { tx?: Tx } = {}): Promise<DeactivationResult> {
  await authorize(ctx, "m10.user.deactivate", { tx: opts.tx, objectType: "user", objectId: input.userId });
  const reason = parseInput(reasonSchema, input.reason, { "": "Alasan" });
  return runService(ctx, opts, async (tx) => {
    assertNotOwnAccount(ctx, input.userId, "menonaktifkan akun");
    return deactivateInTx(tx, ctx, input.userId, reason, { rule: "BR-37" });
  });
}

/** Inti penonaktifan (dipakai admin sistem & otomatis tanggal keluar dengan konteks Sistem). */
export async function deactivateInTx(
  tx: Tx,
  ctx: ActorContext,
  userId: string,
  reason: string,
  opts: { rule?: string; exitDate?: boolean } = {},
): Promise<DeactivationResult> {
  const { user, employee } = await loadUserWithEmployee(tx, ctx, userId);
  if (user.status === "inactive") {
    const revoked = await revokeAllSessions(user.id, opts.exitDate ? "exit_date" : "user_inactive", { tx, now: ctx.now, actorUserId: ctx.userId });
    return { userId: user.id, alreadyInactive: true, sessionsRevoked: revoked, devicesBlocked: [], requestsCancelled: 0 };
  }
  await tx
    .update(users)
    .set({ status: "inactive", deactivatedAt: ctx.now, deactivatedBy: ctx.userId, deactivationReason: reason, updatedAt: ctx.now })
    .where(eq(users.id, user.id));

  // Permintaan akses terbuka untuk akun ini dibatalkan (tidak ada akses tersisa yang dapat "menyusul" aktif).
  const open = await tx
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.objectType, "user"),
        eq(approvalRequests.objectId, user.id),
        eq(approvalRequests.status, "submitted"),
        inArray(approvalRequests.type, ["account_create", "role_grant", "scope_extension", "multi_role"]),
      ),
    );
  for (const r of open) {
    await approvals.cancel(systemContext({ tenantId: ctx.tenantId, now: ctx.now }), r.id, `Akun dinonaktifkan: ${reason}`, { tx });
  }
  await tx
    .update(userRoles)
    .set({ status: "rejected", updatedAt: ctx.now })
    .where(and(eq(userRoles.userId, user.id), eq(userRoles.status, "pending")));
  await tx
    .update(userScopes)
    .set({ status: "rejected", updatedAt: ctx.now })
    .where(and(eq(userScopes.userId, user.id), eq(userScopes.status, "pending")));

  const sessionsRevoked = await revokeAllSessions(user.id, opts.exitDate ? "exit_date" : "user_inactive", { tx, now: ctx.now, actorUserId: ctx.userId });

  const held = await tx
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.tenantId, ctx.tenantId), eq(devices.holderEmployeeId, employee.id), inArray(devices.status, ["registered", "active"])));
  const devicesBlocked: string[] = [];
  for (const d of held) {
    await blockDevice(ctx, d.id, `Pemegang perangkat (${employee.fullName}) dinonaktifkan: ${reason}`, { tx });
    devicesBlocked.push(d.id);
  }

  await auditRecord(tx, {
    ctx,
    objectType: "user",
    objectId: user.id,
    action: "deactivate",
    before: { status: user.status },
    after: { status: "inactive", sessionsRevoked, devicesBlocked, requestsCancelled: open.length },
    reason,
    rule: opts.rule ?? null,
  });
  if (isSystem(ctx)) {
    await notify(tx, {
      event: "user.deactivated",
      tenantId: ctx.tenantId,
      title: `Akun ${employee.fullName} dinonaktifkan otomatis`,
      body: `${reason}. Sesi diputus: ${sessionsRevoked}; perangkat diblokir: ${devicesBlocked.length}.`,
      objectType: "user",
      objectId: user.id,
      link: `/akses/pengguna/${user.id}`,
      now: ctx.now,
    });
  }
  return { userId: user.id, alreadyInactive: false, sessionsRevoked, devicesBlocked, requestsCancelled: open.length };
}

// ---------------------------------------------------------------------------------------------------------------------
// Kredensial (US-M10-02 KP-3/KP-4; 7.10.6)
// ---------------------------------------------------------------------------------------------------------------------

/** Reset PIN (admin sistem; pemilik diberi tahu oleh core `user.pin_reset`) → kode sekali pakai untuk PIN baru. */
export async function resetPin(ctx: ActorContext, input: { userId: string; reason: string }, opts: { tx?: Tx } = {}) {
  const reason = parseInput(reasonSchema, input.reason, { "": "Alasan" });
  assertNotOwnAccount(ctx, input.userId, "mereset PIN");
  return issuePinEnrollment(ctx, input.userId, { purpose: "reset", reason }, opts);
}

/** Kode aktivasi akun lapangan pertama kali (pengguna menetapkan PIN sendiri di hadapan admin sistem). */
export async function issueInitialPin(ctx: ActorContext, input: { userId: string }, opts: { tx?: Tx } = {}) {
  assertNotOwnAccount(ctx, input.userId, "menerbitkan kode PIN");
  return issuePinEnrollment(ctx, input.userId, { purpose: "initial", reason: "Kode aktivasi akun lapangan" }, opts);
}

const TEMP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

function temporaryPassword(): string {
  const part = () => Array.from({ length: 4 }, () => TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)]).join("");
  return `${part()}-${part()}-${part()}`;
}

async function ownerChannelEmail(tx: Tx, ctx: ActorContext, subject: string, text: string): Promise<void> {
  const { emails } = await params.get(tx, "notifications.digest_recipients", ctxBusinessDate(ctx));
  if (emails.length === 0) return;
  onAfterCommit(tx, async () => {
    await sendEmail({ to: [...emails], subject, text });
  });
}

async function hasOwnerRole(tx: Tx, userId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: userRoles.id })
    .from(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.role, "owner"), eq(userRoles.status, "active")))
    .limit(1);
  return rows.length > 0;
}

/**
 * Reset kata sandi web kantor oleh admin sistem: kata sandi sementara (≥ 10 karakter, ditampilkan SEKALI untuk
 * diserahkan langsung), wajib diganti saat masuk, semua sesi web dicabut, pemilik diberi tahu (in-app; bila yang direset
 * pemilik sendiri juga lewat e-mail — verifikasi di luar sistem, 7.10.6).
 */
export async function resetPassword(ctx: ActorContext, input: { userId: string; reason: string }, opts: { tx?: Tx } = {}): Promise<{ temporaryPassword: string; userName: string }> {
  await authorize(ctx, "m10.user.reset_password", { tx: opts.tx, objectType: "user", objectId: input.userId });
  const reason = parseInput(reasonSchema, input.reason, { "": "Alasan" });
  const temp = temporaryPassword();
  const hash = await hashPassword(temp);
  return runService(ctx, opts, async (tx) => {
    assertNotOwnAccount(ctx, input.userId, "mereset kata sandi");
    const { user, employee } = await loadUserWithEmployee(tx, ctx, input.userId);
    if (user.status === "inactive") throw ValidationError.field("userId", "Akun nonaktif; kata sandi tidak dapat direset.");
    const roles = (await activeRolesOf(tx, [user.id], ctxBusinessDate(ctx))).get(user.id) ?? [];
    if (!rolesAllowInterface(roles, "web") && !rolesAllowInterface(roles, "portal")) {
      throw ValidationError.field("userId", "Pengguna lapangan/POS memakai PIN, bukan kata sandi. Gunakan Reset PIN.");
    }
    await tx
      .update(users)
      .set({ passwordHash: hash, passwordChangedAt: ctx.now, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null, updatedAt: ctx.now })
      .where(eq(users.id, user.id));
    await revokeAllSessions(user.id, "admin", { tx, now: ctx.now, kind: "web", actorUserId: ctx.userId });
    await logAccess(tx, { event: "password_changed", tenantId: ctx.tenantId, userId: user.id, reason, details: { reset: true, by: ctx.userId }, occurredAt: ctx.now });
    await auditRecord(tx, { ctx, objectType: "user", objectId: user.id, action: "update", after: { passwordReset: true, mustChangePassword: true }, reason });
    await notify(tx, {
      event: "user.password_reset",
      tenantId: ctx.tenantId,
      title: `Kata sandi ${employee.fullName} direset admin sistem`,
      body: `Alasan: ${reason}`,
      objectType: "user",
      objectId: user.id,
      link: `/akses/pengguna/${user.id}`,
      now: ctx.now,
    });
    if (await hasOwnerRole(tx, user.id)) {
      await ownerChannelEmail(tx, ctx, "EQUA — kata sandi pemilik direset", `Kata sandi akun ${user.username} direset admin sistem. Alasan: ${reason}. Bila Anda tidak memintanya, hubungi tim IT segera.`);
    }
    return { temporaryPassword: temp, userName: employee.fullName };
  });
}

/** Reset 2FA (core `resetTotp`: sesi dicabut, pemilik diberi tahu) + e-mail bila akun pemilik (7.10.6). */
export async function resetTwoFactor(ctx: ActorContext, input: { userId: string; reason: string }, opts: { tx?: Tx } = {}): Promise<void> {
  const reason = parseInput(reasonSchema, input.reason, { "": "Alasan" });
  assertNotOwnAccount(ctx, input.userId, "mereset 2FA");
  await authorize(ctx, "m10.user.reset_totp", { tx: opts.tx, objectType: "user", objectId: input.userId });
  await runService(ctx, opts, async (tx) => {
    const { user } = await loadUserWithEmployee(tx, ctx, input.userId);
    await resetTotp(ctx, input.userId, reason, { tx });
    if (await hasOwnerRole(tx, user.id)) {
      await ownerChannelEmail(tx, ctx, "EQUA — 2FA pemilik direset", `Autentikasi dua faktor akun ${user.username} direset admin sistem. Alasan: ${reason}. Daftarkan ulang aplikasi autentikator saat masuk berikutnya.`);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Kueri (tampilan)
// ---------------------------------------------------------------------------------------------------------------------

export type UserListItem = {
  id: string;
  username: string;
  status: UserRow["status"];
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  employeeId: string;
  employeeNo: string;
  fullName: string;
  position: string;
  exitDate: string | null;
  roles: { id: string; role: RoleCode; status: UserRoleRow["status"]; validUntil: string | null; expired: boolean }[];
  scopes: { id: string; type: ScopeType; refId: string; status: UserScopeRow["status"]; label: string }[];
  pendingApproval: boolean;
  createdAt: Date;
};

export type UserListFilter = { status?: UserRow["status"] | "pending" | "all"; q?: string };

/** Daftar pengguna tenant (admin sistem, pemilik). */
export async function listUsers(ctx: ActorContext, filter: UserListFilter = {}, opts: { tx?: Tx } = {}): Promise<UserListItem[]> {
  await authorize(ctx, "m10.user.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx
    .select({ user: users, employee: employees })
    .from(users)
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(eq(users.tenantId, ctx.tenantId))
    .orderBy(asc(employees.fullName));
  const q = filter.q?.trim().toLowerCase();
  const filtered = rows.filter(({ user, employee }) => {
    if (filter.status === "pending" && user.status !== "pending_approval") return false;
    if (filter.status && filter.status !== "all" && filter.status !== "pending" && user.status !== filter.status) return false;
    if (q && !`${user.username} ${employee.fullName} ${employee.employeeNo}`.toLowerCase().includes(q)) return false;
    return true;
  });
  return decorateUsers(tx, ctx, filtered);
}

async function decorateUsers(tx: Tx, ctx: ActorContext, rows: { user: UserRow; employee: typeof employees.$inferSelect }[]): Promise<UserListItem[]> {
  const ids = rows.map((r) => r.user.id);
  const today = ctxBusinessDate(ctx);
  const roleRows = ids.length
    ? await tx.select().from(userRoles).where(and(inArray(userRoles.userId, ids), inArray(userRoles.status, ["pending", "active"]))).orderBy(asc(userRoles.createdAt))
    : [];
  const scopeRows = ids.length
    ? await tx.select().from(userScopes).where(and(inArray(userScopes.userId, ids), inArray(userScopes.status, ["pending", "active"]))).orderBy(asc(userScopes.createdAt))
    : [];
  const labels = await scopeLabels(tx, scopeRows.map((s) => ({ type: s.scopeType, refId: s.refId })));
  return rows.map(({ user, employee }) => {
    const roles = roleRows
      .filter((r) => r.userId === user.id)
      .map((r) => ({ id: r.id, role: r.role as RoleCode, status: r.status, validUntil: r.validUntil, expired: !!r.validUntil && r.validUntil < today }));
    return {
      id: user.id,
      username: user.username,
      status: user.status,
      lockedUntil: user.lockedUntil && user.lockedUntil > ctx.now ? user.lockedUntil : null,
      lastLoginAt: user.lastLoginAt,
      employeeId: employee.id,
      employeeNo: employee.employeeNo,
      fullName: employee.fullName,
      position: employee.position,
      exitDate: employee.exitDate,
      roles,
      scopes: scopeRows
        .filter((s) => s.userId === user.id)
        .map((s) => ({ id: s.id, type: s.scopeType, refId: s.refId, status: s.status, label: labels.get(`${s.scopeType}:${s.refId}`) ?? s.refId })),
      pendingApproval: user.status === "pending_approval" || roles.some((r) => r.status === "pending"),
      createdAt: user.createdAt,
    };
  });
}

export type UserDetail = UserListItem & {
  deactivatedAt: Date | null;
  deactivationReason: string | null;
  deactivatedByName: string | null;
  totpEnabled: boolean;
  hasPin: boolean;
  history: { roles: UserRoleRow[]; scopes: (UserScopeRow & { label: string })[] };
  sessions: { id: string; kind: string; deviceId: string | null; deviceCode: string | null; createdAt: Date; lastActiveAt: Date; expiresAt: Date; revokedAt: Date | null; revokeReason: string | null }[];
  devicesHeld: { id: string; code: string; name: string; status: string }[];
  recentAccess: (typeof accessLogs.$inferSelect)[];
  approvals: approvals.ApprovalRow[];
  names: Map<string, string>;
};

/** Rincian satu pengguna: peran/lingkup (termasuk riwayat), sesi, perangkat yang dipegang, log akses, persetujuan. */
export async function getUserDetail(ctx: ActorContext, userId: string, opts: { tx?: Tx } = {}): Promise<UserDetail> {
  await authorize(ctx, "m10.user.read", { tx: opts.tx, objectType: "user", objectId: userId });
  const tx = opts.tx ?? getDb();
  const { user, employee } = await loadUserWithEmployee(tx, ctx, userId);
  const [base] = await decorateUsers(tx, ctx, [{ user, employee }]);
  const roleHistory = await tx.select().from(userRoles).where(eq(userRoles.userId, userId)).orderBy(desc(userRoles.createdAt));
  const scopeHistory = await tx.select().from(userScopes).where(eq(userScopes.userId, userId)).orderBy(desc(userScopes.createdAt));
  const labels = await scopeLabels(tx, scopeHistory.map((s) => ({ type: s.scopeType, refId: s.refId })));
  const sessionRows = await tx
    .select({ s: sessions, deviceCode: devices.deviceCode })
    .from(sessions)
    .leftJoin(devices, eq(devices.id, sessions.deviceId))
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.createdAt))
    .limit(20);
  const held = await tx
    .select({ id: devices.id, code: devices.deviceCode, name: devices.name, status: devices.status })
    .from(devices)
    .where(and(eq(devices.tenantId, ctx.tenantId), eq(devices.holderEmployeeId, employee.id)));
  const recentAccess = await tx.select().from(accessLogs).where(eq(accessLogs.userId, userId)).orderBy(desc(accessLogs.occurredAt)).limit(20);
  const approvalRows = await approvals.listForObject(tx, "user", userId);
  const names = await userNames(tx, [
    user.deactivatedBy,
    ...roleHistory.flatMap((r) => [r.grantedBy, r.revokedBy, r.createdBy]),
    ...scopeHistory.flatMap((s) => [s.revokedBy, s.createdBy]),
    ...approvalRows.flatMap((a) => [a.requesterUserId, a.decidedBy]),
  ]);
  return {
    ...base!,
    deactivatedAt: user.deactivatedAt,
    deactivationReason: user.deactivationReason,
    deactivatedByName: user.deactivatedBy ? (names.get(user.deactivatedBy) ?? null) : null,
    totpEnabled: user.totpEnabled,
    hasPin: !!user.pinHash,
    history: { roles: roleHistory, scopes: scopeHistory.map((s) => ({ ...s, label: labels.get(`${s.scopeType}:${s.refId}`) ?? s.refId })) },
    sessions: sessionRows.map(({ s, deviceCode }) => ({
      id: s.id,
      kind: s.kind,
      deviceId: s.deviceId,
      deviceCode,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      expiresAt: s.expiresAt,
      revokedAt: s.revokedAt,
      revokeReason: s.revokeReason,
    })),
    devicesHeld: held,
    recentAccess,
    approvals: approvalRows,
    names,
  };
}

/** Karyawan aktif tanpa akun (pilihan formulir buat akun, BR-36). */
export async function listEmployeesWithoutAccount(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m10.user.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = toBusinessDate(ctx.now);
  const rows = await tx
    .select({ id: employees.id, employeeNo: employees.employeeNo, fullName: employees.fullName, position: employees.position, exitDate: employees.exitDate, intendedRoles: employees.intendedRoles })
    .from(employees)
    .leftJoin(users, eq(users.employeeId, employees.id))
    .where(and(eq(employees.tenantId, ctx.tenantId), eq(employees.isActive, true), isNull(users.id)))
    .orderBy(asc(employees.fullName));
  return rows.filter((r) => !r.exitDate || r.exitDate > today);
}

export type ScopeOption = { value: string; label: string };
export type ScopeOptions = {
  trucks: ScopeOption[];
  depots: ScopeOption[];
  stores: ScopeOption[];
  sources: ScopeOption[];
  employees: { id: string; label: string }[];
};

/** Pilihan unit lingkup & karyawan aktif untuk formulir akun/perangkat (nilai `jenis:id`). */
export async function listScopeOptions(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<ScopeOptions> {
  await authorizeAny(ctx, ["m10.user.read", "m10.device.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const truckRows = await tx
    .select({ id: trucks.id, code: trucks.code, plate: trucks.plateNumber })
    .from(trucks)
    .where(and(eq(trucks.tenantId, ctx.tenantId), eq(trucks.isActive, true)))
    .orderBy(asc(trucks.code));
  const outletRows = await tx
    .select({ id: outlets.id, code: outlets.code, name: outlets.name, kind: outlets.kind })
    .from(outlets)
    .where(and(eq(outlets.tenantId, ctx.tenantId), eq(outlets.isActive, true)))
    .orderBy(asc(outlets.code));
  const sourceRows = await tx
    .select({ id: waterSources.id, name: waterSources.name })
    .from(waterSources)
    .where(and(eq(waterSources.tenantId, ctx.tenantId), eq(waterSources.isActive, true)))
    .orderBy(asc(waterSources.code));
  const today = ctxBusinessDate(ctx);
  const empRows = await tx
    .select({ id: employees.id, name: employees.fullName, no: employees.employeeNo, exitDate: employees.exitDate })
    .from(employees)
    .where(and(eq(employees.tenantId, ctx.tenantId), eq(employees.isActive, true)))
    .orderBy(asc(employees.fullName));
  return {
    trucks: truckRows.map((t) => ({ value: `truck:${t.id}`, label: `Truk ${t.code} · ${t.plate}` })),
    depots: outletRows.filter((o) => o.kind === "depot").map((o) => ({ value: `outlet:${o.id}`, label: `${o.name} (${o.code})` })),
    stores: outletRows.filter((o) => o.kind === "store").map((o) => ({ value: `outlet:${o.id}`, label: `${o.name} (${o.code})` })),
    sources: sourceRows.map((s) => ({ value: `water_source:${s.id}`, label: s.name })),
    employees: empRows.filter((e) => !e.exitDate || e.exitDate > today).map((e) => ({ id: e.id, label: `${e.name} (${e.no})` })),
  };
}
