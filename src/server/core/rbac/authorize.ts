/**
 * Otorisasi lapisan layanan (docs/ARCHITECTURE.md §3 langkah 1): `authorize(ctx, "m4.deposit.receive")` lalu cek
 * lingkup (`assertOutletScope`, `assertTruckScope`, `assertSourceScope`, `assertTenantScope`).
 *
 * Penolakan → `ForbiddenError` berpesan aturan (US-M10-03 KP-2) + dicatat di `access_logs`:
 * - Tanpa `opts.tx` (pola baku: authorize SEBELUM membuka transaksi) → dicatat seketika.
 * - Dengan `opts.tx` (sudah di dalam transaksi) → galat dilempar tanpa dicatat; `runService`/route handler memanggil
 *   `logDenialIfNeeded` setelah transaksi rollback. Ini menghindari catatan ikut rollback dan deadlock PGlite.
 *
 * Konteks sistem (`systemContext()`) selalu diizinkan. Izin yang tidak ada di katalog = galat program (bukan 403).
 */
import "server-only";

import { eq } from "drizzle-orm";

import { outlets, trucks, waterSources } from "@/db/schema";
import { label, type RoleCode } from "@/lib/labels";

import { isSystem, type ActorContext } from "../context";
import { isTransaction, runInTx, type Tx } from "../db";
import { ForbiddenError, NotFoundError } from "../errors";
import { conditionalGrant, rolesHavePermission } from "./matrix";
import { getPermission, type PermissionDef } from "./permissions";
import { logDenialIfNeeded, recordDenial } from "./denials";
import { SOD_RULES, type SodRuleCode } from "./sod-rules";

export { recordDenial, logDenialIfNeeded };

export type AuthorizeConditions = {
  /** Kernet ditetapkan sebagai pengemudi pengganti untuk truk & tanggal tindakan ini (US-M2-11). */
  substitute_driver?: boolean;
  /** Tambahan S5 (B-71): Pemilik mitra di tenant mitranya & flag `phase3.partner_portal` aktif (D-11 butir 1). */
  partner_portal_phase3?: boolean;
};

export type AuthorizeOptions = {
  /** Transaksi yang sedang terbuka (penolakan tidak dicatat seketika — lihat keterangan berkas). */
  tx?: Tx;
  conditions?: AuthorizeConditions;
  objectType?: string;
  objectId?: string;
};

function requirePermission(permission: string): PermissionDef {
  const def = getPermission(permission);
  if (!def) {
    throw new Error(
      `Izin "${permission}" tidak ada di katalog RBAC (src/server/core/rbac/permissions.ts). Tambahkan entrinya dulu.`,
    );
  }
  return def;
}

/** Benar bila pelaku berhak atas izin (tanpa efek samping). */
export function can(ctx: ActorContext, permission: string, conditions: AuthorizeConditions = {}): boolean {
  requirePermission(permission);
  if (isSystem(ctx)) return true;
  if (rolesHavePermission(ctx.roles, permission)) return true;
  return ctx.roles.some((role) => {
    const cond = conditionalGrant(role, permission);
    return cond !== null && conditions[cond] === true;
  });
}

/** Aturan pemisahan tugas yang paling tepat menjelaskan penolakan izin. */
export function denialRule(roles: readonly RoleCode[], def: PermissionDef): SodRuleCode {
  if (roles.includes("dispatcher") && def.cash) return "SOD-04";
  if (roles.includes("finance_admin") && def.orderWrite) return "SOD-03";
  if (roles.includes("system_admin") && def.finance && def.kind !== "read") return "SOD-07";
  if (roles.includes("owner") && def.daily) return "SOD-08";
  if (roles.includes("accountant") && def.kind !== "read" && def.kind !== "export") return "SOD-09";
  return "RBAC";
}

