import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { creditNotes, customerAdvances, customers, domainEvents, invoices, posSales } from "@/db/schema";
import { customerId } from "@/db/seed";
import { withTx } from "@/server/core/db";
import { emit, type DomainEvent } from "@/server/core/events";
import { reverseSaleAfterClose } from "@/server/modules/m6-pos";
import * as m5 from "@/server/modules/m5-receivables";
import { recordStoreReturn } from "@/server/modules/m7-store";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { closeVia, makeStore, openShiftVia, PARTNER, sellVia, SP, stockUp } from "../m7-store/helpers";
import { finance, invoiceRow, system, today } from "./helpers";

const PARTNER_TEMPO = customerId("PLG-0001");

/** Penjualan tempo toko pada shift yang kemudian ditutup (faktur M5 terbit saat tutup shift). */
async function invoicedStoreSale(db: Parameters<typeof makeStore>[0], quantity = 3) {
  const pos = await makeStore(db);
  await stockUp(db, pos, [{ productId: SP.FILTER, quantity: 20, unitCost: 25_000 }]);
  const shiftId = await openShiftVia(pos);
  const s = await sellVia(pos, shiftId, [{ productId: SP.FILTER, quantity, unitPrice: PARTNER.FILTER }], { customerId: PARTNER_TEMPO, method: "credit" });
  expect(s.res.status).toBe("applied");
  expect((await closeVia(pos, shiftId, 200_000)).status).toBe("applied");
  const [sale] = await db.select().from(posSales).where(eq(posSales.id, s.saleId));
  expect(sale!.invoiceId).toBeTruthy();
  return { pos, shiftId, saleId: s.saleId, invoiceId: sale!.invoiceId! };
}

