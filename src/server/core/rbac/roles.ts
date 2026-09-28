/**
 * Katalog peran tetap (US-M10-01 KP-1; BRD 4.2; PRD Bab 3.2). Hak per peran hanya lewat peran — tidak ada hak ad hoc
 * per pengguna. Label dari `src/lib/labels.ts`.
 */
import { label, ROLE_CODES, type RoleCode } from "@/lib/labels";

export type RoleInterface = "web" | "field" | "pos" | "portal";

export type RoleDef = {
  code: RoleCode;
  label: string;
  /** Wajib 2FA TOTP di web kantor (PTB-35). */
  requires2fa: boolean;
  /** Peran lapangan (PIN + perangkat terdaftar; aksi offline) — tidak ada izin menu kantor. */
  isFieldRole: boolean;
  /** Hanya membaca (akuntan, pemilik mitra). */
  isReadOnly: boolean;
  /** Antarmuka utama peran. */
  interfaces: readonly RoleInterface[];
  /** Jenis lingkup data yang mengikat peran (US-M10-01 KP-3). */
  scopeKind: "tenant" | "truck" | "outlet" | "water_source";
  /** Tahap produk (1 = Tahap 1/RL-7, 3 = Tahap 3). */
  phase: 1 | 3;
  description: string;
};

export const ROLE_CATALOG: Record<RoleCode, RoleDef> = {
  owner: {
    code: "owner",
    label: label("role", "owner"),
    requires2fa: true,
    isFieldRole: false,
    isReadOnly: false,
    interfaces: ["web"],
    scopeKind: "tenant",
    phase: 1,
    description: "Membaca ringkasan, menyetujui pengecualian, memutuskan; tidak menginput transaksi harian.",
  },
  finance_admin: {
    code: "finance_admin",
    label: label("role", "finance_admin"),
    requires2fa: true,
    isFieldRole: false,
    isReadOnly: false,
    interfaces: ["web"],
    scopeKind: "tenant",
    phase: 1,
    description: "Setoran, selisih, transfer, kas kantor, tutup kas, piutang, jurnal; tidak membuat/mengubah pesanan.",
  },
  dispatcher: {
    code: "dispatcher",
    label: label("role", "dispatcher"),
    requires2fa: false,
    isFieldRole: false,
    isReadOnly: false,
    interfaces: ["web"],
    scopeKind: "tenant",
    phase: 1,
    description: "Pelanggan, pesanan, papan jadwal, kru, peta armada; tidak mengakses kas.",
  },
  driver: {
    code: "driver",
    label: label("role", "driver"),
    requires2fa: false,
    isFieldRole: true,
    isReadOnly: false,
    interfaces: ["field"],
    scopeKind: "truck",
    phase: 1,
    description: "Rit sendiri hari itu: berangkat, tiba, selesai, pembayaran, pelunasan, setor.",
  },
  helper: {
    code: "helper",
    label: label("role", "helper"),
    requires2fa: false,
    isFieldRole: true,
    isReadOnly: false,
    interfaces: ["field"],
    scopeKind: "truck",
    phase: 1,
    description: "Membaca rit truknya; tindakan sopir hanya bila ditetapkan sebagai pengemudi pengganti hari itu (PTB-10).",
  },
  depot_operator: {
    code: "depot_operator",
    label: label("role", "depot_operator"),
    requires2fa: false,
    isFieldRole: true,
    isReadOnly: false,
    interfaces: ["pos"],
    scopeKind: "outlet",
    phase: 1,
    description: "POS depot outletnya: transaksi, shift, void, pasokan, opname.",
  },
  store_cashier: {
    code: "store_cashier",
    label: label("role", "store_cashier"),
    requires2fa: false,
    isFieldRole: true,
    isReadOnly: false,
    interfaces: ["pos", "web"],
    scopeKind: "outlet",
    phase: 1,
    description: "POS toko: penjualan, penerimaan barang, opname, pesan ulang, usulan barang/harga.",
  },
  production_operator: {
    code: "production_operator",
    label: label("role", "production_operator"),
    requires2fa: false,
    isFieldRole: true,
    isReadOnly: false,
    interfaces: ["field"],
    scopeKind: "water_source",
    phase: 1,
    description: "Meter, pengisian truk, pasokan, uji mutu — hanya sumber air yang ditugaskan.",
  },
  system_admin: {
    code: "system_admin",
    label: label("role", "system_admin"),
    requires2fa: true,
    isFieldRole: false,
    isReadOnly: false,
    interfaces: ["web"],
    scopeKind: "tenant",
    phase: 1,
    description: "Pengguna, peran, lingkup, perangkat, pemantauan; tidak menyentuh transaksi keuangan.",
  },
  accountant: {
    code: "accountant",
    label: label("role", "accountant"),
    requires2fa: false,
    isFieldRole: false,
    isReadOnly: true,
    interfaces: ["web"],
    scopeKind: "tenant",
    phase: 1,
    description: "Baca-saja M11 dan laporan keuangan selama pendampingan (PTB-11); mengesahkan saldo awal.",
  },
  partner_owner: {
    code: "partner_owner",
    label: label("role", "partner_owner"),
    requires2fa: false,
    isFieldRole: false,
    isReadOnly: true,
    interfaces: ["portal"],
    scopeKind: "tenant",
    phase: 1,
    description: "Baca-saja laporan outlet tenant sendiri (RL-7, US-P3-10); mengajukan permintaan dukungan.",
  },
  regional_coach: {
    code: "regional_coach",
    label: label("role", "regional_coach"),
    requires2fa: false,
    isFieldRole: false,
    isReadOnly: false,
    interfaces: ["web"],
    scopeKind: "tenant",
    phase: 3,
    description: "Survei calon mitra, onboarding, audit mutu, pembinaan (Tahap 3).",
  },
};

export const ALL_ROLES: readonly RoleCode[] = ROLE_CODES;

/** Peran yang wajib 2FA (PTB-35): pemilik, Admin Keuangan, admin sistem. */
export const ROLES_REQUIRING_2FA: readonly RoleCode[] = ALL_ROLES.filter((r) => ROLE_CATALOG[r].requires2fa);

/** Peran lapangan (PIN + perangkat). */
export const FIELD_ROLES: readonly RoleCode[] = ALL_ROLES.filter((r) => ROLE_CATALOG[r].isFieldRole);

export function roleLabel(code: RoleCode): string {
  return ROLE_CATALOG[code]?.label ?? code;
}

/** Benar bila salah satu peran wajib 2FA. */
export function requires2fa(roles: readonly RoleCode[]): boolean {
  return roles.some((r) => ROLE_CATALOG[r]?.requires2fa);
}
