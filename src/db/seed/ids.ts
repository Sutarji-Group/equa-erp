/**
 * ID deterministik untuk data seed agar seed IDEMPOTEN (insert … on conflict do nothing).
 * Bentuknya UUID v7 sah (versi 7, varian RFC 4122) dengan stempel waktu tetap 2025-01-01 sehingga `isUuidV7()` lulus
 * dan baris seed terurut sebelum data nyata. Hanya untuk data seed — data aplikasi memakai `newId()`.
 */
import { createHash } from "node:crypto";

const SEED_EPOCH_MS = BigInt(Date.UTC(2025, 0, 1));

/** UUID v7-berbentuk yang deterministik dari kunci alami, mis. `seedId("outlet:D01")`. */
export function seedId(key: string): string {
  const digest = createHash("sha256").update(`equa-seed:${key}`).digest();
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 6; i++) bytes[i] = Number((SEED_EPOCH_MS >> BigInt(8 * (5 - i))) & BigInt(0xff));
  digest.copy(bytes, 6, 0, 10);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
