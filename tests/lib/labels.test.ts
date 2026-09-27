import { describe, expect, it } from "vitest";

import { enumOptions, enumValues, isEnumValue, label, LABELS, ROLE_CODES } from "@/lib/labels";

describe("lib/labels — label Indonesia untuk enum (ARCHITECTURE §4)", () => {
  it("label mengembalikan istilah PRD", () => {
    expect(label("order_status", "awaiting_approval")).toBe("Menunggu persetujuan");
    expect(label("trip_status", "departed")).toBe("Berangkat");
    expect(label("credit_status", "credit")).toBe("Tempo");
    expect(label("role", "finance_admin")).toBe("Admin Keuangan");
    expect(label("incoming_transfer_status", "unmatched")).toBe("Belum dicocokkan");
    expect(label("shift_deposit_status", "not_deposited")).toBe("Belum disetor");
  });

  it("nilai tak dikenal dikembalikan apa adanya; kosong menjadi tanda pisah", () => {
    expect(label("order_status", "unknown_value")).toBe("unknown_value");
    expect(label("order_status", null)).toBe("—");
    expect(label("order_status", "")).toBe("—");
    expect(label("order_status", "toString")).toBe("toString");
  });

  it("memuat semua kode peran dan enum status dari glosarium", () => {
    expect(ROLE_CODES).toEqual([
      "owner",
      "finance_admin",
      "dispatcher",
      "driver",
      "helper",
      "depot_operator",
      "store_cashier",
      "production_operator",
      "system_admin",
      "accountant",
      "partner_owner",
      "regional_coach",
    ]);
    expect(enumValues("order_status")).toEqual(["new", "awaiting_approval", "scheduled", "in_delivery", "completed", "cancelled"]);
    expect(enumValues("trip_status")).toEqual(["assigned", "departed", "arrived", "completed", "failed"]);
    expect(enumValues("deposit_status")).toEqual(["running", "submitted", "received", "closed"]);
    expect(enumValues("discrepancy_status")).toEqual(["formed", "explained", "approved", "rejected", "followed_up", "done"]);
    expect(enumValues("invoice_status")).toEqual(["open", "partial", "paid"]);
    expect(enumValues("period_status")).toEqual(["open", "closed", "locked", "reopened"]);
    expect(enumValues("approval_status")).toEqual(["submitted", "approved", "rejected", "expired", "cancelled"]);
    expect(enumValues("device_status")).toEqual(["registered", "active", "blocked", "wipe_pending", "wiped"]);
    expect(enumValues("notification_status")).toEqual(["new", "read", "actioned", "done"]);
    expect(enumValues("credit_status")).toEqual(["cash", "credit", "credit_migrated", "on_hold"]);
  });

  it("setiap label tidak kosong dan enumOptions/isEnumValue konsisten", () => {
    for (const [name, map] of Object.entries(LABELS)) {
      for (const [value, text] of Object.entries(map)) {
        expect(text.trim().length, `${name}.${value}`).toBeGreaterThan(0);
      }
    }
    expect(enumOptions("outlet_kind")).toEqual([
      { value: "depot", label: "Depot" },
      { value: "store", label: "Toko" },
    ]);
    expect(isEnumValue("role", "driver")).toBe(true);
    expect(isEnumValue("role", "customer")).toBe(false);
  });
});
