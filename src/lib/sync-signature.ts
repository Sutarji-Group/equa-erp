/**
 * Tanda tangan perintah sinkron lapangan (isomorfik — klien WebCrypto & server node:crypto; docs/ARCHITECTURE.md §7).
 *
 * Setiap perintah outbox terikat ke SESI PIN pengguna pemiliknya (`sessionId`) dan ditandatangani HMAC-SHA256 dengan
 * "kunci perintah" sesi itu. Kunci diberikan server saat login PIN daring, disimpan di perangkat TERBUNGKUS kunci
 * turunan PIN (PBKDF2 → AES-GCM) dan hanya dibuka (non-extractable) selama pengguna itu aktif & layar tidak terkunci.
 * Akibatnya pengguna lain di perangkat yang sama (kernet di ponsel truk, kasir lain di tablet) tidak dapat mengirim
 * perintah atas nama orang lain.
 *
 * Isi yang ditandatangani: versi, id, type, userId, sessionId, deviceTime (string mentah), businessDate, reboundFrom,
 * payload (JSON kanonik: kunci diurutkan, setelah JSON round-trip), dan pasangan `attachmentId:sha256` lampiran.
 */

export const COMMAND_SIGNATURE_VERSION = "equa-cmd-v1";

export type SignableCommand = {
  id: string;
  type: string;
  userId: string;
  sessionId: string;
  /** ISO string persis seperti dikirim klien. */
  deviceTime: string;
  businessDate: string;
  /** Sesi asal perintah bila diikat ulang ke sesi baru setelah login ulang (lihat `rebindOutbox`). */
  reboundFrom?: string | null;
  payload: unknown;
  attachmentIds?: readonly string[];
  /** SHA-256 hex isi lampiran, sejajar `attachmentIds`. */
  attachmentHashes?: readonly string[];
};

/** JSON kanonik: nilai di-round-trip JSON (Date → ISO, undefined dibuang), kunci objek diurutkan rekursif. */
export function canonicalJsonForSigning(value: unknown): string {
  const normalized: unknown = value === undefined ? null : JSON.parse(JSON.stringify(value) ?? "null");
  return canonical(normalized);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

/** String yang ditandatangani untuk satu perintah. */
export function commandSigningString(cmd: SignableCommand): string {
  const ids = cmd.attachmentIds ?? [];
  const hashes = cmd.attachmentHashes ?? [];
  const attachments = ids.map((id, i) => `${id}:${(hashes[i] ?? "").toLowerCase()}`).join(",");
  return [
    COMMAND_SIGNATURE_VERSION,
    cmd.id,
    cmd.type,
    cmd.userId,
    cmd.sessionId,
    cmd.deviceTime,
    cmd.businessDate,
    cmd.reboundFrom ?? "",
    canonicalJsonForSigning(cmd.payload ?? {}),
    attachments,
  ].join("\n");
}
