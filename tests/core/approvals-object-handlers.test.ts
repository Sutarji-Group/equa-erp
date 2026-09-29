import { describe, expect, it } from "vitest";

import { newId } from "@/lib/ids";
import * as approvals from "@/server/core/approvals";

import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";

const T0 = new Date("2026-09-28T03:00:00Z"); // 10.00 WIB

describe("Handler persetujuan per jenis objek (jenis bersama 'correction', BR-38)", () => {
  useTestDb({ seed: true });

  it("BR-38 koreksi lintas modul: handler dipilih dari object_type, cadangan ke handler umum", async () => {
    const calls: string[] = [];
    const offGeneric = approvals.registerApprovalHandler("correction", {
      onApproved: async () => {
        calls.push("umum");
      },
    });
    const offPos = approvals.registerApprovalHandler(
      "correction",
      {
        onApproved: async ({ request }) => {
          calls.push(`pos:${request.objectType}`);
        },
      },
      { objectType: "pos_sale" },
    );
    try {
      const keu = seededContext("keuangan1", { now: T0 });
      const owner = seededContext("pemilik", { now: T0 });

      const posReq = await approvals.submit(keu, {
        type: "correction",
        objectType: "pos_sale",
        objectId: newId(),
        amount: 750_000,
        reason: "Pembalik penjualan salah catat setelah shift ditutup",
      });
      await approvals.decide(owner, posReq.id, "approve");

      const otherReq = await approvals.submit(keu, {
        type: "correction",
        // Jenis objek tanpa handler khusus (trip/trip_payment kini punya handler M3 — B-34, S5) → cadangan umum.
        objectType: "objek_uji",
        objectId: newId(),
        amount: 600_000,
        reason: "Pembayaran rit dicatat pada pelanggan yang salah",
      });
      await approvals.decide(owner, otherReq.id, "approve");

      expect(calls).toEqual(["pos:pos_sale", "umum"]);
      expect(approvals.getApprovalHandlers("correction", "pos_sale")?.onApproved).toBeTypeOf("function");
      expect(approvals.getApprovalHandlers("correction", "tidak_ada")).toBe(approvals.getApprovalHandlers("correction"));
    } finally {
      offPos();
      offGeneric();
    }
  });
});
