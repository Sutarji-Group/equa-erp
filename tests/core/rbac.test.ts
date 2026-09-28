import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { navPermissions, PERMISSION_PATTERN } from "@/components/shared/nav/registry";
import { accessLogs, notifications } from "@/db/schema";
import { outletId, truckId, userIdByUsername, waterSourceId } from "@/db/seed";
import { ROLE_CODES, type RoleCode } from "@/lib/labels";
import { systemContext } from "@/server/core/context";
import { ForbiddenError } from "@/server/core/errors";
import {
  assertOutletScope,
  assertSourceScope,
  assertTenantScope,
  assertTruckScope,
  authorize,
  can,
  exportMatrix,
  getPermission,
  PERMISSIONS,
  permissionsForRoles,
  requires2fa,
  ROLE_CATALOG,
  ROLE_PERMISSIONS,
} from "@/server/core/rbac";

import { seededContext, testContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";

const perms = (role: RoleCode) => PERMISSIONS.filter((p) => p.roles.includes(role));

describe("Katalog izin & matriks (murni)", () => {
  it("US-M10-01 KP-1 setiap izin berformat <modul>.<sumberdaya>.<aksi>, unik, berlabel Indonesia", () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of PERMISSIONS) {
      expect(p.key).toMatch(PERMISSION_PATTERN);
      expect(p.label.length).toBeGreaterThan(3);
      for (const r of p.roles) expect(ROLE_CODES).toContain(r);
    }
  });

  it("US-M10-01 KP-1 semua izin menu di registri navigasi ada di katalog RBAC", () => {
    const missing = navPermissions().filter((p) => !getPermission(p));
    expect(missing).toEqual([]);
  });

  it("US-M10-01 KP-1 katalog peran tetap memuat 12 peran dengan label", () => {
    expect(Object.keys(ROLE_CATALOG).sort()).toEqual([...ROLE_CODES].sort());
    expect(ROLE_CATALOG.accountant.isReadOnly).toBe(true);
  });

  it("PTB-35 2FA wajib untuk pemilik, Admin Keuangan, admin sistem saja", () => {
    const need = ROLE_CODES.filter((r) => ROLE_CATALOG[r].requires2fa).sort();
    expect(need).toEqual(["finance_admin", "owner", "system_admin"]);
    expect(requires2fa(["dispatcher"])).toBe(false);
    expect(requires2fa(["dispatcher", "owner"])).toBe(true);
  });

  it("US-M10-03 KP-1 akuntan baca-saja (read/export/attest)", () => {
    const bad = perms("accountant").filter((p) => !["read", "export", "attest"].includes(p.kind));
    expect(bad.map((p) => p.key)).toEqual([]);
  });

  it("US-M10-03 KP-1 admin sistem tidak mengubah transaksi keuangan", () => {
    const bad = perms("system_admin").filter((p) => p.finance && p.kind !== "read");
    expect(bad.map((p) => p.key)).toEqual([]);
  });

  it("US-M10-03 KP-1 pemilik tidak menginput transaksi harian", () => {
    expect(perms("owner").filter((p) => p.daily).map((p) => p.key)).toEqual([]);
  });

  it("US-M10-03 KP-1 Admin Keuangan tidak membuat/mengubah pesanan & pengiriman", () => {
    expect(perms("finance_admin").filter((p) => p.orderWrite).map((p) => p.key)).toEqual([]);
    expect(ROLE_PERMISSIONS.finance_admin.has("m2.order.create")).toBe(false);
    expect(ROLE_PERMISSIONS.finance_admin.has("m2.order.read")).toBe(true);
  });

  it("US-M10-03 KP-1 Dispatcher tidak mengakses kas", () => {
    expect(perms("dispatcher").filter((p) => p.cash).map((p) => p.key)).toEqual([]);
    expect(permissionsForRoles(["dispatcher"]).some((k) => k.startsWith("m4."))).toBe(false);
  });

  it("US-P3-10 KP-1 pemilik mitra hanya baca (+ permintaan dukungan)", () => {
    const bad = perms("partner_owner").filter((p) => p.kind !== "read" && p.key !== "p3.support_request.create");
    expect(bad.map((p) => p.key)).toEqual([]);
  });

  it("US-M10-01 KP-3 peran lapangan tidak memegang izin kantor M10/M11", () => {
    for (const role of ["driver", "helper", "depot_operator", "production_operator"] as RoleCode[]) {
      const office = perms(role).filter((p) => (p.module === "m10" && p.key !== "m10.support_ticket.create") || p.module === "m11");
      expect(office.map((p) => p.key), role).toEqual([]);
    }
  });

  it("US-M10-03 KP-4 matriks peran × tindakan dapat diekspor", () => {
    const m = exportMatrix();
    expect(m.roles).toHaveLength(ROLE_CODES.length);
    expect(m.rows).toHaveLength(PERMISSIONS.length);
    const receive = m.rows.find((r) => r.key === "m4.deposit.receive")!;
    expect(receive.grants.finance_admin).toBe("Ya");
    expect(receive.grants.dispatcher).toBe("");
    const complete = m.rows.find((r) => r.key === "m3.trip.complete")!;
    expect(complete.grants.helper).toBe("Bersyarat");
  });
});

