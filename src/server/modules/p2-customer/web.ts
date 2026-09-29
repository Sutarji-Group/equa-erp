/**
 * P2 — adaptor web aplikasi pelanggan (Server Component / Server Action / route handler): cookie sesi pelanggan
 * (`equa_pelanggan`, httpOnly, 30 hari), pelaku dari cookie, pengalihan ke masuk/daftar, metadata permintaan.
 * Terpisah dari `index.ts` karena memakai `next/headers` (bukan untuk modul lain / uji layanan).
 */
import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { serverEnv } from "@/lib/env";

import { withTx } from "@/server/core/db";
import { toUserMessage } from "@/server/core/errors";

import { isAppEnabled, type CustomerContext } from "./service/common";
import { resolveCustomerSession, type RequestMeta } from "./service/auth";
import { CUSTOMER_APP_TENANT_ID } from "./service/common";

export const CUSTOMER_COOKIE = "equa_pelanggan";

export async function customerToken(): Promise<string | null> {
  return (await cookies()).get(CUSTOMER_COOKIE)?.value ?? null;
}

export async function setCustomerCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(CUSTOMER_COOKIE, token, {
    httpOnly: true,
    secure: serverEnv().NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearCustomerCookie(): Promise<void> {
  (await cookies()).delete(CUSTOMER_COOKIE);
}

export async function customerRequestMeta(now: Date = new Date()): Promise<RequestMeta> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  return { now, ip: fwd || h.get("x-real-ip"), userAgent: h.get("user-agent")?.slice(0, 300) ?? null, tenantId: CUSTOMER_APP_TENANT_ID };
}

/** Pelanggan dari cookie (null bila belum masuk / sesi habis). */
export async function getCustomer(now: Date = new Date()): Promise<CustomerContext | null> {
  const token = await customerToken();
  if (!token) return null;
  return withTx((tx) => resolveCustomerSession(tx, token, now));
}

export async function appEnabled(): Promise<boolean> {
  return withTx((tx) => isAppEnabled(tx, CUSTOMER_APP_TENANT_ID));
}

/**
 * Pelanggan wajib masuk. `linked` (bawaan) = wajib sudah terhubung ke data pelanggan; bila belum → /app/daftar
 * (lengkapi pendaftaran / menunggu verifikasi).
 */
export async function requireCustomer(opts: { linked?: boolean; next?: string } = {}): Promise<CustomerContext> {
  const cctx = await getCustomer();
  if (!cctx) redirect(`/app/masuk${opts.next ? `?lanjut=${encodeURIComponent(opts.next)}` : ""}`);
  if ((opts.linked ?? true) && (!cctx.consentGiven || cctx.status !== "linked" || !cctx.customerId)) redirect("/app/daftar");
  return cctx;
}

/** Pelaku untuk route handler JSON/berkas: null → 401. */
export async function customerForRoute(): Promise<CustomerContext | null> {
  const cctx = await getCustomer();
  if (!cctx || cctx.status !== "linked" || !cctx.customerId) return null;
  return cctx;
}

export type CustomerActionState = { ok?: boolean; error?: string; message?: string; data?: Record<string, unknown> };

/** Jalankan aksi & ubah galat layanan menjadi pesan Indonesia apa adanya (tanpa kode teknis). */
export async function attemptCustomer(fn: () => Promise<string | void | CustomerActionState>, success?: string): Promise<CustomerActionState> {
  try {
    const res = await fn();
    if (res && typeof res === "object") return { ok: true, ...res };
    return { ok: true, message: typeof res === "string" ? res : success };
  } catch (error) {
    // redirect()/notFound() Next harus diteruskan.
    if (error && typeof error === "object" && "digest" in error && typeof (error as { digest?: unknown }).digest === "string" && String((error as { digest: string }).digest).startsWith("NEXT_")) throw error;
    return { ok: false, error: toUserMessage(error) };
  }
}
