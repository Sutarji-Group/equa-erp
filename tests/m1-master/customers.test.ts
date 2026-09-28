import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  auditLogs,
  customerAddresses,
  customerCreditHistory,
  customers,
  invoices,
  notifications,
  orders,
  trips,
} from "@/db/schema";
import {
  customerId as seedCustomerId,
  EQUA_TENANT_ID,
  seedId,
  tariffZoneId,
  userIdByUsername,
} from "@/db/seed";
import { withTx } from "@/server/core/db";
import {
  DomainError,
  ForbiddenError,
  ValidationError,
} from "@/server/core/errors";
import { emit } from "@/server/core/events";
import * as m1 from "@/server/modules/m1-master";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import {
  createOrder,
  createScheduledTrip,
  createTruck,
} from "../helpers/fixtures";
import {
  ctxOf,
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

  async function newCustomer(overrides: Partial<m1.CreateCustomerInput> = {}) {
    const res = await m1.createCustomer(dispatcher(), {
      name: `Hotel Uji ${Math.random().toString(36).slice(2, 8)}`,
      segment: "hotel",
      waPhone: uniqueWa(),
      addresses: [
        {
          label: "Utama",
          addressText: `Jl. Uji Coba No. ${Math.floor(Math.random() * 999)}, Cipanas`,
          lat: -6.74,
          lng: 107.05,
        },
      ],
      // Pelanggan uji saling mirip namanya — lewati peringatan duplikat kecuali uji KP-7.
      confirmDuplicate: true,
      ...overrides,
    });
    if (res.status !== "created") throw new Error("duplikat tak terduga");
    return res;
  }

  describe("US-M1-01 Mengelola pelanggan dan alamat kirim", () => {
    it("US-M1-01 KP-1 bidang wajib: nama, segmen, WA format Indonesia, minimal satu alamat — pesan berbahasa Indonesia", async () => {
      await expect(
        m1.createCustomer(dispatcher(), {
          name: "",
          segment: "hotel",
          waPhone: uniqueWa(),
          addresses: [{ label: "Utama", addressText: "Jl. Raya 1, Cianjur" }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      const badWa = m1.createCustomer(dispatcher(), {
        name: "Toko Uji",
        segment: "hotel",
        waPhone: "12345",
        addresses: [{ label: "Utama", addressText: "Jl. Raya 1, Cianjur" }],
      });
      await expect(badWa).rejects.toThrow(/Nomor WA tidak valid/);
      await expect(
        m1.createCustomer(dispatcher(), {
          name: "Toko Uji",
          segment: "planet" as never,
          waPhone: uniqueWa(),
          addresses: [{ label: "Utama", addressText: "Jl. Raya 1, Cianjur" }],
        }),
      ).rejects.toThrow(/Segmen/);
      await expect(
        m1.createCustomer(dispatcher(), {
          name: "Toko Uji",
          segment: "hotel",
          waPhone: uniqueWa(),
          addresses: [],
        }),
      ).rejects.toThrow(/Minimal satu alamat/);

      const res = await newCustomer({
        contactName: "Bu Rina",
        notes: "Masuk gerbang belakang",
        fixedReceiveTime: "07:30",
      });
      expect(res.customer.waPhone).toMatch(/^628/);
      expect(res.customer.contactName).toBe("Bu Rina");
      expect(res.customer.fixedReceiveTime).toBe("07:30:00");
      expect(res.addresses).toHaveLength(1);
    });

    it("US-M1-01 KP-1 hanya Dispatcher yang membuat pelanggan (Admin Keuangan ditolak & tercatat)", async () => {
      await expect(
        m1.createCustomer(finance(), {
          name: "X",
          segment: "hotel",
          waPhone: uniqueWa(),
          addresses: [{ label: "U", addressText: "Jl. Raya 1, Cianjur" }],
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("US-M1-01 KP-2 alamat berkoordinat dikunci & dipetakan otomatis ke satu zona; tanpa koordinat = Belum dikunci + Zona manual beralasan", async () => {
      const res = await newCustomer({
        addresses: [
          {
            label: "Utama",
            addressText: "Jl. Cugenang Km 2, Cugenang",
            lat: -6.7712 + 0.01,
            lng: 107.0853,
          },
          {
            label: "Gudang",
            addressText: "Kp. Tanpa Titik, Cilaku",
            manualZoneId: tariffZoneId("Z2"),
            manualZoneReason: "Belum ada koordinat",
          },
          { label: "Cadangan", addressText: "Kp. Tanpa Titik Dua, Cilaku" },
        ],
      });
      const [a, b, c] = res.addresses;
      expect(a!.coordinateStatus).toBe("locked");
      expect(a!.coordinateSource).toBe("map");
      expect(a!.zoneAssignment).toBe("auto");
      expect(a!.tariffZoneId).toBe(tariffZoneId("Z1"));
      expect(a!.distanceMethod).toBe("straight_line_x1_3");
      expect(b!.coordinateStatus).toBe("unlocked");
      expect(b!.zoneAssignment).toBe("manual");
      expect(b!.tariffZoneId).toBe(tariffZoneId("Z2"));
      expect(c!.tariffZoneId).toBeNull();
      // Zona manual tanpa alasan ditolak.
      await expect(
        m1.addAddress(dispatcher(), res.customer.id, {
          label: "X",
          addressText: "Jl. Tanpa alasan, Cianjur",
          manualZoneId: tariffZoneId("Z3"),
        }),
      ).rejects.toThrow(/Alasan zona manual/);
    });

    it("US-M1-01 KP-2 lokasi Selesai rit pertama diusulkan sebagai koordinat; Dispatcher diberi tahu lalu mengonfirmasi (idempoten)", async () => {
      const res = await newCustomer({
        addresses: [
          {
            label: "Utama",
            addressText: "Kp. Belum Dikunci, Cilaku",
            manualZoneId: tariffZoneId("Z2"),
            manualZoneReason: "Tanpa titik",
          },
        ],
      });
      const address = res.addresses[0]!;
      const truck = await createTruck(t.db);
      const order = await createOrder(t.db, {
        customerId: res.customer.id,
        addressId: address.id,
        date: TODAY,
      });
      const trip = await createScheduledTrip(t.db, {
        order,
        truckId: truck.id,
        date: TODAY,
      });
      await t.db
        .update(trips)
        .set({
          status: "completed",
          completedAt: T0,
          completedLat: -6.842,
          completedLng: 107.139,
        })
        .where(eq(trips.id, trip.id));
      const payload = {
        tripId: trip.id,
        orderId: order.id,
        customerId: res.customer.id,
        truckId: truck.id,
        driverUserId: null,
        isInternal: false,
        volumeL: 5000,
        price: 200_000,
        paymentMethod: "cash" as const,
        cashReceived: 200_000,
        transferAmount: 0,
        creditAmount: 0,
        underpaymentAmount: 0,
        completedAt: T0.toISOString(),
        recordedByOffice: false,
        lateSync: false,
      };
      await withTx((tx) =>
        emit(tx, "trip.completed", payload, {
          tenantId: EQUA_TENANT_ID,
          occurredAt: T0,
        }),
      );
      await withTx((tx) =>
        emit(tx, "trip.completed", payload, {
          tenantId: EQUA_TENANT_ID,
          occurredAt: T0,
        }),
      );
      const [row] = await t.db
        .select()
        .from(customerAddresses)
        .where(eq(customerAddresses.id, address.id));
      expect(row!.proposedLat).toBe(-6.842);
      expect(row!.proposedFromTripId).toBe(trip.id);
      expect(row!.coordinateStatus).toBe("unlocked");
      const notes = await t.db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.event, "address.coordinate_proposed"),
            eq(notifications.objectId, address.id),
            eq(notifications.recipientUserId, userIdByUsername("dispatcher1")),
          ),
        );
      expect(notes).toHaveLength(1);
      const proposals = await m1.listCoordinateProposals(dispatcher());
      expect(
        proposals.some(
          (p) => p.addressId === address.id && p.tripNumber === trip.number,
        ),
      ).toBe(true);

      const locked = await m1.confirmCoordinateProposal(
        dispatcher(),
        address.id,
      );
      expect(locked.coordinateStatus).toBe("locked");
      expect(locked.coordinateSource).toBe("first_delivery");
      expect(locked.zoneAssignment).toBe("auto");
      expect(locked.tariffZoneId).not.toBeNull();
      expect(locked.proposedLat).toBeNull();
      // Rit berikutnya tidak mengusulkan lagi (alamat sudah Dikunci).
      const again = await withTx((tx) =>
        m1.proposeCoordinateFromTrip(tx, {
          tripId: trip.id,
          tenantId: EQUA_TENANT_ID,
          now: T0,
        }),
      );
      expect(again.proposed).toBe(false);
    });

    it("US-M1-01 KP-2 Dispatcher dapat menolak usulan koordinat beralasan; alamat tetap Belum dikunci", async () => {
      const res = await newCustomer({
        addresses: [
          { label: "Utama", addressText: "Kp. Usulan Ditolak, Cilaku" },
        ],
      });
      await t.db
        .update(customerAddresses)
        .set({ proposedLat: -6.9, proposedLng: 107.2, proposedAt: T0 })
        .where(eq(customerAddresses.id, res.addresses[0]!.id));
      const after = await m1.rejectCoordinateProposal(
        dispatcher(),
        res.addresses[0]!.id,
        "Titik di jalan raya, bukan rumah",
      );
      expect(after.proposedLat).toBeNull();
      expect(after.coordinateStatus).toBe("unlocked");
    });

    it("US-M1-01 KP-3 pelanggan baru berstatus Tunai (riwayat BR-01) dan Dispatcher tidak dapat mengubah status/batas/tempo", async () => {
      const res = await newCustomer();
      expect(res.customer.creditStatus).toBe("cash");
      const history = await t.db
        .select()
        .from(customerCreditHistory)
        .where(eq(customerCreditHistory.customerId, res.customer.id));
      expect(history[0]!.toStatus).toBe("cash");
      expect(history[0]!.rule).toBe("BR-01");
      // Skema ubah pelanggan tidak menerima status kredit/batas — nilai diabaikan.
      const upd = await m1.updateCustomer(dispatcher(), res.customer.id, {
        notes: "Catatan baru",
        creditStatus: "credit",
        creditLimit: 99_000_000,
      } as never);
      expect(upd.status).toBe("updated");
      const [row] = await t.db
        .select()
        .from(customers)
        .where(eq(customers.id, res.customer.id));
      expect(row!.creditStatus).toBe("cash");
      expect(row!.creditLimit).toBe(10_000_000);
    });

    it("US-M1-01 KP-4 batas kredit otomatis dari segmen (PAR-10) & tempo standar 14 hari (PAR-08); rumah tangga tunai tanpa batas", async () => {
      const hotel = await newCustomer({ segment: "hotel" });
      expect(hotel.customer.creditLimit).toBe(10_000_000);
      expect(hotel.customer.paymentTermDays).toBe(14);
      const depot = await newCustomer({ segment: "third_party_depot" });
      expect(depot.customer.creditLimit).toBe(3_000_000);
      const house = await newCustomer({ segment: "household" });
      expect(house.customer.creditLimit).toBe(0);
      // Segmen berubah → batas bawaan ikut berubah (bila belum diubah pemilik).
      const moved = await m1.updateCustomer(dispatcher(), depot.customer.id, {
        segment: "industry",
      });
      expect(moved.status === "updated" && moved.customer.creditLimit).toBe(
        10_000_000,
      );
      // Pelanggan Tempo tidak dapat dipindah ke rumah tangga (BR-04).
      await t.db
        .update(customers)
        .set({ creditStatus: "credit" })
        .where(eq(customers.id, hotel.customer.id));
      await expect(
        m1.updateCustomer(dispatcher(), hotel.customer.id, {
          segment: "household",
        }),
      ).rejects.toThrow(/hanya tunai/);
      // Batasan DB: rumah tangga tidak pernah Tempo.
      await expect(
        t.db
          .update(customers)
          .set({ creditStatus: "credit" })
          .where(eq(customers.id, house.customer.id)),
      ).rejects.toThrow();
    });

    it("US-M1-01 KP-6 penanda mitra toko otomatis untuk depot pihak ketiga dengan pesanan Selesai ≤ 90 hari; manual untuk mitra depot EQUA", async () => {
      const active = await newCustomer({ segment: "third_party_depot" });
      const idle = await newCustomer({ segment: "third_party_depot" });
      const o = await createOrder(t.db, {
        customerId: active.customer.id,
        addressId: active.addresses[0]!.id,
        date: TODAY,
      });
      await t.db
        .update(orders)
        .set({ status: "completed", completedAt: days(-10) })
        .where(eq(orders.id, o.id));
      const old = await createOrder(t.db, {
        customerId: idle.customer.id,
        addressId: idle.addresses[0]!.id,
        date: TODAY,
      });
      await t.db
        .update(orders)
        .set({ status: "completed", completedAt: days(-120) })
        .where(eq(orders.id, old.id));
      await t.db
        .update(customers)
        .set({ isStorePartner: true, storePartnerSource: "auto" })
        .where(eq(customers.id, idle.customer.id));

      const res = await withTx((tx) => m1.refreshStorePartnerFlags(tx, T0));
      expect(res.flagged).toBeGreaterThanOrEqual(1);
      const [a] = await t.db
        .select()
        .from(customers)
        .where(eq(customers.id, active.customer.id));
      const [b] = await t.db
        .select()
        .from(customers)
        .where(eq(customers.id, idle.customer.id));
      expect(a!.isStorePartner).toBe(true);
      expect(a!.storePartnerSource).toBe("auto");
      expect(b!.isStorePartner).toBe(false);

      const manual = await m1.setStorePartner(dispatcher(), idle.customer.id, {
        isStorePartner: true,
        reason: "Mitra depot EQUA (RL-7)",
      });
      expect(manual.storePartnerSource).toBe("manual");
      await withTx((tx) => m1.refreshStorePartnerFlags(tx, T0));
      const [c] = await t.db
        .select()
        .from(customers)
        .where(eq(customers.id, idle.customer.id));
      expect(c!.isStorePartner).toBe(true);
    });

    it("US-M1-01 KP-7 WA sama atau nama+alamat mirip → kandidat ditampilkan, tidak memblokir; konfirmasi tetap menyimpan", async () => {
      const wa = uniqueWa();
      const first = await newCustomer({
        name: "Depot Air Sumber Rejeki",
        segment: "third_party_depot",
        waPhone: wa,
        addresses: [
          {
            label: "Utama",
            addressText: "Jl. Raya Sukaresmi No. 17, Sukaresmi",
            lat: -6.75,
            lng: 107.14,
          },
        ],
      });
      const byWa = await m1.createCustomer(dispatcher(), {
        name: "Nama Lain Sekali",
        segment: "hotel",
        waPhone: wa,
        addresses: [
          { label: "Utama", addressText: "Alamat yang berbeda jauh, Mande" },
        ],
      });
      expect(byWa.status).toBe("duplicates");
      if (byWa.status === "duplicates")
        expect(byWa.candidates[0]).toMatchObject({
          customerId: first.customer.id,
          reason: "wa",
        });

      const byName = await m1.createCustomer(dispatcher(), {
        name: "Depot Air Sumber Rejeki",
        segment: "third_party_depot",
        waPhone: uniqueWa(),
        addresses: [
          { label: "Utama", addressText: "Jl Raya Sukaresmi No 17 Sukaresmi" },
        ],
      });
      expect(byName.status).toBe("duplicates");
      if (byName.status === "duplicates")
        expect(
          byName.candidates.some(
            (c) =>
              c.customerId === first.customer.id && c.reason === "name_address",
          ),
        ).toBe(true);

      const confirmed = await m1.createCustomer(dispatcher(), {
        name: "Nama Lain Sekali",
        segment: "hotel",
        waPhone: wa,
        addresses: [
          { label: "Utama", addressText: "Alamat yang berbeda jauh, Mande" },
        ],
        confirmDuplicate: true,
        duplicateNote: "Satu pemilik dua usaha",
      });
      expect(confirmed.status).toBe("created");
    });

    it("US-M1-01 KP-8 tidak dapat dihapus; nonaktif beralasan; ditolak bila ada pesanan aktif atau piutang terbuka", async () => {
      const withOrder = await newCustomer();
      await createOrder(t.db, {
        customerId: withOrder.customer.id,
        addressId: withOrder.addresses[0]!.id,
        date: TODAY,
      });
      await expect(
        m1.deactivateCustomer(
          dispatcher(),
          withOrder.customer.id,
          "Pindah usaha",
        ),
      ).rejects.toThrow(/pesanan aktif/);

      const withDebt = await newCustomer();
      await t.db.insert(invoices).values({
        tenantId: EQUA_TENANT_ID,
        number: `F-26-9${Math.floor(Math.random() * 99999)}`,
        kind: "delivery",
        customerId: withDebt.customer.id,
        issueDate: TODAY,
        dueDate: TODAY,
        amount: 250_000,
        outstandingAmount: 250_000,
      });
      await expect(
        m1.deactivateCustomer(
          dispatcher(),
          withDebt.customer.id,
          "Pindah usaha",
        ),
      ).rejects.toThrow(/piutang terbuka/);

      const clean = await newCustomer();
      await expect(
        m1.deactivateCustomer(dispatcher(), clean.customer.id, ""),
      ).rejects.toThrow(/Alasan/);
      const off = await m1.deactivateCustomer(
        dispatcher(),
        clean.customer.id,
        "Usaha tutup",
      );
      expect(off.isActive).toBe(false);
      expect(off.deactivationReason).toBe("Usaha tutup");
      // Penghapusan ditolak basis data (Bab 6.1).
      await expect(
        t.db.delete(customers).where(eq(customers.id, clean.customer.id)),
      ).rejects.toThrow();
      const back = await m1.reactivateCustomer(
        dispatcher(),
        clean.customer.id,
        "Buka kembali",
      );
      expect(back.isActive).toBe(true);
    });

    it("US-M1-01 KP-9 ringkasan: piutang terbuka, batas tersisa (BR-06), 10 pesanan terakhir, rata-rata jarak antar pesanan, catatan khusus, harga khusus aktif", async () => {
      const res = await newCustomer({
        notes: "Akses lewat gang samping",
        fixedReceiveTime: "08:00",
      });
      const addr = res.addresses[0]!.id;
      for (let i = 0; i < 12; i++) {
        await createOrder(t.db, {
          customerId: res.customer.id,
          addressId: addr,
          date: `2026-09-${String(1 + i * 2).padStart(2, "0")}`,
          pricePerTrip: 200_000,
        });
      }
      const credit = await createOrder(t.db, {
        customerId: res.customer.id,
        addressId: addr,
        date: "2026-10-06",
        pricePerTrip: 300_000,
      });
      await t.db
        .update(orders)
        .set({ paymentMethod: "credit" })
        .where(eq(orders.id, credit.id));
      await t.db.insert(invoices).values({
        tenantId: EQUA_TENANT_ID,
        number: `F-26-8${Math.floor(Math.random() * 99999)}`,
        kind: "delivery",
        customerId: res.customer.id,
        issueDate: TODAY,
        dueDate: TODAY,
        amount: 500_000,
        outstandingAmount: 500_000,
      });
      const summary = await m1.getCustomerSummary(
        dispatcher(),
        res.customer.id,
      );
      expect(summary.openReceivable).toBe(500_000);
      expect(summary.openCreditOrders).toBe(300_000);
      expect(summary.remainingLimit).toBe(10_000_000 - 800_000);
      expect(summary.lastOrders).toHaveLength(10);
      expect(summary.lastOrders[0]!.requestedDate).toBe("2026-10-06");
      expect(summary.averageDaysBetweenOrders).not.toBeNull();
      expect(summary.notes).toBe("Akses lewat gang samping");
      // Harga khusus aktif pelanggan seed (Hotel Puncak Cianjur).
      const seeded = await m1.getCustomerSummary(
        dispatcher(),
        seedCustomerId("PLG-0033"),
      );
      expect(seeded.activeSpecialPrices[0]).toMatchObject({
        price: 240_000,
        reviewOverdue: true,
      });
    });

    it("US-M1-01 KP-10 semua perubahan pelanggan & alamat berjejak audit (nilai lama/baru, pelaku)", async () => {
      const res = await newCustomer();
      await m1.updateCustomer(dispatcher(), res.customer.id, {
        contactName: "Pak Budi",
      });
      await m1.setAddressManualZone(dispatcher(), res.addresses[0]!.id, {
        zoneId: tariffZoneId("Z3"),
        reason: "Di batas zona, jalan memutar",
      });
      const logs = await t.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.objectId, res.customer.id));
      expect(logs.map((l) => l.action)).toEqual(
        expect.arrayContaining(["create", "update"]),
      );
      const upd = logs.find((l) => l.action === "update")!;
      expect(upd.before).toMatchObject({ contactName: null });
      expect(upd.after).toMatchObject({ contactName: "Pak Budi" });
      expect(upd.actorUserId).toBe(userIdByUsername("dispatcher1"));
      const addrLogs = await t.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.objectId, res.addresses[0]!.id));
      expect(
        addrLogs.some((l) => l.reason === "Di batas zona, jalan memutar"),
      ).toBe(true);
    });

    it("US-M2-01 KP-1 pencarian pelanggan (nama/WA/alamat) setelah 2 karakter; hasil memuat alamat & alamat terakhir; ≤ 1 detik", async () => {
      const res = await newCustomer({
        name: "Kolam Renang Cari Saya",
        segment: "swimming_pool",
        addresses: [
          {
            label: "Utama",
            addressText: "Jl. Pencarian Unik 77, Mande",
            lat: -6.78,
            lng: 107.23,
          },
        ],
      });
      expect(await m1.searchCustomers(dispatcher(), "K")).toEqual([]);
      const started = Date.now();
      const byName = await m1.searchCustomers(dispatcher(), "cari saya");
      expect(Date.now() - started).toBeLessThan(1000);
      expect(byName[0]!.id).toBe(res.customer.id);
      expect(byName[0]!.addresses[0]!.zoneCode).toBeTruthy();
      const byAddress = await m1.searchCustomers(
        dispatcher(),
        "Pencarian Unik",
      );
      expect(byAddress.map((r) => r.id)).toContain(res.customer.id);
      const byWa = await m1.searchCustomers(
        dispatcher(),
        `0${res.customer.waPhone.slice(2, 9)}`,
      );
      expect(byWa.map((r) => r.id)).toContain(res.customer.id);
      expect(byName[0]!.lastAddressId).toBe(res.addresses[0]!.id);
    });

    it("US-M2-01 KP-3 pelanggan baru dari layar pesanan: nama, WA, alamat, segmen — otomatis Tunai", async () => {
      const res = await m1.quickCreateCustomer(dispatcher(), {
        name: "Pelanggan Telepon Baru",
        waPhone: uniqueWa(),
        segment: "construction",
        addressText: "Lokasi proyek baru, Cibeber",
      });
      expect(res.status).toBe("created");
      if (res.status === "created") {
        expect(res.customer.creditStatus).toBe("cash");
        expect(res.addresses[0]!.label).toBe("Utama");
      }
      await expect(
        m1.quickCreateCustomer(ctxOf("keuangan1"), {
          name: "X",
          waPhone: uniqueWa(),
          segment: "hotel",
          addressText: "Jl. Raya 2, Cianjur",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("US-M1-06 KP-3 pelanggan data awal hanya diubah lewat koreksi berjejak (alasan wajib)", async () => {
      const id = seedCustomerId("PLG-0001");
      await expect(
        m1.updateCustomer(dispatcher(), id, { contactName: "Pak Baru" }),
      ).rejects.toBeInstanceOf(DomainError);
      const ok = await m1.updateCustomer(dispatcher(), id, {
        contactName: "Pak Baru",
        correctionReason: "Kontak berganti sejak Agustus",
      });
      expect(ok.status).toBe("updated");
      const logs = await t.db
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.objectId, id), eq(auditLogs.action, "correct")),
        );
      expect(logs[0]!.reason).toBe("Kontak berganti sejak Agustus");
    });

    it("PTB-02 sumber air acuan dapat diubah Dispatcher beralasan (jarak & zona dihitung ulang)", async () => {
      const res = await newCustomer({
        addresses: [
          {
            label: "Utama",
            addressText: "Jl. Dekat SA1, Cugenang",
            lat: -6.775,
            lng: 107.087,
          },
        ],
      });
      const addr = res.addresses[0]!;
      const other = seedId("water_source:SA2");
      const after = await m1.setAddressReferenceSource(dispatcher(), addr.id, {
        waterSourceId: other,
        reason: "Truk selalu mengisi di SA2",
      });
      expect(after.referenceWaterSourceId).toBe(other);
      expect(after.referenceSourceManual).toBe(true);
      expect(after.distanceM!).toBeGreaterThan(addr.distanceM!);
      await expect(
        m1.setAddressReferenceSource(dispatcher(), addr.id, {
          waterSourceId: other,
          reason: "",
        }),
      ).rejects.toThrow(/Alasan/);
      void owner;
    });
  });
});