describe("authorize & lingkup", () => {
  const t = useTestDb({ seed: true });

  it("US-M10-03 KP-2 penolakan menyebut aturan dan tercatat di log akses", async () => {
    const ctx = seededContext("dispatcher1");
    const err = await authorize(ctx, "m4.deposit.receive").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).message).toMatch(/Dispatcher tidak mengakses kas/);
    expect((err as ForbiddenError).rule).toBe("SOD-04");
    const logs = await t.db
      .select()
      .from(accessLogs)
      .where(and(eq(accessLogs.userId, userIdByUsername("dispatcher1")), eq(accessLogs.event, "action_denied")));
    expect(logs.some((l) => l.permission === "m4.deposit.receive" && l.rule === "SOD-04" && l.success === false)).toBe(true);
  });

  it("US-M10-03 KP-1 aturan yang tepat untuk tiap peran", async () => {
    const cases: [string, string, string][] = [
      ["keuangan1", "m2.order.create", "SOD-03"],
      ["admin1", "m4.deposit.receive", "SOD-07"],
      ["sopir1", "m10.user.create", "RBAC"],
      ["admin1", "m11.journal.create", "SOD-07"],
      ["pemilik", "m2.order.create", "SOD-08"],
      ["akuntan", "m11.journal.create", "SOD-09"],
    ];
    for (const [user, perm, rule] of cases) {
      const err = await authorize(seededContext(user), perm).catch((e: unknown) => e);
      expect((err as ForbiddenError).rule, `${user} ${perm}`).toBe(rule);
    }
  });

  it("US-M10-03 KP-2 lebih dari 3 percobaan sehari → pemilik diberi tahu (sekali)", async () => {
    const ctx = seededContext("kasir");
    for (let i = 0; i < 5; i++) await authorize(ctx, "m11.period.lock").catch(() => undefined);
    const owner = userIdByUsername("pemilik");
    const notes = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.recipientUserId, owner), eq(notifications.event, "access.repeated_denial")));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.objectId).toBe(userIdByUsername("kasir"));
  });

  it("PTB-10 kernet mendapat tindakan sopir hanya sebagai pengemudi pengganti", async () => {
    const kernet = seededContext("kernet1");
    expect(can(kernet, "m3.trip.read")).toBe(true);
    expect(can(kernet, "m3.trip.complete")).toBe(false);
    expect(can(kernet, "m3.trip.complete", { substitute_driver: true })).toBe(true);
    const err = await authorize(kernet, "m3.trip.complete").catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/pengemudi pengganti/);
    await expect(authorize(kernet, "m3.trip.complete", { conditions: { substitute_driver: true } })).resolves.toBeUndefined();
  });

  it("US-M10-05 KP-5 konteks sistem selalu diizinkan", async () => {
    await expect(authorize(systemContext(), "m11.period.lock")).resolves.toBeUndefined();
  });

  it("izin di luar katalog adalah galat program", () => {
    expect(() => can(testContext({ role: "owner" }), "m99.tidak.ada")).toThrow(/tidak ada di katalog/);
  });

  it("US-M10-01 KP-3 sopir hanya truknya; operator hanya outletnya; produksi hanya sumbernya", async () => {
    const sopir = seededContext("sopir1");
    await expect(assertTruckScope(t.db, sopir, truckId("T1"))).resolves.toBeUndefined();
    await expect(assertTruckScope(t.db, sopir, truckId("T2"))).rejects.toBeInstanceOf(ForbiddenError);

    const depot = seededContext("depot01");
    await expect(assertOutletScope(t.db, depot, outletId("D01"))).resolves.toBeUndefined();
    await expect(assertOutletScope(t.db, depot, outletId("D02"))).rejects.toThrow(/lingkup tugas/);

    const prod = seededContext("produksi1");
    await expect(assertSourceScope(t.db, prod, waterSourceId("SA1"))).resolves.toBeUndefined();
    await expect(assertSourceScope(t.db, prod, waterSourceId("SA2"))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("US-M10-01 KP-3 pengguna kantor berlingkup tenant mencakup semua unit tenant itu", async () => {
    const keu = seededContext("keuangan1");
    await expect(assertOutletScope(t.db, keu, outletId("D07"))).resolves.toBeUndefined();
    await expect(assertTruckScope(t.db, keu, truckId("T5"))).resolves.toBeUndefined();
  });

  it("NFR-30 pemilik mitra tidak dapat membuka data tenant lain", () => {
    const partner = testContext({ role: "partner_owner", tenantId: "0192f1c4-7b7a-7cc2-9d7e-3f1b2a4c5d6e" });
    expect(() => assertTenantScope(partner, seededContext("pemilik").tenantId)).toThrow(ForbiddenError);
    expect(() => assertTenantScope(partner, partner.tenantId)).not.toThrow();
  });
});
