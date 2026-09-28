/**
 * Katalog aturan pemisahan tugas (murni, tanpa DB): aturan tetap US-M10-03 KP-1 dan kombinasi peran terlarang PTB-31
 * (US-M10-01 KP-4). Pesan menyebut aturannya (US-M10-03 KP-2).
 */
import { label, type RoleCode } from "@/lib/labels";

export type SodRuleCode =
  | "SOD-01"
  | "SOD-02"
  | "SOD-03"
  | "SOD-04"
  | "SOD-05"
  | "SOD-06"
  | "SOD-07"
  | "SOD-08"
  | "SOD-09"
  | "RBAC"
  | "SCOPE";

export type SodRule = { code: SodRuleCode; title: string; ref: string };

/** Aturan tetap yang diperiksa pada setiap tindakan (US-M10-03 KP-1). */
export const SOD_RULES: Record<SodRuleCode, SodRule> = {
  "SOD-01": { code: "SOD-01", title: "Pembuat transaksi/permintaan bukan penyetujunya", ref: "FR-M10-03, US-M10-04 KP-2" },
  "SOD-02": { code: "SOD-02", title: "Penerima setoran bukan penyetornya", ref: "US-M10-03 KP-1, US-M4-02 KP-9" },
  "SOD-03": { code: "SOD-03", title: "Admin Keuangan tidak membuat/mengubah pesanan dan pengiriman", ref: "US-M10-03 KP-1" },
  "SOD-04": { code: "SOD-04", title: "Dispatcher tidak mengakses kas", ref: "US-M10-03 KP-1" },
  "SOD-05": {
    code: "SOD-05",
    title: "Sopir hanya mengerjakan rit sendiri dan tidak mengubah setelah kirim",
    ref: "US-M10-03 KP-1, FR-M3-07",
  },
  "SOD-06": { code: "SOD-06", title: "Operator/Kasir hanya outletnya", ref: "US-M10-03 KP-1" },
  "SOD-07": { code: "SOD-07", title: "Admin sistem tidak mengubah transaksi keuangan", ref: "US-M10-03 KP-1" },
  "SOD-08": { code: "SOD-08", title: "Pemilik tidak menginput transaksi harian", ref: "US-M10-03 KP-1, BRD 4.2" },
  "SOD-09": { code: "SOD-09", title: "Akuntan hanya dapat membaca", ref: "PTB-11" },
  RBAC: { code: "RBAC", title: "Hak akses hanya lewat peran", ref: "US-M10-01 KP-1" },
  SCOPE: { code: "SCOPE", title: "Data hanya dalam lingkup yang ditugaskan", ref: "US-M10-01 KP-3, NFR-30" },
};

export type ForbiddenCombination = { roles: readonly [RoleCode, RoleCode]; ref: string; reason: string };

const CASH_OR_DAILY_ROLES: readonly RoleCode[] = [
  "dispatcher",
  "driver",
  "helper",
  "depot_operator",
  "store_cashier",
  "production_operator",
];

function pairs(role: RoleCode, others: readonly RoleCode[], ref: string, reason: string): ForbiddenCombination[] {
  return others.map((o) => ({ roles: [role, o] as const, ref, reason }));
}

/**
 * Kombinasi peran yang TIDAK DAPAT DIAJUKAN (PTB-31, US-M10-01 KP-4):
 * - Admin Keuangan bersama Dispatcher, Sopir, Kernet, Operator (depot/produksi), atau Kasir;
 * - Admin sistem bersama peran yang menyentuh kas atau jurnal (Admin Keuangan, Sopir, Kernet, Operator depot, Kasir);
 * - Pemilik bersama peran pencatat transaksi harian (Admin Keuangan, Dispatcher, Sopir, Kernet, Operator, Kasir);
 * - [PM, NFR-30] Pemilik mitra bersama peran internal EQUA mana pun (isolasi tenant).
 */
export const FORBIDDEN_ROLE_COMBINATIONS: readonly ForbiddenCombination[] = [
  ...pairs("finance_admin", CASH_OR_DAILY_ROLES, "PTB-31", "Admin Keuangan menerima uang sehingga tidak boleh mencatat pesanan atau transaksi lapangan"),
  ...pairs(
    "system_admin",
    ["finance_admin", "driver", "helper", "depot_operator", "store_cashier"],
    "PTB-31",
    "Admin sistem mengatur hak akses sehingga tidak boleh memegang peran yang menyentuh kas atau jurnal",
  ),
  ...pairs(
    "owner",
    ["finance_admin", ...CASH_OR_DAILY_ROLES],
    "PTB-31",
    "Pemilik menyetujui pengecualian sehingga tidak boleh memegang peran pencatat transaksi harian",
  ),
  ...pairs(
    "partner_owner",
    [
      "owner",
      "finance_admin",
      "dispatcher",
      "driver",
      "helper",
      "depot_operator",
      "store_cashier",
      "production_operator",
      "system_admin",
      "accountant",
      "regional_coach",
    ],
    "NFR-30",
    "Pemilik mitra hanya melihat tenant sendiri sehingga tidak boleh memegang peran internal EQUA",
  ),
];

export type RoleCombinationViolation = { roles: [RoleCode, RoleCode]; ref: string; message: string };

/** Periksa kombinasi peran terhadap PTB-31 (murni). */
export function findForbiddenCombinations(roles: readonly RoleCode[]): RoleCombinationViolation[] {
  const set = new Set(roles);
  const out: RoleCombinationViolation[] = [];
  for (const combo of FORBIDDEN_ROLE_COMBINATIONS) {
    const [a, b] = combo.roles;
    if (set.has(a) && set.has(b)) {
      out.push({
        roles: [a, b],
        ref: combo.ref,
        message: `Kombinasi peran ${label("role", a)} dan ${label("role", b)} tidak dapat diajukan (${combo.ref}): ${combo.reason}.`,
      });
    }
  }
  return out;
}
