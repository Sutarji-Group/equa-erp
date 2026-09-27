import { describe, expect, it } from "vitest";

import { assertRupiahInteger, formatRupiah, parseRupiah, zRupiah, zRupiahNonNegative, zRupiahPositive } from "@/lib/money";

describe("lib/money — rupiah integer", () => {
  it("formatRupiah memakai titik ribuan dan awalan Rp", () => {
    expect(formatRupiah(1_250_000)).toBe("Rp 1.250.000");
    expect(formatRupiah(0)).toBe("Rp 0");
    expect(formatRupiah(999)).toBe("Rp 999");
    expect(formatRupiah(-5_000)).toBe("-Rp 5.000");
    expect(formatRupiah(5_000, { signed: true })).toBe("+Rp 5.000");
    expect(formatRupiah(1_250_000, { prefix: false })).toBe("1.250.000");
    expect(formatRupiah(1_000.6)).toBe("Rp 1.001");
    expect(formatRupiah(Number.NaN)).toBe("Rp -");
  });

  it("parseRupiah menerima format umum", () => {
    expect(parseRupiah("Rp 1.250.000")).toBe(1_250_000);
    expect(parseRupiah("Rp1.250.000")).toBe(1_250_000);
    expect(parseRupiah("1.250.000")).toBe(1_250_000);
    expect(parseRupiah("1250000")).toBe(1_250_000);
    expect(parseRupiah(" 1.250.000,00 ")).toBe(1_250_000);
    expect(parseRupiah("-Rp 5.000")).toBe(-5_000);
    expect(parseRupiah("Rp -5.000")).toBe(-5_000);
    expect(parseRupiah("(5.000)")).toBe(-5_000);
    expect(parseRupiah("0")).toBe(0);
    expect(parseRupiah(15000)).toBe(15_000);
  });

  it("parseRupiah menolak masukan tidak valid", () => {
    expect(parseRupiah("")).toBeNull();
    expect(parseRupiah("abc")).toBeNull();
    expect(parseRupiah("1.000,50")).toBeNull();
    expect(parseRupiah("1.25.000")).toBeNull();
    expect(parseRupiah("1,250,000")).toBeNull();
    expect(parseRupiah("99999999999999999999")).toBeNull();
    expect(parseRupiah(10.5)).toBeNull();
    expect(parseRupiah(null)).toBeNull();
  });

  it("formatRupiah ∘ parseRupiah bolak-balik", () => {
    for (const n of [0, 1, 999, 1000, 19_000, 1_250_000, 987_654_321, -42_000]) {
      expect(parseRupiah(formatRupiah(n))).toBe(n);
    }
  });

  it("assertRupiahInteger melempar RangeError berbahasa Indonesia", () => {
    expect(() => assertRupiahInteger(1000)).not.toThrow();
    expect(() => assertRupiahInteger(10.5, "Harga")).toThrow("Harga harus berupa bilangan bulat rupiah");
    expect(() => assertRupiahInteger("1000")).toThrow(RangeError);
    expect(() => assertRupiahInteger(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });

  it("skema Zod rupiah", () => {
    expect(zRupiah.safeParse(-100).success).toBe(true);
    expect(zRupiah.safeParse(1.5).success).toBe(false);
    expect(zRupiahNonNegative.safeParse(0).success).toBe(true);
    expect(zRupiahNonNegative.safeParse(-1).success).toBe(false);
    expect(zRupiahPositive.safeParse(0).success).toBe(false);
    const r = zRupiahPositive.safeParse(0);
    expect(r.success ? "" : r.error.issues[0]?.message).toBe("Jumlah rupiah harus lebih dari nol.");
  });
});
