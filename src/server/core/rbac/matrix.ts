/**
 * Matriks peran × izin (US-M10-01 KP-1, US-M10-03 KP-4) — diturunkan dari katalog `./permissions.ts` (kolom `roles`).
 *
 * Invarian pemisahan tugas yang dijaga uji (`tests/core/rbac.test.ts`):
 * - Akuntan baca-saja (read/export/attest).
 * - Admin sistem tidak memegang izin yang mengubah transaksi keuangan (`finance`).
 * - Pemilik tidak memegang izin input transaksi harian (`daily`).
 * - Admin Keuangan tidak membuat/mengubah pesanan & pengiriman (`orderWrite`) — kecuali jalur "dicatat kantor".
 * - Dispatcher tidak mengakses kas (`cash`).
 * - Peran lapangan tidak memegang izin menu kantor M10/M11.
 *
 * Murni (tanpa DB) — aman dipakai kerangka kantor (daftar izin untuk menu) maupun layanan.
 */
import { label, type RoleCode } from "@/lib/labels";

import { CONDITIONAL_GRANTS, MODULE_LABELS, PERMISSIONS, type ConditionalGrantCondition, type PermissionDef } from "./permissions";
import { ALL_ROLES, ROLE_CATALOG } from "./roles";

function buildMatrix(): Record<RoleCode, ReadonlySet<string>> {
  const out = Object.fromEntries(ALL_ROLES.map((r) => [r, new Set<string>()])) as Record<RoleCode, Set<string>>;
  for (const perm of PERMISSIONS) {
    for (const role of perm.roles) out[role].add(perm.key);
  }
  return out;
}

/** Peran → himpunan izin. */
export const ROLE_PERMISSIONS: Readonly<Record<RoleCode, ReadonlySet<string>>> = buildMatrix();

/** Benar bila peran memegang izin (tanpa syarat). */
export function roleHasPermission(role: RoleCode, permission: string): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/** Gabungan izin dari beberapa peran (urutan katalog). Dipakai kerangka kantor untuk menyaring menu. */
export function permissionsForRoles(roles: readonly RoleCode[]): string[] {
  const set = new Set<string>();
  for (const role of roles) for (const perm of ROLE_PERMISSIONS[role] ?? []) set.add(perm);
  return PERMISSIONS.filter((p) => set.has(p.key)).map((p) => p.key);
}

/** Benar bila salah satu peran memegang izin. */
export function rolesHavePermission(roles: readonly RoleCode[], permission: string): boolean {
  return roles.some((r) => roleHasPermission(r, permission));
}

/** Izin bersyarat yang berlaku untuk peran (mis. kernet pengganti, portal mitra Tahap 3). */
export function conditionalGrant(role: RoleCode, permission: string): ConditionalGrantCondition | null {
  for (const g of CONDITIONAL_GRANTS) {
    if (g.role === role && g.permissions.includes(permission)) return g.condition;
  }
  return null;
}

export type MatrixRow = {
  module: string;
  moduleLabel: string;
  key: string;
  label: string;
  kind: PermissionDef["kind"];
  ref: string;
  /** Kode peran → "Ya" / "Bersyarat" / "" (untuk tampilan & ekspor). */
  grants: Record<RoleCode, "Ya" | "Bersyarat" | "">;
};

export type ExportedMatrix = {
  roles: { code: RoleCode; label: string; requires2fa: boolean; isFieldRole: boolean; isReadOnly: boolean }[];
  rows: MatrixRow[];
};

/**
 * Matriks peran × tindakan untuk ditampilkan & diekspor pemilik (US-M10-03 KP-4). Laporan ekspor terdaftar sebagai
 * `core.rbac_matrix` (Excel/PDF) — lihat `src/server/core/core-reports.ts`.
 */
export function exportMatrix(): ExportedMatrix {
  const roles = ALL_ROLES.map((code) => ({
    code,
    label: label("role", code),
    requires2fa: ROLE_CATALOG[code].requires2fa,
    isFieldRole: ROLE_CATALOG[code].isFieldRole,
    isReadOnly: ROLE_CATALOG[code].isReadOnly,
  }));
  const rows: MatrixRow[] = PERMISSIONS.map((perm) => {
    const grants = Object.fromEntries(
      ALL_ROLES.map((role) => [
        role,
        roleHasPermission(role, perm.key) ? "Ya" : conditionalGrant(role, perm.key) ? "Bersyarat" : "",
      ]),
    ) as MatrixRow["grants"];
    return {
      module: perm.module,
      moduleLabel: MODULE_LABELS[perm.module] ?? perm.module,
      key: perm.key,
      label: perm.label,
      kind: perm.kind,
      ref: perm.ref ?? "",
      grants,
    };
  });
  return { roles, rows };
}
