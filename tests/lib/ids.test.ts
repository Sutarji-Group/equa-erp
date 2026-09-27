import { describe, expect, it } from "vitest";

import { isUuid, isUuidV7, newId, uuidV7Timestamp } from "@/lib/ids";

describe("lib/ids — UUID v7", () => {
  it("newId menghasilkan UUID v7 unik", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(isUuidV7(id)).toBe(true);
  });

  it("UUID v7 terurut menurut waktu pembuatan", () => {
    const a = newId();
    const b = newId();
    expect(a < b).toBe(true);
    const ts = uuidV7Timestamp(a);
    expect(Math.abs(ts - Date.now())).toBeLessThan(5_000);
  });

  it("isUuid / isUuidV7 memvalidasi", () => {
    expect(isUuid("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(true);
    expect(isUuidV7("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(false);
    expect(isUuid("bukan-uuid")).toBe(false);
    expect(isUuid(123)).toBe(false);
    expect(() => uuidV7Timestamp("bukan-uuid")).toThrow(RangeError);
  });
});
