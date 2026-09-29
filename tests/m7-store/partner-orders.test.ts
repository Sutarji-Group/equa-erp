/**
 * B-73 (S5, US-P3-03 KP-3): layar POS toko menampilkan pull P3 `p3.store_partner_orders` (pesanan spare part portal
 * mitra menunggu kasir) dan mengisi keranjang harga mitra dari katalog perangkat; penjualan harga mitra pelanggan itu
 * mengonfirmasi pesanan otomatis (pesanan hilang dari pull berikutnya).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { partnerPortalOrders } from "@/db/schema";
import { partnerOrderCart, P3_STORE_PARTNER_ORDERS_KEY, type StorePartnerOrdersReference, type StoreProductRef, type StoreReference } from "@/client/m7-store/contract";
import { createPortalSparePartOrder } from "@/server/modules/p3-partner";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { disablePhase3, enablePhase3, setupPartner } from "../p3-partner/helpers";
import { expectApplied, makeStore, openShiftVia, PARTNER, sellVia, SP, stockUp } from "./helpers";

describe("B-73 POS toko: pesanan spare part portal mitra (US-P3-03 KP-3)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(async () => {
    bootstrapForTests();
    await enablePhase3();
  });
  afterAll(async () => {
    await disablePhase3();
  });

  it("B-73 US-P3-03 KP-3 kasir toko mengunduh pesanan mitra menunggu; keranjang terisi harga mitra dari katalog perangkat; penjualan harga mitra → pesanan terkonfirmasi & hilang dari daftar", async () => {
    const p = await setupPartner(t.db);
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.UV, quantity: 3, unitCost: 100_000 }]);
    const order = await createPortalSparePartOrder(p.portal(), { outletId: p.outletId, items: [{ productId: SP.UV, quantity: 2 }], pickup: "store_pickup", paymentMethod: "cash" });

    const pull = await pos.hp.pull(pos.op, { keys: `${P3_STORE_PARTNER_ORDERS_KEY},m7.store` });
    const pending = pull.data[P3_STORE_PARTNER_ORDERS_KEY] as StorePartnerOrdersReference;
    const store = pull.data["m7.store"] as StoreReference;
    const ref = pending.orders.find((o) => o.id === order.id)!;
    expect(ref).toMatchObject({ customerId: p.customerId, pickup: "store_pickup", paymentMethod: "cash", estimatedAmount: 2 * PARTNER.UV });
    expect(ref.customerName).not.toBe("-");
    expect(store.customers.some((c) => c.id === p.customerId && c.isStorePartner)).toBe(true);

    const cart = partnerOrderCart(ref, store.products);
    expect(cart).toEqual({ lines: [{ productId: SP.UV, quantity: 2 }], issues: [] });
    const uv = store.products.find((x) => x.id === SP.UV)!;
    expect(uv.prices.partner).toBe(PARTNER.UV);

    const shiftId = await openShiftVia(pos);
    const sale = await sellVia(pos, shiftId, cart.lines.map((l) => ({ ...l, unitPrice: uv.prices.partner! })), { customerId: p.customerId });
    expectApplied(sale.res);
    const [confirmed] = await t.db.select().from(partnerPortalOrders).where(eq(partnerPortalOrders.id, order.id));
    expect(confirmed).toMatchObject({ status: "confirmed", posSaleId: sale.saleId });
    const after = (await pos.hp.pull(pos.op, { keys: P3_STORE_PARTNER_ORDERS_KEY })).data[P3_STORE_PARTNER_ORDERS_KEY] as StorePartnerOrdersReference;
    expect(after.orders.some((o) => o.id === order.id)).toBe(false);
  });

  it("B-73 US-P3-03 KP-3 isi keranjang dari pesanan: stok kurang dibatasi & dilaporkan, barang tanpa harga mitra / di luar katalog dilaporkan (kasir menyesuaikan)", () => {
    const products = [
      { id: "a", code: "TK-A", name: "Lampu UV", unit: "pcs", category: null, barcode: null, minStock: null, status: "active", balance: 1, prices: { general: 150_000, partner: 135_000 } },
      { id: "b", code: "TK-B", name: "Sikat", unit: "pcs", category: null, barcode: null, minStock: null, status: "active", balance: 5, prices: { general: 20_000 } },
    ] satisfies StoreProductRef[];
    const res = partnerOrderCart(
      {
        items: [
          { productId: "a", name: "Lampu UV", quantity: 3 },
          { productId: "b", name: "Sikat", quantity: 1 },
          { code: "TK-X", name: "Pompa", quantity: 1 },
          { code: "tk-a", name: "Lampu UV", quantity: 1 },
        ],
      },
      products,
    );
    expect(res.lines).toEqual([{ productId: "a", quantity: 1 }]);
    expect(res.issues).toEqual([
      "Lampu UV: dipesan 3 pcs, stok tinggal 1 pcs.",
      "Sikat: Harga belum ditetapkan.",
      "Pompa: tidak ada di katalog toko perangkat ini.",
      "Lampu UV: dipesan 1 pcs, stok tinggal 0 pcs.",
    ]);
  });
});
