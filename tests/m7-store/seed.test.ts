import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { internalTransfers, posSales, purchaseReceipts, reorderItems, stockBalances, stockLedger } from "@/db/schema";
import { EQUA_TENANT_ID, outletId, productId } from "@/db/seed";
import { DEMO_M7_SHIFT_ID, DEMO_M7_SUBSTITUTE_RECEIPT_ID, DEMO_M7_SUPPLIERS, seedDemoM7Store } from "@/db/seed/demo-m7-store";
import { getReorderList, getStoreStockCount, listPayables, listStoreItems, listStoreStockCounts, productPerformance } from "@/server/modules/m7-store";
import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";

const TK1 = outletId("TK1");

describe("seed demo M7 (toko TK1)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("kartu stok konsisten: saldo = Σ mutasi per barang; barang di bawah minimum masuk daftar pesan ulang", async () => {
    const sums = await t.db
      .select({ productId: stockLedger.productId, q: sql<string>`sum(${stockLedger.quantity})` })
      .from(stockLedger)
      .where(eq(stockLedger.outletId, TK1))
      .groupBy(stockLedger.productId);
    const balances = await t.db.select().from(stockBalances).where(eq(stockBalances.outletId, TK1));
    expect(balances.length).toBe(9);
    for (const b of balances) expect(Number(sums.find((s) => s.productId === b.productId)?.q)).toBe(b.quantity);
    const tisu = balances.find((b) => b.productId === productId("TK-TISU"))!;
    expect(tisu.quantity).toBe(900 + 1_000 - 5 - 100 - 20 - 300);
    const items = await listStoreItems(seededContext("pemilik"), { outletId: TK1 });
    expect(items.items.find((i) => i.code === "TK-LAMPU-UV")).toMatchObject({ balance: 2, belowMinimum: true });
    const reorder = await getReorderList(seededContext("keuangan1"), { outletId: TK1 });
    expect(reorder.rows.map((r) => [r.code, r.status]).sort()).toEqual([
      ["TK-FILTER-10", "open"],
      ["TK-GALON-KOSONG", "ordered"],
      ["TK-LAMPU-UV", "open"],
    ]);
  });

  it("utang pemasok per umur; nota pengganti menunggu; opname bulan lalu disetujui dengan selisih beralasan", async () => {
    const pay = await listPayables(seededContext("keuangan1"));
    const plastik = pay.bySupplier.find((s) => s.supplierId === DEMO_M7_SUPPLIERS.plastik)!;
    expect(plastik).toMatchObject({ total: 500_000, d1_7: 500_000 });
    const grosir = pay.bySupplier.find((s) => s.supplierId === DEMO_M7_SUPPLIERS.grosir)!;
    expect(grosir).toMatchObject({ total: 482_000 + 750_000, not_due: 482_000, d1_7: 750_000 });
    const [sub] = await t.db.select().from(purchaseReceipts).where(eq(purchaseReceipts.id, DEMO_M7_SUBSTITUTE_RECEIPT_ID));
    expect(sub).toMatchObject({ status: "pending_acceptance", isSubstituteNote: true });
    const counts = await listStoreStockCounts(seededContext("keuangan1"), { outletId: TK1 });
    expect(counts.rows).toHaveLength(1);
    const detail = await getStoreStockCount(seededContext("pemilik"), counts.rows[0]!.id);
    expect(detail.count.status).toBe("approved");
    expect(detail.lines.filter((l) => l.differenceQty !== 0)).toEqual([expect.objectContaining({ differenceQty: -5, reason: "damaged" })]);
  });

  it("shift kemarin ditutup dengan 7 transaksi (tunai/QRIS/tempo, diskon); laporan margin terisi; transfer ke D03 Dikirim", async () => {
    const sales = await t.db.select().from(posSales).where(eq(posSales.shiftId, DEMO_M7_SHIFT_ID));
    expect(sales).toHaveLength(7);
    expect(new Set(sales.map((s) => s.paymentMethod))).toEqual(new Set(["cash", "qris", "credit"]));
    expect(sales.filter((s) => s.discountAmount > 0)).toHaveLength(1);
    const month = sales[0]!.businessDate.slice(0, 7);
    const perf = await productPerformance(seededContext("pemilik"), { outletId: TK1, month });
    const uv = perf.rows.find((r) => r.code === "TK-LAMPU-UV")!;
    expect(uv).toMatchObject({ soldQty: 2, revenue: 270_000, cogs: 260_000, grossMargin: 10_000 });
    const [tr] = await t.db.select().from(internalTransfers).where(and(eq(internalTransfers.fromOutletId, TK1), eq(internalTransfers.tenantId, EQUA_TENANT_ID)));
    expect(tr).toMatchObject({ status: "sent", toOutletId: outletId("D03"), totalValue: 100 * 600 + 100 * 300 });
  });

  it("seed demo idempoten: dijalankan ulang tidak menambah data", async () => {
    const before = await t.db.select({ n: sql<number>`count(*)::int` }).from(stockLedger).where(eq(stockLedger.outletId, TK1));
    expect(await seedDemoM7Store(t.db)).toEqual({ created: false });
    const after = await t.db.select({ n: sql<number>`count(*)::int` }).from(stockLedger).where(eq(stockLedger.outletId, TK1));
    expect(after[0]!.n).toBe(before[0]!.n);
    expect((await t.db.select().from(reorderItems).where(eq(reorderItems.outletId, TK1))).length).toBe(3);
  });
});
