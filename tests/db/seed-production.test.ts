/**
 * Seed produksi `pnpm db:seed:prod` (S5-C): data acuan tanpa data demo + akun pertama pemilik & admin sistem.
 * Rujukan: US-M10-01 KP-8 (akun awal go-live), US-M10-02 KP-4 (kata sandi + 2FA wajib), PTB-35, B-08, NFR-34,
 * US-M11-01 KP-2 (pemetaan wajib lengkap), D-02 (flag Tahap 2/3 mati), D-12 butir 4 (rekening bank saat cut-over).
 */
import { verify } from "@node-rs/argon2";
import { and, eq, sql } from "drizzle-orm";
import { generate } from "otplib";
import { describe, expect, it } from "vitest";

import { eventAccountMappings, featureFlags, userRoles, users, userScopes } from "@/db/schema";
import { DEFAULT_FEATURE_FLAGS, EQUA_TENANT_ID, EXTRA_SETTINGS, LAMPIRAN_B_PARAMETERS } from "@/db/seed";
import {
  hasDemoData,
  type InitialAccountInput,
  ProductionSeedError,
  runProductionSeed,
  validateInitialAccounts,
} from "@/db/seed/production";
import { changeOwnPassword, confirmTotpEnrollment, loginWithPassword, startTotpEnrollment, webActorFromToken } from "@/server/core/auth";
import { REQUIRED_MAPPINGS } from "@/server/modules/m11-accounting/constants";

import { createTestDb, useTestDb as withTestDb } from "../helpers/db";

const NOW = new Date("2026-10-01T01:00:00Z");

const ACCOUNTS: InitialAccountInput[] = [
  { role: "owner", username: "Pak.Haji", fullName: "H. Pemilik Produksi", password: "sementara-pemilik-01", phone: "6281200000001" },
  { role: "system_admin", username: "admin.it", fullName: "Admin Sistem Produksi", password: "sementara-admin-01" },
];

const t = withTestDb();

async function expectSeedError(p: Promise<unknown>, part: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProductionSeedError);
  expect((err as Error).message).toContain(part);
}

