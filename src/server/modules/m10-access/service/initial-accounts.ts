/**
 * M10 — persetujuan sekaligus akun awal go-live (US-M10-01 KP-8; NFR-34; data_signoffs kelompok `initial_accounts`).
 *
 * Alur: admin sistem membuat akun awal dengan mode `initialLoad` (status Menunggu persetujuan, tanpa permintaan satu
 * per satu) → `prepareInitialAccountsSignoff` menyusun daftar (draf tanda tangan data awal; draf lama digantikan) →
 * pemilik `signInitialAccounts` → seluruh akun di daftar aktif sekaligus, berjejak per akun. Setelah ditandatangani,
 * mode akun awal DITUTUP: akun baru wajib lewat persetujuan pemilik (6.2a).
 */
import "server-only";

import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";

import { dataSignoffs, employees, userRoles, users, userScopes } from "@/db/schema";
import { label, type RoleCode } from "@/lib/labels";
import { record as auditRecord } from "@/server/core/audit";
import type { ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { ConflictError, DomainError, NotFoundError } from "@/server/core/errors";
import { authorize, runService, sod } from "@/server/core/rbac";

import { scopeLabels } from "./shared";
import { initialAccountsSigned } from "./users";

export type InitialAccountEntry = { userId: string; username: string; name: string; employeeNo: string; roles: RoleCode[]; scopes: string[] };
export type SignoffRow = typeof dataSignoffs.$inferSelect;

async function pendingInitialAccounts(tx: Tx, tenantId: string): Promise<InitialAccountEntry[]> {
  const rows = await tx
    .select({ id: users.id, username: users.username, name: employees.fullName, employeeNo: employees.employeeNo })
    .from(users)
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(and(eq(users.tenantId, tenantId), eq(users.status, "pending_approval"), isNull(users.approvalRequestId)))
    .orderBy(asc(employees.fullName));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const roles = await tx.select().from(userRoles).where(and(inArray(userRoles.userId, ids), eq(userRoles.status, "pending")));
  const scopes = await tx.select().from(userScopes).where(and(inArray(userScopes.userId, ids), eq(userScopes.status, "pending")));
  const labels = await scopeLabels(tx, scopes.map((s) => ({ type: s.scopeType, refId: s.refId })));
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    name: r.name,
    employeeNo: r.employeeNo,
    roles: roles.filter((x) => x.userId === r.id).map((x) => x.role as RoleCode),
    scopes: scopes.filter((x) => x.userId === r.id).map((x) => labels.get(`${x.scopeType}:${x.refId}`) ?? x.refId),
  }));
}

