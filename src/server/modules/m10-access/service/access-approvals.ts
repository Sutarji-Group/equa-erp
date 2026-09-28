/**
 * M10 — efek keputusan permintaan akses (PRD 6.2a; US-M10-01 KP-4/KP-8; US-M10-04 KP-3/KP-4; D-08).
 *
 * Handler menerima `ctx` PENYETUJU (pemilik). Tulisan langsung dengan `tx` + `audit.record` (tanpa `authorize` izin
 * admin — pemilik tidak memegangnya). Aturan:
 * - Disetujui → akun/peran/lingkup yang tertaut permintaan menjadi Aktif; pindah peran mencabut peran lama & lingkup
 *   yang tidak sesuai peran baru (akun tetap; riwayat transaksi lama tetap merujuk peran saat itu).
 * - Ditolak / dibatalkan → pemberian berstatus Ditolak; akun baru tetap tidak aktif.
 * - Lewat tenggat (`escalate`, D-08) → permintaan TETAP terbuka & ditandai terlambat; akses TIDAK pernah aktif tanpa
 *   keputusan ("Akun/peran tidak aktif"). Handler `onOverdue` hanya mencatat jejak.
 * - Kombinasi peran diperiksa ulang saat disetujui (PTB-31): bila kini terlarang, keputusan ditolak dengan pesan.
 */
import "server-only";

import { and, eq, inArray, ne } from "drizzle-orm";

import { users, userRoles, userScopes } from "@/db/schema";
import type { RoleCode } from "@/lib/labels";
import type { ApprovalHandlerArgs, ApprovalHandlers } from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError } from "@/server/core/errors";
import { sod } from "@/server/core/rbac";

import { activeRolesOf, scopeRuleFor } from "./shared";

async function activateLinked(tx: Tx, args: ApprovalHandlerArgs): Promise<{ roles: RoleCode[]; scopes: number }> {
  const { request, ctx } = args;
  const pendingRoles = await tx
    .select()
    .from(userRoles)
    .where(and(eq(userRoles.approvalRequestId, request.id), eq(userRoles.status, "pending")));
  const pendingScopes = await tx
    .select()
    .from(userScopes)
    .where(and(eq(userScopes.approvalRequestId, request.id), eq(userScopes.status, "pending")));
  if (pendingRoles.length) {
    await tx
      .update(userRoles)
      .set({ status: "active", grantedBy: ctx.userId, grantedAt: ctx.now, updatedAt: ctx.now })
      .where(inArray(userRoles.id, pendingRoles.map((r) => r.id)));
    for (const r of pendingRoles) {
      await auditRecord(tx, {
        ctx,
        objectType: "user_role",
        objectId: r.id,
        action: "activate",
        before: { status: "pending" },
        after: { status: "active", role: r.role, userId: r.userId, validUntil: r.validUntil, approval: request.number },
        rule: "6.2a",
      });
    }
  }
  if (pendingScopes.length) {
    await tx
      .update(userScopes)
      .set({ status: "active", updatedAt: ctx.now })
      .where(inArray(userScopes.id, pendingScopes.map((s) => s.id)));
    for (const s of pendingScopes) {
      await auditRecord(tx, {
        ctx,
        objectType: "user_scope",
        objectId: s.id,
        action: "activate",
        before: { status: "pending" },
        after: { status: "active", scopeType: s.scopeType, refId: s.refId, userId: s.userId, approval: request.number },
        rule: "6.2a",
      });
    }
  }
  return { roles: pendingRoles.map((r) => r.role as RoleCode), scopes: pendingScopes.length };
}

