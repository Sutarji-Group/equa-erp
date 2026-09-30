/**
 * M6 — perbaikan S5-B (audit PRD): harga master dipaksakan dengan jendela katalog offline (US-M6-01 KP-1, US-M6-06
 * KP-4), pasokan air diterima otomatis lalu dikonfirmasi tidak dijurnal ganda (BR-33), tunai tersinkron setelah shift
 * ditutup masuk setoran (US-M4-06 KP-7), harga transfer internal hilang dilaporkan (US-M6-05 KP-5).
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { customerAddresses, deposits, domainEvents, outlets, posSales, productPrices, products, shifts, waterSupplyReceipts } from "@/db/schema";
import { EQUA_TENANT_ID, internalCustomerId, outletId, userIdByUsername } from "@/db/seed";
import { addDays, toBusinessDate } from "@/lib/time";
import { systemContext } from "@/server/core/context";
import { withTx } from "@/server/core/db";
import { emit } from "@/server/core/events";
import * as m4 from "@/server/modules/m4-cash";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { createCustomer, createOrder, createScheduledTrip, createTruck, today } from "../helpers/fixtures";
import { closeVia, exactClosingStock, expectApplied, isi, notificationsFor, openShiftVia, P, posFor, PRICE, sellVia } from "./helpers";

describe("M6 — perbaikan audit S5-B", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  async function internalTripCompleted(outletCode: string, volumeL = 5_000, completedAt = new Date()) {
    const cust = await createCustomer(t.db, { segment: "third_party_depot" });
    const truck = await createTruck(t.db);
    const order = await createOrder(t.db, { customerId: cust.id, addressId: cust.addressId!, date: today() });
    const trip = await createScheduledTrip(t.db, { order, truckId: truck.id, date: today() });
    await withTx((tx) =>
      emit(
        tx,
        "trip.completed",
        {
          tripId: trip.id,
          orderId: order.id,
          customerId: cust.id,
          truckId: truck.id,
          driverUserId: userIdByUsername("sopir1"),
          isInternal: true,
          destinationOutletId: outletId(outletCode),
          volumeL,
          price: 0,
          paymentMethod: "internal" as const,
          cashReceived: 0,
          transferAmount: 0,
          creditAmount: 0,
          underpaymentAmount: 0,
          completedAt: completedAt.toISOString(),
          recordedByOffice: false,
          lateSync: false,
        },
        { ctx: systemContext({ tenantId: EQUA_TENANT_ID, now: completedAt }), objectType: "trip", objectId: trip.id },
      ),
    );
    return (await t.db.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.tripId, trip.id)))[0]!;
  }

  it("US-M6-01 KP-1 US-M6-06 KP-4 BR-15 harga perangkat hanya diterima bila harga master dalam jendela katalog offline; harga lain ditolak", async () => {
    const pos = await posFor("D02");
    const { shiftId } = await openShiftVia(pos);
    // Harga naik kemarin → harga lama (kemarin lusa) masih di katalog perangkat offline: diterima & ditandai.
    await t.db.insert(productPrices).values({
      tenantId: EQUA_TENANT_ID,
      productId: P.ISI,
      kind: "standard",
      outletId: pos.outletId,
      price: PRICE.ISI + 1_000,
      effectiveFrom: addDays(toBusinessDate(new Date()), -1),
      status: "active",
      isOwnerDirect: true,
      reason: "Uji harga naik",
      approvedAt: new Date(),
    });
    const stale = await sellVia(pos, shiftId, [isi(2, PRICE.ISI)]);
    expectApplied(stale.res);
    expect((await t.db.select().from(posSales).where(eq(posSales.id, stale.saleId)))[0]).toMatchObject({ priceMismatch: true, total: 2 * PRICE.ISI });
    // Harga rekaan (Rp 1) bukan harga master mana pun → ditolak, tidak mengurangi kas seharusnya.
    const cheap = await sellVia(pos, shiftId, [isi(10, 1)]);
    expect(cheap.res.status).toBe("rejected");
    expect(cheap.res.message).toMatch(/tidak sesuai harga master/);
  });

  it("US-M6-05 KP-2 BR-33 pasokan diterima otomatis (PAR-61) lalu dikonfirmasi operator: tidak ada nilai transfer internal ganda — hanya penyesuaian selisih", async () => {
    const pos = await posFor("D05");
    const arrived = await internalTripCompleted("D05", 5_000, new Date(Date.now() - 3_600_000));
    const { shiftId } = await openShiftVia(pos);
    expectApplied(await closeVia(pos, shiftId, { counted: 200_000 }));
    expect((await t.db.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.id, arrived.id)))[0]!.status).toBe("auto_accepted");
    // Konfirmasi operator tersinkron terlambat dengan volume sama → penyesuaian 0.
    const res = await pos.send("m6.water_supply.confirm", { receiptId: arrived.id, receivedVolumeL: 5_000 });
    expect(res.status).toBe("conflict");
    const evs = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "water_supply.confirmed"), eq(domainEvents.objectId, arrived.id)));
    const values = evs.map((e) => (e.payload as { transferValue: number; autoAccepted?: boolean; adjustmentOfAutoAccepted?: boolean }));
    expect(values).toHaveLength(2);
    expect(values.find((v) => v.autoAccepted)!.transferValue).toBeGreaterThan(0);
    expect(values.find((v) => v.adjustmentOfAutoAccepted)).toMatchObject({ transferValue: 0 });
  });

  it("US-M4-06 KP-7 7.6.6 tunai POS tersinkron setelah shift ditutup masuk setoran shift (belum diterima) atau setoran susulan (sudah diterima)", async () => {
    const pos = await posFor("D06");
    const { shiftId } = await openShiftVia(pos);
    const a = await sellVia(pos, shiftId, [isi(2)]);
    expectApplied(a.res);
    // Transaksi B dari perangkat rusak: uangnya sudah di laci saat hitung tutup.
    const counted = 200_000 + 2 * PRICE.ISI + 3 * PRICE.ISI;
    expectApplied(await closeVia(pos, shiftId, { counted, reason: "Ada transaksi di tablet rusak" }));
    const [closed] = await t.db.select().from(shifts).where(eq(shifts.id, shiftId));
    const depBefore = (await t.db.select().from(deposits).where(eq(deposits.id, closed!.depositId!)))[0]!;
    expect(depBefore.expectedCash).toBe(2 * PRICE.ISI);
    const b = await sellVia(pos, shiftId, [isi(3)]);
    expect(b.res.status).toBe("conflict");
    const depAfter = (await t.db.select().from(deposits).where(eq(deposits.id, closed!.depositId!)))[0]!;
    expect(depAfter.expectedCash).toBe(5 * PRICE.ISI);
    expect((await t.db.select().from(shifts).where(eq(shifts.id, shiftId)))[0]!.cashDifference).toBe(0);
    expect((await notificationsFor(t.db, "pos.late_cash_after_close", { objectId: depAfter.id })).length).toBeGreaterThan(0);
    // Setoran shift diterima; transaksi C tersinkron sesudahnya → setoran susulan outlet (bertanda).
    await m4.receiveDeposit(seededContext("keuangan1"), { depositId: depAfter.id, receivedAmount: 5 * PRICE.ISI });
    const c = await sellVia(pos, shiftId, [isi(1)]);
    expect(c.res.status).toBe("conflict");
    const extra = (await t.db.select().from(deposits).where(and(eq(deposits.outletId, pos.outletId), eq(deposits.submittedLate, true))))
      .filter((d) => (d.summarySnapshot as { kind?: string } | null)?.kind === "late_cash_after_close");
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatchObject({ status: "submitted", expectedCash: PRICE.ISI, shiftId: null });
  });

  it("US-M6-02 KP-3 US-M6-04 KP-3 tutup shift ditolak server tanpa stok fisik semua bahan utama; bahan baru setelah shift dibuka → konflik", async () => {
    const pos = await posFor("D04");
    const { shiftId } = await openShiftVia(pos);
    expectApplied((await sellVia(pos, shiftId, [isi(1)])).res);
    const counted = 200_000 + PRICE.ISI;
    // Tanpa stok sama sekali → ditolak dengan tindakan.
    const none = await closeVia(pos, shiftId, { counted, stock: [] });
    expect(none.status).toBe("rejected");
    expect(none.message).toMatch(/Isi stok fisik semua bahan utama/);
    // Sebagian bahan → ditolak, menyebut bahan yang belum diisi.
    const full = await exactClosingStock(shiftId);
    const partial = await closeVia(pos, shiftId, { counted, stock: full.filter((l) => l.productId !== P.TISU) });
    expect(partial.status).toBe("rejected");
    expect(partial.message).toMatch(/Tisu segel galon/);
    expect((await t.db.select().from(shifts).where(eq(shifts.id, shiftId)))[0]!.status).toBe("open");
    // Bahan baru ditambahkan master setelah shift dibuka (belum ada di perangkat) → tutup diterima sebagai konflik.
    await t.db.insert(products).values({
      tenantId: EQUA_TENANT_ID,
      code: "UJI-SEGEL-BARU",
      name: "Segel plastik baru",
      line: "depot",
      unit: "pcs",
      category: "bahan_habis_pakai",
      isConsumable: true,
      status: "active",
      sortOrder: 99,
    });
    const res = await closeVia(pos, shiftId, { counted, stock: full });
    expect(res.status, res.message ?? "").toBe("conflict");
    expect(res.message).toMatch(/Segel plastik baru/);
    expect((await t.db.select().from(shifts).where(eq(shifts.id, shiftId)))[0]!.status).toBe("closed");
  });

  it("US-M6-05 KP-5 BR-33 harga transfer internal tidak dapat ditentukan → Admin Keuangan diberi tahu & event membawa penanda (tidak hilang diam-diam)", async () => {
    const pos = await posFor("D03");
    await t.db.update(outlets).set({ lat: null, lng: null }).where(eq(outlets.id, pos.outletId));
    await t.db.update(customerAddresses).set({ tariffZoneId: null }).where(eq(customerAddresses.customerId, internalCustomerId("D03")));
    const r = await internalTripCompleted("D03", 4_000);
    expectApplied(await pos.send("m6.water_supply.confirm", { receiptId: r.id, receivedVolumeL: 4_000 }));
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "water_supply.confirmed"), eq(domainEvents.objectId, r.id)));
    expect(ev!.payload).toMatchObject({ transferValue: 0, transferPriceMissing: expect.stringMatching(/Zona/) });
    expect((await notificationsFor(t.db, "water_supply.transfer_price_missing", { objectId: r.id })).length).toBeGreaterThan(0);
  });
});
