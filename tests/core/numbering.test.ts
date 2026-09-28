import { describe, expect, it } from "vitest";

import { withTx } from "@/server/core/db";
import { formatDocNumber, nextNumber, sequenceScopeKey, tripNumber } from "@/server/core/numbering";

import { useTestDb } from "../helpers/db";

describe("D-04 format nomor dokumen (murni)", () => {
  it("D-04 memformat semua jenis nomor dengan tahun WIB 2 digit", () => {
    expect(formatDocNumber("order", 123, "2027-03-01")).toBe("P-27-000123");
    expect(formatDocNumber("invoice", 1, "2026-09-28")).toBe("F-26-000001");
    expect(formatDocNumber("credit_note", 7, "2026-09-28")).toBe("NK-26-000007");
    expect(formatDocNumber("deposit", 45, "2026-09-28")).toBe("S-26-000045");
    expect(formatDocNumber("approval", 9, "2026-09-28")).toBe("A-26-000009");
    expect(formatDocNumber("purchase_receipt", 3, "2026-09-28")).toBe("NB-26-000003");
    expect(formatDocNumber("internal_transfer", 12, "2026-09-28")).toBe("TI-26-00012");
    expect(formatDocNumber("journal", 5, "2026-09-28")).toBe("J-2609-00005");
    expect(formatDocNumber("pos_sale", 42, "2026-09-28", { outletCode: "D01" })).toBe("D01-260928-0042");
  });

  it("US-M2-02 KP-1 nomor rit = nomor pesanan + urutan tangki", () => {
    expect(tripNumber("P-27-000123", 2)).toBe("P-27-000123/2");
    expect(() => tripNumber("X-1", 1)).toThrow();
  });

  it("D-04 tahun & tanggal mengikuti WIB, bukan UTC (31 Des 17.30 UTC = 1 Jan WIB)", () => {
    const instant = new Date("2026-12-31T17:30:00Z");
    expect(sequenceScopeKey("order", instant)).toBe("27");
    expect(sequenceScopeKey("pos_sale", instant, { outletCode: "TK1" })).toBe("TK1-270101");
    expect(sequenceScopeKey("journal", instant)).toBe("2701");
  });

  it("D-04 nomor POS wajib kode outlet", () => {
    expect(() => formatDocNumber("pos_sale", 1, "2026-09-28")).toThrow(/Kode outlet wajib/);
  });
});

describe("nextNumber (PGlite)", () => {
  const t = useTestDb();

  it("US-M2-02 KP-1 berurutan per tahun dan mulai ulang di tahun baru", async () => {
    const a = await withTx((tx) => nextNumber(tx, "order", "2026-05-01"));
    const b = await withTx((tx) => nextNumber(tx, "order", "2026-12-31"));
    const c = await withTx((tx) => nextNumber(tx, "order", "2027-01-01"));
    expect([a, b, c]).toEqual(["P-26-000001", "P-26-000002", "P-27-000001"]);
    expect(t.db).toBeDefined();
  });

  it("D-04 lingkup terpisah per jenis dan per outlet+tanggal", async () => {
    const inv = await withTx((tx) => nextNumber(tx, "invoice", "2026-05-01"));
    const pos1 = await withTx((tx) => nextNumber(tx, "pos_sale", "2026-05-01", { outletCode: "D01" }));
    const pos2 = await withTx((tx) => nextNumber(tx, "pos_sale", "2026-05-01", { outletCode: "D02" }));
    const pos3 = await withTx((tx) => nextNumber(tx, "pos_sale", "2026-05-01", { outletCode: "D01" }));
    expect(inv).toBe("F-26-000001");
    expect([pos1, pos2, pos3]).toEqual(["D01-260501-0001", "D02-260501-0001", "D01-260501-0002"]);
  });

  it("D-04 aman konkuren: 25 transaksi paralel mendapat nomor unik tanpa lubang", async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () => withTx((tx) => nextNumber(tx, "deposit", "2026-06-15"))),
    );
    expect(new Set(results).size).toBe(25);
    const seqs = results.map((n) => Number(n.split("-")[2])).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it("D-04 nomor dari transaksi yang rollback dipakai ulang (tidak ada lubang)", async () => {
    await expect(
      withTx(async (tx) => {
        await nextNumber(tx, "credit_note", "2026-07-01");
        throw new Error("batal");
      }),
    ).rejects.toThrow("batal");
    const n = await withTx((tx) => nextNumber(tx, "credit_note", "2026-07-01"));
    expect(n).toBe("NK-26-000001");
  });
});
