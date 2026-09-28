/**
 * URL halaman masuk & jalur lanjutan (murni, tanpa Next.js — dapat diuji). Dipakai `office.ts` & halaman /masuk.
 */
import type { SessionInvalidReason } from "./session";

/** Alasan (query `?alasan=`) di halaman masuk. */
export const LOGIN_REASON_MESSAGES: Record<string, string> = {
  "sesi-habis": "Sesi Anda berakhir karena tidak aktif. Silakan masuk lagi.",
  "sesi-maksimal": "Sesi Anda sudah mencapai batas waktu maksimal. Silakan masuk lagi.",
  "sesi-dicabut": "Sesi Anda diakhiri. Silakan masuk lagi.",
  "akun-nonaktif": "Akun Anda tidak aktif. Hubungi admin sistem.",
  keluar: "Anda sudah keluar. Sampai jumpa.",
  "perlu-masuk": "Silakan masuk untuk melanjutkan.",
};

export function reasonParam(reason: SessionInvalidReason): string | null {
  switch (reason) {
    case "expired_idle":
      return "sesi-habis";
    case "expired_max":
      return "sesi-maksimal";
    case "revoked":
      return "sesi-dicabut";
    case "user_inactive":
      return "akun-nonaktif";
    default:
      return null;
  }
}

/** URL halaman masuk dengan alasan (Bahasa Indonesia di `LOGIN_REASON_MESSAGES`). */
export function loginUrl(reason?: string | null): string {
  return reason ? `/masuk?alasan=${encodeURIComponent(reason)}` : "/masuk";
}

/** Jalur lanjutan aman (relatif, bukan ke halaman masuk). */
export function safeNextPath(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 500) return "/beranda";
  // Hanya jalur relatif di situs ini: tolak "//host", "/\\host", skema, karakter kendali, dan halaman masuk.
  if (!/^\/(?![\/\\])/.test(raw) || /[\\\u0000-\u001f]/.test(raw) || raw.startsWith("/masuk")) return "/beranda";
  return raw;
}
