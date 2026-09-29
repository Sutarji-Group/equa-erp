import { NextResponse, type NextRequest } from "next/server";

/**
 * Proxy Next.js 16 (pengganti middleware; docs/ARCHITECTURE.md §6): HANYA pemeriksaan cookie ringan untuk rute web
 * kantor — tanpa cookie `equa_session` → arahkan ke /masuk?lanjut=<jalur>. Validasi sesi (tidak aktif/maksimal PAR-46,
 * 2FA, akun nonaktif) dan otorisasi selalu di lapisan server (`requireOfficeSession`, layanan `authorize`).
 * Rute lapangan (/sopir, /pos, /produksi, /aktivasi-perangkat) memakai token perangkat, bukan cookie.
 *
 * Portal pemilik mitra `/mitra/*` (D-11 butir 2, B-70): tanpa cookie → /mitra/masuk (login portal sendiri, bukan
 * login kantor); halaman publik portal (masuk, daftar calon mitra, keluar) dilewatkan. Pemeriksaan sesi portal yang
 * sebenarnya tetap di layout server (`requirePortalSession`).
 */
const PORTAL_PUBLIC_PATHS = ["/mitra/masuk", "/mitra/daftar", "/mitra/keluar"] as const;

function isPortalPath(path: string): boolean {
  return path === "/mitra" || path.startsWith("/mitra/");
}

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const portal = isPortalPath(path);
  if (portal && PORTAL_PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return NextResponse.next();
  if (request.cookies.get("equa_session")?.value) return NextResponse.next();
  const url = request.nextUrl.clone();
  if (portal) {
    url.pathname = "/mitra/masuk";
    url.search = "";
    return NextResponse.redirect(url);
  }
  const next = `${path}${request.nextUrl.search}`;
  url.pathname = "/masuk";
  url.search = `?lanjut=${encodeURIComponent(next)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Rute web kantor (docs/ARCHITECTURE.md §9). /produksi (beranda lapangan) sengaja tidak termasuk; hanya subrute
  // kantor M8.
  matcher: [
    "/beranda/:path*",
    "/kotak-masuk/:path*",
    "/persetujuan/:path*",
    "/notifikasi/:path*",
    "/pesanan/:path*",
    "/jadwal/:path*",
    "/langganan/:path*",
    "/sopir-kantor/:path*",
    "/kas/:path*",
    "/piutang/:path*",
    "/outlet/:path*",
    "/toko/:path*",
    "/produksi/neraca-air/:path*",
    "/produksi/utilisasi/:path*",
    "/produksi/mutu/:path*",
    "/produksi/pengisian/:path*",
    "/produksi/kelola-meter/:path*",
    "/armada/:path*",
    "/laporan/:path*",
    "/akuntansi/:path*",
    "/master/:path*",
    "/kemitraan/:path*",
    "/akses/:path*",
    "/audit/:path*",
    "/pengaturan/:path*",
    "/bantuan/:path*",
    // Tambahan modul P2 (hanya tambah): kotak keluhan & layar kantor aplikasi pelanggan.
    "/keluhan/:path*",
    // Tambahan S5 (B-70, D-11 butir 2): portal pemilik mitra — pengalihan cookie ringan ke /mitra/masuk.
    "/mitra/:path*",
    // Tambahan S5 (B-08): ubah kata sandi mandiri pengguna web (kantor & portal).
    "/akun/:path*",
  ],
};
