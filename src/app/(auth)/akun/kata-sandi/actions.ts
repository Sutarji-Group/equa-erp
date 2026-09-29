"use server";

import { redirect } from "next/navigation";

import { changeOwnPassword, passwordPageState } from "@/server/core/auth";
import { currentSessionToken, getRequestMeta } from "@/server/core/auth/office";
import { DomainError, toUserMessage, ValidationError } from "@/server/core/errors";

export type ChangePasswordResult = { error: string; field?: "currentPassword" | "newPassword" | "confirmPassword" } | undefined;

const FIELDS = new Set(["currentPassword", "newPassword", "confirmPassword"]);

/** Ubah kata sandi mandiri (B-08): sukses → beranda kantor / portal mitra sesuai peran. */
export async function changePasswordAction(values: { currentPassword: string; newPassword: string; confirmPassword: string }): Promise<ChangePasswordResult> {
  const token = await currentSessionToken();
  let home: string = "/beranda";
  try {
    const state = await passwordPageState(token);
    if (!state) return { error: "Sesi Anda sudah berakhir. Silakan masuk lagi." };
    home = state.home;
    await changeOwnPassword(token, values ?? { currentPassword: "", newPassword: "", confirmPassword: "" }, await getRequestMeta());
  } catch (error) {
    if (!(error instanceof DomainError)) console.error("[equa] galat ubah kata sandi:", error);
    const path = error instanceof ValidationError ? error.issues[0]?.path : undefined;
    return { error: toUserMessage(error), ...(path && FIELDS.has(path) ? { field: path as "currentPassword" } : {}) };
  }
  redirect(`${home}?kata-sandi=diubah`);
}
