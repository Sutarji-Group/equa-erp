import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { auditLogs, outlets, outletWaterLedger } from "@/db/schema";
import { EQUA_TENANT_ID, outletId } from "@/db/seed";
import { ForbiddenError } from "@/server/core/errors";
import { depotWaterOpenings, recordDepotOpeningWater } from "@/server/modules/m8-production";
import { waterBalance } from "@/server/modules/m6-pos";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { dispatcher, finance, owner } from "./helpers";

describe("M8 — stok air awal depot saat cut-over (backlog B-10)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("B-10 US-M6-05 KP-3 Admin Keuangan mencatat stok air awal depot sekali (buku air M6 jenis 'opening'); kedua kali ditolak, peran lain ditolak", async () => {
    // Depot baru (belum punya stok awal di buku air).
    const [depot] = await t.db
      .insert(outlets)
      .values({ tenantId: EQUA_TENANT_ID, code: "DU1", name: "Depot Uji Cut-over", kind: "depot", storageCapacityL: 5_000 })
      .returning();
    const depotId = depot!.id;
    await expect(recordDepotOpeningWater(dispatcher(), { outletId: depotId, volumeL: 1_200, reason: "Ukur toren saat cut-over" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordDepotOpeningWater(owner(), { outletId: depotId, volumeL: 1_200, reason: "Ukur toren saat cut-over" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordDepotOpeningWater(finance(), { outletId: depotId, volumeL: 1_200, reason: "x" })).rejects.toThrow(/Tulis dasar angka/);
    await expect(recordDepotOpeningWater(finance(), { outletId: depotId, volumeL: 999_999, reason: "Ukur toren saat cut-over" })).rejects.toThrow(/melebihi kapasitas toren/);
    await expect(recordDepotOpeningWater(finance(), { outletId: outletId("TK1"), volumeL: 100, reason: "Ukur toren saat cut-over" })).rejects.toThrow(/bukan depot/);

    const before = await waterBalance(t.db, depotId);
    const res = await recordDepotOpeningWater(finance(), { outletId: depotId, volumeL: 1_200, businessDate: "2026-09-01", reason: "Ukur toren bersama operator depot" });
    expect(res.balanceAfterL).toBe(before + 1_200);
    const [row] = await t.db.select().from(outletWaterLedger).where(and(eq(outletWaterLedger.outletId, depotId), eq(outletWaterLedger.kind, "opening")));
    expect(row).toMatchObject({ volumeL: 1_200, businessDate: "2026-09-01", sourceObjectType: "depot_water_opening" });
    const [audit] = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "depot_water_opening"), eq(auditLogs.objectId, res.ledgerId)));
    expect(audit?.reason).toMatch(/Ukur toren/);

    await expect(recordDepotOpeningWater(finance(), { outletId: depotId, volumeL: 900, reason: "Ukur ulang toren" })).rejects.toThrow(/sudah dicatat/);
    const list = await depotWaterOpenings(owner());
    expect(list.find((r) => r.outletId === depotId)).toMatchObject({ opening: { volumeL: 1_200, businessDate: "2026-09-01" }, currentBalanceL: before + 1_200 });
    expect(list.every((r) => r.outletCode.startsWith("D"))).toBe(true);
    await expect(depotWaterOpenings(seededContext("kasir"))).rejects.toBeInstanceOf(ForbiddenError);
  });
});
