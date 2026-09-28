/**
 * M10 — pembantu internal layanan (tidak diekspor ke modul lain): pemuatan pengguna, nama, label lingkup, aturan
 * lingkup per peran (US-M10-01 KP-3), kuartal (PAR-47), dan penjaga "bukan akun sendiri" (SOD-01).
 */
import "server-only";

import { and, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";

import { employees, outlets, tenants, trucks, userRoles, users, userScopes, waterSources } from "@/db/schema";
import { label, type RoleCode, type ScopeType } from "@/lib/labels";
import { isWithinWindow, lastDayOfMonth, toBusinessDate, type HourMinute } from "@/lib/time";
import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/core/errors";
import { ROLE_CATALOG } from "@/server/core/rbac";

export type UserRow = typeof users.$inferSelect;
export type EmployeeRow = typeof employees.$inferSelect;
export type UserRoleRow = typeof userRoles.$inferSelect;
export type UserScopeRow = typeof userScopes.$inferSelect;

export type ScopeInput = { type: ScopeType; refId: string };

/** Pengguna + karyawan dalam tenant pelaku (NotFound bila lintas tenant — NFR-30). */
export async function loadUserWithEmployee(tx: Tx, ctx: ActorContext, userId: string): Promise<{ user: UserRow; employee: EmployeeRow }> {
  const rows = await tx
    .select({ user: users, employee: employees })
    .from(users)
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(eq(users.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row || row.user.tenantId !== ctx.tenantId) throw new NotFoundError("Pengguna tidak ditemukan.");
  return row;
}

/** Nama lengkap karyawan per userId (untuk tampilan & kalimat audit). */
export async function userNames(tx: Tx, userIds: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: users.id, name: employees.fullName })
    .from(users)
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Nama karyawan per employeeId. */
export async function employeeNames(tx: Tx, employeeIds: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const ids = [...new Set(employeeIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return new Map();
  const rows = await tx.select({ id: employees.id, name: employees.fullName }).from(employees).where(inArray(employees.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Peran aktif (masa berlaku mencakup tanggal) per pengguna. */
export async function activeRolesOf(tx: Tx, userIds: readonly string[], date: string): Promise<Map<string, RoleCode[]>> {
  const out = new Map<string, RoleCode[]>();
  if (userIds.length === 0) return out;
  const rows = await tx
    .select({ userId: userRoles.userId, role: userRoles.role })
    .from(userRoles)
    .where(
      and(
        inArray(userRoles.userId, [...userIds]),
        eq(userRoles.status, "active"),
        or(isNull(userRoles.validFrom), lte(userRoles.validFrom, date)),
        or(isNull(userRoles.validUntil), gte(userRoles.validUntil, date)),
      ),
    );
  for (const r of rows) out.set(r.userId, [...(out.get(r.userId) ?? []), r.role as RoleCode]);
  return out;
}

/**
 * Jenis lingkup yang WAJIB/BOLEH untuk peran (US-M10-01 KP-3): Sopir/Kernet → truk (lingkup harian dari jadwal kru
 * M2 menimpa saat ada jadwal); Operator depot → outlet depot; Kasir → toko; Operator produksi → sumber air; peran
 * kantor → tenant sendiri; pemilik mitra → tenant mitra. Peran lapangan TIDAK PERNAH berlingkup tenant (tidak ada
 * tampilan lintas lingkup).
 */
export function scopeRuleFor(role: RoleCode): { type: ScopeType; outletKind?: "depot" | "store"; auto: boolean } {
  switch (ROLE_CATALOG[role].scopeKind) {
    case "truck":
      return { type: "truck", auto: false };
    case "water_source":
      return { type: "water_source", auto: false };
    case "outlet":
      return { type: "outlet", outletKind: role === "store_cashier" ? "store" : "depot", auto: false };
    default:
      return { type: "tenant", auto: role !== "partner_owner" };
  }
}

/**
 * Validasi & lengkapi lingkup untuk sekumpulan peran. Peran kantor mendapat lingkup tenant pelaku otomatis; peran
 * lapangan wajib minimal satu unit sesuai jenisnya dan unitnya harus milik tenant.
 */
export async function normalizeScopes(tx: Tx, ctx: ActorContext, roles: readonly RoleCode[], scopes: readonly ScopeInput[]): Promise<ScopeInput[]> {
  const out = new Map<string, ScopeInput>();
  const allowedTypes = new Set<ScopeType>();
  for (const role of roles) {
    const rule = scopeRuleFor(role);
    allowedTypes.add(rule.type);
    if (rule.auto) out.set(`tenant:${ctx.tenantId}`, { type: "tenant", refId: ctx.tenantId });
  }
  for (const s of scopes) {
    if (!allowedTypes.has(s.type)) {
      throw ValidationError.field(
        "scopes",
        `Lingkup ${label("scope_type", s.type).toLowerCase()} tidak sesuai peran ${roles.map((r) => label("role", r)).join(", ")} (US-M10-01 KP-3).`,
      );
    }
    await assertScopeRef(tx, ctx, roles, s);
    out.set(`${s.type}:${s.refId}`, s);
  }
  for (const role of roles) {
    const rule = scopeRuleFor(role);
    if (rule.auto) continue;
    if (![...out.values()].some((s) => s.type === rule.type)) {
      throw ValidationError.field(
        "scopes",
        `Peran ${label("role", role)} wajib diberi lingkup ${label("scope_type", rule.type).toLowerCase()}${rule.outletKind ? ` (${rule.outletKind === "store" ? "toko" : "depot"})` : ""}.`,
      );
    }
  }
  return [...out.values()];
}

async function assertScopeRef(tx: Tx, ctx: ActorContext, roles: readonly RoleCode[], s: ScopeInput): Promise<void> {
  if (s.type === "truck") {
    const r = await tx.select({ id: trucks.id }).from(trucks).where(and(eq(trucks.id, s.refId), eq(trucks.tenantId, ctx.tenantId))).limit(1);
    if (!r[0]) throw ValidationError.field("scopes", "Truk lingkup tidak ditemukan.");
  } else if (s.type === "water_source") {
    const r = await tx
      .select({ id: waterSources.id })
      .from(waterSources)
      .where(and(eq(waterSources.id, s.refId), eq(waterSources.tenantId, ctx.tenantId)))
      .limit(1);
    if (!r[0]) throw ValidationError.field("scopes", "Sumber air lingkup tidak ditemukan.");
  } else if (s.type === "outlet") {
    const r = await tx.select({ id: outlets.id, kind: outlets.kind, tenantId: outlets.tenantId }).from(outlets).where(eq(outlets.id, s.refId)).limit(1);
    const o = r[0];
    if (!o || (o.tenantId !== ctx.tenantId && !roles.includes("partner_owner"))) throw ValidationError.field("scopes", "Outlet lingkup tidak ditemukan.");
    const wanted = roles.includes("store_cashier") && !roles.includes("depot_operator") ? "store" : roles.includes("depot_operator") && !roles.includes("store_cashier") ? "depot" : null;
    if (wanted && o.kind !== wanted) {
      throw ValidationError.field("scopes", wanted === "store" ? "Kasir toko hanya dapat diberi lingkup toko." : "Operator depot hanya dapat diberi lingkup outlet depot.");
    }
  } else if (s.type === "tenant") {
    const r = await tx.select({ id: tenants.id, kind: tenants.kind }).from(tenants).where(eq(tenants.id, s.refId)).limit(1);
    if (!r[0]) throw ValidationError.field("scopes", "Tenant lingkup tidak ditemukan.");
    if (!roles.includes("partner_owner") && s.refId !== ctx.tenantId) {
      throw ValidationError.field("scopes", "Peran internal hanya berlingkup tenant sendiri (NFR-30).");
    }
  }
}

/** Label lingkup ("Truk T1 · F 8231 KA", "Outlet Depot Ciranjang", …) per `type:refId`. */
export async function scopeLabels(tx: Tx, scopes: readonly { type: ScopeType; refId: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = (t: ScopeType) => [...new Set(scopes.filter((s) => s.type === t).map((s) => s.refId))];
  const truckIds = ids("truck");
  if (truckIds.length) {
    for (const r of await tx.select({ id: trucks.id, code: trucks.code, plate: trucks.plateNumber }).from(trucks).where(inArray(trucks.id, truckIds))) {
      out.set(`truck:${r.id}`, `Truk ${r.code} · ${r.plate}`);
    }
  }
  const outletIds = ids("outlet");
  if (outletIds.length) {
    for (const r of await tx.select({ id: outlets.id, name: outlets.name, code: outlets.code }).from(outlets).where(inArray(outlets.id, outletIds))) {
      out.set(`outlet:${r.id}`, `${r.name} (${r.code})`);
    }
  }
  const sourceIds = ids("water_source");
  if (sourceIds.length) {
    for (const r of await tx.select({ id: waterSources.id, name: waterSources.name }).from(waterSources).where(inArray(waterSources.id, sourceIds))) {
      out.set(`water_source:${r.id}`, r.name);
    }
  }
  const tenantIds = ids("tenant");
  if (tenantIds.length) {
    for (const r of await tx.select({ id: tenants.id, name: tenants.name }).from(tenants).where(inArray(tenants.id, tenantIds))) {
      out.set(`tenant:${r.id}`, `Tenant ${r.name}`);
    }
  }
  for (const s of scopes) if (!out.has(`${s.type}:${s.refId}`)) out.set(`${s.type}:${s.refId}`, `${label("scope_type", s.type)} ${s.refId.slice(0, 8)}`);
  return out;
}

/** SOD-01: admin sistem tidak mengubah akses akunnya sendiri — minta admin sistem lain (BRD 10.4: 2–3 orang IT). */
export function assertNotOwnAccount(ctx: ActorContext, userId: string, what: string): void {
  if (ctx.userId && ctx.userId === userId) {
    throw new ForbiddenError(
      `Anda tidak dapat ${what} untuk akun Anda sendiri. Minta admin sistem lain melakukannya (Pembuat permintaan bukan penyetujunya; FR-M10-03).`,
      { rule: "SOD-01", objectType: "user", objectId: userId },
    );
  }
}

/** Kuartal tanggal bisnis, mis. "2026-Q3" (PAR-47 tinjauan tiap kuartal). */
export function quarterOf(date: string | Date): string {
  const d = typeof date === "string" ? date : toBusinessDate(date);
  const [y, m] = d.split("-").map(Number) as [number, number];
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

/** Tanggal awal & akhir kuartal ("2026-Q3" → 2026-07-01 .. 2026-09-30). */
export function quarterRange(quarter: string): { start: string; end: string } {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!m) throw ValidationError.field("quarter", "Kuartal harus berformat YYYY-Qn (mis. 2026-Q3).");
  const y = Number(m[1]);
  const q = Number(m[2]);
  const startMonth = (q - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  return { start: `${y}-${String(startMonth).padStart(2, "0")}-01`, end: lastDayOfMonth(`${y}-${String(endMonth).padStart(2, "0")}-01`) };
}

/** Jam layanan (PAR-07) mencakup `now`? */
export function withinWindow(start: string, end: string, now: Date): boolean {
  return isWithinWindow(start as HourMinute, end as HourMinute, now);
}
