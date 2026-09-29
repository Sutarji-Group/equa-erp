/**
 * Muatan Web Push → notifikasi perangkat (B-68; PTB-05, US-P2-03 KP-4, 6.3). Isomorfik & murni: dipakai service worker
 * `src/app/sw.ts` (event `push` / `notificationclick`) dan diuji tanpa peramban.
 *
 * Bentuk muatan server = `PushPayload` (`src/server/core/notifications/channels/webpush.ts`): `{ title, body?, url?,
 * tag?, severity? }` — dikirim kanal notifikasi inti (pengguna lapangan & kantor) dan P2 (pelanggan aplikasi).
 * Tautan HANYA jalur relatif asal yang sama (tanpa pengalihan terbuka ke situs lain).
 */

export type PushNotificationPayload = {
  title?: unknown;
  body?: unknown;
  url?: unknown;
  tag?: unknown;
  severity?: unknown;
};

export type BuiltPushNotification = {
  title: string;
  options: {
    body?: string;
    tag?: string;
    icon: string;
    badge: string;
    lang: string;
    requireInteraction: boolean;
    data: { url: string };
  };
};

const DEFAULT_TITLE = "EQUA";
const ICON = "/icons/icon-192.png";

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t ? t.slice(0, max) : undefined;
}

/**
 * Tautan tujuan saat notifikasi diketuk: hanya jalur relatif (`/…`, bukan `//…`) atau URL absolut ber-origin sama;
 * selain itu → `/` (beranda sesuai sesi).
 */
export function safeNotificationPath(url: unknown, origin: string): string {
  if (typeof url !== "string" || !url.trim()) return "/";
  const raw = url.trim();
  try {
    const base = new URL(origin);
    const target = new URL(raw, base);
    if (target.origin !== base.origin) return "/";
    if (raw.startsWith("//")) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}

/** Urai data push (JSON; teks biasa → isi pesan) menjadi judul & opsi `showNotification`. */
export function buildPushNotification(raw: string | null | undefined, origin: string): BuiltPushNotification {
  let payload: PushNotificationPayload = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      payload = parsed && typeof parsed === "object" ? (parsed as PushNotificationPayload) : { body: String(parsed) };
    } catch {
      payload = { body: raw };
    }
  }
  const critical = payload.severity === "critical" || payload.severity === "high";
  const tag = text(payload.tag, 120);
  return {
    title: text(payload.title, 120) ?? DEFAULT_TITLE,
    options: {
      ...(text(payload.body, 500) ? { body: text(payload.body, 500) } : {}),
      ...(tag ? { tag } : {}),
      icon: ICON,
      badge: ICON,
      lang: "id",
      // Kritis/tinggi (6.3) tetap tampil sampai disentuh.
      requireInteraction: critical,
      data: { url: safeNotificationPath(payload.url, origin) },
    },
  };
}
