/**
 * B-52 (D-10 butir 1) — konfirmasi keputusan B-31: pendapatan & piutang dijurnal pada PERISTIWA SUMBER (rit Selesai,
 * penjualan POS tempo, tagihan langganan mitra), `invoice.issued` tidak dijurnal. Uji ini memastikan tidak ada jenis
 * faktur yang luput dari jurnal:
 * - setiap jenis faktur (`invoice_kind`) terdaftar di `m5.INVOICE_REVENUE_SOURCES` dengan event sumber yang dijurnal M11;
 * - alur nyata (rit tempo M3, tempo toko M7, faktur bulanan) → setiap faktur punya jurnal sumber bernilai sama di piutang
 *   1-1401, dan tidak ada jurnal yang bersumber dari `invoice.issued`.
 */
import { and, eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/db/client";
import { accounts, customers, domainEvents, invoiceLines, invoices, journalLines, journals, posSales } from "@/db/schema";
import { customerId } from "@/db/seed";
import { enumValues } from "@/lib/labels";
import * as m11 from "@/server/modules/m11-accounting";
import * as m5 from "@/server/modules/m5-receivables";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { completeCash, departArrive, driverWorld, expectApplied as expectFieldApplied, PRICE } from "../m3-driver/helpers";
import { setPeriod, THIS_PERIOD } from "../m11-accounting/helpers";
import { closeVia, expectApplied, makeStore, openShiftVia, PARTNER, sellVia, SP, stockUp } from "../m7-store/helpers";

/** Debit piutang 1-1401 pada jurnal otomatis sumber tertentu. */
async function receivableDebitOf(db: Db, type: string, ids: string[]): Promise<number> {
  const rows = await db
    .select({ debit: journalLines.debit, credit: journalLines.credit })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(eq(journals.sourceObjectType, type), inArray(journals.sourceObjectId, ids), eq(accounts.code, "1-1401"), eq(journals.status, "posted")));
  return rows.reduce((s, r) => s + Number(r.debit ?? 0) - Number(r.credit ?? 0), 0);
}

describe("B-52 setiap faktur punya peristiwa sumber yang dijurnal (M5 ↔ M11)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(async () => {
    bootstrapForTests();
    await setPeriod(t.db, THIS_PERIOD, "open");
  });

  it("B-52 US-M11-02 KP-1 D-10 setiap jenis faktur terdaftar dengan event sumber yang dijurnal M11; invoice.issued sengaja tidak dijurnal", () => {
    const journaled = new Set<string>(m11.JOURNALED_EVENTS);
    for (const kind of enumValues("invoice_kind")) {
      const src = m5.INVOICE_REVENUE_SOURCES[kind];
      expect(src, kind).toBeDefined();
      for (const ev of src.events) expect(journaled.has(ev), `${kind} → ${ev}`).toBe(true);
      if (src.events.length === 0) expect(kind).toBe("opening_balance");
    }
    expect(journaled.has("invoice.issued")).toBe(false);
    expect(m11.SKIPPED_EVENTS.map((s) => s.event)).toContain("invoice.issued");
  });

  it("B-52 US-M5-01 KP-1 US-M7-04 KP-3 faktur rit tempo, tempo toko & faktur bulanan → jurnal sumber (rit / POS) bernilai sama; tidak ada jurnal dari invoice.issued", async () => {
    // Rit tempo (faktur kirim per rit) lewat aplikasi sopir.
    const w = await driverWorld(t.db, { customerCredit: "credit", creditLimit: 10_000_000 });
    const trip = await w.addTrip({ paymentMethod: "credit" });
    await departArrive(w, trip.id);
    expectFieldApplied(await completeCash(w, trip.id, w.sopir, { payment: { method: "credit" } }));
    const [delivery] = await t.db.select().from(invoices).where(and(eq(invoices.tripId, trip.id), eq(invoices.kind, "delivery")));
    expect(delivery!.amount).toBe(PRICE);
    expect(await receivableDebitOf(t.db, "trip", [trip.id])).toBe(delivery!.amount);

    // Pelanggan tagihan bulanan: rit tempo → belum ditagih → faktur bulanan; jurnal tetap per rit.
    const wm = await driverWorld(t.db, { customerCredit: "credit", creditLimit: 10_000_000 });
    await t.db.update(customers).set({ monthlyBilling: true }).where(eq(customers.id, wm.customer.id));
    const tripM = await wm.addTrip({ paymentMethod: "credit" });
    await departArrive(wm, tripM.id);
    expectFieldApplied(await completeCash(wm, tripM.id, wm.sopir, { payment: { method: "credit" } }));
    expect(await receivableDebitOf(t.db, "trip", [tripM.id])).toBe(PRICE);

    // Tempo toko: faktur per transaksi saat tutup shift; jurnal dari pos_sale.recorded.
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.SIKAT, quantity: 5, unitCost: 10_000 }]);
    const shiftId = await openShiftVia(pos);
    const sale = await sellVia(pos, shiftId, [{ productId: SP.SIKAT, quantity: 2, unitPrice: PARTNER.SIKAT }], { customerId: customerId("PLG-0001"), method: "credit" });
    expectApplied(sale.res);
    expectApplied(await closeVia(pos, shiftId, 200_000));
    const [ps] = await t.db.select().from(posSales).where(eq(posSales.id, sale.saleId));
    const [storeInv] = await t.db.select().from(invoices).where(eq(invoices.id, ps!.invoiceId!));
    expect(storeInv!.kind).toBe("store_sale");
    expect(await receivableDebitOf(t.db, "pos_sale", [sale.saleId])).toBe(storeInv!.amount);

    // Semua faktur uji ini: jenisnya punya sumber terdaftar & bersumber rit/POS; faktur bulanan (bila terbit) memuat
    // baris per rit yang masing-masing sudah dijurnal.
    const created = [delivery!, storeInv!];
    for (const inv of created) {
      const src = m5.INVOICE_REVENUE_SOURCES[inv.kind];
      expect(src.events.length, inv.kind).toBeGreaterThan(0);
    }
    const monthlyLines = await t.db.select().from(invoiceLines).where(eq(invoiceLines.tripId, tripM.id));
    for (const l of monthlyLines) expect(await receivableDebitOf(t.db, "trip", [l.tripId!])).toBe(l.amount);

    // Tidak ada jurnal yang bersumber dari event invoice.issued (anti posting ganda, B-31).
    const issued = await t.db.select({ id: domainEvents.id }).from(domainEvents).where(and(eq(domainEvents.type, "invoice.issued"), inArray(domainEvents.objectId, created.map((i) => i.id))));
    expect(issued.length).toBe(created.length);
    const fromIssued = await t.db.select().from(journals).where(inArray(journals.sourceEventId, issued.map((e) => e.id)));
    expect(fromIssued).toEqual([]);
  });
});
