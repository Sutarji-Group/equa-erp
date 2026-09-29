/**
 * Uji integrasi ronde P3 + P2: Aplikasi Pelanggan (P2) ↔ Akuntansi (M11). P2 membentuk pelunasan M5 kanal `digital` lalu
 * memancarkan `collection.recorded` DAN `digital_payment.succeeded` untuk satu pembayaran gerbang. M11 menjurnal keduanya;
 * sebelum integrasi, pemetaan `digital_payment.succeeded/default` (Dr 1-1301 / Cr 1-1401) ikut dijurnal sehingga piutang
 * dikredit dua kali. Berkas ini memastikan:
 * - pelunasan piutang/uang muka dijurnal SEKALI (dari `collection.recorded`);
 * - `digital_payment.succeeded` hanya membukukan biaya gerbang sebagai beban (PTB-50);
 * - tanpa handler lintas modul yang gagal diam-diam (insiden).
 */
import { and, eq, inArray, like, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/db/client";
import { accounts, customerPayments, incidents, invoices, journalLines, journals, paymentIntents } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import { addDays } from "@/lib/time";
import * as p2 from "@/server/modules/p2-customer";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { setPeriod } from "../m11-accounting/helpers";
import { enableApp, linkedCustomer, minutes, refresh, TODAY } from "../p2-customer/helpers";

type Totals = Record<string, { debit: number; credit: number }>;

/** Total debit/kredit per kode akun atas jurnal otomatis objek sumber tertentu. */
async function totalsFor(db: Db, sources: { type: string; id: string }[]): Promise<Totals> {
  const rows = await db
    .select({ code: accounts.code, debit: journalLines.debit, credit: journalLines.credit, sourceType: journals.sourceObjectType, sourceId: journals.sourceObjectId })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(
      and(
        eq(journals.tenantId, EQUA_TENANT_ID),
        inArray(
          journals.sourceObjectId,
          sources.map((s) => s.id),
        ),
      ),
    );
  const out: Totals = {};
  for (const r of rows) {
    if (!sources.some((s) => s.type === r.sourceType && s.id === r.sourceId)) continue;
    const t = (out[r.code] ??= { debit: 0, credit: 0 });
    t.debit += Number(r.debit ?? 0);
    t.credit += Number(r.credit ?? 0);
  }
  return out;
}

async function crossModuleIncidents(db: Db) {
  return db
    .select({ title: incidents.title })
    .from(incidents)
    .where(or(like(incidents.title, "%(m11-accounting:%"), like(incidents.title, "%(p2-customer:%")));
}

let invSeq = 0;
async function openInvoice(db: Db, customerId: string, amount: number) {
  invSeq++;
  const [row] = await db
    .insert(invoices)
    .values({
      tenantId: EQUA_TENANT_ID,
      number: `F-26-9${String(invSeq).padStart(5, "0")}`,
      kind: "delivery",
      customerId,
      issueDate: addDays(TODAY, -10),
      dueDate: addDays(TODAY, 5),
      amount,
      outstandingAmount: amount,
      status: "open",
    })
    .returning();
  return row!;
}

describe("Integrasi P2 ↔ M11: pembayaran digital dijurnal sekali + biaya gerbang", () => {
  const t = useTestDb({ seed: true });

  beforeAll(async () => {
    bootstrapForTests();
    await enableApp();
    await setPeriod(t.db, TODAY.slice(0, 7), "open");
    p2.setPaymentGatewayForTests(p2.mockGateway());
  });
  afterAll(() => p2.setPaymentGatewayForTests(undefined));

  it("US-P2-04 KP-3 bayar tagihan lewat QRIS → piutang 1-1401 dikredit sekali (collection.recorded), biaya gerbang Dr beban / Cr transfer belum dicocokkan (PTB-50)", async () => {
    const a = await linkedCustomer(t.db, { creditStatus: "credit", creditLimit: 5_000_000 });
    const inv = await openInvoice(t.db, a.customer.id, 600_000);
    const otp = await p2.requestPaymentOtp(await refresh(a.token, minutes(5)));
    await p2.verifyPaymentOtp(await refresh(a.token, minutes(5)), { code: otp.devCode! });
    const intent = await p2.createPaymentIntent(await refresh(a.token, minutes(6)), { target: "invoice", invoiceId: inv.id, method: "qris_dynamic" });
    await p2.simulateMockPayment(intent.id, "settlement", { now: minutes(10) });

    const [pay] = await t.db.select().from(customerPayments).where(eq(customerPayments.paymentIntentId, intent.id));
    expect(pay).toMatchObject({ channel: "digital", amount: 600_000, advanceAmount: 0 });
    const totals = await totalsFor(t.db, [
      { type: "customer_payment", id: pay!.id },
      { type: "payment_intent", id: intent.id },
    ]);
    // QRIS 0,7% × 600.000 = 4.200 (p2.payment_rules).
    expect(totals["1-1401"]).toEqual({ debit: 0, credit: 600_000 });
    expect(totals["1-1301"]).toEqual({ debit: 600_000, credit: 4_200 });
    expect(totals["6-1901"]).toEqual({ debit: 4_200, credit: 0 });
    const intentJournals = await t.db.select().from(journals).where(and(eq(journals.sourceObjectType, "payment_intent"), eq(journals.sourceObjectId, intent.id)));
    expect(intentJournals).toHaveLength(1);
    expect(intentJournals[0]).toMatchObject({ status: "posted" });
  });

  it("US-P2-04 KP-4 bayar di muka pesanan → seluruh nilai menjadi uang muka 2-1201 sekali (tanpa kredit piutang ganda)", async () => {
    const a = await linkedCustomer(t.db);
    const [addr] = await p2.listMyAddresses(a.cctx);
    const placed = await p2.placeOrder(a.cctx, { addressId: addr!.id, tankCount: 1, date: TODAY, slot: "afternoon", paymentMethod: "digital" });
    const intent = await p2.createPaymentIntent(a.cctx, { target: "order", orderId: placed.orderId, method: "virtual_account" });
    await p2.simulateMockPayment(intent.id, "settlement", { now: minutes(15) });

    const [pay] = await t.db.select().from(customerPayments).where(eq(customerPayments.paymentIntentId, intent.id));
    expect(pay!.advanceAmount).toBe(placed.total);
    const totals = await totalsFor(t.db, [
      { type: "customer_payment", id: pay!.id },
      { type: "payment_intent", id: intent.id },
    ]);
    // Dr 1-1301 / Cr 1-1401 lalu Dr 1-1401 / Cr 2-1201 → piutang netral, uang muka = nilai bayar.
    expect(totals["1-1401"]).toEqual({ debit: placed.total, credit: placed.total });
    expect(totals["2-1201"]).toEqual({ debit: 0, credit: placed.total });
    expect(totals["1-1301"]!.debit).toBe(placed.total);
    const [pi] = await t.db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.id));
    expect(pi!.gatewayFee).toBeGreaterThan(0);
    expect(totals["6-1901"]).toEqual({ debit: pi!.gatewayFee, credit: 0 });
  });

  it("tanpa insiden handler lintas modul (M11/P2) selama alur pembayaran digital", async () => {
    expect(await crossModuleIncidents(t.db)).toEqual([]);
  });
});