/** Bangun ForbiddenError berpesan aturan untuk izin yang ditolak (tanpa mencatat). */
export function permissionDenied(ctx: ActorContext, permission: string, opts: AuthorizeOptions = {}): ForbiddenError {
  const def = requirePermission(permission);
  const rule = denialRule(ctx.roles, def);
  const roleText = ctx.roles.length ? ctx.roles.map((r) => label("role", r)).join(", ") : "tanpa peran aktif";
  const why =
    rule === "RBAC"
      ? "Hak akses hanya lewat peran; minta admin sistem bila tugas Anda memerlukannya."
      : `Aturan pemisahan tugas: ${SOD_RULES[rule].title} (${SOD_RULES[rule].ref}).`;
  let message = `Tindakan "${def.label}" tidak diizinkan untuk peran Anda (${roleText}). ${why}`;
  if (ctx.roles.includes("helper") && conditionalGrant("helper", permission)) {
    message = `Tindakan "${def.label}" hanya dapat dilakukan kernet yang ditetapkan Dispatcher sebagai pengemudi pengganti hari ini (US-M2-11).`;
  }
  return new ForbiddenError(message, {
    permission,
    rule,
    objectType: opts.objectType,
    objectId: opts.objectId,
  });
}

/** Lempar ForbiddenError (tanpa mencatat) bila tidak berhak — untuk dipakai di dalam transaksi. */
export function assertCan(ctx: ActorContext, permission: string, opts: AuthorizeOptions = {}): void {
  if (!can(ctx, permission, opts.conditions)) throw permissionDenied(ctx, permission, opts);
}

/** Otorisasi izin; penolakan dicatat di log akses (seketika bila tidak ada `opts.tx`). */
export async function authorize(ctx: ActorContext, permission: string, opts: AuthorizeOptions = {}): Promise<void> {
  if (can(ctx, permission, opts.conditions)) return;
  const error = permissionDenied(ctx, permission, opts);
  if (!isTransaction(opts.tx)) await recordDenial(ctx, error);
  throw error;
}

/** Otorisasi bila pelaku memegang SALAH SATU izin. */
export async function authorizeAny(ctx: ActorContext, permissions: readonly string[], opts: AuthorizeOptions = {}): Promise<void> {
  if (permissions.some((perm) => can(ctx, perm, opts.conditions))) return;
  const error = permissionDenied(ctx, permissions[0]!, opts);
  if (!isTransaction(opts.tx)) await recordDenial(ctx, error);
  throw error;
}

/**
 * Pembungkus fungsi layanan: jalankan `fn` di transaksi pemanggil (`opts.tx`) atau transaksi baru; bila galat
 * `ForbiddenError` (lingkup/pemisahan tugas) terjadi di transaksi baru, catat penolakannya SETELAH rollback.
 */
