/**
 * Uji constraint skema hasil tinjauan skema S0 (docs/dev/schema-review-s0.json): indeks unik parsial, CHECK, kolom
 * baru untuk alur offline/pembalik/tenant. Satu DB seed untuk seluruh berkas; setiap uji membuat datanya sendiri.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  approvalRequests,
  auditLogs,
  consumableReceipts,
  customers,
  delegations,
  deposits,
  fuelComponents,
  gpsPositions,
  incomingTransfers,
  internalTransfers,
  invoices,
  journals,
  meterReadings,
  officeCashMovements,
  orders,
  outletWaterLedger,
  productPrices,
  purchaseReceipts,
  recurringOrders,
  reportSnapshots,
  shifts,
  specialPrices,
  stockLedger,
  suppliers,
  tariffZoneBoundaries,
  tripExpenses,
  tripPayments,
  truckFills,
  waterMeters,
  waterSupplyReceipts,
  zoneTariffs,
} from "@/db/schema";
import {
  customerId,
  EQUA_TENANT_ID,
  outletId,
  productId,
  tariffZoneBoundaryId,
  tariffZoneId,
  truckId,
  userIdByUsername,
  waterSourceId,
} from "@/db/seed";
import { newId } from "@/lib/ids";

import { createTestDb, type TestDb } from "../helpers/db";
import {
  createJournalFixture,
  createPartnerTenant,
  createPosSaleFixture,
  createShiftFixture,
  createTripFixture,
  ensurePeriod,
  expectSqlState,
  PG,
  seedAddressId,
  uniqueSeq,
} from "../helpers/db-fixtures";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb({ seed: true });
});
afterAll(() => t.close());

const num = (prefix: string) => `${prefix}-${String(uniqueSeq()).padStart(6, "0")}`;

async function columnsOf(table: string): Promise<string[]> {
  const res = await t.db.execute<{ column_name: string }>(
    sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table}`,
  );
  return res.rows.map((r) => r.column_name);
}

describe("M6/M7 kas outlet, POS offline & koreksi", () => {
  it("US-M6-02 KP-2 KP-5 BR-08 setor sebagian: banyak setoran sebagian + tepat satu setoran akhir per shift", async () => {
    const shift = await createShiftFixture(t.db);
    const base = {
      tenantId: EQUA_TENANT_ID,
      sourceType: "depot_shift" as const,
      businessDate: "2026-09-28",
      outletId: shift.outletId,
      shiftId: shift.shiftId,
      method: "bank_slip" as const,
    };
    await t.db.insert(deposits).values({ ...base, number: num("S-26"), isPartial: true, expectedCash: 1_000_000 });
    await t.db.insert(deposits).values({ ...base, number: num("S-26"), isPartial: true, expectedCash: 800_000 });
    await t.db.insert(deposits).values({ ...base, number: num("S-26"), method: "physical", expectedCash: 350_000 });
    await expectSqlState(
      t.db.insert(deposits).values({ ...base, number: num("S-26"), method: "physical", expectedCash: 1 }),
      PG.uniqueViolation,
      "deposits_shift_final_uq",
    );
    await t.db.update(shifts).set({ partialDepositTotal: 1_800_000 }).where(eq(shifts.id, shift.shiftId));
  });

  it("US-M6-01 KP-4 US-M6-06 KP-2 nomor POS offline: nomor lokal unik per perangkat; nomor resmi diisi server & unik per outlet", async () => {
    const shift = await createShiftFixture(t.db);
    const device = newId();
    await t.db.execute(
      sql`insert into devices (id, tenant_id, device_code, name, kind) values (${device}, ${EQUA_TENANT_ID}, ${`HP-POS-${uniqueSeq()}`}, 'POS cadangan', 'tablet')`,
    );
    const a = await createPosSaleFixture(t.db, shift, { deviceId: device, localNumber: "D01-280926-P2-0007" });
    await expectSqlState(
      createPosSaleFixture(t.db, shift, { deviceId: device, localNumber: "D01-280926-P2-0007" }),
      PG.uniqueViolation,
      "pos_sales_device_local_number_uq",
    );
    // Dua perangkat berbeda boleh punya urutan lokal yang sama (kode perangkat berbeda di nomor lokal).
    await createPosSaleFixture(t.db, shift, { localNumber: "D01-280926-P2-0007" });
    // Nomor resmi (server) unik per outlet; baris yang belum sinkron boleh kosong berapa pun banyaknya.
    const official = num("D01-280926");
    await createPosSaleFixture(t.db, shift, { number: official });
    await expectSqlState(createPosSaleFixture(t.db, shift, { number: official }), PG.uniqueViolation, "pos_sales_outlet_number_uq");
    expect(a.saleId).toBeTruthy();
  });

  it("7.6.6 US-M6-06 KP-1 KP-3 shift offline yang bentrok disimpan sebagai konflik sinkron, bukan ditolak", async () => {
    const partner = await createPartnerTenant(t.db);
    const shiftArgs = { outletId: partner.outletId, tenantId: partner.tenantId, status: "open" as const };
    await createShiftFixture(t.db, shiftArgs);
    await expectSqlState(createShiftFixture(t.db, shiftArgs), PG.uniqueViolation, "shifts_one_open_per_outlet_uq");
    const conflict = await createShiftFixture(t.db, { ...shiftArgs, syncConflict: true });
    // Penjualan shift konflik tetap tersimpan (tidak ada transaksi hilang).
    await createPosSaleFixture(t.db, conflict);
    await t.db
      .update(shifts)
      .set({ conflictResolvedAt: new Date(), conflictResolvedBy: userIdByUsername("keuangan1"), syncConflictNote: "Perangkat cadangan" })
      .where(eq(shifts.id, conflict.shiftId));
  });

  it("US-M6-02 KP-4 US-M6-03 KP-2 BR-38 pembalik POS pasca-tutup: satu pembalik bernilai negatif per transaksi", async () => {
    const shift = await createShiftFixture(t.db);
    const sale = await createPosSaleFixture(t.db, shift);
    const later = await createShiftFixture(t.db);
    await createPosSaleFixture(t.db, later, { reversalOfId: sale.saleId, isReversal: true, total: -10_000, quantity: -2 });
    await expectSqlState(
      createPosSaleFixture(t.db, later, { reversalOfId: sale.saleId, isReversal: true, total: -10_000, quantity: -2 }),
      PG.uniqueViolation,
      "pos_sales_reversal_uq",
    );
    await expectSqlState(createPosSaleFixture(t.db, later, { total: -5_000 }), PG.checkViolation, "pos_sales_reversal_chk");
    await expectSqlState(
      createPosSaleFixture(t.db, later, { reversalOfId: sale.saleId, isReversal: false }),
      PG.checkViolation,
      "pos_sales_reversal_chk",
    );
  });

  it("US-M7-02 KP-6 7.6.6 nota pembelian & transfer internal: nomor resmi unik per tenant; dokumen perangkat wajib nomor lokal", async () => {
    const [supplier] = await t.db
      .insert(suppliers)
      .values({ tenantId: EQUA_TENANT_ID, name: `Pemasok ${uniqueSeq()}`, status: "active" })
      .returning({ id: suppliers.id });
    const device = newId();
    await t.db.execute(
      sql`insert into devices (id, tenant_id, device_code, name, kind) values (${device}, ${EQUA_TENANT_ID}, ${`HP-TK-${uniqueSeq()}`}, 'Tablet toko', 'tablet')`,
    );
    const base = { tenantId: EQUA_TENANT_ID, outletId: outletId("TK1"), supplierId: supplier!.id, totalAmount: 100_000, businessDate: "2026-09-28" };
    await expectSqlState(t.db.insert(purchaseReceipts).values({ ...base }), PG.checkViolation, "purchase_receipts_number_chk");
    await expectSqlState(
      t.db.insert(purchaseReceipts).values({ ...base, deviceId: device, number: num("NB-26") }),
      PG.checkViolation,
      "purchase_receipts_number_chk",
    );
    await t.db.insert(purchaseReceipts).values({ ...base, deviceId: device, localNumber: `TK1-P1-${uniqueSeq()}`, deviceSeq: 1 });
    const internal = {
      tenantId: EQUA_TENANT_ID,
      fromOutletId: outletId("TK1"),
      toOutletId: outletId("D01"),
      businessDate: "2026-09-28",
      sentAt: new Date(),
      totalValue: 60_000,
    };
    const ti = num("TI-26");
    await t.db.insert(internalTransfers).values({ ...internal, number: ti });
    await expectSqlState(t.db.insert(internalTransfers).values({ ...internal, number: ti }), PG.uniqueViolation, "internal_transfers_tenant_number_uq");
  });

  it("BR-28 US-M7-02 KP-1 KP-6 nota pemasok yang sama tidak dapat diinput dua kali (kecuali setelah dibalik)", async () => {
    const [supplier] = await t.db
      .insert(suppliers)
      .values({ tenantId: EQUA_TENANT_ID, name: `Pemasok ${uniqueSeq()}`, status: "active" })
      .returning({ id: suppliers.id });
    const row = {
      tenantId: EQUA_TENANT_ID,
      outletId: outletId("TK1"),
      supplierId: supplier!.id,
      supplierNoteNumber: "INV/2026/0911",
      totalAmount: 250_000,
      businessDate: "2026-09-28",
    };
    const [first] = await t.db.insert(purchaseReceipts).values({ ...row, number: num("NB-26") }).returning({ id: purchaseReceipts.id });
    await expectSqlState(
      t.db.insert(purchaseReceipts).values({ ...row, number: num("NB-26") }),
      PG.uniqueViolation,
      "purchase_receipts_supplier_note_uq",
    );
    await t.db.update(purchaseReceipts).set({ status: "reversed" }).where(eq(purchaseReceipts.id, first!.id));
    await t.db.insert(purchaseReceipts).values({ ...row, number: num("NB-26"), reversalOfId: first!.id, totalAmount: -250_000 });
    await t.db.insert(purchaseReceipts).values({ ...row, number: num("NB-26") });
  });
});

describe("M3/M8 satu transaksi hidup per rit", () => {
  it("US-M3-04 KP-1 7.3.6 hanya satu pembayaran aktif per rit; setelah dibalik boleh dicatat ulang", async () => {
    const trip = await createTripFixture(t.db);
    const pay = {
      tenantId: EQUA_TENANT_ID,
      tripId: trip.tripId,
      customerId: trip.customerId,
      method: "cash" as const,
      expectedAmount: 200_000,
      receivedAmount: 200_000,
      businessDate: "2026-09-28",
    };
    const [first] = await t.db.insert(tripPayments).values(pay).returning({ id: tripPayments.id });
    await expectSqlState(t.db.insert(tripPayments).values(pay), PG.uniqueViolation, "trip_payments_live_uq");
    const [rev] = await t.db
      .insert(tripPayments)
      .values({ ...pay, expectedAmount: -200_000, receivedAmount: -200_000, reversalOfId: first!.id, reversalReason: "Salah catat" })
      .returning({ id: tripPayments.id });
    await expectSqlState(
      t.db.insert(tripPayments).values({ ...pay, expectedAmount: -200_000, receivedAmount: -200_000, reversalOfId: first!.id }),
      PG.uniqueViolation,
      "trip_payments_reversal_uq",
    );
    await t.db.update(tripPayments).set({ reversedAt: new Date(), reversedById: rev!.id }).where(eq(tripPayments.id, first!.id));
    await t.db.insert(tripPayments).values({ ...pay, receivedAmount: 150_000, underpaymentAmount: 50_000 });
  });

  it("US-M3-04 KP-2 PTB-18 tunai: diterima + kurang bayar = seharusnya; jumlah negatif hanya untuk baris pembalik", async () => {
    const trip = await createTripFixture(t.db);
    const pay = { tenantId: EQUA_TENANT_ID, tripId: trip.tripId, customerId: trip.customerId, businessDate: "2026-09-28" };
    await expectSqlState(
      t.db.insert(tripPayments).values({ ...pay, method: "cash", expectedAmount: 200_000, receivedAmount: 150_000 }),
      PG.checkViolation,
      "trip_payments_amounts_chk",
    );
    await expectSqlState(
      t.db.insert(tripPayments).values({ ...pay, method: "transfer", expectedAmount: 200_000, receivedAmount: -1 }),
      PG.checkViolation,
    );
    // Tempo: 0 diterima, tidak ada kurang bayar (seluruhnya faktur).
    await t.db.insert(tripPayments).values({ ...pay, method: "credit", expectedAmount: 200_000, receivedAmount: 0 });
  });

  it("US-M8-02 KP-2 KP-6 PTB-09 satu pengisian hidup per rit; pembalik tunggal", async () => {
    const trip = await createTripFixture(t.db);
    const fill = {
      tenantId: EQUA_TENANT_ID,
      waterSourceId: waterSourceId("SA1"),
      truckId: truckId("T3"),
      tripId: trip.tripId,
      businessDate: "2026-09-28",
      volumeL: 5_000,
      filledAt: new Date(),
    };
    const [first] = await t.db.insert(truckFills).values(fill).returning({ id: truckFills.id });
    await expectSqlState(t.db.insert(truckFills).values(fill), PG.uniqueViolation, "truck_fills_trip_live_uq");
    const [rev] = await t.db.insert(truckFills).values({ ...fill, volumeL: -5_000, reversalOfId: first!.id }).returning({ id: truckFills.id });
    await expectSqlState(t.db.insert(truckFills).values({ ...fill, reversalOfId: first!.id }), PG.uniqueViolation, "truck_fills_reversal_uq");
    await t.db.update(truckFills).set({ reversedAt: new Date(), reversedById: rev!.id }).where(eq(truckFills.id, first!.id));
    await t.db.insert(truckFills).values({ ...fill, volumeL: 4_800, volumeReason: "sisa muatan" });
  });

  it("Bab 6.4 butir 2 NFR-07 US-M3-09 KP-2 satu baris per perintah sinkron pada tabel lapangan", async () => {
    const trip = await createTripFixture(t.db);
    const cmd = newId();
    await t.db.insert(tripPayments).values({
      tenantId: EQUA_TENANT_ID,
      tripId: trip.tripId,
      customerId: trip.customerId,
      method: "credit",
      expectedAmount: 200_000,
      receivedAmount: 0,
      businessDate: "2026-09-28",
      syncCommandId: cmd,
    });
    const other = await createTripFixture(t.db);
    await expectSqlState(
      t.db.insert(tripPayments).values({
        tenantId: EQUA_TENANT_ID,
        tripId: other.tripId,
        customerId: other.customerId,
        method: "credit",
        expectedAmount: 200_000,
        receivedAmount: 0,
        businessDate: "2026-09-28",
        syncCommandId: cmd,
      }),
      PG.uniqueViolation,
      "trip_payments_sync_command_uq",
    );
    const expense = { tenantId: EQUA_TENANT_ID, truckId: truckId("T1"), businessDate: "2026-09-28", kind: "fuel" as const, amount: 100_000, fundingSource: "cash_on_hand" as const, syncCommandId: newId() };
    await t.db.insert(tripExpenses).values(expense);
    await expectSqlState(t.db.insert(tripExpenses).values(expense), PG.uniqueViolation, "trip_expenses_sync_command_uq");
    const indexes = await t.db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where schemaname = 'public' and indexname like '%\\_sync\\_command\\_uq'`,
    );
    expect(indexes.rows.map((r) => r.indexname).sort()).toEqual(
      [
        "consumable_receipts_sync_command_uq",
        "customer_payments_sync_command_uq",
        "meter_readings_sync_command_uq",
        "quality_checklists_sync_command_uq",
        "stock_counts_sync_command_uq",
        "tank_level_readings_sync_command_uq",
        "trip_expenses_sync_command_uq",
        "trip_incidents_sync_command_uq",
        "trip_payments_sync_command_uq",
        "trip_status_events_sync_command_uq",
        "truck_fills_sync_command_uq",
        "water_supply_receipts_sync_command_uq",
      ].sort(),
    );
  });
});

describe("M10 pemisahan tugas & persetujuan", () => {
  const approval = (objectId: string) => ({
    tenantId: EQUA_TENANT_ID,
    number: num("A-26"),
    type: "petty_cash",
    requesterUserId: userIdByUsername("keuangan1"),
    objectType: "petty_cash",
    objectId,
    reason: "Beli ATK",
  });

  it("FR-M10-03 US-M10-03 KP-1 pemohon tidak pernah dapat memutuskan permintaannya sendiri (CHECK DB)", async () => {
    const [req] = await t.db.insert(approvalRequests).values(approval(newId())).returning({ id: approvalRequests.id });
    await expectSqlState(
      t.db
        .update(approvalRequests)
        .set({ status: "approved", decidedBy: userIdByUsername("keuangan1"), decidedAt: new Date() })
        .where(eq(approvalRequests.id, req!.id)),
      PG.checkViolation,
      "approval_requests_sod_chk",
    );
    await t.db
      .update(approvalRequests)
      .set({ status: "approved", decidedBy: userIdByUsername("pemilik"), decidedAt: new Date() })
      .where(eq(approvalRequests.id, req!.id));
  });

  it("US-M10-04 KP-2 KP-3 hanya satu permintaan menunggu keputusan per (jenis, objek)", async () => {
    const objectId = newId();
    const [first] = await t.db.insert(approvalRequests).values(approval(objectId)).returning({ id: approvalRequests.id });
    await expectSqlState(t.db.insert(approvalRequests).values(approval(objectId)), PG.uniqueViolation, "approval_requests_live_uq");
    await t.db.update(approvalRequests).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(approvalRequests.id, first!.id));
    await t.db.insert(approvalRequests).values(approval(objectId));
  });

  it("US-M10-04 KP-5 PTB-32 delegasi ke diri sendiri atau masa berlaku terbalik ditolak", async () => {
    const base = {
      tenantId: EQUA_TENANT_ID,
      delegatorUserId: userIdByUsername("pemilik"),
      approvalType: "credit_grant",
      validFrom: new Date("2026-10-01T00:00:00Z"),
      validUntil: new Date("2026-10-07T00:00:00Z"),
      reason: "Cuti",
    };
    await expectSqlState(
      t.db.insert(delegations).values({ ...base, delegateUserId: userIdByUsername("pemilik") }),
      PG.checkViolation,
      "delegations_valid_chk",
    );
    await expectSqlState(
      t.db.insert(delegations).values({ ...base, delegateUserId: userIdByUsername("keuangan1"), validUntil: base.validFrom }),
      PG.checkViolation,
    );
    await t.db.insert(delegations).values({ ...base, delegateUserId: userIdByUsername("keuangan1") });
  });

  it("NFR-30 D-04 nomor dokumen unik per tenant (setoran, jurnal, persetujuan)", async () => {
    const partner = await createPartnerTenant(t.db);
    const number = num("S-26");
    const dep = { sourceType: "driver" as const, businessDate: "2026-09-28", number };
    await t.db.insert(deposits).values({ ...dep, tenantId: EQUA_TENANT_ID, depositorUserId: userIdByUsername("sopir2") });
    await t.db.insert(deposits).values({ ...dep, tenantId: partner.tenantId });
    await expectSqlState(
      t.db.insert(deposits).values({ ...dep, tenantId: EQUA_TENANT_ID, depositorUserId: userIdByUsername("sopir3") }),
      PG.uniqueViolation,
      "deposits_tenant_number_uq",
    );
    const periodId = await ensurePeriod(t.db, "2026-09");
    const j = await createJournalFixture(t.db, { periodId, status: "draft" });
    await expectSqlState(
      t.db.insert(journals).values({ tenantId: EQUA_TENANT_ID, number: j.number, kind: "manual", journalDate: "2026-09-15", description: "dobel" }),
      PG.uniqueViolation,
      "journals_tenant_number_uq",
    );
    const a = approval(newId());
    await t.db.insert(approvalRequests).values(a);
    await expectSqlState(t.db.insert(approvalRequests).values({ ...a, objectId: newId() }), PG.uniqueViolation, "approval_requests_tenant_number_uq");
  });
});

describe("M1 master harga, zona & pelanggan", () => {
  it("BR-15 BR-16 BR-19 US-M1-02 KP-4 satu harga aktif per tanggal berlaku (produk, zona, BBM, harga khusus)", async () => {
    await expectSqlState(
      t.db.insert(productPrices).values({ tenantId: EQUA_TENANT_ID, productId: productId("ISI-ULANG"), kind: "standard", price: 6_000, effectiveFrom: "2025-01-01", status: "active" }),
      PG.uniqueViolation,
      "product_prices_active_uq",
    );
    // Menunggu persetujuan untuk tanggal yang sama boleh; harga per outlet berdiri sendiri.
    await t.db.insert(productPrices).values({ tenantId: EQUA_TENANT_ID, productId: productId("ISI-ULANG"), kind: "standard", price: 6_000, effectiveFrom: "2025-01-01" });
    await t.db.insert(productPrices).values({ tenantId: EQUA_TENANT_ID, productId: productId("ISI-ULANG"), kind: "standard", outletId: outletId("D02"), price: 5_500, recommendedPrice: 5_000, effectiveFrom: "2025-01-01", status: "active" });
    await expectSqlState(
      t.db.insert(zoneTariffs).values({ tariffZoneId: tariffZoneId("Z1"), pricePerTrip: 1, effectiveFrom: "2025-01-01", status: "active" }),
      PG.uniqueViolation,
      "zone_tariffs_active_all_uq",
    );
    await t.db.insert(zoneTariffs).values({ tariffZoneId: tariffZoneId("Z1"), segment: "hotel", pricePerTrip: 190_000, effectiveFrom: "2025-01-01", status: "active" });
    await expectSqlState(
      t.db.insert(zoneTariffs).values({ tariffZoneId: tariffZoneId("Z1"), segment: "hotel", pricePerTrip: 1, effectiveFrom: "2025-01-01", status: "active" }),
      PG.uniqueViolation,
      "zone_tariffs_active_segment_uq",
    );
    await expectSqlState(
      t.db.insert(fuelComponents).values({ tenantId: EQUA_TENANT_ID, amountPerTrip: 1, effectiveFrom: "2025-01-01", status: "active" }),
      PG.uniqueViolation,
      "fuel_components_active_uq",
    );
    const sp = { customerId: customerId("PLG-0034"), productId: productId("AIR-TRUK"), price: 150_000, reason: "Kontrak hotel", validFrom: "2026-10-01", reviewDate: "2027-04-01", status: "active" as const };
    await t.db.insert(specialPrices).values(sp);
    await expectSqlState(t.db.insert(specialPrices).values(sp), PG.uniqueViolation, "special_prices_active_uq");
  });

  it("US-M1-05 KP-1 KP-4 batas zona berversi: satu batas aktif per tanggal berlaku, rentang valid, alamat mencatat versi batas", async () => {
    await expectSqlState(
      t.db.insert(tariffZoneBoundaries).values({ tariffZoneId: tariffZoneId("Z2"), minDistanceM: 5_000, maxDistanceM: 11_000, effectiveFrom: "2025-01-01", status: "active" }),
      PG.uniqueViolation,
      "tariff_zone_boundaries_active_uq",
    );
    await expectSqlState(
      t.db.insert(tariffZoneBoundaries).values({ tariffZoneId: tariffZoneId("Z2"), minDistanceM: 9_000, maxDistanceM: 8_000, effectiveFrom: "2026-11-01" }),
      PG.checkViolation,
      "tariff_zone_boundaries_range_chk",
    );
    await t.db.insert(tariffZoneBoundaries).values({
      tariffZoneId: tariffZoneId("Z2"),
      minDistanceM: 5_000,
      maxDistanceM: 11_000,
      effectiveFrom: "2026-11-01",
      reason: "Perluasan zona 2 (menunggu persetujuan pemilik)",
    });
    const res = await t.db.execute<{ n: number }>(
      sql`select count(*)::int as n from customer_addresses where zone_boundary_id = ${tariffZoneBoundaryId("Z1")} and zone_assigned_at is not null`,
    );
    expect(Number(res.rows[0]!.n)).toBeGreaterThan(0);
  });

  it("BR-04 US-M1-01 KP-4 CR-12 rumah tangga tunai saja: Tempo, batas kredit, atau tagihan bulanan ditolak DB", async () => {
    const household = {
      tenantId: EQUA_TENANT_ID,
      name: "Ibu Uji Rumah Tangga",
      segment: "household" as const,
      waPhone: "6281200000001",
    };
    await expectSqlState(t.db.insert(customers).values({ ...household, creditStatus: "credit" }), PG.checkViolation, "customers_household_cash_chk");
    await expectSqlState(t.db.insert(customers).values({ ...household, creditLimit: 500_000 }), PG.checkViolation, "customers_household_cash_chk");
    await expectSqlState(t.db.insert(customers).values({ ...household, monthlyBilling: true }), PG.checkViolation, "customers_household_cash_chk");
    await expectSqlState(
      t.db.insert(customers).values({ ...household, segment: "industry", creditLimit: -1 }),
      PG.checkViolation,
      "customers_credit_values_chk",
    );
    await expectSqlState(
      t.db.insert(customers).values({ ...household, segment: "industry", paymentTermDays: 0 }),
      PG.checkViolation,
      "customers_credit_values_chk",
    );
    await t.db.insert(customers).values(household);
  });

  it("US-M5-03 KP-3 BR-03 pembukaan Ditahan oleh pemilik menyimpan cakupan faktur", async () => {
    await t.db
      .update(customers)
      .set({ holdReleasedAt: new Date(), holdReleasedBy: userIdByUsername("pemilik"), holdReleaseCoversDueUntil: "2026-09-30" })
      .where(eq(customers.id, customerId("PLG-0026")));
    const [row] = await t.db.select().from(customers).where(eq(customers.id, customerId("PLG-0026")));
    expect(row?.holdReleaseCoversDueUntil).toBe("2026-09-30");
  });
});

describe("M2 pesanan langganan", () => {
  it("US-M2-06 KP-2 KP-3 KPI-06 job H-2 tidak membangkitkan pesanan langganan dua kali per tanggal", async () => {
    const [rec] = await t.db
      .insert(recurringOrders)
      .values({
        tenantId: EQUA_TENANT_ID,
        customerId: customerId("PLG-0034"),
        addressId: seedAddressId("PLG-0034"),
        pattern: "weekly",
        daysOfWeek: [1, 4],
        startDate: "2026-09-01",
        createdVia: "customer_app",
      })
      .returning({ id: recurringOrders.id });
    await createTripFixture(t.db, { recurringOrderId: rec!.id, requestedDate: "2026-10-01" });
    await expectSqlState(
      createTripFixture(t.db, { recurringOrderId: rec!.id, requestedDate: "2026-10-01" }),
      PG.uniqueViolation,
      "orders_recurring_date_uq",
    );
    await createTripFixture(t.db, { recurringOrderId: rec!.id, requestedDate: "2026-10-05" });
    const created = await t.db.select().from(orders).where(eq(orders.recurringOrderId, rec!.id));
    expect(created).toHaveLength(2);
  });
});

describe("M4/M5/M6 posting turunan unik per sumber", () => {
  it("US-M4-04 KP-1 US-M4-01 KP-3 US-M6-04 KP-1 transfer tercatat, mutasi kas, kartu stok & buku air: satu posting per sumber", async () => {
    const sourceId = newId();
    const transfer = {
      tenantId: EQUA_TENANT_ID,
      sourceKind: "trip_payment" as const,
      sourceObjectType: "trip_payment",
      sourceObjectId: sourceId,
      amount: 200_000,
      transferDate: "2026-09-28",
      businessDate: "2026-09-28",
    };
    await t.db.insert(incomingTransfers).values(transfer);
    await expectSqlState(t.db.insert(incomingTransfers).values(transfer), PG.uniqueViolation, "incoming_transfers_source_uq");

    const shift = await createShiftFixture(t.db);
    const qris = { tenantId: EQUA_TENANT_ID, sourceKind: "qris_shift" as const, shiftId: shift.shiftId, amount: 50_000, transferDate: "2026-09-28", businessDate: "2026-09-28" };
    await t.db.insert(incomingTransfers).values(qris);
    await expectSqlState(t.db.insert(incomingTransfers).values(qris), PG.uniqueViolation, "incoming_transfers_qris_shift_uq");

    const cash = { tenantId: EQUA_TENANT_ID, businessDate: "2026-09-28", kind: "deposit_received" as const, direction: "in" as const, amount: 100_000, sourceObjectType: "deposit", sourceObjectId: newId() };
    await t.db.insert(officeCashMovements).values(cash);
    await expectSqlState(t.db.insert(officeCashMovements).values(cash), PG.uniqueViolation, "office_cash_movements_source_uq");

    const stock = {
      tenantId: EQUA_TENANT_ID,
      outletId: outletId("D01"),
      productId: productId("TUTUP"),
      kind: "consumption" as const,
      quantity: -2,
      balanceAfter: 98,
      businessDate: "2026-09-28",
      occurredAt: new Date(),
      sourceObjectType: "pos_sale",
      sourceObjectId: newId(),
    };
    await t.db.insert(stockLedger).values(stock);
    await expectSqlState(t.db.insert(stockLedger).values(stock), PG.uniqueViolation, "stock_ledger_source_uq");

    const water = { tenantId: EQUA_TENANT_ID, outletId: outletId("D01"), businessDate: "2026-09-28", kind: "sales_out" as const, volumeL: -38, occurredAt: new Date(), sourceObjectType: "pos_sale", sourceObjectId: newId() };
    const [w] = await t.db.insert(outletWaterLedger).values(water).returning({ id: outletWaterLedger.id });
    await expectSqlState(t.db.insert(outletWaterLedger).values(water), PG.uniqueViolation, "outlet_water_ledger_source_uq");
    // Pembalik (BR-38) boleh merujuk sumber yang sama.
    await t.db.insert(outletWaterLedger).values({ ...water, volumeL: 38, reversalOfId: w!.id, reversalReason: "Void" });
  });

  it("US-M7-04 KP-3 US-M7-06 KP-1 US-M6-05 KP-1 faktur per penjualan tempo, penerimaan per transfer internal, pasokan per rit", async () => {
    const shift = await createShiftFixture(t.db, { outletCode: "TK1", operator: "kasir" });
    const sale = await createPosSaleFixture(t.db, shift);
    const inv = {
      tenantId: EQUA_TENANT_ID,
      kind: "store_sale" as const,
      customerId: customerId("PLG-0001"),
      posSaleId: sale.saleId,
      issueDate: "2026-09-28",
      dueDate: "2026-10-12",
      amount: 10_000,
      outstandingAmount: 10_000,
    };
    await t.db.insert(invoices).values({ ...inv, number: num("F-26") });
    await expectSqlState(t.db.insert(invoices).values({ ...inv, number: num("F-26") }), PG.uniqueViolation, "invoices_pos_sale_uq");

    const [ti] = await t.db
      .insert(internalTransfers)
      .values({ tenantId: EQUA_TENANT_ID, number: num("TI-26"), fromOutletId: outletId("TK1"), toOutletId: outletId("D01"), businessDate: "2026-09-28", sentAt: new Date(), totalValue: 60_000 })
      .returning({ id: internalTransfers.id });
    const receipt = { tenantId: EQUA_TENANT_ID, outletId: outletId("D01"), source: "internal_transfer" as const, internalTransferId: ti!.id, receivedAt: new Date(), businessDate: "2026-09-28" };
    const [cr] = await t.db.insert(consumableReceipts).values(receipt).returning({ id: consumableReceipts.id });
    await expectSqlState(t.db.insert(consumableReceipts).values(receipt), PG.uniqueViolation, "consumable_receipts_transfer_uq");
    await t.db.update(consumableReceipts).set({ reversedAt: new Date() }).where(eq(consumableReceipts.id, cr!.id));
    await t.db.insert(consumableReceipts).values(receipt);

    const trip = await createTripFixture(t.db, { customerCode: "PLG-0034" });
    const supply = { tenantId: EQUA_TENANT_ID, outletId: outletId("D01"), tripId: trip.tripId, businessDate: "2026-09-28", deliveredVolumeL: 5_000 };
    await t.db.insert(waterSupplyReceipts).values(supply);
    await expectSqlState(t.db.insert(waterSupplyReceipts).values(supply), PG.uniqueViolation, "water_supply_receipts_trip_uq");
  });
});

describe("M10/M9/M12 jejak, laporan & GPS", () => {
  it("US-M10-05 KP-2 NFR-11 rantai hash audit tidak dapat bercabang (prev_hash unik, satu genesis)", async () => {
    const [last] = await t.db.select({ hash: auditLogs.hash }).from(auditLogs).orderBy(sql`${auditLogs.seq} desc`).limit(1);
    const row = { source: "system" as const, objectType: "uji", objectId: "1", action: "create" };
    const prev = last?.hash ?? null;
    if (prev === null) {
      await t.db.insert(auditLogs).values({ ...row, hash: `g-${uniqueSeq()}` });
      await expectSqlState(t.db.insert(auditLogs).values({ ...row, hash: `g2-${uniqueSeq()}` }), PG.uniqueViolation, "audit_logs_genesis_uq");
    } else {
      await expectSqlState(t.db.insert(auditLogs).values({ ...row, hash: `g2-${uniqueSeq()}` }), PG.uniqueViolation, "audit_logs_genesis_uq");
    }
    const [tip] = await t.db.select({ hash: auditLogs.hash }).from(auditLogs).orderBy(sql`${auditLogs.seq} desc`).limit(1);
    await t.db.insert(auditLogs).values({ ...row, prevHash: tip!.hash, hash: `h-${uniqueSeq()}` });
    await expectSqlState(
      t.db.insert(auditLogs).values({ ...row, prevHash: tip!.hash, hash: `cabang-${uniqueSeq()}` }),
      PG.uniqueViolation,
      "audit_logs_prev_hash_uq",
    );
  });

  it("US-M9-03 KP-4 US-M11-04 KP-2 laporan Final per varian filter: satu versi Final berlaku, varian lain tidak bentrok", async () => {
    const snap = { tenantId: EQUA_TENANT_ID, reportKey: "m9.monthly", period: "2026-09", status: "final" as const, data: { ok: true } };
    await t.db.insert(reportSnapshots).values({ ...snap, scopeKey: "" });
    await t.db.insert(reportSnapshots).values({ ...snap, scopeKey: "outlet:D01" });
    await expectSqlState(
      t.db.insert(reportSnapshots).values({ ...snap, scopeKey: "outlet:D01", revision: 2 }),
      PG.uniqueViolation,
      "report_snapshots_final_uq",
    );
    await t.db.insert(reportSnapshots).values({ ...snap, scopeKey: "outlet:D01", revision: 2, status: "provisional" });
  });

  it("US-M12-01 KP-1 KP-6 posisi GPS ganda (kirim ulang) ditolak; indeks waktu untuk retensi PAR-52", async () => {
    const pos = { tenantId: EQUA_TENANT_ID, truckId: truckId("T4"), source: "phone" as const, deviceTime: new Date("2026-09-28T01:00:00Z"), lat: -6.82, lng: 107.14 };
    await t.db.insert(gpsPositions).values(pos);
    await expectSqlState(t.db.insert(gpsPositions).values(pos), PG.uniqueViolation, "gps_positions_dedupe_uq");
    await t.db.insert(gpsPositions).values({ ...pos, source: "gps_device" });
    const idx = await t.db.execute<{ n: number }>(sql`select count(*)::int as n from pg_indexes where indexname = 'gps_positions_time_idx'`);
    expect(Number(idx.rows[0]!.n)).toBe(1);
  });

  it("US-M5-01 KP-6 PTB-28 CHECK sisa faktur = nilai − dibayar − nota kredit − dihapus", async () => {
    const inv = {
      tenantId: EQUA_TENANT_ID,
      kind: "delivery" as const,
      customerId: customerId("PLG-0034"),
      issueDate: "2026-09-28",
      dueDate: "2026-10-12",
      amount: 300_000,
    };
    await expectSqlState(t.db.insert(invoices).values({ ...inv, number: num("F-26"), outstandingAmount: 299_999 }), PG.checkViolation, "invoices_outstanding_chk");
    await expectSqlState(
      t.db.insert(invoices).values({ ...inv, number: num("F-26"), paidAmount: 400_000, outstandingAmount: -100_000 }),
      PG.checkViolation,
      "invoices_outstanding_chk",
    );
    await t.db.insert(invoices).values({ ...inv, number: num("F-26"), writtenOffAmount: 300_000, outstandingAmount: 0, status: "paid" });
  });
});

describe("tinjauan skema S0 — kolom baru tersedia", () => {
  it("Bab 6.7 US-M3-06 KP-4 US-M12-05 KP-3 BR-25 metadata keterangan perjalanan offline & aksi lapangan per rit", async () => {
    expect(await columnsOf("fleet_events")).toEqual(
      expect.arrayContaining([
        "explanation_device_time",
        "explanation_device_id",
        "explanation_sync_command_id",
        "explanation_business_date",
        "explanation_late",
      ]),
    );
    expect(await columnsOf("trips")).toEqual(
      expect.arrayContaining([
        "completion_business_date",
        "sync_conflict_resolved_at",
        "sync_conflict_resolved_by",
        "credit_hold_flagged_at",
        "credit_hold_resolution",
      ]),
    );
    expect(await columnsOf("trip_status_events")).toEqual(
      expect.arrayContaining(["trip_id", "status", "device_time", "synced_at", "sync_command_id", "recorded_by_office", "late_sync", "clock_skew_flagged"]),
    );
  });

  it("US-P2-02 KP-4 US-M10-05 KP-1 US-M2-05 KP-6 aktor aplikasi pelanggan & persetujuan kurang bayar kedua", async () => {
    expect(await columnsOf("orders")).toEqual(
      expect.arrayContaining(["created_by_customer_account_id", "cancelled_by_customer_account_id", "underpayment_approval_request_id"]),
    );
    expect(await columnsOf("audit_logs")).toContain("actor_customer_account_id");
    expect(await columnsOf("domain_events")).toContain("actor_customer_account_id");
  });

  it("NFR-30 US-P3-09 KP-1 US-M6-07 KP-3 kolom tenant/outlet: tenant_id tabel anak, harga outlet, batas parameter mitra, tanggal aktif outlet", async () => {
    for (const table of [
      "stock_count_lines",
      "consumable_receipt_lines",
      "product_prices",
      "purchase_receipt_lines",
      "internal_transfer_lines",
      "quality_checklist_items",
      "device_usage_logs",
      "document_sequences",
    ]) {
      expect(await columnsOf(table), table).toContain("tenant_id");
    }
    expect(await columnsOf("product_prices")).toEqual(expect.arrayContaining(["outlet_id", "recommended_price"]));
    expect(await columnsOf("parameters")).toEqual(expect.arrayContaining(["min_value", "max_value", "tenant_editable"]));
    expect(await columnsOf("outlets")).toEqual(expect.arrayContaining(["activated_on", "onboarding_completed_at", "billing_start_date"]));
    const pp = await t.db.select({ tenantId: productPrices.tenantId }).from(productPrices).limit(5);
    expect(pp.every((r) => r.tenantId === EQUA_TENANT_ID)).toBe(true);
  });

  it("BR-38 US-M3-08 KP-2 US-M7-08 KP-2 kolom pembalik pada pengeluaran rit, alokasi pemasok, transfer internal, penerimaan", async () => {
    for (const table of [
      "trip_expenses",
      "supplier_payment_allocations",
      "internal_transfers",
      "consumable_receipts",
      "water_supply_receipts",
      "outlet_water_ledger",
    ]) {
      expect(await columnsOf(table), table).toEqual(expect.arrayContaining(["reversal_of_id", "reversal_reason", "correction_approval_id"]));
    }
    const expense = { tenantId: EQUA_TENANT_ID, truckId: truckId("T1"), businessDate: "2026-09-28", kind: "toll" as const, amount: 20_000, fundingSource: "cash_on_hand" as const };
    const [e] = await t.db.insert(tripExpenses).values(expense).returning({ id: tripExpenses.id });
    await t.db.insert(tripExpenses).values({ ...expense, amount: -20_000, reversalOfId: e!.id, reversalReason: "Nota ganda" });
    await expectSqlState(
      t.db.insert(tripExpenses).values({ ...expense, amount: -20_000, reversalOfId: e!.id }),
      PG.uniqueViolation,
      "trip_expenses_reversal_uq",
    );
  });

  it("US-M8-01 KP-5 pembacaan meter baru tetap satu per (meter, tanggal, fase) selama belum dikoreksi", async () => {
    const [meter] = await t.db.select({ id: waterMeters.id }).from(waterMeters).limit(1);
    const reading = { tenantId: EQUA_TENANT_ID, waterSourceId: waterSourceId("SA1"), waterMeterId: meter!.id, businessDate: "2026-09-25", phase: "evening" as const, readingL: 2_000_000, readAt: new Date() };
    await t.db.insert(meterReadings).values(reading);
    await expectSqlState(t.db.insert(meterReadings).values(reading), PG.uniqueViolation, "meter_readings_meter_date_phase_uq");
  });
});
