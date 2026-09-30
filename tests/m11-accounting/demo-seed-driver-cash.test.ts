/**
 * Integrasi S5-B: seed demo M11 koheren dengan setoran demo M3/M4 — aturan baru US-M11-06 KP-2 ("kas di tangan sopir
 * harus nol setelah setoran diterima", paket B) menuntut tunai rit di setoran yang BELUM diterima sudah tercatat di kas
 * di tangan sopir; tanpa itu penerimaan setoran demo membuat saldo negatif yang tidak dapat direkonsiliasi (P-07).
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { journalLines, journals, tripPayments } from "@/db/schema";
import { EQUA_TENANT_ID, seedId, userIdByUsername } from "@/db/seed";
import { seedDemoM11Accounting } from "@/db/seed/demo-m11-accounting";
import { monthOf } from "@/lib/time";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createCustomer, createDeposit, createOrder, createScheduledTrip, createTruck, today } from "../helpers/fixtures";

const account = (code: string) => seedId(`account:${code}`);

describe("Seed demo M11 — kas di tangan sopir koheren dengan setoran demo (integrasi S5-B)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M11-06 KP-2 tunai rit di setoran sopir yang belum diterima dibukukan ke kas di tangan sopir (penerimaan setoran demo kembali ke nol); setoran diterima tidak ikut; idempoten", async () => {
    const date = today();
    const cust = await createCustomer(t.db, {});
    const truck = await createTruck(t.db);
    const order = await createOrder(t.db, { customerId: cust.id, addressId: cust.addressId!, date, trips: 2 });
    const pendingTrip = await createScheduledTrip(t.db, { order, truckId: truck.id, date, sequence: 1 });
    const receivedTrip = await createScheduledTrip(t.db, { order, truckId: truck.id, date, sequence: 2 });
    const sopir = userIdByUsername("sopir1");
    const pending = await createDeposit(t.db, { date, sourceType: "driver", status: "submitted", depositorUserId: sopir, expectedCash: 300_000 });
    const received = await createDeposit(t.db, { date, sourceType: "driver", status: "closed", depositorUserId: userIdByUsername("sopir2"), expectedCash: 200_000 });
    const pay = { tenantId: EQUA_TENANT_ID, customerId: cust.id, driverUserId: sopir, method: "cash" as const, businessDate: date };
    await t.db.insert(tripPayments).values([
      { ...pay, tripId: pendingTrip.id, expectedAmount: 300_000, receivedAmount: 300_000, depositId: pending.id },
      { ...pay, tripId: receivedTrip.id, expectedAmount: 200_000, receivedAmount: 200_000, depositId: received.id },
    ]);

    await seedDemoM11Accounting(t.db, new Date(), { force: true });
    const id = seedId(`m11:demo_journal:${monthOf(date)}:driver-cash-pending`);
    const [journal] = await t.db.select().from(journals).where(eq(journals.id, id));
    expect(journal).toMatchObject({ status: "posted", totalDebit: 300_000, totalCredit: 300_000 });
    const lines = await t.db.select().from(journalLines).where(eq(journalLines.journalId, id));
    expect(lines.map((l) => [l.accountId, l.debit, l.credit])).toEqual([
      [account("1-1102"), 300_000, 0],
      [account("4-1101"), 0, 300_000],
    ]);
    // Idempoten: seed ulang tidak menambah jurnal.
    expect((await seedDemoM11Accounting(t.db, new Date(), { force: true })).journals).toBe(0);
    expect(await t.db.select().from(journals).where(and(eq(journals.id, id), eq(journals.tenantId, EQUA_TENANT_ID)))).toHaveLength(1);
  });
});
