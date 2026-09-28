import { NextResponse } from "next/server";

import { logout, SESSION_COOKIE } from "@/server/core/auth";
import { readCookie } from "@/server/core/auth/resolver";
import { requestIp } from "@/server/core/auth/device-auth";

/**
 * Keluar dari web kantor (`POST /keluar`, formulir menu pengguna OfficeShell): cabut sesi, hapus cookie, arahkan ke
 * /masuk dengan pesan.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  try {
    await logout(token, { ip: requestIp(request.headers), userAgent: request.headers.get("user-agent") });
  } catch (error) {
    console.error("[equa] gagal mencabut sesi saat keluar:", error);
  }
  const response = NextResponse.redirect(new URL("/masuk?alasan=keluar", request.url), 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
