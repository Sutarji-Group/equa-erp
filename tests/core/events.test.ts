import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { domainEvents, parameters } from "@/db/schema";
import { isBootstrapped } from "@/server/core/bootstrap";
import { withTx } from "@/server/core/db";
import { DOMAIN_EVENT_TYPES, emit, listHandlers, on, onAny, queryEvents, type DomainEvent } from "@/server/core/events";

import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";

/** Katalog ARCHITECTURE §8 (nama WAJIB sama). */
const ARCHITECTURE_EVENTS = [
  "trip.published", "trip.departed", "trip.arrived", "trip.completed", "trip.failed", "trip.payment_recorded",
  "collection.recorded", "trip.expense_recorded", "expense.verified", "deposit.submitted", "deposit.received",
  "deposit.closed", "discrepancy.formed", "discrepancy.decided", "transfer.matched", "transfer.not_found",
  "bank_deposit.recorded", "office_cash.moved", "petty_cash.recorded", "cash_day.closed", "invoice.issued",
  "invoice.paid", "credit_note.issued", "payment.reversed", "credit_status.changed", "shift.opened", "shift.closed",
  "pos_sale.recorded", "pos_sale.voided", "consumable.usage_posted", "consumable.received", "stock.adjusted",
  "internal_transfer.sent", "internal_transfer.received", "purchase_receipt.recorded", "supplier_payment.recorded",
  "water_supply.confirmed", "meter.reading_recorded", "truck_fill.recorded", "water_balance.computed",
  "restitution.recorded", "restitution.settled", "approval.decided", "fleet_event.detected", "period.closed",
  "period.locked", "asset.depreciated", "partner.subscription_invoiced", "digital_payment.succeeded",
  // Koreksi/pembalik (tinjauan pasca-F3c).
  "trip.corrected", "trip_payment.reversed", "trip_expense.reversed", "bank_deposit.reversed",
  "restitution.settlement_reversed", "consumable.receipt_reversed", "purchase_receipt.corrected", "invoice.written_off",
  "customer_advance.refunded", "discrepancy.reopened",
  // Tambahan modul: karyawan keluar (M1 → M10, BR-37).
  "employee.exited",
  // Tambahan modul M2: pesanan dibuat & transisi status pesanan (US-M2-01, US-M2-02 KP-2).
  "order.created", "order.status_changed",
];

const payload = {
  shiftId: "0192f1c4-7b7a-7cc2-9d7e-3f1b2a4c5d6e",
  outletId: "0192f1c4-7b7a-7cc2-9d7e-3f1b2a4c5d6f",
  operatorUserId: null,
  openingCash: 200_000,
};