describe("B-22 Penjualan tempo toko → faktur, retur & void → nota kredit", () => {
  const t = useTestDb({ seed: true });
  beforeAll(async () => {
    bootstrapForTests();
    await t.db.update(customers).set({ creditStatus: "credit", creditLimit: 100_000_000 }).where(eq(customers.id, PARTNER_TEMPO));
  });

  it("US-M5-01 KP-1 penjualan tempo toko yang tersinkron setelah shift ditutup langsung difakturkan (pos_sales.invoice_id terisi); event diputar ulang tidak menggandakan", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.SIKAT, quantity: 5, unitCost: 10_000 }]);
    const shiftId = await openShiftVia(pos);
    expect((await closeVia(pos, shiftId, 200_000)).status).toBe("applied");
    // Perangkat lain mengirim transaksi tempo shift itu setelah shift ditutup (tetap dicatat, ditinjau Admin Keuangan).
    const late = await sellVia(pos, shiftId, [{ productId: SP.SIKAT, quantity: 2, unitPrice: PARTNER.SIKAT }], { customerId: PARTNER_TEMPO, method: "credit" });
    expect(["applied", "conflict"]).toContain(late.res.status);
    const [sale] = await t.db.select().from(posSales).where(eq(posSales.id, late.saleId));
    expect(sale!.invoiceId).toBeTruthy();
    const inv = await invoiceRow(t.db, sale!.invoiceId!);
    expect(inv).toMatchObject({ kind: "store_sale", posSaleId: late.saleId, customerId: PARTNER_TEMPO, amount: 2 * PARTNER.SIKAT });
    // Putar ulang event pos_sale.recorded (mis. pemulihan) → tetap satu faktur.
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "pos_sale.recorded"), eq(domainEvents.objectId, late.saleId)));
    await withTx((tx) => emit(tx, "pos_sale.recorded", (ev as unknown as DomainEvent<"pos_sale.recorded">).payload, { ctx: system(), businessDate: sale!.businessDate }));
    expect(await t.db.select().from(invoices).where(eq(invoices.posSaleId, late.saleId))).toHaveLength(1);
  });

  it("US-M5-01 KP-6 retur barang toko tempo setelah shift ditutup (PTB-46) → nota kredit atas faktur transaksi asal; diputar ulang tidak menggandakan", async () => {
    const { saleId, invoiceId } = await invoicedStoreSale(t.db, 3);
    const res = await recordStoreReturn(finance(), { saleId, lines: [{ productId: SP.FILTER, quantity: 1 }], reason: "Filter bocor" });
    expect(res.status).toBe("applied");
    const notes = await t.db.select().from(creditNotes).where(eq(creditNotes.invoiceId, invoiceId));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ amount: PARTNER.FILTER, posSaleId: saleId });
    expect(notes[0]!.number).toMatch(/^NK-\d{2}-\d{6}$/);
    expect(await invoiceRow(t.db, invoiceId)).toMatchObject({ creditedAmount: PARTNER.FILTER, outstandingAmount: 2 * PARTNER.FILTER, status: "partial" });
    const [cnEv] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "credit_note.issued"), eq(domainEvents.objectId, notes[0]!.id)));
    expect(cnEv!.payload).toMatchObject({ purpose: "store_return", amount: PARTNER.FILTER, profitCenter: "L4" });
    const [retEv] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "store_return.recorded"), eq(domainEvents.objectId, saleId)));
    await withTx((tx) => emit(tx, "store_return.recorded", (retEv as unknown as DomainEvent<"store_return.recorded">).payload, { ctx: system(), businessDate: today() }));
    expect(await t.db.select().from(creditNotes).where(eq(creditNotes.invoiceId, invoiceId))).toHaveLength(1);
  });

  it("US-M5-02 KP-3 retur atas faktur toko yang sudah lunas → kelebihan menjadi uang muka pelanggan (tidak ada uang yang hilang)", async () => {
    const { saleId, invoiceId } = await invoicedStoreSale(t.db, 2);
    await m5.recordOfficePayment(finance(), { customerId: PARTNER_TEMPO, businessDate: today(), amount: 2 * PARTNER.FILTER, method: "cash", allocations: [{ invoiceId, amount: 2 * PARTNER.FILTER }] });
    expect(await invoiceRow(t.db, invoiceId)).toMatchObject({ status: "paid" });
    const before = await t.db.select().from(customerAdvances).where(eq(customerAdvances.customerId, PARTNER_TEMPO));
    await recordStoreReturn(finance(), { saleId, lines: [{ productId: SP.FILTER, quantity: 1 }], reason: "Filter retak" });
    const after = await t.db.select().from(customerAdvances).where(eq(customerAdvances.customerId, PARTNER_TEMPO));
    const created = after.filter((a) => !before.some((b) => b.id === a.id));
    expect(created.reduce((s, a) => s + a.amount, 0)).toBe(PARTNER.FILTER);
    expect(await invoiceRow(t.db, invoiceId)).toMatchObject({ status: "paid", outstandingAmount: 0 });
  });

  it("US-M5-01 KP-6 void/pembalik transaksi tempo setelah shift ditutup (PTB-43) → nota kredit penuh atas fakturnya", async () => {
    const { saleId, invoiceId } = await invoicedStoreSale(t.db, 2);
    // Uang muka pelanggan dari uji sebelumnya dapat sudah teralokasi otomatis ke faktur baru ini.
    const before = await invoiceRow(t.db, invoiceId);
    const advancesBefore = await t.db.select().from(customerAdvances).where(eq(customerAdvances.customerId, PARTNER_TEMPO));
    await reverseSaleAfterClose(finance(), { saleId, reason: "Transaksi salah input pelanggan" });
    const notes = await t.db.select().from(creditNotes).where(eq(creditNotes.invoiceId, invoiceId));
    expect(notes.reduce((s, n) => s + n.amount, 0)).toBe(before.outstandingAmount);
    expect(await invoiceRow(t.db, invoiceId)).toMatchObject({ creditedAmount: before.outstandingAmount, outstandingAmount: 0 });
    // Bagian yang sudah dibayar (uang muka teralokasi) kembali menjadi uang muka pelanggan.
    const advancesAfter = await t.db.select().from(customerAdvances).where(eq(customerAdvances.customerId, PARTNER_TEMPO));
    const created = advancesAfter.filter((a) => !advancesBefore.some((b) => b.id === a.id)).reduce((s, a) => s + a.amount, 0);
    expect(created).toBe(2 * PARTNER.FILTER - before.outstandingAmount);
    const [cnEv] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "credit_note.issued"), eq(domainEvents.objectId, notes[0]!.id)));
    expect(cnEv!.payload).toMatchObject({ purpose: "pos_void" });
  });
});
