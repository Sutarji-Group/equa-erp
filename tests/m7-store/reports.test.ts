import { beforeAll, describe, expect, it } from "vitest";

import { customerId } from "@/db/seed";
import { NAV_GROUPS } from "@/components/shared/nav/registry";
import { newId } from "@/lib/ids";
import { addDays, toBusinessDate } from "@/lib/time";
import { getApprovalHandlers } from "@/server/core/approvals";
import { ForbiddenError } from "@/server/core/errors";
import { exportReport, listReports } from "@/server/core/export";
import { listJobs } from "@/server/core/jobs";
import { listPullProviders, listSyncHandlerTypes } from "@/server/core/sync";
import { hasPosKindPolicy, postStockMovement } from "@/server/modules/m6-pos";
import { partnerPurchases, productPerformance } from "@/server/modules/m7-store";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { accountant, expectApplied, finance, GENERAL, makeStore, openShiftVia, owner, PARTNER, sellVia, SP, stockUp } from "./helpers";

describe("US-M7-07 Laporan barang laris/mati dan margin per barang", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M7-07 KP-1 per barang per bulan: terjual, omzet (setelah diskon), harga pokok, margin kotor, hari tanpa penjualan, saldo & nilai; laris 30% teratas, mati ≥ PAR-66 hari", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [
      { productId: SP.FILTER, quantity: 10, unitCost: 25_000 },
      { productId: SP.GALON, quantity: 10, unitCost: 30_000 },
      { productId: SP.UV, quantity: 5, unitCost: 100_000 },
    ]);
    const today = toBusinessDate(new Date());
    // Pompa masuk stok 100 hari lalu dan tidak pernah terjual → "mati".
    const old = new Date(Date.now() - 100 * 86_400_000);
    await postStockMovement(t.db, { tenantId: pos.cashier.ctx.tenantId, outletId: pos.outletId, productId: SP.POMPA, kind: "opening", quantity: 4, unitCost: 15_000, businessDate: toBusinessDate(old), occurredAt: old, source: { type: "uji", id: newId() } });
    const shiftId = await openShiftVia(pos);
    expectApplied((await sellVia(pos, shiftId, [{ productId: SP.FILTER, quantity: 6, unitPrice: GENERAL.FILTER }])).res);
    expectApplied((await sellVia(pos, shiftId, [{ productId: SP.FILTER, quantity: 1, unitPrice: GENERAL.FILTER }], { discountAmount: 1_750, discountReason: "Pelanggan tetap" })).res);
    expectApplied((await sellVia(pos, shiftId, [{ productId: SP.GALON, quantity: 2, unitPrice: GENERAL.GALON }])).res);
    const rep = await productPerformance(owner(), { outletId: pos.outletId, month: today.slice(0, 7) });
    const by = new Map(rep.rows.map((r) => [r.productId, r]));
    expect(by.get(SP.FILTER)).toMatchObject({ soldQty: 7, revenue: 7 * 35_000 - 1_750, cogs: 7 * 25_000, grossMargin: 7 * 35_000 - 1_750 - 175_000, balance: 3, stockValue: 75_000, group: "fast", groupLabel: "Laris", daysWithoutSale: 0 });
    expect(by.get(SP.GALON)).toMatchObject({ soldQty: 2, revenue: 80_000, cogs: 60_000, grossMargin: 20_000, group: "normal" });
    expect(by.get(SP.POMPA)).toMatchObject({ soldQty: 0, balance: 4, stockValue: 60_000, group: "dead", groupLabel: "Mati" });
    expect(by.get(SP.POMPA)!.daysWithoutSale).toBeGreaterThanOrEqual(90);
    expect(by.get(SP.UV)).toMatchObject({ soldQty: 0, group: "normal", daysWithoutSale: 0 });
    expect(rep.deadDays).toBe(90);
    expect(rep.fastPercent).toBe(30);
    // Hanya pemilik (US-M7-07 "Sebagai Pemilik").
    await expect(productPerformance(finance(), { outletId: pos.outletId })).rejects.toBeInstanceOf(ForbiddenError);
    // Bulan lalu: saldo & nilai pada akhir bulan itu.
    const prevMonth = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
    const prev = await productPerformance(owner(), { outletId: pos.outletId, month: prevMonth });
    expect(prev.rows.find((r) => r.productId === SP.FILTER)).toMatchObject({ soldQty: 0, balance: 0 });
  });

  it("US-M7-07 KP-2 pembelian bulanan per pelanggan mitra (dasar paket mitra Bab 9)", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.TUTUP, quantity: 1000, unitCost: 400 }]);
    const shiftId = await openShiftVia(pos);
    const tempo = customerId("PLG-0001");
    const cash = customerId("PLG-0002");
    expectApplied((await sellVia(pos, shiftId, [{ productId: SP.TUTUP, quantity: 100, unitPrice: PARTNER.TUTUP }], { customerId: tempo, method: "credit" })).res);
    expectApplied((await sellVia(pos, shiftId, [{ productId: SP.TUTUP, quantity: 50, unitPrice: PARTNER.TUTUP }], { customerId: tempo })).res);
    expectApplied((await sellVia(pos, shiftId, [{ productId: SP.TUTUP, quantity: 20, unitPrice: PARTNER.TUTUP }], { customerId: cash, method: "qris" })).res);
    expectApplied((await sellVia(pos, shiftId, [{ productId: SP.TUTUP, quantity: 10, unitPrice: GENERAL.TUTUP }])).res);
    const rep = await partnerPurchases(accountant(), { outletId: pos.outletId });
    const by = new Map(rep.rows.map((r) => [r.customerId, r]));
    expect(by.get(tempo)).toMatchObject({ transactions: 2, total: 150 * PARTNER.TUTUP, credit: 100 * PARTNER.TUTUP, cash: 50 * PARTNER.TUTUP, isStorePartner: true });
    expect(by.get(cash)).toMatchObject({ transactions: 1, qris: 20 * PARTNER.TUTUP });
    expect(rep.rows).toHaveLength(2);
  });

  it("US-M7-07 KP-3 laporan toko diekspor Excel/PDF sesuai US-M9-03 (izin per laporan)", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.SIKAT, quantity: 5, unitCost: 10_000 }]);
    const month = toBusinessDate(new Date()).slice(0, 7);
    const perf = await exportReport(owner(), "m7.product_performance", "xlsx", { outletId: pos.outletId, month });
    expect(perf.rowCount).toBeGreaterThan(0);
    expect((await exportReport(owner(), "m7.product_performance", "pdf", { outletId: pos.outletId, month })).contentType).toBe("application/pdf");
    expect((await exportReport(accountant(), "m7.partner_purchases", "xlsx", { outletId: pos.outletId, month })).body.length).toBeGreaterThan(0);
    await expect(exportReport(finance(), "m7.product_performance", "xlsx", { month })).rejects.toBeInstanceOf(ForbiddenError);
    const keys = listReports()
      .map((r) => r.key)
      .filter((k) => k.startsWith("m7."));
    expect(keys.sort()).toEqual(
      [
        "m7.discounts",
        "m7.internal_transfers",
        "m7.items",
        "m7.partner_purchases",
        "m7.payables",
        "m7.payables_aging",
        "m7.product_performance",
        "m7.purchases",
        "m7.reorder",
        "m7.stock_card",
        "m7.stock_counts",
        "m7.supplier_payments",
        "m7.suppliers",
      ].sort(),
    );
    for (const key of ["m7.items", "m7.purchases", "m7.payables", "m7.payables_aging", "m7.supplier_payments", "m7.suppliers", "m7.discounts", "m7.internal_transfers"]) {
      const x = await exportReport(owner(), key, "xlsx", key === "m7.items" || key === "m7.purchases" || key === "m7.discounts" ? { outletId: pos.outletId } : {});
      expect(x.body.length, key).toBeGreaterThan(0);
    }
    const card = await exportReport(finance(), "m7.stock_card", "xlsx", { outletId: pos.outletId, productId: SP.SIKAT });
    expect(card.rowCount).toBe(1);
  });
});

