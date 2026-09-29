/**
 * Uji trigger pengerasan DB baru (src/db/sql/hardening.sql, tinjauan skema S0): buku besar append-only, penjaga kolom
 * imutabel transaksi tersimpan/terposting, penjaga jurnal (seimbang, periode, cut-over), FK komposit tenant (NFR-30).
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateSchemaDdl } from "@/db/ddl";
import {
  applyDbHardening,
  hardeningViolationCode,
  IMMUTABLE_COLUMN_GUARDS,
  isHardeningManagedDrop,
  LEDGER_APPEND_ONLY_TABLES,
  SQLSTATE_APPEND_ONLY,
  SQLSTATE_BEFORE_CUTOVER,
  SQLSTATE_IMMUTABLE,
  SQLSTATE_JOURNAL_UNBALANCED,
  SQLSTATE_PERIOD_CLOSED,
  TENANT_FOREIGN_KEYS,
  TENANT_UNIQUE_INDEXES,
} from "@/db/hardening";
import {
  accountingPeriods,
  customerAdvances,
  customerPayments,
  dailySummaries,
  employees,
  invoices,
  journalLines,
  journals,
  meterReadings,
  officeCashMovements,
  outletWaterLedger,
  parameters,
  paymentAllocations,
  posSaleLines,
  posSales,
  shifts,
  stockLedger,
  supplierPaymentAllocations,
  supplierPayments,
  suppliers,
  tripPayments,
  tripStatusEvents,
  truckFills,
  users,
  purchaseReceipts,
  waterMeters,
} from "@/db/schema";
import { customerId, EQUA_TENANT_ID, outletId, productId, truckId, userIdByUsername, waterSourceId } from "@/db/seed";
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
  uniqueSeq,
} from "../helpers/db-fixtures";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb({ seed: true });
});
afterAll(() => t.close());

async function triggerTables(name: string): Promise<string[]> {
  const res = await t.db.execute<{ table_name: string }>(
    sql`select c.relname as table_name from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
        where tg.tgname = ${name} and not tg.tgisinternal order by 1`,
  );
  return res.rows.map((r) => r.table_name);
}

describe("NFR-11 / BR-38 buku besar, ledger & alokasi append-only (EQ002)", () => {
  it("NFR-11 BR-38 trigger append-only terpasang pada semua tabel buku (koreksi = baris pembalik)", async () => {
    const tables = await triggerTables("equa_append_only");
    for (const table of LEDGER_APPEND_ONLY_TABLES) expect(tables, table).toContain(table);
  });

  it("US-M4-01 KP-3 NFR-11 mutasi kas kantor tidak dapat di-UPDATE (mis. jumlah menjadi 0)", async () => {
    const id = newId();
    await t.db.insert(officeCashMovements).values({
      id,
      tenantId: EQUA_TENANT_ID,
      businessDate: "2026-09-28",
      kind: "deposit_received",
      direction: "in",
      amount: 750_000,
      sourceObjectType: "deposit",
      sourceObjectId: newId(),
    });
    await expectSqlState(
      t.db.update(officeCashMovements).set({ amount: 0 }).where(eq(officeCashMovements.id, id)),
      SQLSTATE_APPEND_ONLY,
      "tidak dapat diubah",
    );
    // Koreksi yang sah: baris pembalik merujuk baris asal.
    await t.db.insert(officeCashMovements).values({
      tenantId: EQUA_TENANT_ID,
      businessDate: "2026-09-28",
      kind: "adjustment",
      direction: "out",
      amount: 750_000,
      reversalOfId: id,
      description: "Pembalik setoran salah catat",
    });
  });

  it("US-M6-04 KP-1 US-M6-05 KP-3 kartu stok & buku air outlet tidak dapat di-UPDATE", async () => {
    const [ledger] = await t.db
      .insert(stockLedger)
      .values({
        tenantId: EQUA_TENANT_ID,
        outletId: outletId("D01"),
        productId: productId("TUTUP"),
        kind: "receipt",
        quantity: 100,
        balanceAfter: 100,
        businessDate: "2026-09-28",
        occurredAt: new Date(),
      })
      .returning({ id: stockLedger.id });
    await expectSqlState(
      t.db.update(stockLedger).set({ quantity: 1 }).where(eq(stockLedger.id, ledger!.id)),
      SQLSTATE_APPEND_ONLY,
    );
    const [water] = await t.db
      .insert(outletWaterLedger)
      .values({
        tenantId: EQUA_TENANT_ID,
        outletId: outletId("D01"),
        businessDate: "2026-09-28",
        kind: "supply_in",
        volumeL: 5_000,
        occurredAt: new Date(),
      })
      .returning({ id: outletWaterLedger.id });
    await expectSqlState(
      t.db.update(outletWaterLedger).set({ volumeL: 4_000 }).where(eq(outletWaterLedger.id, water!.id)),
      SQLSTATE_APPEND_ONLY,
    );
  });

  it("US-M5-02 KP-2 US-M7-08 KP-2 alokasi pelunasan & alokasi pembayaran pemasok tidak dapat di-UPDATE", async () => {
    const [inv] = await t.db
      .insert(invoices)
      .values({
        tenantId: EQUA_TENANT_ID,
        number: `F-26-${String(uniqueSeq()).padStart(6, "0")}`,
        kind: "delivery",
        customerId: customerId("PLG-0034"),
        issueDate: "2026-09-28",
        dueDate: "2026-10-12",
        amount: 200_000,
        outstandingAmount: 200_000,
      })
      .returning({ id: invoices.id });
    const [adv] = await t.db
      .insert(customerAdvances)
      .values({ tenantId: EQUA_TENANT_ID, customerId: customerId("PLG-0034"), amount: 50_000, remainingAmount: 50_000 })
      .returning({ id: customerAdvances.id });
    const [alloc] = await t.db
      .insert(paymentAllocations)
      .values({ invoiceId: inv!.id, customerAdvanceId: adv!.id, amount: 50_000 })
      .returning({ id: paymentAllocations.id });
    await expectSqlState(
      t.db.update(paymentAllocations).set({ amount: 10 }).where(eq(paymentAllocations.id, alloc!.id)),
      SQLSTATE_APPEND_ONLY,
    );

    const [supplier] = await t.db
      .insert(suppliers)
      .values({ tenantId: EQUA_TENANT_ID, name: "CV Galon Jaya", status: "active" })
      .returning({ id: suppliers.id });
    const [receipt] = await t.db
      .insert(purchaseReceipts)
      .values({
        tenantId: EQUA_TENANT_ID,
        outletId: outletId("TK1"),
        number: `NB-26-${String(uniqueSeq()).padStart(6, "0")}`,
        supplierId: supplier!.id,
        totalAmount: 300_000,
        businessDate: "2026-09-28",
      })
      .returning({ id: purchaseReceipts.id });
    const [payment] = await t.db
      .insert(supplierPayments)
      .values({ tenantId: EQUA_TENANT_ID, supplierId: supplier!.id, businessDate: "2026-09-28", amount: 300_000, method: "cash" })
      .returning({ id: supplierPayments.id });
    const [spa] = await t.db
      .insert(supplierPaymentAllocations)
      .values({ supplierPaymentId: payment!.id, purchaseReceiptId: receipt!.id, amount: 300_000 })
      .returning({ id: supplierPaymentAllocations.id });
    await expectSqlState(
      t.db.update(supplierPaymentAllocations).set({ amount: 1 }).where(eq(supplierPaymentAllocations.id, spa!.id)),
      SQLSTATE_APPEND_ONLY,
    );
  });

  it("US-M3-03 KP-6 Bab 6.7 riwayat aksi lapangan per rit (trip_status_events) append-only", async () => {
    const trip = await createTripFixture(t.db);
    const [ev] = await t.db
      .insert(tripStatusEvents)
      .values({ tenantId: EQUA_TENANT_ID, tripId: trip.tripId, status: "departed", deviceTime: new Date(), syncCommandId: newId() })
      .returning({ id: tripStatusEvents.id });
    await expectSqlState(
      t.db.update(tripStatusEvents).set({ lateSync: true }).where(eq(tripStatusEvents.id, ev!.id)),
      SQLSTATE_APPEND_ONLY,
    );
  });

  it("US-M11-03 KP-3 baris jurnal Draf masih dapat disusun; setelah terposting baris terkunci (EQ002)", async () => {
    const periodId = await ensurePeriod(t.db, "2026-09");
    const draft = await createJournalFixture(t.db, { periodId, status: "draft" });
    await t.db
      .update(journalLines)
      .set({ description: "Beban listrik September" })
      .where(eq(journalLines.journalId, draft.journalId));

    const posted = await createJournalFixture(t.db, { periodId });
    await expectSqlState(
      t.db.update(journalLines).set({ debit: 1 }).where(eq(journalLines.journalId, posted.journalId)),
      SQLSTATE_APPEND_ONLY,
      "pembalik",
    );
  });
});

describe("NFR-11 / BR-38 penjaga kolom imutabel transaksi tersimpan & terposting (EQ003)", () => {
  it("penjaga imutabel terpasang sesuai IMMUTABLE_COLUMN_GUARDS (hardening.sql ↔ hardening.ts sinkron)", async () => {
    const res = await t.db.execute<{ table_name: string; args: string }>(
      sql`select c.relname as table_name, encode(tg.tgargs, 'escape') as args
          from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
          where tg.tgname = 'equa_immutable' and not tg.tgisinternal order by 1`,
    );
    const byTable = new Map(res.rows.map((r) => [r.table_name, r.args.split("\\000").filter(Boolean)]));
    expect([...byTable.keys()].sort()).toEqual(Object.keys(IMMUTABLE_COLUMN_GUARDS).sort());
    for (const [table, guard] of Object.entries(IMMUTABLE_COLUMN_GUARDS)) {
      const args = byTable.get(table)!;
      if ("allowOnly" in guard) {
        expect(args, table).toEqual(["allow", ...guard.allowOnly]);
      } else {
        const expected = [
          ...guard.immutable,
          ...("once" in guard ? guard.once.map((c: string) => `${c}:once`) : []),
        ].sort();
        expect(args[0], table).toBe("deny");
        expect(args.slice(1).sort(), table).toEqual(expected);
      }
    }
  });

  it("US-M3-04 KP-1 KP-2 pembayaran rit: cara bayar & jumlah terkunci; tautan setoran/faktur & penanda pembalik tetap boleh", async () => {
    const trip = await createTripFixture(t.db);
    const [pay] = await t.db
      .insert(tripPayments)
      .values({
        tenantId: EQUA_TENANT_ID,
        tripId: trip.tripId,
        customerId: trip.customerId,
        driverUserId: userIdByUsername("sopir1"),
        method: "cash",
        expectedAmount: 200_000,
        receivedAmount: 200_000,
        businessDate: "2026-09-28",
      })
      .returning({ id: tripPayments.id });
    await expectSqlState(
      t.db.update(tripPayments).set({ receivedAmount: 0, underpaymentAmount: 200_000 }).where(eq(tripPayments.id, pay!.id)),
      SQLSTATE_IMMUTABLE,
      "pembalik",
    );
    await expectSqlState(t.db.update(tripPayments).set({ method: "credit" }).where(eq(tripPayments.id, pay!.id)), SQLSTATE_IMMUTABLE);
    await expectSqlState(
      t.db.update(tripPayments).set({ businessDate: "2026-09-27" }).where(eq(tripPayments.id, pay!.id)),
      SQLSTATE_IMMUTABLE,
    );
    // Alur sah: sinkron & penandaan pembalik.
    await t.db
      .update(tripPayments)
      .set({ syncedAt: new Date(), lateSync: true, reversedAt: new Date() })
      .where(eq(tripPayments.id, pay!.id));
  });

  it("US-M5-02 KP-4 pelunasan tersimpan: jumlah & cara bayar terkunci; tautan setoran boleh", async () => {
    const [pay] = await t.db
      .insert(customerPayments)
      .values({
        tenantId: EQUA_TENANT_ID,
        customerId: customerId("PLG-0034"),
        channel: "office",
        method: "cash",
        amount: 500_000,
        businessDate: "2026-09-28",
      })
      .returning({ id: customerPayments.id });
    await expectSqlState(t.db.update(customerPayments).set({ amount: 5_000 }).where(eq(customerPayments.id, pay!.id)), SQLSTATE_IMMUTABLE);
    await t.db.update(customerPayments).set({ notes: "Diterima di kantor" }).where(eq(customerPayments.id, pay!.id));
  });

  it("US-M6-03 KP-1 BR-38 transaksi POS tersimpan: total & harga terkunci; void & nomor resmi (sekali) tetap boleh", async () => {
    const shift = await createShiftFixture(t.db);
    const sale = await createPosSaleFixture(t.db, shift);
    await expectSqlState(t.db.update(posSales).set({ total: 0 }).where(eq(posSales.id, sale.saleId)), SQLSTATE_IMMUTABLE);
    await expectSqlState(
      t.db.update(posSales).set({ paymentMethod: "qris" }).where(eq(posSales.id, sale.saleId)),
      SQLSTATE_IMMUTABLE,
    );
    await expectSqlState(
      t.db.update(posSaleLines).set({ quantity: 1, lineTotal: 5_000 }).where(eq(posSaleLines.id, sale.lineId)),
      SQLSTATE_IMMUTABLE,
    );
    // Nomor resmi diberikan server saat sinkron (sekali), lalu terkunci.
    const number = `D01-280926-${String(uniqueSeq()).padStart(4, "0")}`;
    await t.db.update(posSales).set({ number }).where(eq(posSales.id, sale.saleId));
    await expectSqlState(
      t.db.update(posSales).set({ number: `${number}X` }).where(eq(posSales.id, sale.saleId)),
      SQLSTATE_IMMUTABLE,
      "pembalik",
    );
    // Void beralasan (US-M6-03) mengubah status & penanda — sah.
    await t.db
      .update(posSales)
      .set({ status: "voided", voidReason: "wrong_quantity", voidNote: "Salah tekan jumlah", voidedAt: new Date(), voidedBy: userIdByUsername("depot01") })
      .where(eq(posSales.id, sale.saleId));
    await t.db.update(posSaleLines).set({ unitCost: 1_200 }).where(eq(posSaleLines.id, sale.lineId));
    await expectSqlState(t.db.update(posSaleLines).set({ unitCost: 1_300 }).where(eq(posSaleLines.id, sale.lineId)), SQLSTATE_IMMUTABLE);
  });

  it("US-M8-01 KP-5 angka meter terkunci; koreksi = baris baru (superseded_by_id) + status verifikasi boleh", async () => {
    const [meter] = await t.db.select({ id: waterMeters.id }).from(waterMeters).limit(1);
    const [reading] = await t.db
      .insert(meterReadings)
      .values({
        tenantId: EQUA_TENANT_ID,
        waterSourceId: waterSourceId("SA1"),
        waterMeterId: meter!.id,
        businessDate: "2026-09-20",
        phase: "morning",
        readingL: 1_000_000,
        readAt: new Date("2026-09-19T23:00:00Z"),
      })
      .returning({ id: meterReadings.id });
    await expectSqlState(
      t.db.update(meterReadings).set({ readingL: 999_000 }).where(eq(meterReadings.id, reading!.id)),
      SQLSTATE_IMMUTABLE,
    );
    const [fix] = await t.db
      .insert(meterReadings)
      .values({
        tenantId: EQUA_TENANT_ID,
        waterSourceId: waterSourceId("SA1"),
        waterMeterId: meter!.id,
        businessDate: "2026-09-21",
        phase: "morning",
        readingL: 1_000_500,
        readAt: new Date("2026-09-20T23:00:00Z"),
      })
      .returning({ id: meterReadings.id });
    await t.db
      .update(meterReadings)
      .set({ supersededById: fix!.id, status: "superseded", correctionReason: "Salah baca angka" })
      .where(eq(meterReadings.id, reading!.id));
  });

  it("US-M8-02 KP-6 volume pengisian truk terkunci; rit dapat ditautkan sekali & baris asal ditandai dibalik", async () => {
    const [fill] = await t.db
      .insert(truckFills)
      .values({
        tenantId: EQUA_TENANT_ID,
        waterSourceId: waterSourceId("SA1"),
        truckId: truckId("T2"),
        businessDate: "2026-09-28",
        volumeL: 5_000,
        filledAt: new Date(),
        status: "unlinked",
      })
      .returning({ id: truckFills.id });
    await expectSqlState(t.db.update(truckFills).set({ volumeL: 4_000 }).where(eq(truckFills.id, fill!.id)), SQLSTATE_IMMUTABLE);
    const trip = await createTripFixture(t.db);
    await t.db.update(truckFills).set({ tripId: trip.tripId, status: "linked" }).where(eq(truckFills.id, fill!.id));
    const other = await createTripFixture(t.db);
    await expectSqlState(t.db.update(truckFills).set({ tripId: other.tripId }).where(eq(truckFills.id, fill!.id)), SQLSTATE_IMMUTABLE);
    await t.db.update(truckFills).set({ reversedAt: new Date(), reversalReason: "Pengisian ganda" }).where(eq(truckFills.id, fill!.id));
  });

  it("US-M5-01 KP-6 faktur: nilai & pelanggan terkunci; pelunasan/sisa tetap boleh berubah (CHECK konsisten)", async () => {
    const [inv] = await t.db
      .insert(invoices)
      .values({
        tenantId: EQUA_TENANT_ID,
        number: `F-26-${String(uniqueSeq()).padStart(6, "0")}`,
        kind: "delivery",
        customerId: customerId("PLG-0034"),
        issueDate: "2026-09-28",
        dueDate: "2026-10-12",
        amount: 400_000,
        outstandingAmount: 400_000,
      })
      .returning({ id: invoices.id });
    await expectSqlState(t.db.update(invoices).set({ amount: 0, outstandingAmount: 0 }).where(eq(invoices.id, inv!.id)), SQLSTATE_IMMUTABLE);
    await t.db
      .update(invoices)
      .set({ paidAmount: 150_000, outstandingAmount: 250_000, status: "partial" })
      .where(eq(invoices.id, inv!.id));
    await expectSqlState(
      t.db.update(invoices).set({ paidAmount: 200_000 }).where(eq(invoices.id, inv!.id)),
      PG.checkViolation,
      "invoices_outstanding_chk",
    );
  });

  it("US-M11-02 KP-1 NFR-11 jurnal terposting: kolom keuangan terkunci (EQ003); tinjauan pemilik tetap boleh", async () => {
    const periodId = await ensurePeriod(t.db, "2026-09");
    const j = await createJournalFixture(t.db, { periodId });
    await expectSqlState(t.db.update(journals).set({ description: "diubah" }).where(eq(journals.id, j.journalId)), SQLSTATE_IMMUTABLE);
    await expectSqlState(t.db.update(journals).set({ status: "draft" }).where(eq(journals.id, j.journalId)), SQLSTATE_IMMUTABLE);
    await t.db
      .update(journals)
      .set({ ownerReviewedAt: new Date(), ownerReviewedBy: userIdByUsername("pemilik") })
      .where(eq(journals.id, j.journalId));
    // Jurnal Draf bebas disusun.
    const draft = await createJournalFixture(t.db, { periodId, status: "draft" });
    await t.db.update(journals).set({ description: "Draf direvisi" }).where(eq(journals.id, draft.journalId));
  });
});

describe("US-M11-02 KP-3 / BR-32 / US-M11-09 penjaga jurnal", () => {
  it("US-M11-02 KP-3 jurnal terposting tidak seimbang ditolak saat COMMIT (EQ004, constraint trigger DEFERRABLE)", async () => {
    const periodId = await ensurePeriod(t.db, "2026-09");
    await expectSqlState(
      createJournalFixture(t.db, {
        periodId,
        lines: [
          { account: "1-1101", debit: 100_000 },
          { account: "4-1101", credit: 90_000 },
        ],
      }),
      SQLSTATE_JOURNAL_UNBALANCED,
      "tidak seimbang",
    );
    // Total header tidak sama dengan Σ baris.
    await expectSqlState(createJournalFixture(t.db, { periodId, totalDebit: 1, totalCredit: 1 }), SQLSTATE_JOURNAL_UNBALANCED);
    // Terposting tanpa baris.
    await expectSqlState(createJournalFixture(t.db, { periodId, lines: [], totalDebit: 0, totalCredit: 0 }), SQLSTATE_JOURNAL_UNBALANCED);
    // Header lalu baris dalam satu transaksi (pola ledger.postJournal) → lolos.
    const ok = await createJournalFixture(t.db, { periodId });
    const rows = await t.db.select().from(journals).where(eq(journals.id, ok.journalId));
    expect(rows[0]?.status).toBe("posted");
    // Draf tidak seimbang boleh (belum buku besar).
    await createJournalFixture(t.db, { periodId, status: "draft", lines: [{ account: "1-1101", debit: 5 }] });
  });

  it("US-M11-10 KP-3 jurnal terposting wajib berperiode (CHECK journals_posted_period_chk)", async () => {
    await expectSqlState(
      t.db.insert(journals).values({
        tenantId: EQUA_TENANT_ID,
        number: `J-2609-${String(uniqueSeq()).padStart(6, "0")}`,
        kind: "manual",
        status: "posted",
        journalDate: "2026-09-15",
        description: "tanpa periode",
      }),
      PG.checkViolation,
      "journals_posted_period_chk",
    );
  });

  it("BR-32 US-M11-10 KP-3 posting ke periode Ditutup/Dikunci ditolak (EQ005); Draf pada periode itu tetap boleh", async () => {
    const locked = await ensurePeriod(t.db, "2026-05", "locked");
    const closed = await ensurePeriod(t.db, "2026-06", "closed");
    await expectSqlState(createJournalFixture(t.db, { periodId: locked, date: "2026-05-10" }), SQLSTATE_PERIOD_CLOSED, "ditutup atau dikunci");
    await expectSqlState(createJournalFixture(t.db, { periodId: closed, date: "2026-06-10" }), SQLSTATE_PERIOD_CLOSED);
    const draft = await createJournalFixture(t.db, { periodId: closed, date: "2026-06-10", status: "draft" });
    // Memposting draf di periode Ditutup → ditolak.
    await expectSqlState(
      t.db.update(journals).set({ status: "posted", postedAt: new Date() }).where(eq(journals.id, draft.journalId)),
      SQLSTATE_PERIOD_CLOSED,
    );
    // Periode yang ditutup setelah posting: baris baru tidak dapat ditambahkan ke jurnalnya.
    const july = await ensurePeriod(t.db, "2026-07", "open");
    const posted = await createJournalFixture(t.db, { periodId: july, date: "2026-07-10" });
    await t.db.update(accountingPeriods).set({ status: "closed" }).where(eq(accountingPeriods.id, july));
    await expectSqlState(
      t.db.insert(journalLines).values({
        journalId: posted.journalId,
        lineNo: 9,
        accountId: (await t.db.select({ a: journalLines.accountId }).from(journalLines).limit(1))[0]!.a,
        profitCenter: "L2",
        debit: 1,
      }),
      SQLSTATE_PERIOD_CLOSED,
    );
    // Periode Dibuka kembali (pemilik) → posting boleh lagi.
    await t.db.update(accountingPeriods).set({ status: "reopened" }).where(eq(accountingPeriods.id, closed));
    await t.db.update(journals).set({ status: "posted", postedAt: new Date() }).where(eq(journals.id, draft.journalId));
  });

  it("US-M11-09 KP-1 NFR-36 jurnal bertanggal sebelum cut-over ditolak kecuali saldo awal (EQ006)", async () => {
    const august = await ensurePeriod(t.db, "2026-08", "open");
    await t.db.insert(parameters).values({
      key: "accounting.cutover_date",
      name: "Tanggal cut-over akuntansi",
      value: { date: "2026-08-01" },
      effectiveFrom: "2025-06-01",
      tenantId: EQUA_TENANT_ID,
      reason: "Cut-over uji",
    });
    try {
      const periodJuly = await ensurePeriod(t.db, "2026-04", "open");
      await expectSqlState(
        createJournalFixture(t.db, { periodId: periodJuly, date: "2026-04-15", kind: "auto" }),
        SQLSTATE_BEFORE_CUTOVER,
        "cut-over",
      );
      await createJournalFixture(t.db, { periodId: periodJuly, date: "2026-04-30", kind: "opening_balance" });
      await createJournalFixture(t.db, { periodId: august, date: "2026-08-01", kind: "auto" });
    } finally {
      // Kembalikan: cut-over tenant dikosongkan dengan baris berlaku lebih baru (parameter tidak dapat dihapus).
      await t.db.insert(parameters).values({
        key: "accounting.cutover_date",
        name: "Tanggal cut-over akuntansi",
        value: { date: null },
        effectiveFrom: "2025-06-02",
        tenantId: EQUA_TENANT_ID,
        reason: "Selesai uji",
      });
    }
  });
});

describe("NFR-30 FK komposit tenant (dikelola hardening.sql)", () => {
  it("NFR-30 indeks unik (id, tenant_id) & FK komposit terpasang sesuai TENANT_FOREIGN_KEYS", async () => {
    const fks = await t.db.execute<{ name: string; table_name: string; def: string }>(
      sql`select con.conname as name, rel.relname as table_name, pg_get_constraintdef(con.oid) as def
          from pg_constraint con join pg_class rel on rel.oid = con.conrelid
          where con.contype = 'f' and con.conname like '%\\_tenant\\_fk' order by 1`,
    );
    expect(fks.rows.map((r) => r.name).sort()).toEqual(TENANT_FOREIGN_KEYS.map((f) => f.name).sort());
    for (const fk of TENANT_FOREIGN_KEYS) {
      const row = fks.rows.find((r) => r.name === fk.name)!;
      expect(row.table_name).toBe(fk.table);
      expect(row.def).toBe(`FOREIGN KEY (${fk.columns.join(", ")}) REFERENCES ${fk.references}(id, tenant_id)`);
    }
    const idx = await t.db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where schemaname = 'public' and indexname like '%\\_id\\_tenant\\_uq'`,
    );
    expect(idx.rows.map((r) => r.indexname).sort()).toEqual([...TENANT_UNIQUE_INDEXES].sort());
  });

  it("NFR-30 US-M6-07 KP-2 transaksi outlet bertenant berbeda dari outlet-nya ditolak (shift, POS, stok)", async () => {
    const partner = await createPartnerTenant(t.db);
    // Shift dengan outlet mitra tetapi tenant EQUA → ditolak.
    await expectSqlState(
      createShiftFixture(t.db, { outletId: partner.outletId, tenantId: EQUA_TENANT_ID }),
      PG.foreignKeyViolation,
      "shifts_outlet_tenant_fk",
    );
    // Shift mitra yang benar → lolos; penjualan POS bertenant EQUA pada shift mitra → ditolak.
    const partnerShift = await createShiftFixture(t.db, { outletId: partner.outletId, tenantId: partner.tenantId });
    await expectSqlState(
      createPosSaleFixture(t.db, { ...partnerShift, tenantId: EQUA_TENANT_ID }),
      PG.foreignKeyViolation,
    );
    await createPosSaleFixture(t.db, partnerShift);
    await expectSqlState(
      t.db.insert(stockLedger).values({
        tenantId: EQUA_TENANT_ID,
        outletId: partner.outletId,
        productId: productId("TUTUP"),
        kind: "receipt",
        quantity: 1,
        balanceAfter: 1,
        businessDate: "2026-09-28",
        occurredAt: new Date(),
      }),
      PG.foreignKeyViolation,
      "stock_ledger_outlet_tenant_fk",
    );
    // Shift EQUA dirujuk POS bertenant mitra → ditolak (shift_id, tenant_id).
    const equaShift = await createShiftFixture(t.db);
    await expectSqlState(
      t.db.insert(posSales).values({
        tenantId: partner.tenantId,
        outletId: partner.outletId,
        shiftId: equaShift.shiftId,
        localNumber: `X-${uniqueSeq()}`,
        deviceSeq: 1,
        operatorUserId: userIdByUsername("depot01"),
        priceKind: "standard",
        businessDate: "2026-09-28",
        soldAt: new Date(),
        subtotal: 5_000,
        total: 5_000,
        paymentMethod: "cash",
      }),
      PG.foreignKeyViolation,
      "pos_sales_shift_tenant_fk",
    );
    expect((await t.db.select().from(shifts).where(eq(shifts.outletId, partner.outletId))).length).toBe(1);
  });

  it("NFR-30 BR-36 akun pengguna harus bertenant sama dengan karyawannya", async () => {
    const partner = await createPartnerTenant(t.db);
    const employeeId = newId();
    await t.db.insert(employees).values({ id: employeeId, tenantId: partner.tenantId, employeeNo: "M-1", fullName: "Operator Mitra", position: "Operator" });
    await expectSqlState(
      t.db.insert(users).values({ tenantId: EQUA_TENANT_ID, employeeId, username: `op.mitra.${uniqueSeq()}` }),
      PG.foreignKeyViolation,
      "users_employee_tenant_fk",
    );
    await t.db.insert(users).values({ tenantId: partner.tenantId, employeeId, username: `op.mitra.${uniqueSeq()}` });
  });
});

describe("pengerasan: idempotensi & pembantu", () => {
  it("NFR-11 applyDbHardening idempoten (dijalankan ulang tanpa galat, trigger tidak berlipat)", async () => {
    const count = async () =>
      Number(
        (
          await t.db.execute<{ n: number }>(
            sql`select count(*)::int as n from pg_trigger where tgname like 'equa\\_%' and not tgisinternal`,
          )
        ).rows[0]!.n,
      );
    const before = await count();
    await applyDbHardening(t.db);
    await applyDbHardening(t.db);
    expect(await count()).toBe(before);
  });

  it("NFR-30 db:push idempoten: skema Drizzle tanpa FK komposit (FK komposit tenant hanya di hardening.sql)", async () => {
    const ddl = await generateSchemaDdl();
    const compositeFks = ddl.filter((s) => /FOREIGN KEY \("[^"]+",/.test(s));
    expect(compositeFks).toEqual([]);
  });

  it("db:push mengabaikan usulan DROP drizzle-kit hanya untuk objek pengerasan", () => {
    expect(isHardeningManagedDrop('ALTER TABLE "shifts" DROP CONSTRAINT "shifts_outlet_tenant_fk";\n')).toBe(true);
    expect(isHardeningManagedDrop('DROP INDEX "outlets_id_tenant_uq";')).toBe(true);
    expect(isHardeningManagedDrop('DROP INDEX IF EXISTS "public"."shifts_id_tenant_uq";')).toBe(true);
    expect(isHardeningManagedDrop('ALTER TABLE "shifts" DROP CONSTRAINT "shifts_outlet_id_outlets_id_fk";')).toBe(false);
    expect(isHardeningManagedDrop('ALTER TABLE "shifts" ADD CONSTRAINT "shifts_outlet_tenant_fk" FOREIGN KEY ("outlet_id","tenant_id") REFERENCES "public"."outlets"("id","tenant_id");')).toBe(false);
  });

  it("hardeningViolationCode memetakan EQ001–EQ006 dan mengabaikan SQLSTATE lain", () => {
    for (const code of ["EQ001", "EQ002", "EQ003", "EQ004", "EQ005", "EQ006"]) {
      expect(hardeningViolationCode({ cause: { code } })).toBe(code);
    }
    expect(hardeningViolationCode({ code: "23505" })).toBeUndefined();
    expect(hardeningViolationCode(new Error("x"))).toBeUndefined();
  });
});

describe("B-59 ringkasan H+0 terbit terkunci di DB (EQ003)", () => {
  it("B-59 US-M9-01 KP-6 snapshot & cap waktu H+0 terbit tidak dapat diubah; tinjauan pemilik boleh; H+0 berjalan bebas", async () => {
    const [draft] = await t.db
      .insert(dailySummaries)
      .values({ tenantId: EQUA_TENANT_ID, businessDate: "2031-01-02", status: "running", snapshot: { omzet: 1 } })
      .returning({ id: dailySummaries.id });
    // Belum terbit: layanan M9 boleh mengisi snapshot & menerbitkan.
    await t.db
      .update(dailySummaries)
      .set({ snapshot: { omzet: 2 }, status: "published", publishedAt: new Date("2031-01-02T15:10:00Z"), cashClosedAt: new Date("2031-01-02T15:00:00Z") })
      .where(eq(dailySummaries.id, draft!.id));
    await expectSqlState(
      t.db.update(dailySummaries).set({ snapshot: { omzet: 999 } }).where(eq(dailySummaries.id, draft!.id)),
      SQLSTATE_IMMUTABLE,
      "pembalik",
    );
    await expectSqlState(t.db.update(dailySummaries).set({ publishedLate: true }).where(eq(dailySummaries.id, draft!.id)), SQLSTATE_IMMUTABLE);
    await expectSqlState(t.db.update(dailySummaries).set({ publishedAt: new Date("2031-01-04T00:00:00Z") }).where(eq(dailySummaries.id, draft!.id)), SQLSTATE_IMMUTABLE);
    // Alur sah setelah terbit: tinjauan pemilik.
    await t.db
      .update(dailySummaries)
      .set({ status: "reviewed", reviewedBy: userIdByUsername("pemilik"), reviewedAt: new Date("2031-01-03T01:00:00Z") })
      .where(eq(dailySummaries.id, draft!.id));
    const [row] = await t.db.select().from(dailySummaries).where(eq(dailySummaries.id, draft!.id));
    expect(row!.snapshot).toEqual({ omzet: 2 });
    expect(row!.status).toBe("reviewed");
    await expectSqlState(t.db.update(dailySummaries).set({ snapshot: {} }).where(eq(dailySummaries.id, draft!.id)), SQLSTATE_IMMUTABLE);
  });
});
