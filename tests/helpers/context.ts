/**
 * Pembuat `ActorContext` untuk uji (docs/ARCHITECTURE.md §3 "testContext").
 *
 * - `testContext({ role: "dispatcher" })` — konteks sintetis (userId acak). Cocok untuk uji murni (RBAC, SoD).
 *   Untuk uji yang MENULIS ke DB (audit/notifikasi merujuk `users.id`), pakai `seededContext("pemilik")` (DB seed)
 *   atau `createTestUser(db, …)` dari `./factories`.
 * - `seededContext(username)` — konteks akun demo seed (`pemilik`, `keuangan1`, `dispatcher1`, `sopir1`, `depot01`,
 *   `kasir`, `produksi1`, `admin1`, `akuntan`, …) dengan peran & lingkup persis seperti seed.
 */
import { EMPLOYEE_SEEDS, EQUA_TENANT_ID, employeeId, outletId, truckId, userIdByUsername, waterSourceId } from "@/db/seed";
import { newId } from "@/lib/ids";
import type { ActorSource, RoleCode } from "@/lib/labels";
import type { ActorContext, ActorScope } from "@/server/core/context";

export type TestContextOptions = {
  role?: RoleCode;
  roles?: RoleCode[];
  userId?: string | null;
  employeeId?: string | null;
  scope?: Partial<ActorScope>;
  tenantId?: string;
  source?: ActorSource;
  deviceId?: string | null;
  now?: Date;
  deviceTime?: Date;
  businessDate?: string;
};

const FIELD_ROLES: RoleCode[] = ["driver", "helper", "production_operator"];
const POS_ROLES: RoleCode[] = ["depot_operator", "store_cashier"];
const OFFICE_ROLES: RoleCode[] = ["owner", "finance_admin", "dispatcher", "system_admin", "accountant", "regional_coach", "partner_owner"];

function defaultSource(roles: RoleCode[]): ActorSource {
  if (roles.some((r) => FIELD_ROLES.includes(r))) return "field";
  if (roles.some((r) => POS_ROLES.includes(r))) return "pos";
  if (roles.includes("partner_owner")) return "partner_portal";
  return "web";
}

/** Konteks sintetis untuk uji. Peran kantor mendapat lingkup tenant bawaan. */
export function testContext(options: TestContextOptions = {}): ActorContext {
  const roles = options.roles ?? (options.role ? [options.role] : []);
  const tenantId = options.tenantId ?? EQUA_TENANT_ID;
  const officeScope = roles.some((r) => OFFICE_ROLES.includes(r)) ? [tenantId] : [];
  return {
    userId: options.userId === undefined ? newId() : options.userId,
    employeeId: options.employeeId === undefined ? null : options.employeeId,
    roles,
    scope: {
      truckIds: options.scope?.truckIds ?? [],
      outletIds: options.scope?.outletIds ?? [],
      sourceIds: options.scope?.sourceIds ?? [],
      tenantIds: options.scope?.tenantIds ?? officeScope,
    },
    tenantId,
    deviceId: options.deviceId ?? null,
    source: options.source ?? defaultSource(roles),
    now: options.now ?? new Date(),
    deviceTime: options.deviceTime,
    businessDate: options.businessDate,
  };
}

/** Konteks akun demo seed (butuh DB `createTestDb({ seed: true })`). */
export function seededContext(username: string, overrides: Omit<TestContextOptions, "role" | "roles" | "userId" | "employeeId"> = {}): ActorContext {
  const seed = EMPLOYEE_SEEDS.find((e) => e.username === username);
  if (!seed) throw new Error(`Akun seed tidak dikenal: ${username}`);
  const scope: Partial<ActorScope> = { truckIds: [], outletIds: [], sourceIds: [], tenantIds: [] };
  if (seed.scope?.type === "truck") scope.truckIds = [truckId(seed.scope.code)];
  else if (seed.scope?.type === "outlet") scope.outletIds = [outletId(seed.scope.code)];
  else if (seed.scope?.type === "water_source") scope.sourceIds = [waterSourceId(seed.scope.code)];
  else scope.tenantIds = [EQUA_TENANT_ID];
  return testContext({
    ...overrides,
    roles: [seed.role],
    userId: userIdByUsername(username),
    employeeId: employeeId(seed.no),
    scope: { ...scope, ...overrides.scope },
  });
}
