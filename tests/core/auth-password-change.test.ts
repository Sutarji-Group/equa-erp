import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { accessLogs, auditLogs, sessions, users } from "@/db/schema";
import type { RoleCode } from "@/lib/labels";
import { AuthError, changeOwnPassword, hashPassword, loginWithPassword, passwordChangeRequired, passwordPageState, validateSession, webActorFromToken } from "@/server/core/auth";
import { ValidationError } from "@/server/core/errors";
import { resetPassword } from "@/server/modules/m10-access";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { createTestUser } from "../helpers/factories";

const t = useTestDb({ seed: true });
beforeAll(() => bootstrapForTests());

async function userWithPassword(role: RoleCode, password = "kata-sandi-lama-1") {
  const u = await createTestUser(t.db, { role });
  await t.db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, u.userId));
  const [row] = await t.db.select({ username: users.username }).from(users).where(eq(users.id, u.userId));
  return { ...u, username: row!.username, password };
}

async function fieldIssue(p: Promise<unknown>): Promise<string | undefined> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ValidationError);
  return (err as ValidationError).issues[0]?.path;
}

describe("B-08 ubah kata sandi mandiri & wajib ganti kata sandi sementara", () => {
  it("B-08 US-M10-02 KP-4 kata sandi sementara (reset admin sistem) → sesi web tidak menghasilkan pelaku sampai diganti; setelah diganti normal", async () => {
    const u = await userWithPassword("dispatcher");
    const reset = await resetPassword(seededContext("admin1"), { userId: u.userId, reason: "Lupa kata sandi (uji)" });
    expect(await passwordChangeRequired(t.db, u.userId)).toBe(true);

    const login = await loginWithPassword({ username: u.username, password: reset.temporaryPassword });
    expect(login.next).toBe("done");
    // Web kantor & API: pelaku ditolak selama kata sandi sementara belum diganti.
    expect(await webActorFromToken(login.token)).toBeNull();
    const page = await passwordPageState(login.token);
    expect(page).toMatchObject({ userId: u.userId, mustChange: true, home: "/beranda" });

    await changeOwnPassword(login.token, { currentPassword: reset.temporaryPassword, newPassword: "sandi-baru-aman-2026", confirmPassword: "sandi-baru-aman-2026" });
    expect(await passwordChangeRequired(t.db, u.userId)).toBe(false);
    expect((await webActorFromToken(login.token))?.roles).toEqual(["dispatcher"]);
    // Kata sandi sementara tidak berlaku lagi; yang baru berlaku.
    await expect(loginWithPassword({ username: u.username, password: reset.temporaryPassword })).rejects.toBeInstanceOf(AuthError);
    expect((await loginWithPassword({ username: u.username, password: "sandi-baru-aman-2026" })).next).toBe("done");

    const trail = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "user"), eq(auditLogs.objectId, u.userId)));
    expect(trail.some((a) => (a.after as Record<string, unknown> | null)?.passwordChanged === true)).toBe(true);
    const logs = await t.db.select().from(accessLogs).where(and(eq(accessLogs.userId, u.userId), eq(accessLogs.event, "password_changed")));
    expect(logs.some((l) => l.success && (l.details as { forced?: boolean } | null)?.forced === true)).toBe(true);
  });

  it("B-08 US-M10-02 KP-4 ubah mandiri (semua pengguna web): sesi web LAIN dicabut, sesi ini tetap; aturan kata sandi baru ditolak dengan pesan tindakan", async () => {
    const u = await userWithPassword("dispatcher");
    const a = await loginWithPassword({ username: u.username, password: u.password });
    const b = await loginWithPassword({ username: u.username, password: u.password });

    expect(await fieldIssue(changeOwnPassword(a.token, { currentPassword: "salah-sekali", newPassword: "sandi-baru-aman-1", confirmPassword: "sandi-baru-aman-1" }))).toBe("currentPassword");
    expect(await fieldIssue(changeOwnPassword(a.token, { currentPassword: u.password, newPassword: "pendek", confirmPassword: "pendek" }))).toBe("newPassword");
    expect(await fieldIssue(changeOwnPassword(a.token, { currentPassword: u.password, newPassword: "sandi-baru-aman-1", confirmPassword: "sandi-baru-aman-2" }))).toBe("confirmPassword");
    expect(await fieldIssue(changeOwnPassword(a.token, { currentPassword: u.password, newPassword: u.password, confirmPassword: u.password }))).toBe("newPassword");
    expect(await fieldIssue(changeOwnPassword(a.token, { currentPassword: u.password, newPassword: u.username, confirmPassword: u.username }))).toBe("newPassword");

    const res = await changeOwnPassword(a.token, { currentPassword: u.password, newPassword: "sandi-baru-aman-1", confirmPassword: "sandi-baru-aman-1" });
    expect(res.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect((await validateSession(t.db, a.token, { kind: "web" })).ok).toBe(true);
    const other = await validateSession(t.db, b.token, { kind: "web" });
    expect(other.ok).toBe(false);
    const [revoked] = await t.db.select({ reason: sessions.revokeReason }).from(sessions).where(eq(sessions.id, b.sessionId));
    expect(revoked!.reason).toBe("replaced");
    // Percobaan kata sandi saat ini yang salah tercatat gagal di log akses.
    const failed = await t.db.select().from(accessLogs).where(and(eq(accessLogs.userId, u.userId), eq(accessLogs.event, "password_changed"), eq(accessLogs.success, false)));
    expect(failed.length).toBe(1);
  });

  it("B-08 NFR-09 tanpa sesi / sesi menunggu 2FA tidak dapat mengubah kata sandi", async () => {
    await expect(changeOwnPassword(null, { currentPassword: "x", newPassword: "sandi-baru-aman-1", confirmPassword: "sandi-baru-aman-1" })).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    const fa = await userWithPassword("finance_admin");
    const pending = await loginWithPassword({ username: fa.username, password: fa.password });
    expect(pending.next).not.toBe("done");
    await expect(changeOwnPassword(pending.token, { currentPassword: fa.password, newPassword: "sandi-baru-aman-1", confirmPassword: "sandi-baru-aman-1" })).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
    expect(await passwordPageState(pending.token)).toBeNull();
  });
});
