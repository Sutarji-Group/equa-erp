import { NextResponse } from "next/server";

import { logout, SESSION_COOKIE } from "@/server/core/auth";
import { requestIp } from "@/server/core/auth/device-auth";
import { readCookie } from "@/server/core/auth/resolver";

/** Keluar dari portal mitra (`POST /mitra/keluar`): cabut sesi, hapus cookie, kembali ke halaman masuk portal. */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  try {
    await logout(token, { ip: requestIp(request.headers), userAgent: request.headers.get("user-agent") });
  } catch (error) {
    console.error("[equa] gagal mencabut sesi portal saat keluar:", error);
  }
  const response = NextResponse.redirect(new URL("/mitra/masuk?alasan=keluar", request.url), 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
