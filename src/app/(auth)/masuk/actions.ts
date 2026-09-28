"use server";

import { redirect } from "next/navigation";

import { confirmTotpEnrollment, loginWithPassword, logout, verifyTotpLogin } from "@/server/core/auth";
import { clearSessionCookie, currentSessionToken, getRequestMeta, safeNextPath, setSessionCookie } from "@/server/core/auth/office";
import { DomainError, toUserMessage } from "@/server/core/errors";

export type ActionResult = { error: string } | undefined;

function failure(error: unknown): { error: string } {
  if (!(error instanceof DomainError)) console.error("[equa] galat masuk:", error);
  return { error: toUserMessage(error) };
}

/** Langkah 1 masuk web kantor: nama pengguna + kata sandi (US-M10-02 KP-4). */
export async function loginAction(values: { username: string; password: string }, next?: string | null): Promise<ActionResult> {
  let step: "done" | "totp" | "totp_enroll";
  try {
    const res = await loginWithPassword({ username: values?.username ?? "", password: values?.password ?? "" }, await getRequestMeta());
    await setSessionCookie(res.token);
    step = res.next;
  } catch (error) {
    return failure(error);
  }
  if (step === "done") redirect(safeNextPath(next));
  redirect(step === "totp" ? "/masuk/2fa" : "/masuk/atur-2fa");
}

/** Langkah 2FA: verifikasi kode TOTP. */
export async function verifyTotpAction(code: string): Promise<ActionResult> {
  try {
    await verifyTotpLogin((await currentSessionToken()) ?? "", code, await getRequestMeta());
  } catch (error) {
    return failure(error);
  }
  redirect("/beranda");
}

/** Pendaftaran 2FA: kode pertama dari aplikasi autentikator. */
export async function confirmEnrollmentAction(code: string): Promise<ActionResult> {
  try {
    await confirmTotpEnrollment((await currentSessionToken()) ?? "", code, await getRequestMeta());
  } catch (error) {
    return failure(error);
  }
  redirect("/beranda");
}

/** Batalkan langkah 2FA / keluar. */
export async function cancelLoginAction(): Promise<void> {
  try {
    await logout(await currentSessionToken(), await getRequestMeta());
  } finally {
    await clearSessionCookie();
  }
  redirect("/masuk");
}
