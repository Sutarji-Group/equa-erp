/**
 * Ubah kata sandi MANDIRI pengguna web (kantor & portal mitra) dan kewajiban ganti kata sandi (B-08; US-M10-02 KP-4,
 * 7.10.6, NFR-09). Tambahan S5 (berkas baru di inti — hanya tambah).
 *
 * - `users.must_change_password = true` (kata sandi sementara hasil reset admin sistem `m10.resetPassword`, atau akun
 *   baru ber-kata sandi awal) → sesi web tetap sah untuk halaman `/akun/kata-sandi`, tetapi halaman kantor/portal
 *   dialihkan ke sana (`requireOfficeSession`, `requirePortalSession`) dan API web menolak pelaku (`webActorFromToken`).
 * - `changeOwnPassword(token, input)` — kata sandi saat ini wajib benar; kata sandi baru ≥ 10 karakter
 *   (`validateNewPassword`), berbeda dari yang lama & dari nama pengguna; konfirmasi sama. Berhasil → hash baru,
 *   `must_change_password = false`, sesi web LAIN dicabut (sesi ini tetap), jejak audit + log akses `password_changed`.
 *   Kata sandi saat ini salah → log akses gagal + hitungan gagal PAR-36 (akun terkunci bila melampaui).
 */
import "server-only";

import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { users } from "@/db/schema";
import { toBusinessDate } from "@/lib/time";

import { logAccess } from "../access-log";
import { buildActorContext } from "../actor";
import { record as auditRecord } from "../audit";
import { getDb, withTx, type Tx } from "../db";
import { ValidationError } from "../errors";
import { get as getParam } from "../params-read";
import { AuthError } from "./errors";
import { hashPassword, MIN_PASSWORD_LENGTH, validateNewPassword, verifySecretHash } from "./password";
import { isPending2fa } from "./resolver";
import { revokeAllSessions, validateSession } from "./session";
import type { RequestMeta } from "./web-login";

/** Halaman ubah kata sandi mandiri (di luar kerangka kantor/portal; lihat `src/app/(auth)/akun/kata-sandi`). */
export const CHANGE_PASSWORD_PATH = "/akun/kata-sandi";
/** Tujuan pengalihan bila kata sandi WAJIB diganti sebelum memakai aplikasi. */
export const FORCED_CHANGE_PASSWORD_URL = `${CHANGE_PASSWORD_PATH}?wajib=1`;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, { error: "Isi kata sandi saat ini." }).max(200),
  newPassword: z.string().max(200, { error: "Kata sandi terlalu panjang (maksimal 200 karakter)." }),
  confirmPassword: z.string().max(200),
});

export type ChangePasswordInput = z.input<typeof changePasswordSchema>;

/** Benar bila pengguna wajib mengganti kata sandi sebelum memakai web kantor/portal. */
export async function passwordChangeRequired(tx: Tx, userId: string): Promise<boolean> {
  const [row] = await tx.select({ must: users.mustChangePassword }).from(users).where(eq(users.id, userId)).limit(1);
  return !!row?.must;
}

function fieldError(field: string, message: string): never {
  throw ValidationError.field(field, message);
}

/**
 * Ganti kata sandi sendiri dari sesi web yang sah (sudah lolos 2FA bila perannya wajib 2FA). Mengembalikan jumlah sesi
 * web lain yang dicabut.
 */
