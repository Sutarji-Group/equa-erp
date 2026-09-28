/**
 * Perlindungan CSRF untuk permintaan berkuki (cookie `equa_session` SameSite=Lax tetap terkirim pada navigasi GET
 * lintas situs). Dipakai route yang punya efek samping walau GET (mis. ekspor menulis `export_logs` + log akses BR-39).
 *
 * - `Sec-Fetch-Site` (semua peramban modern): hanya `same-origin` atau `none` (diketik/bookmark pengguna) yang diterima.
 * - Tanpa header itu: `Origin`/`Referer` (bila ada) wajib ber-host sama.
 * - Permintaan bertoken perangkat (`Authorization: Bearer`) tidak memakai kuki → tidak diperiksa.
 */
import "server-only";

import { ForbiddenError } from "./errors";

/** Benar bila permintaan berasal dari situs lain (dan memakai kuki). */
export function isCrossSiteRequest(request: Request): boolean {
  const headers = request.headers;
  if (/^Bearer\s/i.test(headers.get("authorization") ?? "")) return false;
  const site = headers.get("sec-fetch-site");
  if (site) return !(site === "same-origin" || site === "none");
  let host: string;
  try {
    host = headers.get("x-forwarded-host") ?? headers.get("host") ?? new URL(request.url).host;
  } catch {
    return true;
  }
  for (const name of ["origin", "referer"]) {
    const value = headers.get(name);
    if (!value || value === "null") {
      if (value === "null") return true;
      continue;
    }
    try {
      return new URL(value).host !== host;
    } catch {
      return true;
    }
  }
  return false;
}

/** Lempar `ForbiddenError` bila permintaan lintas situs. */
export function assertSameOrigin(request: Request): void {
  if (isCrossSiteRequest(request)) {
    throw new ForbiddenError("Permintaan ini harus dimulai dari halaman EQUA. Buka menunya lalu ulangi dari sana.", { rule: "CSRF" });
  }
}