describe("Registrasi modul M7 (kerangka POS, sinkron, persetujuan, job, menu)", () => {
  useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("B-05 kebijakan POS toko terpasang di kerangka M6; perintah & pull toko, persetujuan, job terdaftar", () => {
    expect(hasPosKindPolicy("store")).toBe(true);
    expect(listSyncHandlerTypes()).toEqual(
      expect.arrayContaining([
        "m7.purchase_receipt.create",
        "m7.store_product.propose",
        "m7.store_price.propose",
        "m7.supplier.create",
        "m7.reorder.mark_ordered",
        "m7.stock_count.count",
        "m7.internal_transfer.create",
      ]),
    );
    expect(listPullProviders().map(([k]) => k)).toEqual(expect.arrayContaining(["m7.store", "m6.pos", "m1.catalog"]));
    for (const type of ["store_discount", "store_credit_sale"] as const) expect(getApprovalHandlers(type)?.onExpired).toBeTypeOf("function");
    expect(getApprovalHandlers("store_product", "product")?.onApproved).toBeTypeOf("function");
    expect(getApprovalHandlers("store_product", "product_price")?.onApproved).toBeTypeOf("function");
    expect(getApprovalHandlers("supplier")?.onApproved).toBeTypeOf("function");
    for (const obj of ["purchase_receipt", "supplier_payment", "store_return"]) expect(getApprovalHandlers("correction", obj)?.onApproved).toBeTypeOf("function");
    // Handler void & penyesuaian stok milik kerangka M6 tetap (tidak didaftarkan ulang).
    expect(getApprovalHandlers("pos_void")?.onApproved).toBeTypeOf("function");
    expect(listJobs().map((j) => j.key)).toEqual(expect.arrayContaining(["m7.stock_count.monthly_check", "m7.payable.due_reminder", "m7.reorder.sweep"]));
  });

  it("menu M7 di registri nav memakai izin katalog dan rute yang dibangun", () => {
    const items = NAV_GROUPS.flatMap((g) => g.items).filter((i) => i.id.startsWith("m7."));
    expect(items.map((i) => i.href).sort()).toEqual(
      ["/toko/barang", "/toko/barang/[id]", "/toko/laporan", "/toko/opname", "/toko/opname/[id]", "/toko/pemasok", "/toko/pembelian", "/toko/pembelian/[id]", "/toko/pesan-ulang", "/toko/utang"].sort(),
    );
  });
});
