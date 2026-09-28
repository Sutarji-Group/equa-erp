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

  it("handler gagal → seluruh transaksi rollback (event & tulisan lain tidak tersimpan)", async () => {
    const off = on("shift.closed", () => {
      throw new Error("handler M11 gagal");
    });
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

  it("tipe event di luar katalog ditolak", async () => {
    await expect(withTx((tx) => emit(tx, "tidak.ada" as never, {} as never))).rejects.toThrow(/tidak dikenal/);
    expect(() => on("tidak.ada" as never, () => undefined)).toThrow(/tidak dikenal/);
  });

  it("domain_events append-only (UPDATE ditolak trigger)", async () => {
    const err = await t.db.update(domainEvents).set({ type: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
  });
});
