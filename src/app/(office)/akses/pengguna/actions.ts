"use server";

import { revalidatePath } from "next/cache";

import type { ActionState } from "@/components/m10-access/action-state";
import type { RoleCode } from "@/lib/labels";
import { formatTanggalJam } from "@/lib/time";
import { requireOfficeSession } from "@/server/core/auth/office";
import {
  createUser,
  deactivateUser,
  issueInitialPin,
  prepareInitialAccountsSignoff,
  requestReactivation,
  requestRoleChange,
  requestScopeExtension,
  resetPassword,
  resetPin,
  resetTwoFactor,
  revokeRole,
  revokeScope,
  signInitialAccounts,
} from "@/server/modules/m10-access";

import { bool, runAction, scopes, str } from "../_action";

function done(path: string, state: ActionState): ActionState {
  revalidatePath(path);
  return state;
}

/** Buat akun dari karyawan (US-M10-01 KP-2/KP-3/KP-8). */
export async function createUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  return runAction(async () => {
    const r = await createUser(ctx, {
      employeeId: str(formData, "employeeId") ?? "",
      username: str(formData, "username") ?? "",
      role: (str(formData, "role") ?? "") as RoleCode,
      scopes: scopes(formData),
      reason: str(formData, "reason") ?? "",
      initialLoad: bool(formData, "initialLoad"),
    });
    return done("/akses/pengguna", {
      ok: true,
      message: r.approval
        ? `Akun ${r.user.username} dibuat dan menunggu persetujuan pemilik (${r.approval.number}). Akun aktif setelah disetujui.`
        : `Akun awal ${r.user.username} dicatat. Aktif setelah daftar akun awal ditandatangani pemilik.`,
    });
  });
}

export async function prepareInitialAccountsAction(): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  return runAction(async () => {
    const s = await prepareInitialAccountsSignoff(ctx);
    return done("/akses/pengguna", { ok: true, message: `${s.title} siap ditandatangani pemilik.` });
  });
}

export async function signInitialAccountsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  return runAction(async () => {
    const r = await signInitialAccounts(ctx, str(formData, "signoffId") ?? "");
    return done("/akses/pengguna", { ok: true, message: `${r.activated} akun awal aktif sekaligus.` });
  });
}

export async function requestRoleChangeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const userId = str(formData, "userId") ?? "";
  return runAction(async () => {
    const r = await requestRoleChange(ctx, {
      userId,
      role: (str(formData, "role") ?? "") as RoleCode,
      mode: str(formData, "mode") === "add" ? "add" : "replace",
      validUntil: str(formData, "validUntil"),
      scopes: scopes(formData),
      reason: str(formData, "reason") ?? "",
    });
    return done(`/akses/pengguna/${userId}`, { ok: true, message: `Permintaan ${r.number} diajukan ke pemilik. Peran aktif setelah disetujui.` });
  });
}

export async function requestScopeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const userId = str(formData, "userId") ?? "";
  return runAction(async () => {
    const r = await requestScopeExtension(ctx, { userId, scopes: scopes(formData), validUntil: str(formData, "validUntil"), reason: str(formData, "reason") ?? "" });
    return done(`/akses/pengguna/${userId}`, { ok: true, message: `Perluasan lingkup ${r.number} diajukan ke pemilik.` });
  });
}

export async function revokeRoleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const userId = str(formData, "userId") ?? "";
  return runAction(async () => {
    await revokeRole(ctx, { userId, roleId: str(formData, "roleId") ?? "", reason: str(formData, "reason") ?? "" });
    return done(`/akses/pengguna/${userId}`, { ok: true, message: "Peran dicabut seketika (BR-37)." });
  });
}

export async function revokeScopeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const userId = str(formData, "userId") ?? "";
  return runAction(async () => {
    await revokeScope(ctx, { userId, scopeId: str(formData, "scopeId") ?? "", reason: str(formData, "reason") ?? "" });
    return done(`/akses/pengguna/${userId}`, { ok: true, message: "Lingkup dikurangi seketika." });
  });
}

export async function deactivateUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const userId = str(formData, "userId") ?? "";
  return runAction(async () => {
    const r = await deactivateUser(ctx, { userId, reason: str(formData, "reason") ?? "" });
    return done(`/akses/pengguna/${userId}`, {
      ok: true,
      message: `Akun dinonaktifkan. Sesi diputus: ${r.sessionsRevoked}; perangkat diblokir: ${r.devicesBlocked.length}.`,
    });
  });
}

export async function reactivateUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const userId = str(formData, "userId") ?? "";
  return runAction(async () => {
    const r = await requestReactivation(ctx, { userId, role: (str(formData, "role") ?? "") as RoleCode, scopes: scopes(formData), reason: str(formData, "reason") ?? "" });
    return done(`/akses/pengguna/${userId}`, { ok: true, message: `Permintaan aktif kembali ${r.number} diajukan ke pemilik.` });
  });
}

export async function resetPinAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const userId = str(formData, "userId") ?? "";
  return runAction(async () => {
    const r = await resetPin(ctx, { userId, reason: str(formData, "reason") ?? "" });
    return done(`/akses/pengguna/${userId}`, {
      ok: true,
      secret: { label: `Kode PIN baru untuk ${r.userName}`, value: r.displayCode, note: `Berlaku sampai ${formatTanggalJam(r.expiresAt)}. Pengguna memasukkan kode ini di perangkat lalu menetapkan PIN sendiri. Pemilik sudah diberi tahu.` },
    });
  });
}

export async function initialPinAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const userId = str(formData, "userId") ?? "";
  return runAction(async () => {
    const r = await issueInitialPin(ctx, { userId });
    return done(`/akses/pengguna/${userId}`, {
      ok: true,
      secret: { label: `Kode aktivasi akun lapangan ${r.userName}`, value: r.displayCode, note: `Berlaku sampai ${formatTanggalJam(r.expiresAt)}. Berikan di hadapan pengguna; ia menetapkan PIN 6 angka sendiri.` },
    });
  });
}

export async function resetPasswordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const userId = str(formData, "userId") ?? "";
  return runAction(async () => {
    const r = await resetPassword(ctx, { userId, reason: str(formData, "reason") ?? "" });
    return done(`/akses/pengguna/${userId}`, {
      ok: true,
      secret: { label: `Kata sandi sementara ${r.userName}`, value: r.temporaryPassword, note: "Serahkan langsung (bukan lewat chat). Wajib diganti saat masuk. Pemilik sudah diberi tahu." },
    });
  });
}

export async function resetTotpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const userId = str(formData, "userId") ?? "";
  return runAction(async () => {
    await resetTwoFactor(ctx, { userId, reason: str(formData, "reason") ?? "" });
    return done(`/akses/pengguna/${userId}`, { ok: true, message: "2FA direset; pengguna mendaftarkan ulang aplikasi autentikator saat masuk. Pemilik diberi tahu." });
  });
}
