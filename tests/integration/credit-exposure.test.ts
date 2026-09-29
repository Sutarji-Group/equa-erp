/**
 * B-35 — satu definisi eksposur kredit lintas lini (PTB-25, BR-06): pesanan air tempo (M2), tempo toko (M7), kartu
 * piutang (M5) dan kartu pelanggan (M1) memakai angka yang sama, termasuk penjualan tempo toko yang belum difakturkan
 * (shift toko masih terbuka).
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { customers } from "@/db/schema";
import { withTx } from "@/server/core/db";
import * as m1 from "@/server/modules/m1-master";
import * as m2 from "@/server/modules/m2-orders";
import * as m5 from "@/server/modules/m5-receivables";
import { storeCreditExposure } from "@/server/modules/m7-store";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { customer, dispatcher, finance, openInvoice, TODAY } from "../m2-orders/helpers";
import { expectApplied, makeStore, openShiftVia, PARTNER, sellVia, SP, stockUp } from "../m7-store/helpers";

describe("B-35 eksposur kredit lintas lini", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("B-35 US-M2-05 KP-2 US-M7-04 KP-2 pesanan air tempo memuat tempo toko belum difakturkan; M1, M2, M5, M7 memakai eksposur yang sama", async () => {
    const c = await customer(t.db, { creditStatus: "credit", creditLimit: 10_000_000 });
    await t.db.update(customers).set({ isStorePartner: true }).where(eq(customers.id, c.id));
    await openInvoice(t.db, c.id, 300_000);

    // Penjualan tempo toko Sah pada shift yang masih terbuka → belum ada faktur M5.
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.DISPENSER, quantity: 3, unitCost: 700_000 }]);
    const shiftId = await openShiftVia(pos);
    const sale = await sellVia(pos, shiftId, [{ productId: SP.DISPENSER, quantity: 2, unitPrice: PARTNER.DISPENSER }], { method: "credit", customerId: c.id });
    expectApplied(sale.res);
    const storeCredit = 2 * PARTNER.DISPENSER;

    const m2Exposure = await m2.computeCreditExposure(t.db, c.id);
    expect(m2Exposure).toMatchObject({ openInvoices: 300_000, uninvoicedStoreCredit: storeCredit, exposure: 300_000 + storeCredit });
    const m5Exposure = await withTx((tx) => m5.computeExposure(tx, c.id));
    const m7Exposure = await storeCreditExposure(t.db, c.id, 0);
    const card = await m5.getCreditExposure(finance(), c.id);
    const summary = await m1.getCustomerSummary(dispatcher(), c.id);
    for (const e of [m5Exposure, m7Exposure, card]) {
      expect(e.exposure).toBe(m2Exposure.exposure);
      expect(e.uninvoicedStoreCredit).toBe(storeCredit);
    }
    expect(summary.remainingLimit).toBe(m2Exposure.remaining);
    expect(summary.uninvoicedStoreCredit).toBe(storeCredit);

    // Penjualan yang sedang dinilai ulang dapat dikecualikan (persetujuan tempo toko).
    const excluded = await m2.computeCreditExposure(t.db, c.id, { excludeSaleId: sale.saleId });
    expect(excluded.uninvoicedStoreCredit).toBe(0);

    // Batas tersisa lebih kecil dari satu rit → pesanan air tempo ditolak dengan rincian tempo toko.
    const unit = (await m1.resolveTruckWaterPrice(t.db, { customerId: c.id, addressId: c.addressId!, date: TODAY })).unitPrice;
    await t.db.update(customers).set({ creditLimit: m2Exposure.exposure + unit - 1 }).where(eq(customers.id, c.id));
    const blocked = await m2.createOrder(dispatcher(), { customerId: c.id, addressId: c.addressId!, requestedDate: TODAY, paymentMethod: "credit" });
    expect(blocked.status).toBe("credit_blocked");
    if (blocked.status !== "credit_blocked") return;
    expect(blocked.check.reason).toBe("over_limit");
    expect(blocked.check.exposure.uninvoicedStoreCredit).toBe(storeCredit);
    expect(blocked.check.message).toMatch(/tempo toko belum difakturkan/);
    // Tanpa tempo toko, pesanan yang sama masih dalam batas (angka yang dulu dipakai M2 sendiri).
    expect(blocked.check.exposure.exposure - storeCredit).toBeLessThanOrEqual(m2Exposure.exposure + unit - 1);
  });
});