describe("seed produksi db:seed:prod (tanpa data demo)", () => {
  it("US-M10-01 KP-8 NFR-34 mengisi parameter Lampiran B, tenant EQUA, bagan akun & pemetaan, template — tanpa master/transaksi demo", async () => {
    const summary = await runProductionSeed(t.db, { accounts: ACCOUNTS, now: NOW });
    expect(summary.parameters).toBe(LAMPIRAN_B_PARAMETERS.length + EXTRA_SETTINGS.length);
    const c = summary.counts;
    expect(c.parameters).toBe(LAMPIRAN_B_PARAMETERS.length + EXTRA_SETTINGS.length);
    expect(c.feature_flags).toBe(DEFAULT_FEATURE_FLAGS.length);
    expect(c.tenants).toBe(1);
    expect(c.profit_centers).toBe(6);
    expect(c.accounts).toBeGreaterThan(50);
    expect(c.event_account_mappings).toBeGreaterThan(40);
    expect(c.tax_settings).toBe(1);
    expect(c.export_templates).toBe(1);
    expect(c.wa_templates).toBeGreaterThan(3);
    // Tanpa data demo: master & rekening bank diisi saat cut-over (docs/uat/cutover.md).
    expect({ outlets: c.outlets, customers: c.customers, products: c.products, trucks: c.trucks, bank_accounts: c.bank_accounts }).toEqual({
      outlets: 0,
      customers: 0,
      products: 0,
      trucks: 0,
      bank_accounts: 0,
    });
    expect(c.users).toBe(2);
    expect(c.employees).toBe(2);
    expect(await hasDemoData(t.db)).toBe(false);
  });

  it("US-M11-01 KP-2 setiap pemetaan wajib jurnal otomatis tersedia untuk tenant EQUA", async () => {
    const rows = await t.db
      .select({ event: eventAccountMappings.eventKey, entry: eventAccountMappings.entryKey })
      .from(eventAccountMappings)
      .where(eq(eventAccountMappings.tenantId, EQUA_TENANT_ID));
    const have = new Set(rows.map((r) => `${r.event}|${r.entry}`));
    expect(REQUIRED_MAPPINGS.filter((m) => !have.has(`${m.event}|${m.entry}`))).toEqual([]);
  });

  it("D-02 flag Tahap 2 & Tahap 3 mati secara bawaan", async () => {
    const flags = await t.db.select({ key: featureFlags.key, enabled: featureFlags.enabled }).from(featureFlags);
    const byKey = Object.fromEntries(flags.map((f) => [f.key, f.enabled]));
    expect(byKey["phase2.customer_app"]).toBe(false);
    expect(byKey["phase3.partner_portal"]).toBe(false);
  });

  it("US-M10-01 KP-8 PTB-35 B-08 akun pertama pemilik & admin sistem: aktif, lingkup tenant, wajib ganti kata sandi, 2FA belum terdaftar", async () => {
    const rows = await t.db
      .select({ id: users.id, username: users.username, hash: users.passwordHash, must: users.mustChangePassword, totp: users.totpEnabled, status: users.status })
      .from(users)
      .orderBy(users.username);
    expect(rows.map((r) => [r.username, r.status, r.must, r.totp])).toEqual([
      ["admin.it", "active", true, false],
      ["pak.haji", "active", true, false],
    ]);
    expect(await verify(rows.find((r) => r.username === "pak.haji")!.hash!, "sementara-pemilik-01")).toBe(true);
    for (const r of rows) {
      const roles = await t.db.select({ role: userRoles.role, status: userRoles.status }).from(userRoles).where(eq(userRoles.userId, r.id));
      expect(roles).toEqual([{ role: r.username === "pak.haji" ? "owner" : "system_admin", status: "active" }]);
      const scopes = await t.db
        .select({ type: userScopes.scopeType, ref: userScopes.refId })
        .from(userScopes)
        .where(and(eq(userScopes.userId, r.id), eq(userScopes.status, "active")));
      expect(scopes).toEqual([{ type: "tenant", ref: EQUA_TENANT_ID }]);
    }
  });

  it("US-M10-02 KP-4 PTB-35 B-08 pemilik baru login: kata sandi → daftar 2FA → ganti kata sandi → sesi pemilik aktif", async () => {
    // Jam tetap (D-10 butir 6): sesudah seed (peran berlaku sejak tanggal bisnis seed).
    const at = new Date(NOW.getTime() + 60_000);
    const res = await loginWithPassword({ username: "pak.haji", password: "sementara-pemilik-01" }, { now: at });
    expect(res.next).toBe("totp_enroll");
    expect(await webActorFromToken(res.token, { now: at })).toBeNull();
    const enrollment = await startTotpEnrollment(res.token, { now: at });
    const code = await generate({ secret: enrollment.secret, epoch: Math.floor(at.getTime() / 1000) });
    await confirmTotpEnrollment(res.token, code, { now: at });
    // B-08: kata sandi sementara wajib diganti dulu sebelum sesi menghasilkan pelaku.
    expect(await webActorFromToken(res.token, { now: at, actorNow: at })).toBeNull();
    await changeOwnPassword(
      res.token,
      { currentPassword: "sementara-pemilik-01", newPassword: "kata-sandi-baru-pemilik", confirmPassword: "kata-sandi-baru-pemilik" },
      { now: at },
    );
    const ctx = await webActorFromToken(res.token, { now: at, actorNow: at });
    expect(ctx?.roles).toEqual(["owner"]);
    expect(ctx?.tenantId).toBe(EQUA_TENANT_ID);
  });

  it("NFR-34 idempoten: dijalankan ulang tanpa parameter baru, akun yang sudah ada dilewati", async () => {
    const before = await t.db.execute<{ n: number }>(sql`select count(*)::int as n from parameters`);
    const again = await runProductionSeed(t.db, { accounts: ACCOUNTS, now: NOW });
    expect(again.parameters).toBe(0);
    expect(again.accounts.map((a) => a.status)).toEqual(["exists", "exists"]);
    expect(again.counts.parameters).toBe(Number(before.rows[0]!.n));
    expect(again.counts.users).toBe(2);
  });

  it("US-M10-01 KP-8 validasi akun pertama: kata sandi pendek, nama pengguna tidak sah, satu orang dua peran ditolak", () => {
    expect(() => validateInitialAccounts([{ ...ACCOUNTS[0]!, password: "pendek" }])).toThrow(/minimal 10 karakter/);
    expect(() => validateInitialAccounts([{ ...ACCOUNTS[0]!, username: "Pak Haji!" }])).toThrow(/tidak sah/);
    expect(() => validateInitialAccounts([ACCOUNTS[0]!, { ...ACCOUNTS[1]!, username: "PAK.HAJI" }])).toThrow(/PTB-31/);
    expect(() => validateInitialAccounts([{ ...ACCOUNTS[0]!, role: "finance_admin" as never }])).toThrow(/Akses > Pengguna/);
  });

  it("NFR-34 menolak basis data berisi data demo (pnpm db:seed)", async () => {
    const demo = await createTestDb({ seed: true });
    try {
      expect(await hasDemoData(demo.db)).toBe(true);
      await expectSeedError(runProductionSeed(demo.db, { accounts: ACCOUNTS, now: NOW }), "data demo");
    } finally {
      await demo.close();
    }
  });
});