/** Susun draf daftar akun awal untuk ditandatangani pemilik (admin sistem). */
export async function prepareInitialAccountsSignoff(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<SignoffRow> {
  await authorize(ctx, "m10.user.create", { tx: opts.tx, objectType: "data_signoff" });
  return runService(ctx, opts, async (tx) => {
    if (await initialAccountsSigned(tx, ctx.tenantId)) {
      throw new DomainError("INITIAL_LOAD_CLOSED", "Daftar akun awal sudah ditandatangani pemilik; akun baru lewat persetujuan satu per satu.");
    }
    const entries = await pendingInitialAccounts(tx, ctx.tenantId);
    if (entries.length === 0) throw new DomainError("NO_INITIAL_ACCOUNTS", "Belum ada akun awal yang menunggu. Buat akun dengan pilihan \"akun awal go-live\" dulu.");
    const drafts = await tx
      .update(dataSignoffs)
      .set({ status: "superseded", updatedAt: ctx.now })
      .where(and(eq(dataSignoffs.tenantId, ctx.tenantId), eq(dataSignoffs.group, "initial_accounts"), eq(dataSignoffs.status, "draft")))
      .returning({ id: dataSignoffs.id });
    const byRole: Record<string, number> = {};
    for (const e of entries) for (const r of e.roles) byRole[label("role", r)] = (byRole[label("role", r)] ?? 0) + 1;
    const [row] = await tx
      .insert(dataSignoffs)
      .values({
        tenantId: ctx.tenantId,
        group: "initial_accounts",
        title: `Akun pengguna awal go-live (${entries.length} akun)`,
        summary: { count: entries.length, byRole, accounts: entries },
        status: "draft",
        supersedesId: drafts[0]?.id ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    await auditRecord(tx, { ctx, objectType: "data_signoff", objectId: row!.id, action: "create", after: { group: "initial_accounts", count: entries.length, byRole } });
    return row!;
  });
}

/**
 * Tanda tangan pemilik atas daftar akun awal → semua akun di daftar yang masih menunggu menjadi aktif (peran & lingkup
 * aktif), sekaligus (NFR-34). Penyusun daftar tidak dapat menandatanganinya (SOD-01).
 */
export async function signInitialAccounts(ctx: ActorContext, signoffId: string, opts: { tx?: Tx } = {}): Promise<{ activated: number; signoff: SignoffRow }> {
  await authorize(ctx, "m10.initial_accounts.sign", { tx: opts.tx, objectType: "data_signoff", objectId: signoffId });
  return runService(ctx, opts, async (tx) => {
    const rows = await tx.select().from(dataSignoffs).where(eq(dataSignoffs.id, signoffId)).for("update").limit(1);
    const signoff = rows[0];
    if (!signoff || signoff.tenantId !== ctx.tenantId || signoff.group !== "initial_accounts") throw new NotFoundError("Daftar akun awal tidak ditemukan.");
    if (signoff.status !== "draft") throw new ConflictError("SIGNOFF_NOT_DRAFT", "Daftar ini sudah ditandatangani atau digantikan daftar yang lebih baru.");
    sod.assertNotSelf(signoff.createdBy, ctx.userId, "daftar akun awal", { objectType: "data_signoff", objectId: signoff.id });
    const accounts = ((signoff.summary as { accounts?: InitialAccountEntry[] }).accounts ?? []).map((a) => a.userId);
    const still = accounts.length
      ? await tx
          .select({ id: users.id })
          .from(users)
          .where(and(inArray(users.id, accounts), eq(users.tenantId, ctx.tenantId), eq(users.status, "pending_approval"), isNull(users.approvalRequestId)))
      : [];
    const ids = still.map((s) => s.id);
    if (ids.length) {
      await tx.update(users).set({ status: "active", activatedAt: ctx.now, updatedAt: ctx.now }).where(inArray(users.id, ids));
      await tx
        .update(userRoles)
        .set({ status: "active", grantedBy: ctx.userId, grantedAt: ctx.now, updatedAt: ctx.now })
        .where(and(inArray(userRoles.userId, ids), eq(userRoles.status, "pending")));
      await tx.update(userScopes).set({ status: "active", updatedAt: ctx.now }).where(and(inArray(userScopes.userId, ids), eq(userScopes.status, "pending")));
      for (const id of ids) {
        await auditRecord(tx, {
          ctx,
          objectType: "user",
          objectId: id,
          action: "activate",
          before: { status: "pending_approval" },
          after: { status: "active", signoff: signoff.id },
          reason: "Akun awal go-live disetujui sekaligus (NFR-34)",
          rule: "US-M10-01 KP-8",
        });
      }
    }
    const [signed] = await tx
      .update(dataSignoffs)
      .set({ status: "signed", signedBy: ctx.userId, signedAt: ctx.now, updatedAt: ctx.now })
      .where(eq(dataSignoffs.id, signoff.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "data_signoff", objectId: signoff.id, action: "sign", before: { status: "draft" }, after: { status: "signed", activated: ids.length } });
    return { activated: ids.length, signoff: signed! };
  });
}

/** Status daftar akun awal (draf terbaru, sudah ditandatangani?, akun menunggu). */
export async function initialAccountsStatus(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m10.user.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const latest = await tx
    .select()
    .from(dataSignoffs)
    .where(and(eq(dataSignoffs.tenantId, ctx.tenantId), eq(dataSignoffs.group, "initial_accounts")))
    .orderBy(desc(dataSignoffs.createdAt))
    .limit(5);
  return {
    signed: latest.find((s) => s.status === "signed") ?? null,
    draft: latest.find((s) => s.status === "draft") ?? null,
    pending: await pendingInitialAccounts(tx, ctx.tenantId),
  };
}
