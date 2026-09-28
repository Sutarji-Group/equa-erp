import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { accountingPeriods, accounts, journalLines, journalQueue, journals, notifications } from "@/db/schema";
import { accountId, EQUA_TENANT_ID, outletId, userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";
import { withTx } from "@/server/core/db";
import { DomainError } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import * as flags from "@/server/core/flags";
import { postFromMapping, postJournal, resolveMapping, resolvePostingPeriod } from "@/server/core/ledger";
import * as params from "@/server/core/params";

import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";

const tripCompleted = () => ({
  tripId: newId(),
  orderId: newId(),
  customerId: newId(),
  truckId: newId(),
  driverUserId: null,
  isInternal: false,
  volumeL: 5000,
  price: 200_000,
  paymentMethod: "cash" as const,
  cashReceived: 200_000,
  transferAmount: 0,
  creditAmount: 0,
  underpaymentAmount: 0,
  completedAt: "2026-09-20T03:00:00.000Z",
  recordedByOffice: false,
  lateSync: false,
});

describe("Jurnal otomatis (ledger.ts, US-M11-02, FR-M11-10)", () => {
  const t = useTestDb({ seed: true });

  it("US-M11-02 KP-3 jurnal tidak seimbang ditolak", async () => {
    const err = await withTx((tx) =>
      postJournal(tx, {
        date: "2026-09-20",
        source: "uji",
        description: "tidak seimbang",
        lines: [
          { accountCode: "1-1101", debit: 100_000 },
          { accountCode: "4-1101", credit: 90_000 },
        ],
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe("JOURNAL_UNBALANCED");
    await expect(
      withTx((tx) => postJournal(tx, { date: "2026-09-20", source: "uji", description: "x", lines: [{ accountCode: "1-1101", debit: 1, credit: 1 }, { accountCode: "4-1101", credit: 0 }] })),
    ).rejects.toThrow(/salah satu/);
  });

  it("US-M11-02 KP-1 rit Selesai tunai → jurnal L2 dari pemetaan (J-YYMM), idempoten per event", async () => {
    const payload = tripCompleted();
    const result = await withTx(async (tx) => {
      const ev = await emit(tx, "trip.completed", payload, { businessDate: "2026-09-20", tenantId: EQUA_TENANT_ID });
      const first = await postFromMapping(tx, {
        source: "trip.completed",
        sourceEventId: ev.id,
        sourceObject: { type: "trip", id: payload.tripId },
        date: "2026-09-20",
        ref: "P-26-000001/1",
        description: "Rit Selesai tunai",
        entries: [{ entryKey: "cash", amount: payload.cashReceived }],
      });
      const again = await postFromMapping(tx, {
        source: "trip.completed",
        sourceEventId: ev.id,
        date: "2026-09-20",
        description: "Rit Selesai tunai",
        entries: [{ entryKey: "cash", amount: payload.cashReceived }],
      });
      return { first, again };
    });
    expect(result.first.status).toBe("posted");
    if (result.first.status !== "posted") return;
    expect(result.first.number).toBe("J-2609-00001");
    expect(result.first.originPeriod).toBeNull();
    expect(result.again).toMatchObject({ status: "duplicate", journalId: result.first.journalId });
    const lines = await t.db.select().from(journalLines).where(eq(journalLines.journalId, result.first.journalId)).orderBy(journalLines.lineNo);
    expect(lines.map((l) => [l.accountId, l.profitCenter, l.debit, l.credit])).toEqual([
      [accountId("1-1102"), "L2", 200_000, 0],
      [accountId("4-1101"), "L2", 0, 200_000],
    ]);
    const [j] = await t.db.select().from(journals).where(eq(journals.id, result.first.journalId));
    expect(j!.description).toBe("Rit Selesai tunai (P-26-000001/1)");
    expect(j!.totalDebit).toBe(200_000);
  });

  it("FR-M11-10 periode Ditutup/Dikunci → diposting ke periode terbuka pertama dengan penanda asal periode", async () => {
    await t.db.insert(accountingPeriods).values([
      { tenantId: EQUA_TENANT_ID, period: "2026-07", startDate: "2026-07-01", endDate: "2026-07-31", status: "locked" },
      { tenantId: EQUA_TENANT_ID, period: "2026-08", startDate: "2026-08-01", endDate: "2026-08-31", status: "closed" },
    ]);
    const r = await withTx((tx) =>
      postJournal(tx, {
        date: "2026-07-15",
        source: "trip.completed",
        description: "Rit terlambat sinkron",
        lines: [
          { accountCode: "1-1102", profitCenter: "L2", debit: 150_000 },
          { accountCode: "4-1101", profitCenter: "L2", credit: 150_000 },
        ],
      }),
    );
    expect(r).toMatchObject({ status: "posted", period: "2026-09", originPeriod: "2026-07" });
    const [j] = await t.db.select().from(journals).where(eq(journals.id, (r as { journalId: string }).journalId));
    expect(j!.journalDate).toBe("2026-07-15");
    expect(j!.originPeriod).toBe("2026-07");

    // Periode berikutnya pun ditutup → periode baru dibuat Terbuka.
    await t.db.update(accountingPeriods).set({ status: "closed" }).where(eq(accountingPeriods.period, "2026-09"));
    const next = await withTx((tx) => resolvePostingPeriod(tx, EQUA_TENANT_ID, "2026-08-31"));
    expect(next).toMatchObject({ period: "2026-10", originPeriod: "2026-08" });
    await t.db.update(accountingPeriods).set({ status: "open" }).where(eq(accountingPeriods.period, "2026-09"));
  });

  it("US-M11-02 KP-3 pemetaan hilang → antrean jurnal + notifikasi Admin Keuangan (tidak hilang diam-diam)", async () => {
    const r = await withTx((tx) =>
      postFromMapping(tx, {
        source: "trip.completed",
        date: "2026-09-21",
        description: "Rit dengan cara bayar baru",
        entries: [{ entryKey: "voucher", amount: 50_000 }],
      }),
    );
    expect(r).toMatchObject({ status: "queued", reason: "mapping_missing" });
    const q = await t.db.select().from(journalQueue).where(eq(journalQueue.id, (r as { queueId: string }).queueId));
    expect(q[0]).toMatchObject({ eventKey: "trip.completed", status: "pending", journalDate: "2026-09-21" });
    const notes = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.event, "journal.queued"), eq(notifications.recipientUserId, userIdByUsername("keuangan1"))));
    expect(notes.length).toBeGreaterThanOrEqual(1);
  });

  it("US-M11-01 KP-1 akun nonaktif → antrean account_inactive", async () => {
    await t.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, accountId("4-9101")));
    const r = await withTx((tx) =>
      postJournal(tx, {
        date: "2026-09-21",
        source: "deposit.received",
        description: "Selisih lebih",
        lines: [
          { accountCode: "1-1101", debit: 5_000 },
          { accountCode: "4-9101", credit: 5_000 },
        ],
      }),
    );
    expect(r).toMatchObject({ status: "queued", reason: "account_inactive" });
    await t.db.update(accounts).set({ isActive: true }).where(eq(accounts.id, accountId("4-9101")));
  });

  it("7.11.4 aturan pusat laba: from_outlet (depot → L3) dan from_source (pusat laba sumber)", async () => {
    const pos = await withTx((tx) =>
      postFromMapping(tx, {
        source: "pos_sale.recorded",
        date: "2026-09-22",
        description: "Penjualan POS D01",
        entries: [{ entryKey: "depot_cash", amount: 45_000, outletId: outletId("D01") }],
      }),
    );
    const posLines = await t.db.select().from(journalLines).where(eq(journalLines.journalId, (pos as { journalId: string }).journalId));
    expect(posLines.map((l) => l.profitCenter)).toEqual(["L3", "L3"]);
    expect(posLines.every((l) => l.outletId === outletId("D01"))).toBe(true);

    const shortage = await withTx((tx) =>
      postFromMapping(tx, {
        source: "deposit.received",
        date: "2026-09-22",
        description: "Selisih kurang setoran depot",
        entries: [{ entryKey: "shortage", amount: 20_000, profitCenter: "L3" }],
      }),
    );
    const sLines = await t.db.select().from(journalLines).where(eq(journalLines.journalId, (shortage as { journalId: string }).journalId));
    expect(sLines.map((l) => l.profitCenter)).toEqual(["L3", "L3"]);
  });

  it("R04 M11 belum aktif → jurnal otomatis dilewati; sebelum cut-over → antrean", async () => {
    const owner = seededContext("pemilik");
    await flags.set(owner, "accounting.m11_active", false, { reason: "Bagan akun belum disahkan akuntan" });
    const skipped = await withTx((tx) =>
      postFromMapping(tx, { source: "trip.completed", date: "2026-09-23", description: "x", entries: [{ entryKey: "cash", amount: 1_000 }] }),
    );
    expect(skipped).toEqual({ status: "skipped", reason: "m11_inactive" });
    await flags.set(owner, "accounting.m11_active", true, { reason: "M11 diaktifkan" });

    await params.set(seededContext("pemilik", { now: new Date("2026-09-28T03:00:00Z") }), "accounting.cutover_date", { date: "2026-10-01" }, "2026-09-28", "Cut-over akuntansi");
    const before = await withTx((tx) =>
      postJournal(tx, {
        date: "2026-09-28",
        source: "trip.completed",
        description: "sebelum cut-over",
        lines: [
          { accountCode: "1-1102", debit: 1_000 },
          { accountCode: "4-1101", credit: 1_000 },
        ],
      }),
    );
    expect(before).toMatchObject({ status: "queued", reason: "period_unavailable" });
    await expect(
      withTx((tx) => params.set(seededContext("pemilik", { now: new Date("2026-09-28T03:00:00Z") }), "accounting.cutover_date", { date: "2026-10-15" }, "2026-09-29", "tanggal salah", { tx })),
    ).rejects.toThrow(/tanggal 1/);
  });

  it("resolveMapping memilih pemetaan berlaku per tanggal", async () => {
    const m = await withTx((tx) => resolveMapping(tx, "deposit.received", "driver", "2026-09-28"));
    expect(m).toMatchObject({ debitAccountId: accountId("1-1101"), creditAccountId: accountId("1-1102") });
    expect(await withTx((tx) => resolveMapping(tx, "deposit.received", "driver", "2024-01-01"))).toBeNull();
  });
});
