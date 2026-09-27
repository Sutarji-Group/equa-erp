/**
 * Uang = integer rupiah (docs/DECISIONS.md D-04). Tidak ada pecahan sen.
 * Format tampilan: `Rp 1.250.000` (titik pemisah ribuan, spasi biasa setelah "Rp").
 */
import { z } from "zod";

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export type FormatRupiahOptions = {
  /** Tampilkan awalan "Rp " (bawaan `true`). */
  prefix?: boolean;
  /** Tampilkan tanda "+" untuk nilai positif (mis. selisih lebih). Bawaan `false`. */
  signed?: boolean;
};

/**
 * `1250000` → `"Rp 1.250.000"`; `-5000` → `"-Rp 5.000"`.
 * Nilai pecahan dibulatkan ke rupiah terdekat (tampilan tidak boleh gagal); validasi pakai `assertRupiahInteger`.
 */
export function formatRupiah(amount: number, options: FormatRupiahOptions = {}): string {
  const { prefix = true, signed = false } = options;
  if (!Number.isFinite(amount)) return prefix ? "Rp -" : "-";
  const rounded = Math.round(amount);
  const sign = rounded < 0 ? "-" : signed && rounded > 0 ? "+" : "";
  const body = groupThousands(String(Math.abs(rounded)));
  return `${sign}${prefix ? "Rp " : ""}${body}`;
}

/**
 * Urai masukan rupiah dari pengguna menjadi integer. Mengembalikan `null` bila tidak valid.
 * Diterima: `"Rp 1.250.000"`, `"1.250.000"`, `"1250000"`, `"-Rp 5.000"`, `"(5.000)"`, `"1.250.000,00"`.
 * Ditolak: pecahan bukan nol (`"1.000,50"`), huruf, pengelompokan titik yang salah (`"1.25.000"`), angka di luar
 * batas integer aman.
 */
export function parseRupiah(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return Number.isSafeInteger(input) ? input : null;

  let s = input.trim().replace(/\s+/g, "");
  if (s === "") return null;

  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }
  s = s.replace(/^rp\.?/i, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }

  // Bagian desimal (koma) hanya boleh nol.
  const commaParts = s.split(",");
  if (commaParts.length > 2) return null;
  const [intPart = "", decPart] = commaParts;
  if (decPart !== undefined && !/^0{1,2}$/.test(decPart)) return null;

  let digits: string;
  if (/^\d+$/.test(intPart)) {
    digits = intPart;
  } else if (/^\d{1,3}(\.\d{3})+$/.test(intPart)) {
    digits = intPart.replace(/\./g, "");
  } else {
    return null;
  }

  const value = Number(digits);
  if (!Number.isSafeInteger(value)) return null;
  return negative && value !== 0 ? -value : value;
}

/** Lempar `RangeError` bila `value` bukan integer rupiah yang aman. */
export function assertRupiahInteger(value: unknown, label = "Nilai uang"): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new RangeError(`${label} harus berupa bilangan bulat rupiah (tanpa desimal).`);
  }
}

/** Skema Zod untuk jumlah rupiah (integer aman, boleh negatif). */
export const zRupiah = z
  .number({ error: "Masukkan jumlah rupiah." })
  .int({ error: "Jumlah rupiah harus bilangan bulat." })
  .refine(Number.isSafeInteger, { error: "Jumlah rupiah terlalu besar." });

/** Skema Zod untuk jumlah rupiah ≥ 0. */
export const zRupiahNonNegative = zRupiah.refine((v) => v >= 0, { error: "Jumlah rupiah tidak boleh negatif." });

/** Skema Zod untuk jumlah rupiah > 0. */
export const zRupiahPositive = zRupiah.refine((v) => v > 0, { error: "Jumlah rupiah harus lebih dari nol." });
