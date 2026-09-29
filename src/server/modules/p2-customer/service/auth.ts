/**
 * P2 — autentikasi pelanggan (US-P2-01 KP-1/KP-4, 8.6): nomor WA + OTP 6 digit (PAR-74: berlaku 5 menit, 3 percobaan),
 * tanpa kata sandi; sesi 30 hari (`p2.customer_app_rules.session_days`); verifikasi ulang OTP untuk pembayaran;
 * pergantian nomor lewat verifikasi nomor lama DAN baru.
 *
 * Kode OTP disimpan sebagai HMAC (kunci turunan `SESSION_SECRET`), token sesi sebagai SHA-256. Kegagalan verifikasi
 * menaikkan hitungan percobaan di transaksi TERSENDIRI (tidak ikut rollback saat galat dilempar).
 */
import "server-only";

import { randomInt } from "node:crypto";

import { and, count, desc, eq, gt, gte, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { customerAccounts, customerSessions, otpCodes, phoneChangeRequests } from "@/db/schema";
import type { EnumValue } from "@/lib/labels";
import { toBusinessDate } from "@/lib/time";

import { logAccess } from "@/server/core/access-log";
import { hmacHex, randomToken, safeEqual, sha256Hex } from "@/server/core/auth/crypto";
import { withTx, type Tx } from "@/server/core/db";
import { ConflictError, DomainError, parseInput, ValidationError } from "@/server/core/errors";
import * as params from "@/server/core/params";
import { normalizeWaNumber } from "@/server/core/wa";

import { appRules, assertAppEnabled, CUSTOMER_APP_TENANT_ID, isAppEnabled, maskPhone, recordCustomerAudit, type AccountRow, type CustomerContext } from "./common";
import { deliverOtp } from "./messaging";

type OtpPurpose = EnumValue<"otp_purpose">;

export type RequestMeta = { now: Date; ip?: string | null; userAgent?: string | null; tenantId?: string };

const phoneSchema = z
  .string({ error: "Nomor WhatsApp wajib diisi." })
  .trim()
  .transform((v, c) => {
    const n = normalizeWaNumber(v);
    if (!n) {
      c.addIssue({ code: "custom", message: "Nomor WhatsApp tidak valid. Contoh yang benar: 0812-3456-7890." });
      return z.NEVER;
    }
    return n;
  });

const codeSchema = z
  .string({ error: "Kode verifikasi wajib diisi." })
  .trim()
  .regex(/^\d{4,8}$/, { error: "Kode verifikasi berupa angka dari WhatsApp." });

function otpHash(phone: string, purpose: OtpPurpose, code: string): string {
  return hmacHex("code-hmac", `p2-otp:${phone}:${purpose}:${code}`);
}

async function accountByPhone(tx: Tx, phone: string): Promise<AccountRow | null> {
  return (await tx.select().from(customerAccounts).where(eq(customerAccounts.phone, phone)).limit(1))[0] ?? null;
}

export type OtpRequestResult = {
  /** `login` = akun sudah ada; `register` = nomor baru (lengkapi pendaftaran setelah verifikasi). */
  purpose: OtpPurpose;
  phone: string;
  phoneMasked: string;
  expiresAt: Date;
  resendAfterSeconds: number;
  channel: "wa" | "dev";
  /** HANYA dev/uji/E2E (mode tautan tanpa Cloud API): kode ditampilkan "mode uji". */
  devCode?: string;
};

/** Buat & kirim OTP untuk nomor (umum untuk semua tujuan). */
async function issueOtp(tx: Tx, input: { phone: string; purpose: OtpPurpose; accountId: string | null; meta: RequestMeta; tenantId: string }): Promise<OtpRequestResult> {
  const today = toBusinessDate(input.meta.now);
  const par74 = await params.get(tx, "PAR-74", today);
  const rules = await appRules(tx, today, input.tenantId);
  const hourAgo = new Date(input.meta.now.getTime() - 3_600_000);
  // Batas penyalahgunaan di atas batas per nomor: per alamat IP & total per jam (setiap OTP = pesan WA berbayar).
  const limits = await params.get(tx, "p2.otp_request_limits", today);
  const [all] = await tx.select({ n: count() }).from(otpCodes).where(gte(otpCodes.createdAt, hourAgo));
  if (Number(all?.n ?? 0) >= limits.global_per_hour) {
    throw new DomainError("OTP_GLOBAL_LIMIT", "Layanan kode verifikasi sedang sibuk. Coba lagi dalam beberapa menit.");
  }
  if (input.meta.ip) {
    const [byIp] = await tx.select({ n: count() }).from(otpCodes).where(and(eq(otpCodes.requestIp, input.meta.ip), gte(otpCodes.createdAt, hourAgo)));
    if (Number(byIp?.n ?? 0) >= limits.per_ip_per_hour) {
      throw new DomainError("OTP_IP_LIMIT", "Terlalu banyak permintaan kode dari jaringan ini. Coba lagi dalam 1 jam.");
    }
  }
  const recent = await tx
    .select({ createdAt: otpCodes.createdAt })
    .from(otpCodes)
    .where(and(eq(otpCodes.phone, input.phone), gte(otpCodes.createdAt, hourAgo)))
    .orderBy(desc(otpCodes.createdAt));
  if (recent.length >= rules.otp_max_requests_per_hour) {
    throw new DomainError("OTP_RATE_LIMITED", "Terlalu banyak permintaan kode untuk nomor ini. Coba lagi dalam 1 jam.");
  }
  const last = recent[0]?.createdAt;
  if (last && input.meta.now.getTime() - last.getTime() < rules.otp_resend_seconds * 1000) {
    const wait = Math.ceil((rules.otp_resend_seconds * 1000 - (input.meta.now.getTime() - last.getTime())) / 1000);
    throw new DomainError("OTP_RESEND_WAIT", `Kode baru dapat diminta lagi dalam ${wait} detik. Periksa pesan WhatsApp Anda.`);
  }
  const code = String(randomInt(0, 10 ** par74.digits)).padStart(par74.digits, "0");
  const expiresAt = new Date(input.meta.now.getTime() + par74.valid_minutes * 60_000);
  const [row] = await tx
    .insert(otpCodes)
    .values({
      phone: input.phone,
      purpose: input.purpose,
      codeHash: otpHash(input.phone, input.purpose, code),
      expiresAt,
      maxAttempts: par74.max_attempts,
      customerAccountId: input.accountId,
      requestIp: input.meta.ip ?? null,
      createdAt: input.meta.now,
    })
    .returning({ id: otpCodes.id });
  const delivery = await deliverOtp(tx, { tenantId: input.tenantId, phone: input.phone, code, validMinutes: par74.valid_minutes, now: input.meta.now, objectId: row!.id });
  return {
    purpose: input.purpose,
    phone: input.phone,
    phoneMasked: maskPhone(input.phone),
    expiresAt,
    resendAfterSeconds: rules.otp_resend_seconds,
    channel: delivery.channel,
    ...(delivery.devCode ? { devCode: delivery.devCode } : {}),
  };
}

/**
 * Minta OTP masuk/daftar (US-P2-01 KP-1): nomor dengan akun aktif → masuk; nomor baru → daftar. Satu nomor satu akun
 * (KP-4): akun nonaktif (hapus akun) tidak dapat dipakai lagi tanpa kantor.
 */
export async function requestLoginOtp(input: { phone: string }, meta: RequestMeta, opts: { tx?: Tx } = {}): Promise<OtpRequestResult> {
  const data = parseInput(z.object({ phone: phoneSchema }), input, { phone: "Nomor WhatsApp" });
  const tenantId = meta.tenantId ?? CUSTOMER_APP_TENANT_ID;
  const run = async (tx: Tx) => {
    await assertAppEnabled(tx, tenantId);
    const account = await accountByPhone(tx, data.phone);
    // Tanggapan permintaan kode SERAGAM untuk nomor terdaftar/baru/nonaktif (cegah enumerasi nomor, US-P2-01 KP-1):
    // akun nonaktif baru ditolak SETELAH kode diverifikasi (hanya pemegang nomor yang melihat alasannya).
    return issueOtp(tx, { phone: data.phone, purpose: account ? "login" : "register", accountId: account?.id ?? null, meta, tenantId });
  };
  return opts.tx ? run(opts.tx) : withTx(run);
}

type VerifyOutcome = { ok: true; otpId: string } | { ok: false; code: string; message: string };

/** Periksa OTP terbaru nomor+tujuan; percobaan gagal dicatat di transaksi tersendiri (tidak ikut rollback). */
async function checkOtp(phone: string, purposes: OtpPurpose[], code: string, now: Date, tx?: Tx): Promise<VerifyOutcome> {
  const run = async (t: Tx): Promise<VerifyOutcome> => {
    const rows = await t
      .select()
      .from(otpCodes)
      .where(and(eq(otpCodes.phone, phone), isNull(otpCodes.consumedAt), sql`${otpCodes.purpose} in (${sql.join(purposes.map((p) => sql`${p}`), sql`, `)})`))
      .orderBy(desc(otpCodes.createdAt))
      .limit(1)
      .for("update");
    const otp = rows[0];
    if (!otp || otp.expiresAt <= now) return { ok: false, code: "OTP_EXPIRED", message: "Kode sudah kedaluwarsa. Minta kode baru." };
    if (otp.attempts >= otp.maxAttempts) return { ok: false, code: "OTP_LOCKED", message: `Kode salah ${otp.maxAttempts} kali. Minta kode baru.` };
    if (!safeEqual(otp.codeHash, otpHash(phone, otp.purpose, code))) {
      const attempts = otp.attempts + 1;
      await t.update(otpCodes).set({ attempts, ...(attempts >= otp.maxAttempts ? { consumedAt: now } : {}) }).where(eq(otpCodes.id, otp.id));
      const left = otp.maxAttempts - attempts;
      return left > 0
        ? { ok: false, code: "OTP_WRONG", message: `Kode salah. Sisa percobaan: ${left}.` }
        : { ok: false, code: "OTP_LOCKED", message: `Kode salah ${otp.maxAttempts} kali. Minta kode baru.` };
    }
    await t.update(otpCodes).set({ consumedAt: now, attempts: otp.attempts + 1 }).where(eq(otpCodes.id, otp.id));
    return { ok: true, otpId: otp.id };
  };
  // Di dalam transaksi pemanggil (uji/aksi gabungan) hitungan percobaan ikut transaksi itu.
  return tx ? run(tx) : withTx(run);
}

function fail(outcome: Extract<VerifyOutcome, { ok: false }>): never {
  throw new DomainError(outcome.code, outcome.message);
}

export type SessionIssue = { token: string; sessionId: string; expiresAt: Date };

/** Buat sesi pelanggan (token acak; DB menyimpan hash). */
export async function createCustomerSession(tx: Tx, accountId: string, meta: RequestMeta, opts: { reverified?: boolean } = {}): Promise<SessionIssue> {
  const rules = await appRules(tx, toBusinessDate(meta.now), meta.tenantId ?? CUSTOMER_APP_TENANT_ID);
  const token = randomToken(32);
  const expiresAt = new Date(meta.now.getTime() + rules.session_days * 86_400_000);
  const [row] = await tx
    .insert(customerSessions)
    .values({
      customerAccountId: accountId,
      tokenHash: sha256Hex(token),
      lastActiveAt: meta.now,
      expiresAt,
      reverifiedAt: opts.reverified ? meta.now : null,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      createdAt: meta.now,
    })
    .returning({ id: customerSessions.id });
  return { token, sessionId: row!.id, expiresAt };
}

export type LoginResult = SessionIssue & {
  accountId: string;
  /** Langkah berikut: beranda, lengkapi pendaftaran (persetujuan + nama), atau menunggu verifikasi Dispatcher. */
  next: "home" | "complete_registration" | "pending_review";
};

/**
 * Verifikasi OTP masuk/daftar → sesi 30 hari. Nomor baru → akun `verified` (Terverifikasi WA) lalu lengkapi pendaftaran
 * (persetujuan UU PDP + nama; KP-2/KP-5).
 */
export async function verifyLoginOtp(input: { phone: string; code: string }, meta: RequestMeta, opts: { tx?: Tx } = {}): Promise<LoginResult> {
  const data = parseInput(z.object({ phone: phoneSchema, code: codeSchema }), input, { phone: "Nomor WhatsApp", code: "Kode verifikasi" });
  const tenantId = meta.tenantId ?? CUSTOMER_APP_TENANT_ID;
  const outcome = await checkOtp(data.phone, ["login", "register"], data.code, meta.now, opts.tx);
  if (!outcome.ok) {
    const log = async (tx: Tx) =>
      logAccess(tx, {
        tenantId,
        event: "login_failed",
        success: false,
        usernameAttempted: maskPhone(data.phone),
        reason: outcome.message,
        rule: "US-P2-01 KP-1",
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        details: { channel: "customer_app", code: outcome.code },
        occurredAt: meta.now,
      });
    if (opts.tx) await log(opts.tx);
    else await withTx(log);
    fail(outcome);
  }
  const run = async (tx: Tx): Promise<LoginResult> => {
    let account = await accountByPhone(tx, data.phone);
    if (account && (account.status === "inactive" || account.deactivatedAt)) {
      throw new DomainError("ACCOUNT_INACTIVE", "Akun untuk nomor ini sudah dinonaktifkan. Hubungi kantor EQUA.");
    }
    if (!account) {
      [account] = await tx
        .insert(customerAccounts)
        .values({ tenantId, phone: data.phone, status: "verified", verifiedAt: meta.now, lastLoginAt: meta.now, createdAt: meta.now, updatedAt: meta.now })
        .returning();
      await recordCustomerAudit(tx, { tenantId, now: meta.now, accountId: account!.id }, { objectType: "customer_account", objectId: account!.id, action: "create", after: { phone: maskPhone(data.phone), status: "verified" }, rule: "US-P2-01 KP-1" });
    } else {
      await tx
        .update(customerAccounts)
        .set({ lastLoginAt: meta.now, verifiedAt: account.verifiedAt ?? meta.now, status: account.status === "registered" ? "verified" : account.status, updatedAt: meta.now })
        .where(eq(customerAccounts.id, account.id));
    }
    const session = await createCustomerSession(tx, account!.id, { ...meta, tenantId }, { reverified: true });
    await logAccess(tx, {
      tenantId,
      event: "login_success",
      usernameAttempted: maskPhone(data.phone),
      rule: "US-P2-01 KP-1",
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      objectType: "customer_account",
      objectId: account!.id,
      details: { channel: "customer_app" },
      occurredAt: meta.now,
    });
    const status = account!.status === "registered" ? "verified" : account!.status;
    const next: LoginResult["next"] = !account!.consentPdpAt || status === "verified" ? "complete_registration" : status === "pending_review" ? "pending_review" : "home";
    return { ...session, accountId: account!.id, next };
  };
  return opts.tx ? run(opts.tx) : withTx(run);
}

/**
 * Pelaku dari token sesi (null bila tidak sah/kedaluwarsa/dicabut/akun nonaktif). Aktivitas terakhir diperbarui
 * paling sering tiap 5 menit.
 */
export async function resolveCustomerSession(tx: Tx, token: string | null | undefined, now: Date): Promise<CustomerContext | null> {
  if (!token || token.length < 20) return null;
  const rows = await tx
    .select({ s: customerSessions, a: customerAccounts })
    .from(customerSessions)
    .innerJoin(customerAccounts, eq(customerAccounts.id, customerSessions.customerAccountId))
    .where(and(eq(customerSessions.tokenHash, sha256Hex(token)), isNull(customerSessions.revokedAt), gt(customerSessions.expiresAt, now)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const { s, a } = row;
  if (a.status === "inactive" || a.deactivatedAt || a.anonymizedAt) return null;
  // D-02 butir 3: Tahap 2 dimatikan kembali → sesi (30 hari) tidak berlaku untuk halaman, rute JSON/berkas, maupun aksi.
  if (!(await isAppEnabled(tx, a.tenantId))) return null;
  if (now.getTime() - s.lastActiveAt.getTime() > 5 * 60_000) {
    await tx.update(customerSessions).set({ lastActiveAt: now }).where(eq(customerSessions.id, s.id));
  }
  return {
    kind: "customer",
    accountId: a.id,
    customerId: a.status === "linked" ? a.customerId : null,
    tenantId: a.tenantId,
    sessionId: s.id,
    status: a.status,
    phone: a.phone,
    displayName: a.displayName,
    reverifiedAt: s.reverifiedAt,
    consentGiven: !!a.consentPdpAt,
    now,
  };
}

/** Keluar: cabut sesi ini. */
export async function logoutCustomer(tx: Tx, token: string | null | undefined, now: Date): Promise<void> {
  if (!token) return;
  await tx.update(customerSessions).set({ revokedAt: now }).where(and(eq(customerSessions.tokenHash, sha256Hex(token)), isNull(customerSessions.revokedAt)));
}

/** Cabut semua sesi akun (hapus akun, ganti nomor, penonaktifan kantor). */
export async function revokeAccountSessions(tx: Tx, accountId: string, now: Date, exceptSessionId?: string | null): Promise<number> {
  const rows = await tx
    .update(customerSessions)
    .set({ revokedAt: now })
    .where(and(eq(customerSessions.customerAccountId, accountId), isNull(customerSessions.revokedAt), exceptSessionId ? sql`${customerSessions.id} <> ${exceptSessionId}` : sql`true`))
    .returning({ id: customerSessions.id });
  return rows.length;
}

// =====================================================================================================================
// Verifikasi ulang untuk pembayaran (8.6)
// =====================================================================================================================

/** Sesi masih dalam jendela verifikasi ulang pembayaran? */
export async function isReverified(tx: Tx, cctx: CustomerContext): Promise<boolean> {
  if (!cctx.reverifiedAt) return false;
  const rules = await appRules(tx, toBusinessDate(cctx.now), cctx.tenantId);
  return cctx.now.getTime() - cctx.reverifiedAt.getTime() <= rules.payment_reverify_minutes * 60_000;
}

export async function requestPaymentOtp(cctx: CustomerContext, opts: { tx?: Tx } = {}): Promise<OtpRequestResult> {
  const run = async (tx: Tx) => {
    await assertAppEnabled(tx, cctx.tenantId);
    return issueOtp(tx, { phone: cctx.phone, purpose: "payment", accountId: cctx.accountId, meta: { now: cctx.now }, tenantId: cctx.tenantId });
  };
  return opts.tx ? run(opts.tx) : withTx(run);
}

/** Verifikasi ulang OTP → sesi boleh membuat pembayaran selama `payment_reverify_minutes`. */
export async function verifyPaymentOtp(cctx: CustomerContext, input: { code: string }, opts: { tx?: Tx } = {}): Promise<{ reverifiedAt: Date }> {
  const data = parseInput(z.object({ code: codeSchema }), input, { code: "Kode verifikasi" });
  const outcome = await checkOtp(cctx.phone, ["payment"], data.code, cctx.now, opts.tx);
  if (!outcome.ok) fail(outcome);
  const run = async (tx: Tx) => {
    await tx.update(customerSessions).set({ reverifiedAt: cctx.now }).where(eq(customerSessions.id, cctx.sessionId));
    return { reverifiedAt: cctx.now };
  };
  return opts.tx ? run(opts.tx) : withTx(run);
}

// =====================================================================================================================
// Ganti nomor WA (US-P2-01 KP-4): verifikasi nomor lama lalu nomor baru
// =====================================================================================================================

/** Langkah 1: nomor baru belum dipakai akun lain → OTP ke nomor LAMA. */
export async function startPhoneChange(cctx: CustomerContext, input: { newPhone: string }, opts: { tx?: Tx } = {}): Promise<OtpRequestResult & { requestId: string }> {
  const data = parseInput(z.object({ newPhone: phoneSchema }), input, { newPhone: "Nomor WhatsApp baru" });
  const run = async (tx: Tx) => {
    await assertAppEnabled(tx, cctx.tenantId);
    if (data.newPhone === cctx.phone) throw ValidationError.field("newPhone", "Nomor baru sama dengan nomor sekarang.");
    if (await accountByPhone(tx, data.newPhone)) {
      throw new ConflictError("PHONE_IN_USE", "Nomor baru sudah dipakai akun lain (satu nomor satu akun). Hubungi kantor EQUA bila nomor itu milik Anda.");
    }
    const [req] = await tx
      .insert(phoneChangeRequests)
      .values({ customerAccountId: cctx.accountId, oldPhone: cctx.phone, newPhone: data.newPhone, expiresAt: new Date(cctx.now.getTime() + 30 * 60_000), createdAt: cctx.now })
      .returning({ id: phoneChangeRequests.id });
    const otp = await issueOtp(tx, { phone: cctx.phone, purpose: "change_phone", accountId: cctx.accountId, meta: { now: cctx.now }, tenantId: cctx.tenantId });
    return { ...otp, requestId: req!.id };
  };
  return opts.tx ? run(opts.tx) : withTx(run);
}

async function openPhoneChange(tx: Tx, cctx: CustomerContext) {
  const rows = await tx
    .select()
    .from(phoneChangeRequests)
    .where(and(eq(phoneChangeRequests.customerAccountId, cctx.accountId), isNull(phoneChangeRequests.completedAt), gt(phoneChangeRequests.expiresAt, cctx.now)))
    .orderBy(desc(phoneChangeRequests.createdAt))
    .limit(1);
  if (!rows[0]) throw new DomainError("PHONE_CHANGE_EXPIRED", "Permintaan ganti nomor sudah kedaluwarsa. Mulai lagi dari menu Akun.");
  return rows[0];
}

/** Langkah 2: kode dari nomor LAMA benar → OTP ke nomor BARU. */
export async function confirmOldPhone(cctx: CustomerContext, input: { code: string }, opts: { tx?: Tx } = {}): Promise<OtpRequestResult> {
  const data = parseInput(z.object({ code: codeSchema }), input, { code: "Kode verifikasi" });
  const outcome = await checkOtp(cctx.phone, ["change_phone"], data.code, cctx.now, opts.tx);
  if (!outcome.ok) fail(outcome);
  const run = async (tx: Tx) => {
    const req = await openPhoneChange(tx, cctx);
    await tx.update(phoneChangeRequests).set({ oldVerifiedAt: cctx.now }).where(eq(phoneChangeRequests.id, req.id));
    return issueOtp(tx, { phone: req.newPhone, purpose: "change_phone", accountId: cctx.accountId, meta: { now: cctx.now }, tenantId: cctx.tenantId });
  };
  return opts.tx ? run(opts.tx) : withTx(run);
}

export type PhoneChange = { oldPhone: string; newPhone: string };

/**
 * Langkah 3: kode dari nomor BARU benar → nomor akun diganti; sesi lain dicabut; `apply` (pemanggil: accounts.ts)
 * memperbarui nomor WA pelanggan M1 di transaksi yang sama.
 */
export async function verifyNewPhone(
  cctx: CustomerContext,
  input: { code: string },
  apply: (tx: Tx, change: PhoneChange) => Promise<void>,
  opts: { tx?: Tx } = {},
): Promise<PhoneChange> {
  const data = parseInput(z.object({ code: codeSchema }), input, { code: "Kode verifikasi" });
  const req = await (opts.tx ? openPhoneChange(opts.tx, cctx) : withTx((tx) => openPhoneChange(tx, cctx)));
  if (!req.oldVerifiedAt) throw new DomainError("OLD_PHONE_UNVERIFIED", "Verifikasi nomor lama dulu.");
  const outcome = await checkOtp(req.newPhone, ["change_phone"], data.code, cctx.now, opts.tx);
  if (!outcome.ok) fail(outcome);
  const run = async (tx: Tx): Promise<PhoneChange> => {
    if (await accountByPhone(tx, req.newPhone)) throw new ConflictError("PHONE_IN_USE", "Nomor baru sudah dipakai akun lain.");
    await tx.update(customerAccounts).set({ phone: req.newPhone, updatedAt: cctx.now }).where(eq(customerAccounts.id, cctx.accountId));
    await tx.update(phoneChangeRequests).set({ completedAt: cctx.now }).where(eq(phoneChangeRequests.id, req.id));
    await revokeAccountSessions(tx, cctx.accountId, cctx.now, cctx.sessionId);
    const change = { oldPhone: req.oldPhone, newPhone: req.newPhone };
    await apply(tx, change);
    return change;
  };
  return opts.tx ? run(opts.tx) : withTx(run);
}