export async function runService<T>(ctx: ActorContext, opts: { tx?: Tx } | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (opts?.tx) return fn(opts.tx);
  try {
    return await runInTx(undefined, fn);
  } catch (error) {
    await logDenialIfNeeded(ctx, error);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Lingkup (US-M10-01 KP-3)
// ---------------------------------------------------------------------------------------------------------------------

function scopeDenied(ctx: ActorContext, what: string, objectType: string, objectId: string): ForbiddenError {
  return new ForbiddenError(
    `Anda tidak memiliki akses ke ${what} ini. Data hanya dapat dibuka dalam lingkup tugas Anda (US-M10-01 KP-3).`,
    { rule: "SCOPE", objectType, objectId, details: { scope: ctx.scope } },
  );
}

/** Benar bila pelaku memiliki lingkup tenant tersebut (pengguna kantor EQUA, pemilik mitra untuk tenant-nya). */
export function inTenantScope(ctx: ActorContext, tenantId: string): boolean {
  if (isSystem(ctx)) return ctx.tenantId === tenantId || ctx.scope.tenantIds.includes(tenantId);
  return ctx.scope.tenantIds.includes(tenantId);
}

/** Lingkup tenant (NFR-30: tidak ada tampilan lintas tenant). */
export function assertTenantScope(ctx: ActorContext, tenantId: string): void {
  if (isSystem(ctx)) return;
  if (!inTenantScope(ctx, tenantId)) throw scopeDenied(ctx, "data tenant", "tenant", tenantId);
}

/** Murni: truk dalam lingkup (eksplisit, atau lingkup tenant pemilik truk). */
export function inTruckScope(ctx: ActorContext, truckId: string, truckTenantId?: string | null): boolean {
  if (isSystem(ctx) || ctx.scope.truckIds.includes(truckId)) return true;
  return !!truckTenantId && ctx.scope.tenantIds.includes(truckTenantId);
}

/** Murni: outlet dalam lingkup. */
export function inOutletScope(ctx: ActorContext, outletId: string, outletTenantId?: string | null): boolean {
  if (isSystem(ctx) || ctx.scope.outletIds.includes(outletId)) return true;
  return !!outletTenantId && ctx.scope.tenantIds.includes(outletTenantId);
}

/** Murni: sumber air dalam lingkup. */
export function inSourceScope(ctx: ActorContext, sourceId: string, sourceTenantId?: string | null): boolean {
  if (isSystem(ctx) || ctx.scope.sourceIds.includes(sourceId)) return true;
  return !!sourceTenantId && ctx.scope.tenantIds.includes(sourceTenantId);
}

async function tenantOf(tx: Tx, table: typeof trucks | typeof outlets | typeof waterSources, id: string): Promise<string | null> {
  const rows = await tx.select({ tenantId: table.tenantId }).from(table).where(eq(table.id, id)).limit(1);
  return rows[0]?.tenantId ?? null;
}

/**
 * Truk dalam lingkup pelaku (Sopir/Kernet → truknya; kantor → tenant). Penolakan dicatat seketika bila `tx` bukan
 * transaksi terbuka; bila di dalam transaksi, dicatat oleh `runService`/route setelah rollback.
 * Catatan: penugasan harian (jadwal kru, US-M2-11) diperiksa modul M2/M3 di atas cek ini.
 */
export async function assertTruckScope(tx: Tx, ctx: ActorContext, truckId: string): Promise<void> {
  if (isSystem(ctx) || ctx.scope.truckIds.includes(truckId)) return;
  const tenantId = ctx.scope.tenantIds.length ? await tenantOf(tx, trucks, truckId) : null;
  if (tenantId === null && ctx.scope.tenantIds.length) throw new NotFoundError("Truk tidak ditemukan.");
  if (inTruckScope(ctx, truckId, tenantId)) return;
  const error = scopeDenied(ctx, "truk", "truck", truckId);
  if (!isTransaction(tx)) await recordDenial(ctx, error);
  throw error;
}

/** Outlet dalam lingkup pelaku (Operator/Kasir → outletnya; kantor → tenant). */
export async function assertOutletScope(tx: Tx, ctx: ActorContext, outletId: string): Promise<void> {
  if (isSystem(ctx) || ctx.scope.outletIds.includes(outletId)) return;
  const tenantId = ctx.scope.tenantIds.length ? await tenantOf(tx, outlets, outletId) : null;
  if (tenantId === null && ctx.scope.tenantIds.length) throw new NotFoundError("Outlet tidak ditemukan.");
  if (inOutletScope(ctx, outletId, tenantId)) return;
  const error = scopeDenied(ctx, "outlet", "outlet", outletId);
  if (!isTransaction(tx)) await recordDenial(ctx, error);
  throw error;
}

/** Sumber air dalam lingkup pelaku (Operator produksi → sumbernya; kantor → tenant). */
export async function assertSourceScope(tx: Tx, ctx: ActorContext, sourceId: string): Promise<void> {
  if (isSystem(ctx) || ctx.scope.sourceIds.includes(sourceId)) return;
  const tenantId = ctx.scope.tenantIds.length ? await tenantOf(tx, waterSources, sourceId) : null;
  if (tenantId === null && ctx.scope.tenantIds.length) throw new NotFoundError("Sumber air tidak ditemukan.");
  if (inSourceScope(ctx, sourceId, tenantId)) return;
  const error = scopeDenied(ctx, "sumber air", "water_source", sourceId);
  if (!isTransaction(tx)) await recordDenial(ctx, error);
  throw error;
}
