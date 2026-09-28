/**
 * Ruang nama rute PWA lapangan vs web kantor (satu sumber untuk service worker & uji; docs/ARCHITECTURE.md §1, §9).
 *
 * - Rute lapangan (/sopir, /pos, /produksi, /aktivasi-perangkat, /~offline) boleh di-cache service worker dan memakai
 *   token perangkat, bukan cookie.
 * - `/produksi` dipakai bersama PWA operator produksi DAN subrute kantor M8 (neraca air, utilisasi, mutu). Subrute
 *   kantor M8 WAJIB didaftarkan di `OFFICE_ROUTES_UNDER_FIELD_PREFIX` (dan di matcher `src/proxy.ts`) — halaman kantor
 *   tidak boleh pernah di-cache di ponsel lapangan. Uji `tests/ui/field-routes.test.ts` gagal bila ada href nav kantor
 *   yang tergolong rute lapangan atau tidak dijaga proxy.
 *
 * Isomorfik & tanpa impor alias (dibundel esbuild untuk service worker).
 */

/** Awalan rute lapangan. */
export const FIELD_ROUTE_PREFIXES = ["sopir", "pos", "produksi", "aktivasi-perangkat", "~offline"] as const;

/** Subrute KANTOR di bawah awalan lapangan (M8 kantor). Tambah di sini + matcher `src/proxy.ts`. */
export const OFFICE_ROUTES_UNDER_FIELD_PREFIX = ["/produksi/neraca-air", "/produksi/utilisasi", "/produksi/mutu"] as const;

const FIELD_RE = new RegExp(`^/(${FIELD_ROUTE_PREFIXES.map((p) => p.replace(/[~-]/g, "\\$&")).join("|")})(/|$)`);

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Benar bila jalur termasuk PWA lapangan (bukan subrute kantor). */
export function isFieldPath(pathname: string): boolean {
  if (!FIELD_RE.test(pathname)) return false;
  return !OFFICE_ROUTES_UNDER_FIELD_PREFIX.some((p) => underPrefix(pathname, p));
}
