/**
 * M11 — akun buku per rekening bank (B-53, US-M11-06 rekonsiliasi per rekening; US-M4-05 KP-1).
 *
 * Setiap rekening bank PT (M4 `bank_accounts`) WAJIB punya akun buku sendiri (`gl_account_id` terisi & tidak dipakai
 * rekening lain) agar saldo buku per rekening dapat direkonsiliasi dengan rekening koran. Kontrak untuk M4 (tanpa
 * otorisasi; dipanggil DI DALAM transaksi layanan M4 yang sudah memeriksa izin `m4.bank_account.update`):
 *
 * - `bankGlAccountOptions(tx, tenantId)` — akun kas/bank detail aktif + rekening yang sudah memakainya.
 * - `assertBankGlAccount(tx, tenantId, accountId)` — akun ada di tenant, aktif, detail, jenis aset kas/bank.
 * - `createBankGlAccount(tx, ctx, { bankName, accountNumber })` — akun baru `1-12NN` di bawah induk akun bank bawaan
 *   (anak "Aset lancar"), bertanda kas/bank, pusat laba bersama; berjejak audit.
 */
import "server-only";

import { and, asc, eq, like } from "drizzle-orm";

import { accounts, bankAccounts } from "@/db/schema";

import { record as auditRecord } from "@/server/core/audit";
import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, ValidationError } from "@/server/core/errors";

import type { AccountRow } from "./common";

/** Awalan kode akun bank (akun bawaan 1-1201 "Bank — rekening operasional"). */
const BANK_CODE_PREFIX = "1-12";
const DEFAULT_BANK_CODE = "1-1201";

export type BankGlOption = { id: string; code: string; name: string; usedBy: { bankAccountId: string; label: string }[] };

/** Pilihan akun buku rekening bank: akun aset kas/bank detail yang aktif (+ rekening yang sudah memakainya). */
export async function bankGlAccountOptions(tx: Tx, tenantId: string): Promise<BankGlOption[]> {
  const rows = await tx
    .select({ id: accounts.id, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.type, "asset"), eq(accounts.isCash, true), eq(accounts.isPostable, true), eq(accounts.isActive, true), like(accounts.code, `${BANK_CODE_PREFIX}%`)))
    .orderBy(asc(accounts.code));
  const used = await tx
    .select({ id: bankAccounts.id, gl: bankAccounts.glAccountId, bankName: bankAccounts.bankName, accountNumber: bankAccounts.accountNumber })
    .from(bankAccounts)
    .where(eq(bankAccounts.tenantId, tenantId));
  return rows.map((r) => ({ ...r, usedBy: used.filter((u) => u.gl === r.id).map((u) => ({ bankAccountId: u.id, label: `${u.bankName} ${u.accountNumber}` })) }));
}

/** Pastikan akun layak menjadi akun buku rekening bank. */
export async function assertBankGlAccount(tx: Tx, tenantId: string, accountId: string): Promise<AccountRow> {
  const [a] = await tx.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!a || a.tenantId !== tenantId) throw ValidationError.field("glAccountId", "Akun buku tidak ditemukan. Pilih akun kas/bank dari bagan akun.");
  if (!a.isActive) throw ValidationError.field("glAccountId", `Akun ${a.code} ${a.name} nonaktif. Pilih akun lain atau buat akun buku baru.`);
  if (!a.isPostable || a.type !== "asset" || !a.isCash) {
    throw ValidationError.field("glAccountId", `Akun ${a.code} ${a.name} bukan akun kas/bank detail. Pilih akun bank (${BANK_CODE_PREFIX}xx) atau buat akun buku baru.`);
  }
  return a;
}

/** Kode akun bank berikutnya (`1-1202`, `1-1203`, …). */
export async function nextBankGlCode(tx: Tx, tenantId: string): Promise<string> {
  const rows = await tx.select({ code: accounts.code }).from(accounts).where(and(eq(accounts.tenantId, tenantId), like(accounts.code, `${BANK_CODE_PREFIX}%`)));
  const nums = rows.map((r) => /^1-12(\d{2})$/.exec(r.code)?.[1]).filter((n): n is string => !!n).map(Number);
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  if (next > 99) throw new DomainError("BANK_GL_CODE_FULL", "Kode akun bank 1-1201..1-1299 sudah habis. Tambahkan akun buku lewat Akuntansi › Bagan akun lalu pilih akun itu.");
  return `${BANK_CODE_PREFIX}${String(next).padStart(2, "0")}`;
}

/** Buat akun buku baru khusus satu rekening bank (dipanggil M4 saat rekening ditambah tanpa memilih akun). */
export async function createBankGlAccount(tx: Tx, ctx: ActorContext, input: { bankName: string; accountNumber: string }): Promise<AccountRow> {
  const [template] = await tx.select().from(accounts).where(and(eq(accounts.tenantId, ctx.tenantId), eq(accounts.code, DEFAULT_BANK_CODE))).limit(1);
  const code = await nextBankGlCode(tx, ctx.tenantId);
  const tail = input.accountNumber.replace(/\D/g, "").slice(-4);
  const [row] = await tx
    .insert(accounts)
    .values({
      tenantId: ctx.tenantId,
      code,
      name: `Bank — ${input.bankName}${tail ? ` …${tail}` : ""}`,
      type: "asset",
      normalBalance: "debit",
      parentId: template?.parentId ?? null,
      isPostable: true,
      profitCenter: template?.profitCenter ?? "SHARED",
      isCash: true,
      description: `Akun buku rekening ${input.bankName} ${input.accountNumber} (dibuat otomatis saat rekening ditambahkan, B-53).`,
      createdBy: ctx.userId,
    })
    .returning();
  await auditRecord(tx, { ctx, objectType: "account", objectId: row!.id, action: "create", after: { code, name: row!.name, bankAccountNumber: input.accountNumber }, rule: "B-53, US-M11-06" });
  return row!;
}
