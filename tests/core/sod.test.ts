import { describe, expect, it } from "vitest";

import { ForbiddenError } from "@/server/core/errors";
import { sod } from "@/server/core/rbac";

import { testContext } from "../helpers/context";

describe("Pemisahan tugas (US-M10-03, PTB-31)", () => {
  it("FR-M10-03 SOD-01 pembuat transaksi bukan penyetujunya", () => {
    const err = (() => {
      try {
        sod.assertNotSelf("u-1", "u-1", "koreksi");
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).rule).toBe("SOD-01");
    expect((err as ForbiddenError).message).toMatch(/Pembuat transaksi\/permintaan bukan penyetujunya/);
    expect(() => sod.assertNotSelf("u-1", "u-2")).not.toThrow();
  });

  it("US-M10-03 KP-1 SOD-02 penerima setoran bukan penyetornya", () => {
    expect(() => sod.assertReceiverNotDepositor("u-1", "u-1")).toThrow(/menerima setoran Anda sendiri/);
    expect(() => sod.assertReceiverNotDepositor("u-1", "u-2")).not.toThrow();
  });

  it("US-M10-03 KP-1 SOD-03..08 aturan per peran", () => {
    expect(() => sod.assertNotFinanceAdminOnOrders(testContext({ role: "finance_admin" }))).toThrow(/SOD-03|pesanan/);
    expect(() => sod.assertDispatcherNoCash(testContext({ role: "dispatcher" }))).toThrow(/kas/);
    expect(() => sod.assertSystemAdminNotFinance(testContext({ role: "system_admin" }))).toThrow(/transaksi keuangan/);
    expect(() => sod.assertOwnerNotDailyInput(testContext({ role: "owner" }))).toThrow(/transaksi harian/);
    expect(() => sod.assertOwnTrip(testContext({ role: "driver", userId: "a" }), "b")).toThrow(/bukan milik Anda/);
    expect(() => sod.assertOwnTrip(testContext({ role: "driver", userId: "a" }), "a")).not.toThrow();
    expect(() => sod.assertNotLocked(true, { what: "Rit" })).toThrow(/terkunci/);
    expect(() => sod.assertOwnOutlet(testContext({ role: "depot_operator", scope: { outletIds: ["o1"] } }), "o2")).toThrow(ForbiddenError);
  });

  it("US-M10-01 KP-4 PTB-31 Admin Keuangan + Dispatcher/Sopir/Kernet/Operator/Kasir tidak dapat diajukan", () => {
    for (const other of ["dispatcher", "driver", "helper", "depot_operator", "store_cashier", "production_operator"] as const) {
      const r = sod.validateRoleCombination(["finance_admin", other]);
      expect(r.ok, other).toBe(false);
      expect(r.violations[0]!.ref).toBe("PTB-31");
    }
  });

  it("US-M10-01 KP-4 PTB-31 admin sistem + peran kas/jurnal; pemilik + pencatat harian ditolak", () => {
    expect(sod.validateRoleCombination(["system_admin", "finance_admin"]).ok).toBe(false);
    expect(sod.validateRoleCombination(["system_admin", "store_cashier"]).ok).toBe(false);
    expect(sod.validateRoleCombination(["owner", "dispatcher"]).ok).toBe(false);
    expect(sod.validateRoleCombination(["owner", "finance_admin"]).ok).toBe(false);
    expect(() => sod.assertRoleCombination(["owner", "driver"])).toThrow(/tidak dapat diajukan/);
  });

  it("US-M10-01 KP-4 kombinasi yang sah tetap boleh (mis. Sopir + Kernet, Dispatcher + Sopir)", () => {
    expect(sod.validateRoleCombination(["driver", "helper"]).ok).toBe(true);
    expect(sod.validateRoleCombination(["dispatcher", "driver"]).ok).toBe(true);
    expect(sod.validateRoleCombination(["owner", "system_admin"]).ok).toBe(true);
    expect(() => sod.assertRoleCombination(["accountant"])).not.toThrow();
  });

  it("NFR-30 pemilik mitra tidak digabung dengan peran internal EQUA", () => {
    expect(sod.validateRoleCombination(["partner_owner", "depot_operator"]).ok).toBe(false);
  });
});
