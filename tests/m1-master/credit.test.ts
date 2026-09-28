import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  approvalRequests,
  customerCreditHistory,
  customers,
  domainEvents,
  incomingTransfers,
  invoices,
  specialPrices,
} from "@/db/schema";
import {
  customerId as seedCustomerId,
  EQUA_TENANT_ID,
  productId,
} from "@/db/seed";
import * as approvals from "@/server/core/approvals";
import { ForbiddenError } from "@/server/core/errors";
import * as m1 from "@/server/modules/m1-master";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import {
  completedOrders,
  days,
  dispatcher,
  failedRefusedTrip,
  finance,
  owner,
  T0,
  TODAY,
  uniqueWa,
} from "./helpers";

describe("M1 Master Data", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  async function customer(
    segment: m1.CreateCustomerInput["segment"] = "hotel",
  ) {
    const res = await m1.createCustomer(dispatcher(), {
      name: `Pelanggan Kredit ${Math.random().toString(36).slice(2, 8)}`,
      segment,
      waPhone: uniqueWa(),
      addresses: [
        {
          label: "Utama",
          addressText: "Jl. Kredit No. 1, Cianjur",
          lat: -6.83,
          lng: 107.15,
        },
      ],
      confirmDuplicate: true,
    });
    if (res.status !== "created") throw new Error("gagal");
    return { id: res.customer.id, addressId: res.addresses[0]!.id };
  }

  describe("US-M1-01 KP-3 syarat Tempo (PAR-11 + PAR-82) dan persetujuan pemilik", () => {
    it("US-M1-01 KP-3 pelanggan baru tidak layak Tempo; tombol Ajukan Tempo tidak aktif (pengajuan ditolak dengan alasan)", async () => {
      const c = await customer();
      const e = await m1.getCreditEligibility(dispatcher(), c.id);
      expect(e.eligible).toBe(false);
      expect(e.reasons.join(" ")).toMatch(/PAR-11/);
      await expect(
        m1.requestCreditGrant(dispatcher(), c.id, {
          reason: "Pelanggan besar",
        }),
      ).rejects.toMatchObject({ code: "CREDIT_NOT_ELIGIBLE" });
    });

    it("US-M1-01 KP-3 ≥ 10 pesanan Selesai ATAU ≥ 3 bulan sejak Selesai pertama → layak; persetujuan pemilik wajib → status Tempo", async () => {
      const byCount = await customer();
      await completedOrders(t.db, {
        customerId: byCount.id,
        addressId: byCount.addressId,
        count: 10,
        startDaysAgo: 30,
      });
      const byMonths = await customer();
      await completedOrders(t.db, {
        customerId: byMonths.id,
        addressId: byMonths.addressId,
        count: 2,
        startDaysAgo: 100,
      });
      expect(
        (await m1.getCreditEligibility(dispatcher(), byCount.id)).eligible,
      ).toBe(true);
      expect(
        (await m1.getCreditEligibility(dispatcher(), byMonths.id)).eligible,
      ).toBe(true);

      const req = await m1.requestCreditGrant(dispatcher(), byCount.id, {
        reason: "Rutin 3×/minggu, bayar tepat",
      });
      expect(req.type).toBe("credit_grant");
      expect(req.approverRole).toBe("owner");
      // Status belum berubah sebelum pemilik memutuskan.
      expect(
        (
          await t.db
            .select()
            .from(customers)
            .where(eq(customers.id, byCount.id))
        )[0]!.creditStatus,
      ).toBe("cash");
      // Pemohon tidak dapat memutuskan sendiri; Dispatcher bukan penyetuju.
      await expect(
        approvals.decide(dispatcher(), req.id, "approve"),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await approvals.decide(owner(), req.id, "approve", "Disetujui");
      const [row] = await t.db
        .select()
        .from(customers)
        .where(eq(customers.id, byCount.id));
      expect(row!.creditStatus).toBe("credit");
      expect(row!.creditLimit).toBe(10_000_000);
      const hist = await t.db
        .select()
        .from(customerCreditHistory)
        .where(
          and(
            eq(customerCreditHistory.customerId, byCount.id),
            eq(customerCreditHistory.toStatus, "credit"),
          ),
        );
      expect(hist[0]!.approvalRequestId).toBe(req.id);
      const ev = await t.db
        .select()
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.type, "credit_status.changed"),
            eq(domainEvents.objectId, byCount.id),
          ),
        );
      expect(ev[0]!.payload).toMatchObject({ from: "cash", to: "credit" });
    });

    it("US-M1-01 KP-3 syarat tanpa masalah PAR-82: kurang bayar lewat 7 hari, transfer Tidak ditemukan, sengketa ditolak, > 1 rit gagal pelanggan menolak → tidak layak", async () => {
      const cases: {
        name: string;
        setup: (c: { id: string; addressId: string }) => Promise<void>;
        match: RegExp;
      }[] = [
        {
          name: "kurang bayar",
          setup: async (c) => {
            await t.db
              .insert(invoices)
              .values({
                tenantId: EQUA_TENANT_ID,
                number: `F-26-U${Math.floor(Math.random() * 1e6)}`,
                kind: "underpayment",
                customerId: c.id,
                issueDate: "2026-09-01",
                dueDate: "2026-09-01",
                amount: 50_000,
                outstandingAmount: 50_000,
              });
          },
          match: /kurang bayar/,
        },
        {
          name: "transfer",
          setup: async (c) => {
            await t.db
              .insert(incomingTransfers)
              .values({
                tenantId: EQUA_TENANT_ID,
                customerId: c.id,
                amount: 200_000,
                transferDate: "2026-09-10",
                businessDate: "2026-09-10",
                status: "not_found",
                notFoundAt: days(-20),
                sourceKind: "trip_payment",
              } as never);
          },
          match: /Tidak ditemukan/,
        },
        {
          name: "sengketa",
          setup: async (c) => {
            await t.db
              .insert(invoices)
              .values({
                tenantId: EQUA_TENANT_ID,
                number: `F-26-S${Math.floor(Math.random() * 1e6)}`,
                kind: "delivery",
                customerId: c.id,
                issueDate: "2026-09-02",
                dueDate: "2026-09-16",
                amount: 200_000,
                paidAmount: 200_000,
                outstandingAmount: 0,
                status: "paid",
                disputeStatus: "rejected",
              });
          },
          match: /sengketa/,
        },
        {
          name: "rit gagal",
          setup: async (c) => {
            await failedRefusedTrip(t.db, {
              customerId: c.id,
              addressId: c.addressId,
              at: days(-5),
            });
            await failedRefusedTrip(t.db, {
              customerId: c.id,
              addressId: c.addressId,
              at: days(-4),
            });
          },
          match: /pelanggan menolak/,
        },
      ];
      for (const k of cases) {
        const c = await customer();
        await completedOrders(t.db, {
          customerId: c.id,
          addressId: c.addressId,
          count: 10,
          startDaysAgo: 60,
        });
        await k.setup(c);
        const e = await m1.getCreditEligibility(dispatcher(), c.id);
        expect(e.eligible, k.name).toBe(false);
        expect(e.reasons.join(" "), k.name).toMatch(k.match);
      }
      // Satu rit gagal karena menolak masih diperbolehkan.
      const ok = await customer();
      await completedOrders(t.db, {
        customerId: ok.id,
        addressId: ok.addressId,
        count: 10,
        startDaysAgo: 60,
      });
      await failedRefusedTrip(t.db, {
        customerId: ok.id,
        addressId: ok.addressId,
        at: days(-3),
      });
      expect(
        (await m1.getCreditEligibility(dispatcher(), ok.id)).eligible,
      ).toBe(true);
    });

    it("US-M1-01 KP-3 hanya Dispatcher yang mengajukan Tempo; pemilik menolak → status tetap Tunai", async () => {
      const c = await customer();
      await completedOrders(t.db, {
        customerId: c.id,
        addressId: c.addressId,
        count: 10,
        startDaysAgo: 40,
      });
      await expect(
        m1.requestCreditGrant(finance(), c.id, { reason: "x" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const req = await m1.requestCreditGrant(dispatcher(), c.id, {
        reason: "Pelanggan hotel rutin",
      });
      await approvals.decide(owner(), req.id, "reject", "Tunggu 1 bulan lagi");
      expect(
        (await t.db.select().from(customers).where(eq(customers.id, c.id)))[0]!
          .creditStatus,
      ).toBe("cash");
    });
  });

  describe("US-M1-01 KP-4 batas & tempo per pelanggan hanya diubah pemilik; rumah tangga tunai tanpa pengecualian", () => {
    it("US-M1-01 KP-4 rumah tangga tidak pernah layak Tempo walau memenuhi syarat volume (BR-04)", async () => {
      const c = await customer("household");
      await completedOrders(t.db, {
        customerId: c.id,
        addressId: c.addressId,
        count: 12,
        startDaysAgo: 120,
      });
      const e = await m1.getCreditEligibility(dispatcher(), c.id);
      expect(e.eligible).toBe(false);
      expect(e.reasons.join(" ")).toMatch(/BR-04/);
      await expect(
        m1.requestCreditTermsChange(dispatcher(), c.id, {
          creditLimit: 1_000_000,
          paymentTermDays: 14,
          reason: "x y z",
        }),
      ).rejects.toMatchObject({ code: "HOUSEHOLD_CASH_ONLY" });
    });

    it("US-M1-01 KP-4 ubah batas/tempo pelanggan Tempo lewat persetujuan pemilik (alasan tercatat; riwayat)", async () => {
      const id = seedCustomerId("PLG-0024");
      const req = await m1.requestCreditTermsChange(dispatcher(), id, {
        creditLimit: 15_000_000,
        paymentTermDays: 21,
        reason: "Volume naik 2× sejak Agustus",
      });
      expect(req.type).toBe("credit_terms_change");
      await approvals.decide(owner(), req.id, "approve");
      const [row] = await t.db
        .select()
        .from(customers)
        .where(eq(customers.id, id));
      expect(row!.creditLimit).toBe(15_000_000);
      expect(row!.paymentTermDays).toBe(21);
      expect(row!.creditLimitOverridden).toBe(true);
      const hist = await t.db
        .select()
        .from(customerCreditHistory)
        .where(
          and(
            eq(customerCreditHistory.customerId, id),
            eq(customerCreditHistory.approvalRequestId, req.id),
          ),
        );
      expect(hist[0]).toMatchObject({
        creditLimitBefore: 10_000_000,
        creditLimitAfter: 15_000_000,
        termDaysAfter: 21,
      });
      // Pelanggan Tunai belum dapat mengajukan ubah batas.
      const cash = await customer();
      await expect(
        m1.requestCreditTermsChange(dispatcher(), cash.id, {
          creditLimit: 1,
          paymentTermDays: 7,
          reason: "abc",
        }),
      ).rejects.toMatchObject({ code: "NOT_CREDIT_CUSTOMER" });
    });
  });

  describe("US-M1-01 KP-5 harga khusus per pelanggan per produk (BR-16)", () => {
    it("US-M1-01 KP-5 diajukan dengan alasan & tanggal mulai, tinjauan otomatis 6 bulan, berlaku hanya setelah persetujuan pemilik", async () => {
      const c = await customer();
      const before = await m1.resolveTruckWaterPrice(t.db, {
        customerId: c.id,
        addressId: c.addressId,
        date: TODAY,
      });
      expect(before.source).toBe("zone");
      const { specialPrice, approval } = await m1.requestSpecialPrice(
        dispatcher(),
        {
          customerId: c.id,
          productId: productId("AIR-TRUK"),
          price: 190_000,
          validFrom: TODAY,
          reason: "Kontrak volume 30 rit/bulan",
        },
      );
      expect(specialPrice.status).toBe("pending");
      expect(specialPrice.reviewDate).toBe("2027-04-05");
      expect(
        (
          await m1.resolveTruckWaterPrice(t.db, {
            customerId: c.id,
            addressId: c.addressId,
            date: TODAY,
          })
        ).source,
      ).toBe("zone");
      await approvals.decide(owner(), approval.id, "approve");
      const after = await m1.resolveTruckWaterPrice(t.db, {
        customerId: c.id,
        addressId: c.addressId,
        date: TODAY,
      });
      expect(after).toMatchObject({
        source: "special",
        unitPrice: 190_000,
        specialPriceId: specialPrice.id,
      });
      // Tanpa alasan ditolak; pemilik/Admin Keuangan tidak mengajukan.
      await expect(
        m1.requestSpecialPrice(dispatcher(), {
          customerId: c.id,
          productId: productId("AIR-TRUK"),
          price: 1,
          validFrom: TODAY,
          reason: "",
        }),
      ).rejects.toThrow(/Alasan/);
      await expect(
        m1.requestSpecialPrice(finance(), {
          customerId: c.id,
          productId: productId("AIR-TRUK"),
          price: 1,
          validFrom: TODAY,
          reason: "abc",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("US-M1-01 KP-5 harga khusus lewat tanggal tinjauan tetap berlaku dan tampil pada daftar tinjauan pemilik (notifikasi bulanan)", async () => {
      const id = seedCustomerId("PLG-0033");
      const price = await m1.resolveTruckWaterPrice(t.db, {
        customerId: id,
        addressId: (await m1.getCustomerDetail(owner(), id)).addresses[0]!.id,
        date: TODAY,
      });
      expect(price.source).toBe("special");
      const list = await m1.listSpecialPriceReviews(owner());
      const row = list.find((r) => r.customerId === id)!;
      expect(row.reviewDate).toBe("2025-07-01");
      expect(row.daysOverdue).toBeGreaterThan(0);
      const { notifySpecialPriceReviews } =
        await import("@/server/modules/m1-master/service/special-prices");
      const { withTx } = await import("@/server/core/db");
      const res = await withTx((tx) => notifySpecialPriceReviews(tx, T0));
      expect(res.due).toBeGreaterThanOrEqual(1);
      // Tinjauan pemilik: tetap berlaku → tanggal tinjauan berikutnya +6 bulan.
      const reviewed = await m1.reviewSpecialPrice(owner(), row.id, {
        action: "keep",
        note: "Masih pelanggan harian",
      });
      expect(reviewed.reviewDate).toBe("2027-04-05");
      expect(
        (await m1.listSpecialPriceReviews(owner())).some(
          (r) => r.id === row.id,
        ),
      ).toBe(false);
      await expect(
        m1.reviewSpecialPrice(dispatcher(), row.id, {
          action: "keep",
          note: "abc",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const [sp] = await t.db
        .select()
        .from(specialPrices)
        .where(eq(specialPrices.id, row.id));
      expect(sp!.status).toBe("active");
      void approvalRequests;
    });
  });
});