export async function changeOwnPassword(token: string | null | undefined, input: ChangePasswordInput, meta: RequestMeta = {}): Promise<{ userId: string; sessionsRevoked: number }> {
  const now = meta.now ?? new Date();
  const parsed = changePasswordSchema.safeParse(input ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fieldError(String(issue?.path[0] ?? "newPassword"), issue?.message ?? "Periksa isian kata sandi.");
  }
  const data = parsed.data;
  const outcome = await withTx(async (tx) => {
    const v = await validateSession(tx, token, { kind: "web", now });
    if (!v.ok) throw new AuthError("SESSION_EXPIRED", "Sesi Anda sudah berakhir. Silakan masuk lagi.");
    const ctx = await buildActorContext(tx, v.user.id, { source: "web", now });
    if (isPending2fa(ctx, v.session)) throw new AuthError("SESSION_REQUIRED", "Selesaikan verifikasi 2 langkah dulu sebelum mengganti kata sandi.");
    const [user] = await tx.select().from(users).where(eq(users.id, v.user.id)).limit(1);
    if (!user) throw new AuthError("SESSION_EXPIRED", "Silakan masuk lagi.");
    const logBase = { tenantId: user.tenantId, userId: user.id, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null, occurredAt: now };

    if (!(await verifySecretHash(user.passwordHash, data.currentPassword))) {
      // Hitungan gagal kata sandi yang sama dengan login (PAR-36) — menahan tebakan lewat sesi yang tertinggal.
      const { max_attempts, lock_minutes } = await getParam(tx, "PAR-36", toBusinessDate(now));
      const [row] = await tx
        .update(users)
        .set({ failedLoginCount: sql`${users.failedLoginCount} + 1`, updatedAt: now })
        .where(eq(users.id, user.id))
        .returning({ n: users.failedLoginCount });
      const locked = Number(row?.n ?? 0) >= max_attempts;
      if (locked) {
        await tx
          .update(users)
          .set({ failedLoginCount: 0, lockedUntil: new Date(now.getTime() + lock_minutes * 60_000), updatedAt: now })
          .where(eq(users.id, user.id));
        await revokeAllSessions(user.id, "admin", { tx, now, kind: "web" });
      }
      await logAccess(tx, { ...logBase, event: "password_changed", success: false, reason: locked ? "Kata sandi saat ini salah — akun dikunci (PAR-36)" : "Kata sandi saat ini salah" });
      return { error: locked ? new AuthError("ACCOUNT_LOCKED", "Terlalu banyak percobaan salah. Akun dikunci sementara; masuk lagi nanti atau hubungi admin sistem.") : ValidationError.field("currentPassword", "Kata sandi saat ini salah.") };
    }
    try {
      validateNewPassword(data.newPassword);
    } catch {
      return { error: ValidationError.field("newPassword", `Kata sandi baru minimal ${MIN_PASSWORD_LENGTH} karakter.`) };
    }
    if (data.newPassword !== data.confirmPassword) return { error: ValidationError.field("confirmPassword", "Konfirmasi kata sandi baru tidak sama. Ketik ulang.") };
    if (data.newPassword === data.currentPassword) return { error: ValidationError.field("newPassword", "Kata sandi baru harus berbeda dari kata sandi saat ini.") };
    if (data.newPassword.trim().toLowerCase() === user.username.trim().toLowerCase()) {
      return { error: ValidationError.field("newPassword", "Kata sandi tidak boleh sama dengan nama pengguna.") };
    }

    const hash = await hashPassword(data.newPassword);
    const forced = user.mustChangePassword;
    await tx
      .update(users)
      .set({ passwordHash: hash, passwordChangedAt: now, mustChangePassword: false, failedLoginCount: 0, lockedUntil: null, updatedAt: now })
      .where(eq(users.id, user.id));
    const revoked = await revokeAllSessions(user.id, "replaced", { tx, now, kind: "web", exceptSessionId: v.session.id, actorUserId: user.id });
    await auditRecord(tx, {
      ctx: { ...ctx, now },
      objectType: "user",
      objectId: user.id,
      action: "update",
      before: { mustChangePassword: forced },
      after: { passwordChanged: true, mustChangePassword: false, otherSessionsRevoked: revoked },
      reason: forced ? "Ganti kata sandi sementara (wajib setelah reset)" : "Ubah kata sandi mandiri",
      rule: "US-M10-02 KP-4",
    });
    await logAccess(tx, { ...logBase, event: "password_changed", success: true, details: { sessionId: v.session.id, forced, otherSessionsRevoked: revoked } });
    return { userId: user.id, sessionsRevoked: revoked };
  });
  if ("error" in outcome) throw outcome.error;
  return outcome;
}

/** Status untuk halaman ubah kata sandi (tanpa melempar): pengguna, wajib ganti, antarmuka tujuan setelah selesai. */
export async function passwordPageState(token: string | null | undefined, now = new Date()): Promise<{ userId: string; username: string; mustChange: boolean; home: "/beranda" | "/mitra" } | null> {
  const db = getDb();
  const v = await validateSession(db, token, { kind: "web", now });
  if (!v.ok) return null;
  let ctx;
  try {
    ctx = await buildActorContext(db, v.user.id, { source: "web", now });
  } catch {
    return null;
  }
  if (!ctx.roles.length || isPending2fa(ctx, v.session)) return null;
  const mustChange = await passwordChangeRequired(db, v.user.id);
  return { userId: v.user.id, username: v.user.username, mustChange, home: ctx.roles.includes("partner_owner") ? "/mitra" : "/beranda" };
}
