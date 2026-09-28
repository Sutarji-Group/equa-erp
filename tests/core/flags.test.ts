import { describe, expect, it } from "vitest";

import { EQUA_TENANT_ID, truckId } from "@/db/seed";
import { ForbiddenError } from "@/server/core/errors";
import * as flags from "@/server/core/flags";

import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";

describe("Feature flag (PRD 2.1, D-02, D-03)", () => {
  const t = useTestDb({ seed: true });

  it("D-02/D-03 nilai bawaan: Tahap 2/3 & delegasi mati, M11 aktif, deteksi di luar jadwal aktif", async () => {
    expect(await flags.isEnabled(t.db, "phase2.customer_app")).toBe(false);
    expect(await flags.isEnabled(t.db, "phase3.partner_portal")).toBe(false);
    expect(await flags.isEnabled(t.db, "approvals.delegation")).toBe(false);
    expect(await flags.isEnabled(t.db, "partner.franchise_terms")).toBe(false);
    expect(await flags.isEnabled(t.db, "accounting.m11_active")).toBe(true);
    expect(await flags.isEnabled(t.db, "fleet.offschedule_detection", { truckId: truckId("T1") })).toBe(true);
  });

  it("7.12.6 deteksi di luar jadwal dapat dimatikan per truk (lingkup paling spesifik menang)", async () => {
    await flags.set(seededContext("admin1"), "fleet.offschedule_detection", false, {
      scope: { type: "truck", refId: truckId("T3") },
      reason: "Perangkat GPS T3 belum terpasang",
    });
    expect(await flags.isEnabled(t.db, "fleet.offschedule_detection", { truckId: truckId("T3") })).toBe(false);
    expect(await flags.isEnabled(t.db, "fleet.offschedule_detection", { truckId: truckId("T4") })).toBe(true);
  });

  it("flag tenant mengalahkan global; hanya pemilik mengaktifkan Tahap 2", async () => {
    await expect(
      flags.set(seededContext("admin1"), "phase2.customer_app", true, { reason: "coba aktifkan" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await flags.set(seededContext("pemilik"), "phase2.customer_app", true, {
      scope: { type: "tenant", refId: EQUA_TENANT_ID },
      reason: "Gerbang TG-9 terpenuhi",
    });
    expect(await flags.isEnabled(t.db, "phase2.customer_app", { tenantId: EQUA_TENANT_ID })).toBe(true);
    expect(await flags.isEnabled(t.db, "phase2.customer_app")).toBe(false);
    await expect(flags.set(seededContext("pemilik"), "partner.franchise_terms", true, { scope: { type: "outlet", refId: "x" }, reason: "tidak sah" })).rejects.toThrow(
      /tidak dapat diatur/,
    );
    await expect(flags.isEnabled(t.db, "tidak.ada" as never)).rejects.toThrow(/tidak dikenal/);
  });

  it("enabledFlags untuk registri navigasi", async () => {
    const on = await flags.enabledFlags(t.db, { tenantId: EQUA_TENANT_ID });
    expect(on).toContain("accounting.m11_active");
    expect(on).toContain("phase2.customer_app");
  });
});
