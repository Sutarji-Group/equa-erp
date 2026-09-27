/**
 * Pembuat ID isomorfik (server & peramban). ID dibuat di perangkat untuk antrean offline (docs/ARCHITECTURE.md §7),
 * sehingga memakai UUID v7 (berurutan waktu → ramah indeks B-tree).
 */
import { v7 as uuidv7, validate as uuidValidate, version as uuidVersion } from "uuid";

/** UUID v7 baru, mis. `0192f1c4-7b7a-7cc2-9d7e-3f1b2a4c5d6e`. */
export function newId(): string {
  return uuidv7();
}

/** Benar bila `value` adalah UUID yang valid (versi apa pun). */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidValidate(value);
}

/** Benar bila `value` adalah UUID v7 yang valid. */
export function isUuidV7(value: unknown): value is string {
  return isUuid(value) && uuidVersion(value) === 7;
}

/** Stempel waktu (ms epoch) yang tertanam di UUID v7 — berguna untuk debugging antrean. */
export function uuidV7Timestamp(id: string): number {
  if (!isUuidV7(id)) throw new RangeError("ID bukan UUID v7 yang valid.");
  return parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}
