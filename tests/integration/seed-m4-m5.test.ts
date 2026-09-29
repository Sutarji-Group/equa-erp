/**
 * B-39 — seed demo lintas modul M4 ↔ M5 koheren:
 * - transfer "Tidak ditemukan" demo M4 (PLG-0039) merujuk pelunasan kantor M5 yang ADA dan punya piutang sementara
 *   "transfer belum diterima" (seperti hasil handler `transfer.not_found`, US-M4-04 KP-4);
 * - pelunasan transfer kantor demo M5 punya transfer masuk M4 (`office_payment`); pelunasan tunai kantor sesudah saldo
 *   awal kas kantor tercatat di kas kantor (US-M4-06).
 * Waktu seed tetap (D-10 butir 6: uji tidak bergantung jam dinding).
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { cashDays, customerPayments, incomingTransfers, invoices, officeCashMovements } from "@/db/schema";
import { customerId } from "@/db/seed";
import { seedId } from "@/db/seed/ids";
import { seedDemoM4Cash } from "@/db/seed/demo-m4-cash";
import { DEMO_M4_NOT_FOUND_TRANSFER_ID, DEMO_M5_PAYMENT_KEYS, demoM5PaymentId, seedDemoM5PendingTransfers, seedDemoM5Receivables } from "@/db/seed/demo-m5-receivables";
import { addDays, toBusinessDate, wibToUtc } from "@/lib/time";
import { systemContext } from "@/server/core/context";
import { withTx } from "@/server/core/db";
import * as m4 from "@/server/modules/m4-cash";
import { recomputeInvoice } from "@/server/modules/m5-receivables/service/ledger";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";

/** Selasa 20 Okt 2026 10.00 WIB. */
const NOW = new Date("2026-10-20T03:00:00Z");
const TODAY = toBusinessDate(NOW);
const finance = (now = NOW) => seededContext("keuangan1", { now });

