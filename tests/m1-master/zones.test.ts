import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  customerAddresses,
  customerLegacyPrices,
  notifications,
  orders,
  tariffZoneBoundaries,
  tariffZones,
} from "@/db/schema";
import {
  EQUA_TENANT_ID,
  seedId,
  tariffZoneId,
  userIdByUsername,
  waterSourceId,
} from "@/db/seed";
import { addDays } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { withTx } from "@/server/core/db";
import { ForbiddenError } from "@/server/core/errors";
import type { RoutingProvider } from "@/server/core/maps";
import * as m1 from "@/server/modules/m1-master";
import { applyEffectiveZoneTables } from "@/server/modules/m1-master/service/zones";

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

  const SA1 = { lat: -6.7712, lng: 107.0853 };
  const CURRENT = [
    { zoneId: tariffZoneId("Z1"), minKm: 0, maxKm: 5 },
    { zoneId: tariffZoneId("Z2"), minKm: 5, maxKm: 10 },
    { zoneId: tariffZoneId("Z3"), minKm: 10, maxKm: 15 },
    { zoneId: tariffZoneId("Z4"), minKm: 15, maxKm: null },
  ];

  async function customerAt(lat: number, lng: number) {
    const res = await m1.createCustomer(dispatcher(), {
      name: `Pelanggan Zona ${Math.random().toString(36).slice(2, 8)}`,
      segment: "industry",
      waPhone: uniqueWa(),
      addresses: [
        { label: "Utama", addressText: "Jl. Zona No. 9, Cugenang", lat, lng },
      ],
      confirmDuplicate: true,
    });
    if (res.status !== "created") throw new Error("gagal");
    return { id: res.customer.id, address: res.addresses[0]! };
  }

  describe("US-M1-05 Mengelola zona tarif dan pemetaan alamat", () => {
    it("US-M1-05 KP-1 tabel zona tanpa tumpang tindih & tanpa celah, berlaku per tanggal; tarif per rit dapat per segmen", async () => {
      const table = await m1.zoneTableAt(t.db, EQUA_TENANT_ID, TODAY);
      expect(
        table.map((z) => [z.code, z.minDistanceM, z.maxDistanceM]),
      ).toEqual([
        ["Z1", 0, 5000],
        ["Z2", 5000, 10000],
        ["Z3", 10000, 15000],
        ["Z4", 15000, null],
      ]);
      const overlap = CURRENT.map((z, i) => (i === 1 ? { ...z, minKm: 4 } : z));
      await expect(
        m1.proposeZoneTable(owner(), {
          effectiveFrom: addDays(TODAY, 30),
          reason: "Uji",
          zones: overlap,
        }),
      ).rejects.toThrow(/tumpang tindih/);
      const gap = CURRENT.map((z, i) => (i === 1 ? { ...z, minKm: 6 } : z));
      await expect(
        m1.proposeZoneTable(owner(), {
          effectiveFrom: addDays(TODAY, 30),
          reason: "Uji",
          zones: gap,
        }),
      ).rejects.toThrow(/celah/);
      await expect(
        m1.proposeZoneTable(owner(), {
          effectiveFrom: addDays(TODAY, 30),
          reason: "Uji",
          zones: CURRENT.slice(0, 3),
        }),
      ).rejects.toThrow(/semua zona aktif/);
      // Tarif per segmen berlaku per tanggal.
      await m1.proposeZoneTariff(owner(), {
        zoneId: tariffZoneId("Z4"),
        segment: "swimming_pool",
        pricePerTrip: 320_000,
        effectiveFrom: addDays(TODAY, 7),
        reason: "Kolam renang jauh",
      });
      const overview = await m1.getZoneOverview(owner(), {
        date: addDays(TODAY, 7),
      });
      const z4 = overview.table.find((z) => z.code === "Z4")!;
      expect(z4.tariffs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            segment: "swimming_pool",
            pricePerTrip: 320_000,
          }),
          expect.objectContaining({ segment: null, pricePerTrip: 300_000 }),
        ]),
      );
      // Perubahan tabel zona: Dispatcher tidak berhak.
      await expect(
        m1.proposeZoneTable(dispatcher(), {
          effectiveFrom: addDays(TODAY, 30),
          reason: "Uji",
          zones: CURRENT,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("US-M1-05 KP-2 jarak dari sumber air acuan terdekat via layanan peta; cadangan garis lurus × 1,3 bila peta tidak tersedia (ditandai hitung ulang)", async () => {
      const near = await m1.mapAddressToZone(t.db, {
        lat: SA1.lat + 0.01,
        lng: SA1.lng,
        tenantId: EQUA_TENANT_ID,
        date: TODAY,
      });
      expect(near.referenceWaterSourceId).toBe(waterSourceId("SA1"));
      expect(near.distanceMethod).toBe("straight_line_x1_3");
      expect(near.distanceM).toBeGreaterThan(1400);
      expect(near.distanceM).toBeLessThan(1500);
      expect(near.zoneId).toBe(tariffZoneId("Z1"));

      const route: RoutingProvider = {
        name: "osrm",
        distanceKm: async () => ({
          km: 7.2,
          meters: 7200,
          method: "route",
          estimated: false,
        }),
      };
      const viaMap = await m1.mapAddressToZone(t.db, {
        lat: SA1.lat + 0.01,
        lng: SA1.lng,
        tenantId: EQUA_TENANT_ID,
        date: TODAY,
        provider: route,
      });
      expect(viaMap).toMatchObject({
        distanceMethod: "route",
        distanceM: 7200,
        zoneId: tariffZoneId("Z2"),
        estimated: false,
      });

      const down: RoutingProvider = {
        name: "osrm",
        distanceKm: async (a, b) => ({
          km: 1,
          meters: Math.round(
            1000 * Math.hypot(a.lat - b.lat, a.lng - b.lng) * 111 * 1.3,
          ),
          method: "straight_line_x1_3",
          estimated: true,
        }),
      };
      m1.setRoutingProviderForTests(down);
      try {
        const c = await customerAt(SA1.lat + 0.01, SA1.lng);
        expect(c.address.distanceNeedsRecalc).toBe(true);
        expect(c.address.distanceMethod).toBe("straight_line_x1_3");
      } finally {
        m1.setRoutingProviderForTests(null);
      }
    });

    it("US-M1-05 KP-3 pemetaan otomatis saat koordinat tersedia; Dispatcher menetapkan zona lain beralasan (Zona manual)", async () => {
      const c = await customerAt(SA1.lat + 0.03, SA1.lng);
      expect(c.address.zoneAssignment).toBe("auto");
      expect(c.address.tariffZoneId).toBe(tariffZoneId("Z1"));
      const manual = await m1.setAddressManualZone(dispatcher(), c.address.id, {
        zoneId: tariffZoneId("Z2"),
        reason: "Akses jalan memutar lewat Cipanas",
      });
      expect(manual).toMatchObject({
        zoneAssignment: "manual",
        tariffZoneId: tariffZoneId("Z2"),
        zoneManualReason: "Akses jalan memutar lewat Cipanas",
      });
      await expect(
        m1.setAddressManualZone(dispatcher(), c.address.id, {
          zoneId: tariffZoneId("Z3"),
          reason: "",
        }),
      ).rejects.toThrow(/Alasan/);
      const auto = await m1.clearAddressManualZone(
        dispatcher(),
        c.address.id,
        "Jalan pintas sudah dibuka",
      );
      expect(auto.zoneAssignment).toBe("auto");
      expect(auto.tariffZoneId).toBe(tariffZoneId("Z1"));
    });

    it("US-M1-05 KP-4 perubahan batas zona tidak mengubah harga pesanan yang sudah dibuat; daftar alamat berpindah zona untuk ditinjau pemilik", async () => {
      const c = await customerAt(SA1.lat + 0.02, SA1.lng); // ± 2,9 km → Z1
      expect(c.address.tariffZoneId).toBe(tariffZoneId("Z1"));
      const price = await m1.resolveTruckWaterPrice(t.db, {
        customerId: c.id,
        addressId: c.address.id,
        date: TODAY,
      });
      const order = await createOrder(t.db, {
        customerId: c.id,
        addressId: c.address.id,
        date: addDays(TODAY, 3),
        pricePerTrip: price.unitPrice,
      });
      const eff = addDays(TODAY, 2);
      const newTable = [
        { zoneId: tariffZoneId("Z1"), minKm: 0, maxKm: 2 },
        { zoneId: tariffZoneId("Z2"), minKm: 2, maxKm: 10 },
        { zoneId: tariffZoneId("Z3"), minKm: 10, maxKm: 15 },
        { zoneId: tariffZoneId("Z4"), minKm: 15, maxKm: null },
      ];
      // Jalur baku: Admin Keuangan → pemilik. Pratinjau alamat berpindah sebelum diputuskan.
      const req = await m1.proposeZoneTable(finance(), {
        effectiveFrom: eff,
        reason: "Zona diturunkan dari harga hari ini (K23)",
        zones: newTable,
      });
      expect(req.status).toBe("pending");
      const preview = await m1.listZoneMoves(owner(), {
        approvalId: req.approvalId!,
      });
      expect(
        preview.moves.find((m) => m.addressId === c.address.id),
      ).toMatchObject({ fromZoneCode: "Z1", toZoneCode: "Z2" });
      await approvals.decide(owner(), req.approvalId!, "approve");
      // Belum berlaku → alamat tetap Z1 sampai tanggal berlaku (job harian).
      expect(
        (
          await t.db
            .select()
            .from(customerAddresses)
            .where(eq(customerAddresses.id, c.address.id))
        )[0]!.tariffZoneId,
      ).toBe(tariffZoneId("Z1"));
      const res = await withTx((tx) =>
        applyEffectiveZoneTables(tx, days(2), eff),
      );
      expect(res.moved).toBeGreaterThanOrEqual(1);
      const [addr] = await t.db
        .select()
        .from(customerAddresses)
        .where(eq(customerAddresses.id, c.address.id));
      expect(addr!.tariffZoneId).toBe(tariffZoneId("Z2"));
      const [zone] = await t.db
        .select()
        .from(tariffZones)
        .where(eq(tariffZones.id, tariffZoneId("Z1")));
      expect(zone!.maxDistanceM).toBe(2000);
      const [o] = await t.db
        .select()
        .from(orders)
        .where(eq(orders.id, order.id));
      expect(o!.pricePerTrip).toBe(price.unitPrice);
      const note = await t.db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.event, "zone.addresses_moved"),
            eq(notifications.recipientUserId, userIdByUsername("pemilik")),
          ),
        );
      expect(note.length).toBeGreaterThan(0);
      const moves = await m1.listZoneMoves(owner(), { effectiveFrom: eff });
      expect(moves.moves.some((m) => m.addressId === c.address.id)).toBe(true);
      // Riwayat batas tersimpan (versi lama tetap ada).
      const versions = await t.db
        .select()
        .from(tariffZoneBoundaries)
        .where(eq(tariffZoneBoundaries.tariffZoneId, tariffZoneId("Z1")));
      expect(versions.length).toBeGreaterThanOrEqual(2);
    });

    it("US-M1-05 KP-5 simulasi harga zona baru vs harga berlaku per pelanggan (dari impor data awal)", async () => {
      const c = await customerAt(SA1.lat + 0.005, SA1.lng);
      await t.db
        .insert(customerLegacyPrices)
        .values({
          tenantId: EQUA_TENANT_ID,
          customerId: c.id,
          pricePerTrip: 250_000,
          notes: "Harga lama",
        });
      const pendingTariff = await m1.proposeZoneTariff(finance(), {
        zoneId: c.address.tariffZoneId!,
        pricePerTrip: 205_000,
        effectiveFrom: addDays(TODAY, 40),
        reason: "Simulasi",
      });
      const sim = await m1.simulateZonePricing(owner(), {
        date: addDays(TODAY, 40),
      });
      const row = sim.rows.find((r) => r.addressId === c.address.id)!;
      expect(row.legacyPrice).toBe(250_000);
      expect(row.currentPrice).toBe(200_000);
      expect(row.newPrice).toBe(205_000 + 20_000);
      expect(row.difference).toBe(225_000 - 250_000);
      expect(row.differencePct).toBe(-10);
      expect(pendingTariff.status).toBe("pending");
    });

    it("US-M1-05 KP-6 jarak GPS aktual rit dibandingkan zona alamat; penyimpangan ditampilkan, harga tidak berubah otomatis", async () => {
      const c = await customerAt(SA1.lat + 0.01, SA1.lng);
      const same = await m1.compareTripDistanceToZone(t.db, {
        addressId: c.address.id,
        actualDistanceM: 1800,
        date: TODAY,
      });
      expect(same.deviates).toBe(false);
      const far = await m1.compareTripDistanceToZone(t.db, {
        addressId: c.address.id,
        actualDistanceM: 12_000,
        date: TODAY,
      });
      expect(far).toMatchObject({
        deviates: true,
        addressZoneCode: "Z1",
        actualZoneCode: "Z3",
      });
      const after = await m1.resolveTruckWaterPrice(t.db, {
        customerId: c.id,
        addressId: c.address.id,
        date: TODAY,
      });
      expect(after.zoneId).toBe(tariffZoneId("Z1"));
      void seedId;
      void T0;
    });
  });
});