async function rejectLinked(tx: Tx, args: ApprovalHandlerArgs, why: string): Promise<void> {
  const { request, ctx } = args;
  const roles = await tx
    .update(userRoles)
    .set({ status: "rejected", revokeReason: why, updatedAt: ctx.now })
    .where(and(eq(userRoles.approvalRequestId, request.id), eq(userRoles.status, "pending")))
    .returning({ id: userRoles.id, role: userRoles.role });
  const scopes = await tx
    .update(userScopes)
    .set({ status: "rejected", revokeReason: why, updatedAt: ctx.now })
    .where(and(eq(userScopes.approvalRequestId, request.id), eq(userScopes.status, "pending")))
    .returning({ id: userScopes.id });
  if (roles.length || scopes.length) {
    await auditRecord(tx, {
      ctx,
      objectType: "user",
      objectId: request.objectId,
      action: "reject",
      after: { roles: roles.map((r) => r.role), scopes: scopes.length, approval: request.number },
      reason: why,
      rule: "6.2a",
    });
  }
}

/** Periksa ulang kombinasi peran pada saat disetujui (peran pengguna dapat berubah sejak diajukan). */
async function assertCombinationStillValid(tx: Tx, args: ApprovalHandlerArgs, mode: "add" | "replace"): Promise<void> {
  const { request } = args;
  const pending = await tx
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(and(eq(userRoles.approvalRequestId, request.id), eq(userRoles.status, "pending")));
  const current = (await activeRolesOf(tx, [request.objectId], ctxBusinessDate(args.ctx))).get(request.objectId) ?? [];
  const resulting = mode === "add" ? [...current, ...pending.map((p) => p.role as RoleCode)] : pending.map((p) => p.role as RoleCode);
  const check = sod.validateRoleCombination(resulting);
  if (!check.ok) {
    throw new DomainError(
      "ROLE_COMBINATION_FORBIDDEN",
      `${check.violations.map((v) => v.message).join(" ")} Tolak permintaan ini; kombinasi terlarang tidak dapat diaktifkan (PTB-31).`,
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------------

/** `account_create`: akun baru / pengaktifan kembali. */
export const accountCreateHandlers: ApprovalHandlers = {
  onApproved: async (args) => {
    const { tx, request, ctx } = args;
    const rows = await tx.select().from(users).where(eq(users.id, request.objectId)).limit(1);
    const user = rows[0];
    // Permintaan yang tidak merujuk akun M10 (mis. diajukan langsung lewat API inti) tidak mengaktifkan apa pun.
    if (!user) return { activated: false, note: "Akun yang dimintakan tidak ditemukan" };
    if (user.status === "active") return { activated: false, note: "Akun sudah aktif" };
    await assertCombinationStillValid(tx, args, "replace");
    await tx
      .update(users)
      .set({ status: "active", activatedAt: ctx.now, deactivatedAt: null, deactivatedBy: null, deactivationReason: null, updatedAt: ctx.now })
      .where(eq(users.id, user.id));
    const linked = await activateLinked(tx, args);
    await auditRecord(tx, {
      ctx,
      objectType: "user",
      objectId: user.id,
      action: "activate",
      before: { status: user.status },
      after: { status: "active", roles: linked.roles, approval: request.number },
      rule: "6.2a",
    });
    return { activated: true, roles: linked.roles, scopes: linked.scopes };
  },
  onRejected: async (args) => {
    await rejectLinked(args.tx, args, args.reason ?? "Permintaan akun ditolak pemilik");
    const rows = await args.tx.select({ status: users.status }).from(users).where(eq(users.id, args.request.objectId)).limit(1);
    if (rows[0]?.status === "pending_approval") {
      await args.tx
        .update(users)
        .set({ status: "inactive", deactivatedAt: args.ctx.now, deactivatedBy: args.ctx.userId, deactivationReason: `Permintaan akun ditolak: ${args.reason ?? "-"}`, updatedAt: args.ctx.now })
        .where(eq(users.id, args.request.objectId));
    }
    return { activated: false };
  },
  onCancelled: async (args) => {
    await rejectLinked(args.tx, args, args.reason ?? "Permintaan dibatalkan");
    const rows = await args.tx.select({ status: users.status }).from(users).where(eq(users.id, args.request.objectId)).limit(1);
    if (rows[0]?.status === "pending_approval") {
      await args.tx
        .update(users)
        .set({ status: "inactive", deactivatedAt: args.ctx.now, deactivationReason: `Permintaan akun dibatalkan: ${args.reason ?? "-"}`, updatedAt: args.ctx.now })
        .where(eq(users.id, args.request.objectId));
    }
  },
  onOverdue: async ({ tx, request, ctx }) => {
    // D-08: tetap terbuka, akun TIDAK aktif sampai diputuskan.
    await auditRecord(tx, { ctx, objectType: "user", objectId: request.objectId, action: "overdue", after: { approval: request.number, status: "pending_approval" }, reason: "Lewat tenggat 2 hari kerja; akun tetap tidak aktif (D-08)", rule: "6.2a" });
  },
};

/** `role_grant` (pindah/ubah peran) dan `multi_role` (peran tambahan). */
function roleHandlers(mode: "add" | "replace"): ApprovalHandlers {
  return {
    onApproved: async (args) => {
      const { tx, request, ctx } = args;
      await assertCombinationStillValid(tx, args, mode);
      const linked = await activateLinked(tx, args);
      let revoked: RoleCode[] = [];
      if (mode === "replace" && linked.roles.length) {
        const newRole = linked.roles[0]!;
        const old = await tx
          .update(userRoles)
          .set({ status: "revoked", revokedAt: ctx.now, revokedBy: ctx.userId, revokeReason: `Pindah peran (${request.number})`, updatedAt: ctx.now })
          .where(and(eq(userRoles.userId, request.objectId), eq(userRoles.status, "active"), ne(userRoles.role, newRole)))
          .returning({ id: userRoles.id, role: userRoles.role });
        revoked = old.map((o) => o.role as RoleCode);
        // Lingkup yang tidak sesuai peran baru dicabut (lingkup diubah — 7.10.6).
        const keep = scopeRuleFor(newRole).type;
        const scopes = await tx
          .update(userScopes)
          .set({ status: "revoked", revokedAt: ctx.now, revokedBy: ctx.userId, revokeReason: `Pindah peran (${request.number})`, updatedAt: ctx.now })
          .where(and(eq(userScopes.userId, request.objectId), eq(userScopes.status, "active"), ne(userScopes.scopeType, keep)))
          .returning({ id: userScopes.id });
        await auditRecord(tx, {
          ctx,
          objectType: "user",
          objectId: request.objectId,
          action: "update",
          before: { roles: revoked },
          after: { roles: [newRole], scopesRevoked: scopes.length, approval: request.number },
          reason: "Pindah peran disetujui pemilik",
          rule: "6.2a",
        });
      }
      return { activated: linked.roles, revoked };
    },
    onRejected: async (args) => {
      await rejectLinked(args.tx, args, args.reason ?? "Permintaan peran ditolak pemilik");
    },
    onCancelled: async (args) => {
      await rejectLinked(args.tx, args, args.reason ?? "Permintaan dibatalkan");
    },
    onOverdue: async ({ tx, request, ctx }) => {
      await auditRecord(tx, { ctx, objectType: "user", objectId: request.objectId, action: "overdue", after: { approval: request.number }, reason: "Lewat tenggat; peran tetap tidak aktif (D-08)", rule: "6.2a" });
    },
  };
}

export const roleGrantHandlers = roleHandlers("replace");
export const multiRoleHandlers = roleHandlers("add");

/** `scope_extension`: perluasan lingkup. */
export const scopeExtensionHandlers: ApprovalHandlers = {
  onApproved: async (args) => {
    const linked = await activateLinked(args.tx, args);
    return { scopesActivated: linked.scopes };
  },
  onRejected: async (args) => {
    await rejectLinked(args.tx, args, args.reason ?? "Perluasan lingkup ditolak pemilik");
  },
  onCancelled: async (args) => {
    await rejectLinked(args.tx, args, args.reason ?? "Permintaan dibatalkan");
  },
  onOverdue: async ({ tx, request, ctx }) => {
    await auditRecord(tx, { ctx, objectType: "user", objectId: request.objectId, action: "overdue", after: { approval: request.number }, reason: "Lewat tenggat; lingkup tetap tidak aktif (D-08)", rule: "6.2a" });
  },
};