describe("B-39 seed demo M4 ↔ M5 koheren", () => {
  const t = useTestDb({ seed: true });

  async function seedAll() {
    await seedDemoM5Receivables(t.db, NOW, { force: true });
    await seedDemoM4Cash(t.db, NOW, { force: true });
    await seedDemoM5PendingTransfers(t.db, NOW, { force: true });
  }

  beforeAll(async () => {
    bootstrapForTests();
    await seedAll();
  });

  it("B-39 US-M4-04 KP-4 transfer 'Tidak ditemukan' PLG-0039 merujuk pelunasan kantor M5 yang ada + piutang sementara 'transfer belum diterima'", async () => {
    const [tr] = await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.id, DEMO_M4_NOT_FOUND_TRANSFER_ID));
    expect(tr).toMatchObject({ status: "not_found", sourceKind: "office_payment", sourceObjectType: "customer_payment", customerId: customerId("PLG-0039") });
    const [pay] = await t.db.select().from(customerPayments).where(eq(customerPayments.id, tr!.sourceObjectId!));
    expect(pay).toMatchObject({ customerId: customerId("PLG-0039"), channel: "office", method: "transfer", amount: tr!.amount, businessDate: tr!.transferDate, incomingTransferId: tr!.id });
    const [pending] = await t.db.select().from(invoices).where(eq(invoices.pendingTransferId, tr!.id));
    const flagged = toBusinessDate(tr!.notFoundAt!);
    expect(pending).toMatchObject({ customerId: customerId("PLG-0039"), amount: tr!.amount, outstandingAmount: tr!.amount, status: "open", issueDate: flagged, dueDate: flagged });
    expect(pending!.number).toMatch(/^F-26-\d{6}$/);
    // Buku piutang konsisten: menghitung ulang faktur sementara & faktur yang dilunasi transfer itu tidak mengubah apa pun.
    const sys = systemContext({ now: NOW });
    for (const id of [pending!.id]) expect((await withTx((tx) => recomputeInvoice(tx, sys, id))).changed).toBe(false);
  });

  it("B-39 US-M4-04 KP-1 setiap pelunasan transfer kantor demo M5 punya transfer masuk M4 (office_payment); yang lama sudah dicocokkan", async () => {
    const pays = await t.db.select().from(customerPayments).where(and(eq(customerPayments.channel, "office"), eq(customerPayments.method, "transfer")));
    expect(pays.length).toBeGreaterThanOrEqual(3);
    for (const p of pays) {
      const [tr] = await t.db.select().from(incomingTransfers).where(and(eq(incomingTransfers.sourceObjectType, "customer_payment"), eq(incomingTransfers.sourceObjectId, p.id)));
      expect(tr, `transfer untuk pelunasan ${p.notes}`).toMatchObject({ sourceKind: "office_payment", amount: p.amount, customerId: p.customerId, transferDate: p.businessDate });
      expect(p.incomingTransferId).toBe(tr!.id);
      expect(tr!.status).toBe(p.id === demoM5PaymentId("bojong-tf") ? "not_found" : "matched");
    }
    // Daftar transfer terbuka M4 memuat transfer "Tidak ditemukan" dengan nama pelanggan.
    const open = await m4.listIncomingTransfers(finance(), { status: "open" });
    expect(open.find((r) => r.id === DEMO_M4_NOT_FOUND_TRANSFER_ID)).toMatchObject({ customerName: "Kolam Renang Bojong Sari" });
  });

  it("B-39 US-M4-06 KP-1 pelunasan tunai kantor demo M5 (H-1, sesudah saldo awal kas kantor) tercatat di kas kantor; hari kas yang ditutup tetap cocok", async () => {
    const [cash] = await t.db.select().from(customerPayments).where(and(eq(customerPayments.channel, "office"), eq(customerPayments.method, "cash")));
    expect(cash!.id).toBe(demoM5PaymentId("tirta-cash"));
    expect(cash!.businessDate).toBe(addDays(TODAY, -1));
    const moves = await t.db.select().from(officeCashMovements).where(and(eq(officeCashMovements.sourceObjectType, "customer_payment"), eq(officeCashMovements.sourceObjectId, cash!.id)));
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ kind: "customer_payment", direction: "in", amount: cash!.amount, businessDate: cash!.businessDate });
    expect(moves[0]!.description).toContain("Depot Air Tirta Sari");
    const listed = await m4.listOfficeCashMovements(finance(), { from: addDays(TODAY, -1), to: addDays(TODAY, -1) });
    expect(listed.some((m) => m.sourceObjectId === cash!.id)).toBe(true);
    for (const d of await t.db.select().from(cashDays).where(eq(cashDays.status, "closed"))) {
      const [bal] = await t.db
        .select({ v: sql<number>`coalesce(sum(case when ${officeCashMovements.direction} = 'in' then ${officeCashMovements.amount} else -${officeCashMovements.amount} end), 0)` })
        .from(officeCashMovements)
        .where(sql`${officeCashMovements.businessDate} <= ${d.businessDate}`);
      expect(Number(bal!.v)).toBe(d.officeCashSystem);
    }
  });

  it("B-39 seed lintas modul idempoten: dijalankan ulang tidak menggandakan transfer, mutasi kas, faktur", async () => {
    const count = async () => ({
      transfers: Number((await t.db.select({ n: sql<number>`count(*)` }).from(incomingTransfers))[0]!.n),
      moves: Number((await t.db.select({ n: sql<number>`count(*)` }).from(officeCashMovements))[0]!.n),
      invoices: Number((await t.db.select({ n: sql<number>`count(*)` }).from(invoices))[0]!.n),
    });
    const before = await count();
    await seedAll();
    expect(await count()).toEqual(before);
    expect(DEMO_M5_PAYMENT_KEYS).toContain("bojong-tf");
  });

  it("B-39 US-M4-04 KP-4 transfer demo 'Tidak ditemukan' akhirnya dicocokkan → piutang sementara M5 ditutup nota kredit (alur handler nyata)", async () => {
    const [tr] = await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.id, DEMO_M4_NOT_FOUND_TRANSFER_ID));
    await m4.matchTransfer(finance(wibToUtc(TODAY, "11:00")), { transferId: tr!.id, refDate: tr!.transferDate, refAmount: tr!.amount, refNote: "TRSF E-BANKING CR BOJONG SARI (terlambat)" });
    const [inv] = await t.db.select().from(invoices).where(eq(invoices.id, seedId(`m5:demo:invoice:pending:${tr!.id}`)));
    expect(inv).toMatchObject({ outstandingAmount: 0, creditedAmount: tr!.amount, pendingTransferId: null });
    expect(inv!.status).not.toBe("open");
    const [after] = await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.id, tr!.id));
    expect(after!.status).toBe("matched");
  });
});
