/**
 * Seed PRODUKSI (S5-C, `pnpm db:seed:prod`) — data awal minimal untuk go-live TANPA data demo:
 *
 * - parameter Lampiran B (PAR-01..PAR-89) + pengaturan non-PAR + feature flag bawaan (Tahap 2/3 MATI, D-02);
 * - tenant EQUA (ID deterministik, `src/server/core/context.ts`);
 * - pusat laba L1–L5/SHARED, bagan akun template SAK EMKM, pemetaan peristiwa → akun bawaan (PRD 7.11.4) +
 *   pelengkap pemetaan wajib M11, pengaturan pajak non-PKP, template ekspor jurnal konsultan;
 * - template pesan WhatsApp bawaan;
 * - akun pertama PEMILIK dan ADMIN SISTEM (opsional; peran & lingkup tenant aktif) — kata sandi sementara WAJIB diganti
 *   saat login pertama (`must_change_password`) dan 2FA TOTP didaftarkan saat login pertama (PTB-35).
 *
 * TIDAK diisi (masuk lewat layar/impor cut-over, docs/uat/cutover.md): outlet, sumber air, truk, karyawan lain,
 * pelanggan, produk & harga, zona tarif, rekening bank (akun buku sendiri per rekening — D-12 butir 4), saldo awal.
 * Peran sendiri adalah katalog tetap di kode (`src/server/core/rbac/`), bukan baris tabel.
 *
 * Idempoten: ID deterministik + ON CONFLICT DO NOTHING; akun dengan nama pengguna yang sudah ada dilewati.
 * Menolak DB yang berisi data demo (`pnpm db:seed`).
 */
import { hash } from "@node-rs/argon2";
import { and, eq, inArray, sql } from "drizzle-orm";

import { newId } from "@/lib/ids";
import type { RoleCode } from "@/lib/labels";
import { toBusinessDate } from "@/lib/time";

import type { Db, DbOrTx } from "../client";
import { employees, users, userRoles, userScopes } from "../schema";
import { seedAccounting } from "./accounting";
import { seedM11AccountingDefaults } from "./demo-m11-accounting";
import { seedBaseSettings } from "./index";
import { EQUA_TENANT_ID, outletId, seedEquaTenant, userIdByUsername } from "./org";
import { seedWaTemplates } from "./templates";

/** Peran yang boleh dibuat skrip akun pertama (sisanya lewat /akses/pengguna dengan persetujuan pemilik). */
export const INITIAL_ACCOUNT_ROLES = ["owner", "system_admin"] as const satisfies readonly RoleCode[];
export type InitialAccountRole = (typeof INITIAL_ACCOUNT_ROLES)[number];

export type InitialAccountInput = {
  role: InitialAccountRole;
  username: string;
  fullName: string;
  /** Kata sandi SEMENTARA (≥ 10 karakter) — wajib diganti saat login pertama. */
  password: string;
  phone?: string | null;
  /** Nomor karyawan; bawaan `EQ-P01` (pemilik) / `EQ-A01` (admin sistem). */
  employeeNo?: string;
  position?: string;
};

export type InitialAccountResult = {
  role: InitialAccountRole;
  username: string;
  status: "created" | "exists";
  userId: string;
};

export type ProductionSeedSummary = {
  parameters: number;
  accounts: InitialAccountResult[];
  counts: Record<string, number>;
};

/** Galat masukan/penolakan seed produksi (pesan Bahasa Indonesia berisi tindakan). */
export class ProductionSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionSeedError";
  }
}

const USERNAME_PATTERN = /^[a-z0-9._-]{3,40}$/;
const MIN_PASSWORD_LENGTH = 10;

const ROLE_DEFAULTS: Record<InitialAccountRole, { employeeNo: string; position: string }> = {
  owner: { employeeNo: "EQ-P01", position: "Pemilik" },
  system_admin: { employeeNo: "EQ-A01", position: "Admin Sistem (IT)" },
};

/** Validasi & normalisasi masukan akun pertama (tanpa menyentuh DB). */
export function validateInitialAccounts(input: readonly InitialAccountInput[]): InitialAccountInput[] {
  const out = input.map((a) => ({
    ...a,
    username: a.username.trim().toLowerCase(),
    fullName: a.fullName.trim(),
    phone: a.phone?.trim() || null,
  }));
  for (const a of out) {
    if (!(INITIAL_ACCOUNT_ROLES as readonly string[]).includes(a.role)) {
      throw new ProductionSeedError(`Peran "${a.role}" tidak dapat dibuat lewat skrip. Buat akun lain di Akses > Pengguna.`);
    }
    if (!USERNAME_PATTERN.test(a.username)) {
      throw new ProductionSeedError(
        `Nama pengguna "${a.username}" tidak sah: 3–40 karakter huruf kecil, angka, titik, garis bawah, atau strip.`,
      );
    }
    if (a.fullName.length < 3) throw new ProductionSeedError(`Isi nama lengkap untuk akun ${a.username} (minimal 3 karakter).`);
    if (typeof a.password !== "string" || a.password.length < MIN_PASSWORD_LENGTH) {
      throw new ProductionSeedError(`Kata sandi sementara ${a.username} minimal ${MIN_PASSWORD_LENGTH} karakter.`);
    }
    if (a.password.length > 200) throw new ProductionSeedError(`Kata sandi ${a.username} terlalu panjang (maksimal 200 karakter).`);
  }
  const names = out.map((a) => a.username);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new ProductionSeedError(`Nama pengguna "${dup}" dipakai dua kali. Pemilik dan admin sistem harus akun berbeda (PTB-31).`);
  return out;
}