describe("Event domain (ARCHITECTURE §5, §8)", () => {
  const t = useTestDb({ seed: true });

  it("§8 katalog event bertipe sama persis dengan ARCHITECTURE", () => {
    expect([...DOMAIN_EVENT_TYPES].sort()).toEqual([...ARCHITECTURE_EVENTS].sort());
  });

  it("emit menyimpan domain_events dan menjalankan handler di transaksi yang sama", async () => {
    const seen: DomainEvent<"shift.opened">[] = [];
    const off = on("shift.opened", async (event, tx) => {
      seen.push(event);
      const inTx = await tx.select().from(domainEvents).where(eq(domainEvents.id, event.id));
      expect(inTx).toHaveLength(1);
    });
    try {
      const ctx = seededContext("depot01", { businessDate: "2026-09-28" });
      const ev = await withTx((tx) => emit(tx, "shift.opened", payload, { ctx, objectType: "shift", objectId: payload.shiftId }));
      expect(seen).toHaveLength(1);
      expect(seen[0]!.payload.openingCash).toBe(200_000);
      expect(ev.businessDate).toBe("2026-09-28");
      expect(ev.source).toBe("pos");
      const stored = await queryEvents(t.db, { type: "shift.opened" });
      expect(stored.map((s) => s.id)).toContain(ev.id);
      expect(isBootstrapped()).toBe(true);
    } finally {
      off();
    }
  });

  it("handler isolate:false gagal → seluruh transaksi rollback (event & tulisan lain tidak tersimpan)", async () => {
    const off = on(
      "shift.closed",
      () => {
        throw new Error("handler M11 gagal");
      },
      { isolate: false },
    );
    try {
      const before = (await queryEvents(t.db, { type: "shift.closed" })).length;
      await expect(
        withTx(async (tx) => {
          await tx.update(parameters).set({ reason: "harus rollback" }).where(eq(parameters.key, "PAR-02"));
          await emit(tx, "shift.closed", {
            shiftId: payload.shiftId,
            outletId: payload.outletId,
            operatorUserId: null,
            salesTotal: 1,
            expectedCash: 1,
            countedCash: 1,
            cashDiscrepancy: 0,
            qrisAmount: 0,
          });
        }),
      ).rejects.toThrow("handler M11 gagal");
      expect((await queryEvents(t.db, { type: "shift.closed" })).length).toBe(before);
      const par = await t.db.select().from(parameters).where(eq(parameters.key, "PAR-02"));
      expect(par[0]!.reason).not.toBe("harus rollback");
    } finally {
      off();
    }
  });

  it("handler boleh meng-emit event lanjutan; onAny melihat semua; pelepas handler bekerja", async () => {
    const order: string[] = [];
    const off1 = on("deposit.received", async (event, tx) => {
      order.push("deposit.received");
      await emit(tx, "deposit.closed", { depositId: event.payload.depositId, sourceType: "driver", closedBy: "x" });
    });
    const off2 = on("deposit.closed", () => {
      order.push("deposit.closed");
    });
    const offAny = onAny((e) => {
      order.push(`any:${e.type}`);
    });
    try {
      await withTx((tx) =>
        emit(tx, "deposit.received", {
          depositId: payload.shiftId,
          sourceType: "driver",
          expectedAmount: 100,
          receivedAmount: 100,
          discrepancyAmount: 0,
          receivedBy: "u",
          late: false,
        }),
      );
      expect(order).toEqual(["deposit.received", "deposit.closed", "any:deposit.closed", "any:deposit.received"]);
    } finally {
      off1();
      off2();
      offAny();
    }
    expect(listHandlers("deposit.closed")).toEqual([]);
  });

  it("R04 / Bab 6.4 butir 3 handler modul lain (terisolasi, bawaan) gagal → pemancar tetap commit; insiden dicatat; tulisan handler dibatalkan", async () => {
    const { incidents } = await import("@/db/schema");
    const seen: string[] = [];
    const offBad = on(
      "shift.opened",
      async (_event, tx) => {
        await tx.update(parameters).set({ reason: "tulisan handler gagal" }).where(eq(parameters.key, "PAR-03"));
        throw new Error("JOURNAL_UNBALANCED (uji)");
      },
      { name: "m11-accounting:uji-gagal" },
    );
    const offGood = on("shift.opened", () => void seen.push("berikutnya tetap jalan"), { name: "m9-reports:uji" });
    try {
      const ev = await withTx(async (tx) => {
        await tx.update(parameters).set({ reason: "tulisan pemancar" }).where(eq(parameters.key, "PAR-02"));
        return emit(tx, "shift.opened", payload, { ctx: seededContext("depot01") });
      });
      expect(seen).toEqual(["berikutnya tetap jalan"]);
      expect((await queryEvents(t.db, { type: "shift.opened" })).map((e) => e.id)).toContain(ev.id);
      const [p2] = await t.db.select().from(parameters).where(eq(parameters.key, "PAR-02"));
      expect(p2!.reason).toBe("tulisan pemancar");
      const [p3] = await t.db.select().from(parameters).where(eq(parameters.key, "PAR-03"));
      expect(p3!.reason).not.toBe("tulisan handler gagal");
      const inc = await t.db.select().from(incidents).where(eq(incidents.objectId, ev.id));
      expect(inc).toHaveLength(1);
      expect(inc[0]!.title).toMatch(/m11-accounting:uji-gagal/);
    } finally {
      offBad();
      offGood();
    }
  });

  it("registrasi ulang handler bernama sama mengganti yang lama (tidak menggandakan efek)", async () => {
    let calls = 0;
    const offA = on("shift.opened", () => void calls++, { name: "m6-pos:uji-dedupe" });
    const offB = on("shift.opened", () => void calls++, { name: "m6-pos:uji-dedupe" });
    try {
      await withTx((tx) => emit(tx, "shift.opened", payload, { ctx: seededContext("depot01") }));
      expect(calls).toBe(1);
      expect(listHandlers("shift.opened").filter((n) => n === "m6-pos:uji-dedupe")).toHaveLength(1);
    } finally {
      offA();
      offB();
    }
  });

  it("occurredAt event mengikuti ctx.now (waktu dikendalikan uji)", async () => {
    const now = new Date("2026-09-28T01:02:03Z");
    const ev = await withTx((tx) => emit(tx, "shift.opened", payload, { ctx: seededContext("depot01", { now }) }));
    expect(ev.occurredAt.toISOString()).toBe(now.toISOString());
  });

  it("tipe event di luar katalog ditolak", async () => {
    await expect(withTx((tx) => emit(tx, "tidak.ada" as never, {} as never))).rejects.toThrow(/tidak dikenal/);
    expect(() => on("tidak.ada" as never, () => undefined)).toThrow(/tidak dikenal/);
  });

  it("domain_events append-only (UPDATE ditolak trigger)", async () => {
    const err = await t.db.update(domainEvents).set({ type: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
  });
});
