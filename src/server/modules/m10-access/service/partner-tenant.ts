/**
 * M10 — akun & perangkat untuk TENANT MITRA oleh admin sistem EQUA (backlog B-07; RL-7 US-P3-08/US-P3-10, US-M6-07,
 * NFR-30). Perubahan minimal: `createUser` menerima `tenantId` (lihat users.ts) dan fungsi pembungkus di bawah ini
 * menjalankan layanan inti perangkat/PIN dengan konteks tenant mitra.
 *
 * Aturan:
 * - Hanya pelaku dari tenant PEMILIK (EQUA, `tenants.kind = owner`) yang boleh bertindak atas tenant mitra, dan
 *   tenant tujuan wajib `kind = partner` & aktif. Tenant mitra tidak pernah dapat menyentuh tenant lain.
 * - Izin tetap dari matriks (`m10.user.create`, `m10.device.register`, `m10.user.reset_pin` — admin sistem).
 * - Persetujuan akun (`account_create`, US-M10-01 KP-8) tetap diajukan di tenant EQUA agar pemilik EQUA memutuskan.
 */
import "server-only";

import { eq } from "drizzle-orm";

import { tenants } from "@/db/schema";
import { issuePinEnrollment, registerDevice, type RegisterDeviceInput } from "@/server/core/auth";
import type { ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { ForbiddenError, NotFoundError } from "@/server/core/errors";
import { recordDenial } from "@/server/core/rbac";

/** Tenant tujuan yang sah untuk tindakan admin EQUA atas tenant mitra (null = tenant pelaku sendiri). */
export async function resolvePartnerTenantTarget(tx: Tx, ctx: ActorContext, tenantId: string | null | undefined): Promise<string> {
  if (!tenantId || tenantId === ctx.tenantId) return ctx.tenantId;
  const rows = await tx.select({ id: tenants.id, kind: tenants.kind, isActive: tenants.isActive }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const own = await tx.select({ kind: tenants.kind }).from(tenants).where(eq(tenants.id, ctx.tenantId)).limit(1);
  const target = rows[0];
  if (!target) throw new NotFoundError("Tenant mitra tidak ditemukan.");
  if (own[0]?.kind !== "owner" || target.kind !== "partner") {
    throw new ForbiddenError("Akun & perangkat tenant lain hanya dapat dibuat admin sistem EQUA untuk tenant mitra (NFR-30).", {
      rule: "NFR-30",
      objectType: "tenant",
      objectId: tenantId,
    });
  }
  if (!target.isActive) throw new ForbiddenError("Tenant mitra sudah nonaktif; akun/perangkat baru tidak dapat dibuat.", { rule: "US-P3-07", objectType: "tenant", objectId: tenantId });
  return target.id;
}

/** Konteks pelaku yang sama, dengan tenant aktif = tenant mitra tujuan (lingkup tenant ikut). */
export function asTenantActor(ctx: ActorContext, tenantId: string): ActorContext {
  if (tenantId === ctx.tenantId) return ctx;
  return { ...ctx, tenantId, scope: { ...ctx.scope, tenantIds: Array.from(new Set([...ctx.scope.tenantIds, tenantId])) } };
}

async function targetCtx(ctx: ActorContext, tenantId: string, tx?: Tx): Promise<ActorContext> {
  try {
    const target = await resolvePartnerTenantTarget(tx ?? getDb(), ctx, tenantId);
    return asTenantActor(ctx, target);
  } catch (error) {
    if (error instanceof ForbiddenError && !tx) await recordDenial(ctx, error);
    throw error;
  }
}

/** Daftarkan tablet/ponsel POS untuk outlet tenant mitra (B-07) → kode aktivasi 8 karakter (sekali tampil). */
export async function registerDeviceForTenant(ctx: ActorContext, input: RegisterDeviceInput & { tenantId: string }, opts: { tx?: Tx } = {}) {
  const { tenantId, ...rest } = input;
  return registerDevice(await targetCtx(ctx, tenantId, opts.tx), rest, opts);
}

/** Kode aktivasi PIN pertama untuk operator tenant mitra (pengguna menetapkan PIN sendiri di perangkat). */
export async function issueInitialPinForTenant(ctx: ActorContext, input: { tenantId: string; userId: string }, opts: { tx?: Tx } = {}) {
  return issuePinEnrollment(await targetCtx(ctx, input.tenantId, opts.tx), input.userId, { purpose: "initial", reason: "Kode aktivasi akun lapangan tenant mitra" }, opts);
}