/** Benar bila DB berisi data demo `pnpm db:seed` (outlet D01 / akun "pemilik" ber-ID seed). */
export async function hasDemoData(tx: DbOrTx): Promise<boolean> {
  const res = await tx.execute<{ n: number }>(sql`
    select (select count(*) from outlets where id = ${outletId("D01")})::int
         + (select count(*) from users where id = ${userIdByUsername("pemilik")})::int as n`);
  return Number(res.rows[0]?.n ?? 0) > 0;
}

/** Data acuan produksi (tanpa akun). Idempoten. */
export async function seedProductionReference(tx: DbOrTx): Promise<number> {
  const parameters = await seedBaseSettings(tx);
  await seedEquaTenant(tx);
  await seedAccounting(tx, { demoBankAccount: false });
  await seedM11AccountingDefaults(tx);
  await seedWaTemplates(tx);
  return parameters;
}

/** Buat akun pertama pemilik/admin sistem (lewati nama pengguna yang sudah ada). */
export async function createInitialAccounts(
  tx: DbOrTx,
  input: readonly InitialAccountInput[],
  options: { now?: Date } = {},
): Promise<InitialAccountResult[]> {
  const accounts = validateInitialAccounts(input);
  if (accounts.length === 0) return [];
  const now = options.now ?? new Date();
  const today = toBusinessDate(now);
  const existing = await tx
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(inArray(sql`lower(${users.username})`, accounts.map((a) => a.username)));
  const results: InitialAccountResult[] = [];
  for (const a of accounts) {
    const found = existing.find((u) => u.username.toLowerCase() === a.username);
    if (found) {
      results.push({ role: a.role, username: a.username, status: "exists", userId: found.id });
      continue;
    }
    const defaults = ROLE_DEFAULTS[a.role];
    const employeeNo = a.employeeNo?.trim() || defaults.employeeNo;
    const [dupNo] = await tx.select({ id: employees.id }).from(employees)
      .where(and(eq(employees.tenantId, EQUA_TENANT_ID), eq(employees.employeeNo, employeeNo)))
      .limit(1);
    if (dupNo) throw new ProductionSeedError(`Nomor karyawan ${employeeNo} sudah dipakai. Isi nomor karyawan lain untuk ${a.username}.`);
    const employeeId = newId();
    const userId = newId();
    const reason = "Akun pertama go-live (pnpm db:seed:prod) — ditinjau pemilik di Akses > Pengguna (US-M10-01 KP-8).";
    await tx.insert(employees).values({
      id: employeeId,
      tenantId: EQUA_TENANT_ID,
      employeeNo,
      fullName: a.fullName,
      nickname: a.fullName.split(/\s+/)[0] ?? a.fullName,
      position: a.position?.trim() || defaults.position,
      phone: a.phone ?? null,
      workLocation: "Kantor EQUA",
      intendedRoles: [a.role],
      hireDate: today,
    });
    await tx.insert(users).values({
      id: userId,
      tenantId: EQUA_TENANT_ID,
      employeeId,
      username: a.username,
      passwordHash: await hash(a.password),
      passwordChangedAt: now,
      // Kata sandi sementara diganti saat login pertama (B-08); TOTP didaftarkan saat login pertama (PTB-35).
      mustChangePassword: true,
      totpEnabled: false,
      status: "active",
      activatedAt: now,
    });
    await tx.insert(userRoles).values({
      userId,
      role: a.role,
      status: "active",
      validFrom: today,
      reason,
      grantedAt: now,
    });
    await tx.insert(userScopes).values({
      userId,
      scopeType: "tenant",
      refId: EQUA_TENANT_ID,
      status: "active",
      validFrom: today,
      reason,
    });
    results.push({ role: a.role, username: a.username, status: "created", userId });
  }
  return results;
}

const COUNTED = [
  "parameters",
  "feature_flags",
  "tenants",
  "profit_centers",
  "accounts",
  "event_account_mappings",
  "tax_settings",
  "export_templates",
  "wa_templates",
  "employees",
  "users",
  "outlets",
  "customers",
  "products",
  "trucks",
  "bank_accounts",
] as const;

async function countRows(tx: DbOrTx): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of COUNTED) {
    const res = await tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from "${table}"`));
    out[table] = Number(res.rows[0]?.n ?? 0);
  }
  return out;
}

/**
 * Seed produksi dalam SATU transaksi: data acuan + akun pertama (opsional). Menolak DB berisi data demo.
 * Tanpa akun di masukan dan tanpa pemilik/admin sistem aktif di DB → tetap berhasil (akun dapat dibuat kemudian dengan
 * menjalankan ulang skrip), ringkasan `accounts` kosong.
 */
export async function runProductionSeed(
  db: Db,
  options: { accounts?: readonly InitialAccountInput[]; now?: Date } = {},
): Promise<ProductionSeedSummary> {
  const accounts = validateInitialAccounts(options.accounts ?? []);
  return db.transaction(async (tx) => {
    if (await hasDemoData(tx)) {
      throw new ProductionSeedError(
        "Basis data berisi data demo (pnpm db:seed). Seed produksi hanya untuk DB produksi yang kosong — buat DB/branch Neon baru lalu jalankan pnpm db:migrate.",
      );
    }
    const parameters = await seedProductionReference(tx);
    const created = await createInitialAccounts(tx, accounts, { now: options.now });
    return { parameters, accounts: created, counts: await countRows(tx) };
  });
}
