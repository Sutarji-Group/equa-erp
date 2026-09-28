import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  fuelComponents,
  notifications,
  orders,
  productPrices,
  products,
  zoneTariffs,
} from "@/db/schema";
import {
  customerId as seedCustomerId,
  outletId,
  productId,
  seedId,
  tariffZoneId,
  userIdByUsername,
} from "@/db/seed";
import { addDays } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { ForbiddenError } from "@/server/core/errors";
import * as m1 from "@/server/modules/m1-master";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createOrder } from "../helpers/fixtures";
import {
  days,
  dispatcher,
  finance,
  owner,
  T0,
  TODAY,
  uniqueWa,
} from "./helpers";

describe("M1 Master Data", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  const TOMORROW = addDays(TODAY, 1);

  async function customerInZone(
    zoneCode: string,
    segment: m1.CreateCustomerInput["segment"] = "hotel",
  ) {
    const res = await m1.createCustomer(dispatcher(), {
      name: `Pelanggan Harga ${Math.random().toString(36).slice(2, 8)}`,
      segment,
      waPhone: uniqueWa(),
      addresses: [
        {
          label: "Utama",
          addressText: "Jl. Harga No. 3, Cianjur",
          manualZoneId: tariffZoneId(zoneCode),
          manualZoneReason: "Uji harga",
        },
      ],
      confirmDuplicate: true,
    });
    if (res.status !== "created") throw new Error("gagal");
    return { id: res.customer.id, addressId: res.addresses[0]!.id };
  }

  describe("US-M1-02 Mengelola produk dan harga tiga lini", () => {
    it("US-M1-02 KP-1 air truk = tarif zona alamat + komponen BBM; produk depot harga tunggal per tenant; barang toko harga umum & mitra", async () => {
      const c = await customerInZone("Z2");
      const p = await m1.resolveTruckWaterPrice(t.db, {
        customerId: c.id,
        addressId: c.addressId,
        date: TODAY,
      });
      expect(p).toMatchObject({
        source: "zone",
        zoneTariff: 220_000,
        fuelComponent: 20_000,
        unitPrice: 240_000,
        tempPrice: false,
        zoneId: tariffZoneId("Z2"),
      });
      const depot = await m1.resolveProductPrice(t.db, {
        productId: productId("ISI-ULANG"),
        kind: "standard",
        date: TODAY,
        tenantId: (
          await t.db
            .select()
            .from(products)
            .where(eq(products.id, productId("ISI-ULANG")))
        )[0]!.tenantId,
      });
      expect(depot.unitPrice).toBe(5_000);
      const tenantId = depot.priceId
        ? (
            await t.db
              .select()
              .from(productPrices)
              .where(eq(productPrices.id, depot.priceId))
          )[0]!.tenantId
        : "";
      expect(
        (
          await m1.resolveProductPrice(t.db, {
            productId: productId("TK-TUTUP"),
            kind: "general",
            date: TODAY,
            tenantId,
          })
        ).unitPrice,
      ).toBe(800);
      expect(
        (
          await m1.resolveProductPrice(t.db, {
            productId: productId("TK-TUTUP"),
            kind: "partner",
            date: TODAY,
            tenantId,
          })
        ).unitPrice,
      ).toBe(600);
      // Tarif per segmen didahulukan bila pemilik menetapkannya (US-M1-05 KP-1).
      await m1.proposeZoneTariff(owner(), {
        zoneId: tariffZoneId("Z2"),
        segment: "hotel",
        pricePerTrip: 250_000,
        effectiveFrom: TODAY,
        reason: "Tarif hotel khusus",
      });
      expect(
        (
          await m1.resolveTruckWaterPrice(t.db, {
            customerId: c.id,
            addressId: c.addressId,
            date: TODAY,
          })
        ).unitPrice,
      ).toBe(270_000);
      const house = await customerInZone("Z2", "household");
      expect(
        (
          await m1.resolveTruckWaterPrice(t.db, {
            customerId: house.id,
            addressId: house.addressId,
            date: TODAY,
          })
        ).unitPrice,
      ).toBe(240_000);
      // Harga air truk tidak ditetapkan per produk (BR-19).
      await expect(
        m1.proposeProductPrice(owner(), {
          productId: productId("AIR-TRUK"),
          kind: "standard",
          price: 1,
          effectiveFrom: TODAY,
          reason: "abc",
        }),
      ).rejects.toMatchObject({ code: "TRUCK_WATER_PRICE" });
    });

    it("US-M1-02 KP-2 komponen BBM satu nilai per rit untuk seluruh zona, ditetapkan pemilik dengan tanggal berlaku", async () => {
      const r = await m1.proposeFuelComponent(owner(), {
        amountPerTrip: 25_000,
        effectiveFrom: addDays(TODAY, 10),
        reason: "Harga solar naik",
      });
      expect(r.status).toBe("active");
      const c1 = await customerInZone("Z1");
      const c4 = await customerInZone("Z4");
      const later = addDays(TODAY, 10);
      expect(
        (
          await m1.resolveTruckWaterPrice(t.db, {
            customerId: c1.id,
            addressId: c1.addressId,
            date: later,
          })
        ).fuelComponent,
      ).toBe(25_000);
      expect(
        (
          await m1.resolveTruckWaterPrice(t.db, {
            customerId: c4.id,
            addressId: c4.addressId,
            date: later,
          })
        ).fuelComponent,
      ).toBe(25_000);
      expect(
        (
          await m1.resolveTruckWaterPrice(t.db, {
            customerId: c1.id,
            addressId: c1.addressId,
            date: TODAY,
          })
        ).fuelComponent,
      ).toBe(20_000);
    });

    it("US-M1-02 KP-3 jalur baku: Admin Keuangan mengajukan → pemilik menyetujui → harga aktif pada tanggal berlaku; lewat tenggat → harga lama tetap", async () => {
      const zone = tariffZoneId("Z3");
      // Tanggal berlaku wajib ≥ besok untuk jalur persetujuan.
      await expect(
        m1.proposeZoneTariff(finance(), {
          zoneId: zone,
          pricePerTrip: 280_000,
          effectiveFrom: TODAY,
          reason: "Naik",
        }),
      ).rejects.toThrow(/paling cepat besok/);
      const req = await m1.proposeZoneTariff(finance(), {
        zoneId: zone,
        pricePerTrip: 280_000,
        effectiveFrom: TOMORROW,
        reason: "Penyesuaian biaya",
      });
      expect(req.status).toBe("pending");
      const c = await customerInZone("Z3");
      expect(
        (
          await m1.resolveTruckWaterPrice(t.db, {
            customerId: c.id,
            addressId: c.addressId,
            date: TOMORROW,
          })
        ).zoneTariff,
      ).toBe(260_000);
      const approval = (await approvals.getApproval(t.db, req.approvalId!))!;
      expect(approval.type).toBe("price_change");
      expect(approval.deadlineAt?.toISOString()).toBe(
        `${addDays(TODAY, 0)}T17:00:00.000Z`,
      );
      await approvals.decide(owner(), req.approvalId!, "approve");
      expect(
        (
          await m1.resolveTruckWaterPrice(t.db, {
            customerId: c.id,
            addressId: c.addressId,
            date: TOMORROW,
          })
        ).zoneTariff,
      ).toBe(280_000);
      expect(
        (
          await m1.resolveTruckWaterPrice(t.db, {
            customerId: c.id,
            addressId: c.addressId,
            date: TODAY,
          })
        ).zoneTariff,
      ).toBe(260_000);

      // Lewat tenggat (sebelum tanggal berlaku tidak diputuskan) → usulan batal, harga lama tetap berlaku.
      const late = await m1.proposeProductPrice(finance(), {
        productId: productId("GALON-BARU"),
        kind: "standard",
        price: 50_000,
        effectiveFrom: TOMORROW,
        reason: "Harga galon naik",
      });
      const res = await approvals.expireDue(days(2));
      expect(res.errors).toEqual([]);
      const [row] = await t.db
        .select()
        .from(productPrices)
        .where(eq(productPrices.id, late.id));
      expect(row!.status).toBe("cancelled");
      const tenant = row!.tenantId;
      expect(
        (
          await m1.resolveProductPrice(t.db, {
            productId: productId("GALON-BARU"),
            kind: "standard",
            date: addDays(TODAY, 2),
            tenantId: tenant,
          })
        ).unitPrice,
      ).toBe(45_000);
      // Ditolak pemilik → status Ditolak.
      const rej = await m1.proposeFuelComponent(finance(), {
        amountPerTrip: 30_000,
        effectiveFrom: addDays(TODAY, 3),
        reason: "Usulan BBM",
      });
      await approvals.decide(owner(), rej.approvalId!, "reject", "Belum perlu");
      expect(
        (
          await t.db
            .select()
            .from(fuelComponents)
            .where(eq(fuelComponents.id, rej.id))
        )[0]!.status,
      ).toBe("rejected");
    });

    it("US-M1-02 KP-3 keputusan langsung pemilik (6.2b): tanpa persetujuan, alasan & tanggal wajib, diberitahukan ke Admin Keuangan & Dispatcher; Dispatcher tidak dapat mengubah harga", async () => {
      await expect(
        m1.proposeProductPrice(owner(), {
          productId: productId("CUCI-GALON"),
          kind: "standard",
          price: 2_500,
          effectiveFrom: TODAY,
          reason: "",
        }),
      ).rejects.toThrow(/Alasan/);
      await expect(
        m1.proposeProductPrice(owner(), {
          productId: productId("CUCI-GALON"),
          kind: "standard",
          price: 2_500,
          effectiveFrom: addDays(TODAY, -1),
          reason: "abc",
        }),
      ).rejects.toThrow(/mundur/);
      const r = await m1.proposeProductPrice(owner(), {
        productId: productId("CUCI-GALON"),
        kind: "standard",
        price: 2_500,
        effectiveFrom: TODAY,
        reason: "Sabun naik",
      });
      expect(r).toMatchObject({ status: "active", approvalId: null });
      const [row] = await t.db
        .select()
        .from(productPrices)
        .where(eq(productPrices.id, r.id));
      expect(row!.isOwnerDirect).toBe(true);
      for (const u of ["keuangan1", "dispatcher1"]) {
        const n = await t.db
          .select()
          .from(notifications)
          .where(
            and(
              eq(notifications.event, "price.changed_by_owner"),
              eq(notifications.recipientUserId, userIdByUsername(u)),
            ),
          );
        expect(n.length, u).toBeGreaterThan(0);
      }
      await expect(
        m1.proposeZoneTariff(dispatcher(), {
          zoneId: tariffZoneId("Z1"),
          pricePerTrip: 1,
          effectiveFrom: TOMORROW,
          reason: "abc",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      // Riwayat harga tetap tersimpan (tidak dapat dihapus).
      const hist = await m1.priceHistory(t.db, row!.tenantId, {
        productId: productId("CUCI-GALON"),
      });
      expect(hist.map((h) => h.price)).toEqual(
        expect.arrayContaining([2_000, 2_500]),
      );
      await expect(
        t.db.delete(productPrices).where(eq(productPrices.id, r.id)),
      ).rejects.toThrow();
    });

    it("US-M1-02 KP-4 harga diambil per tanggal transaksi; harga pesanan terkunci; perubahan sebelum tanggal kirim terdeteksi untuk peringatan Dispatcher", async () => {
      const c = await customerInZone("Z1");
      const locked = await m1.resolveTruckWaterPrice(t.db, {
        customerId: c.id,
        addressId: c.addressId,
        date: TODAY,
      });
      const order = await createOrder(t.db, {
        customerId: c.id,
        addressId: c.addressId,
        date: addDays(TODAY, 5),
        pricePerTrip: locked.unitPrice,
      });
      await m1.proposeZoneTariff(owner(), {
        zoneId: tariffZoneId("Z1"),
        pricePerTrip: 190_000,
        effectiveFrom: addDays(TODAY, 3),
        reason: "Penyesuaian",
      });
      const check = await m1.detectTruckPriceChange(t.db, {
        customerId: c.id,
        addressId: c.addressId,
        lockedUnitPrice: locked.unitPrice,
        deliveryDate: addDays(TODAY, 5),
      });
      expect(check).toMatchObject({
        changed: true,
        lockedUnitPrice: 200_000,
        currentUnitPrice: 210_000,
        difference: 10_000,
      });
      const [o] = await t.db
        .select()
        .from(orders)
        .where(eq(orders.id, order.id));
      expect(o!.pricePerTrip).toBe(200_000);
      expect(
        (
          await m1.detectTruckPriceChange(t.db, {
            customerId: c.id,
            addressId: c.addressId,
            lockedUnitPrice: 200_000,
            deliveryDate: TODAY,
          })
        ).changed,
      ).toBe(false);
    });

    it("US-M1-02 KP-5 transfer internal ke depot sendiri = tarif zona alamat depot segmen depot pihak ketiga (+ BBM), tanpa pembayaran", async () => {
      await m1.proposeZoneTariff(owner(), {
        zoneId: tariffZoneId("Z1"),
        segment: "third_party_depot",
        pricePerTrip: 170_000,
        effectiveFrom: addDays(TODAY, 20),
        reason: "Tarif depot",
      });
      const p = await m1.resolveInternalTransferPrice(t.db, {
        depotOutletId: outletId("D01"),
        date: TODAY,
      });
      expect(p.customerId).toBe(seedId("customer:internal:D01"));
      expect(p.zoneTariff + p.fuelComponent).toBe(p.unitPrice);
      const later = await m1.resolveInternalTransferPrice(t.db, {
        depotOutletId: outletId("D01"),
        date: addDays(TODAY, 20),
      });
      if (later.zoneId === tariffZoneId("Z1"))
        expect(later.zoneTariff).toBe(170_000);
      await expect(
        m1.resolveInternalTransferPrice(t.db, {
          depotOutletId: outletId("TK1"),
          date: TODAY,
        }),
      ).rejects.toThrow(/Depot tidak ditemukan/);
    });

    it("US-M1-02 KP-6 produk dinonaktifkan (bukan dihapus): tidak dapat dijual/dipesan, tidak tampil di daftar aktif, tetap di riwayat", async () => {
      const p = await m1.createProduct(finance(), {
        code: "AIR-UJI-19",
        name: "Air uji 19 L",
        line: "depot",
        unit: "galon",
        gallonSizeL: 19,
      });
      await m1.proposeProductPrice(owner(), {
        productId: p.id,
        kind: "standard",
        price: 6_000,
        effectiveFrom: TODAY,
        reason: "Harga awal",
      });
      expect(
        (
          await m1.resolveProductPrice(t.db, {
            productId: p.id,
            kind: "standard",
            date: TODAY,
            tenantId: p.tenantId,
          })
        ).unitPrice,
      ).toBe(6_000);
      await expect(
        m1.setProductActive(finance(), p.id, { active: false, reason: "" }),
      ).rejects.toThrow(/Alasan/);
      const off = await m1.setProductActive(finance(), p.id, {
        active: false,
        reason: "Tidak diproduksi lagi",
      });
      expect(off.status).toBe("inactive");
      await expect(
        m1.resolveProductPrice(t.db, {
          productId: p.id,
          kind: "standard",
          date: TODAY,
          tenantId: p.tenantId,
        }),
      ).rejects.toMatchObject({ code: "PRODUCT_INACTIVE" });
      expect(
        (await m1.listProducts(finance())).some((x) => x.id === p.id),
      ).toBe(false);
      expect(
        (await m1.listProducts(finance(), { includeInactive: true })).some(
          (x) => x.id === p.id,
        ),
      ).toBe(true);
      expect(
        (await m1.priceHistory(t.db, p.tenantId, { productId: p.id })).length,
      ).toBe(1);
      await expect(
        t.db.delete(products).where(eq(products.id, p.id)),
      ).rejects.toThrow();
      // Barang toko baru lewat M7; Dispatcher tidak membuat produk.
      await expect(
        m1.createProduct(finance(), {
          code: "TK-BARU",
          name: "Barang baru",
          line: "store",
          unit: "pcs",
        }),
      ).rejects.toMatchObject({ code: "STORE_PRODUCT_VIA_M7" });
      await expect(
        m1.createProduct(dispatcher(), {
          code: "X-1",
          name: "X",
          line: "depot",
          unit: "pcs",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("7.1.6 alamat tanpa koordinat & tanpa zona manual → harga sementara (tarif zona tertinggi) — tidak dapat diterbitkan", async () => {
      const res = await m1.quickCreateCustomer(dispatcher(), {
        name: "Pelanggan Tanpa Zona",
        waPhone: uniqueWa(),
        segment: "construction",
        addressText: "Lokasi belum jelas, Cibeber",
        confirmDuplicate: true,
      });
      if (res.status !== "created") throw new Error("gagal");
      const p = await m1.resolveTruckWaterPrice(t.db, {
        customerId: res.customer.id,
        addressId: res.addresses[0]!.id,
        date: TODAY,
      });
      expect(p.tempPrice).toBe(true);
      expect(p.zoneId).toBeNull();
      expect(p.zoneTariff).toBe(300_000);
      // Alamat milik pelanggan lain ditolak.
      await expect(
        m1.resolveTruckWaterPrice(t.db, {
          customerId: seedCustomerId("PLG-0001"),
          addressId: res.addresses[0]!.id,
          date: TODAY,
        }),
      ).rejects.toThrow(/Alamat kirim tidak ditemukan/);
      void zoneTariffs;
      void T0;
    });
  });
});
