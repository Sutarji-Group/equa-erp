import { verify } from "@node-rs/argon2";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/db/client";
import { generateSchemaDdl } from "@/db/ddl";
import {
  APPEND_ONLY_TABLES,
  DELETABLE_TECHNICAL_TABLES,
  isHardeningViolation,
  SQLSTATE_APPEND_ONLY,
  SQLSTATE_NO_DELETE,
  withRetentionPurge,
} from "@/db/hardening";
import {
  accessLogs,
  auditLogs,
  customerAddresses,
  customers,
  domainEvents,
  employees,
  orderStatusEnum,
  outlets,
  parameters,
  sessions,
  shifts,
  tenants,
  users,
} from "@/db/schema";
import {
  CUSTOMER_SEEDS,
  EMPLOYEE_SEEDS,
  EQUA_TENANT_ID,
  LAMPIRAN_B_PARAMETERS,
  outletId,
  runSeed,
  SEED_DEMO_PASSWORD,
  SEED_DEMO_PIN,
  SEED_TOTP_SECRETS,
  seedId,
  userIdByUsername,
} from "@/db/seed";
import { isUuidV7, newId } from "@/lib/ids";
import { enumValues } from "@/lib/labels";

import { createTestDb, type TestDb } from "../helpers/db";

async function tableNames(db: Db): Promise<string[]> {
  const res = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' order by tablename`,
  );
  return res.rows.map((r) => r.tablename);
}

/** Kode SQLSTATE dari galat Drizzle/PGlite (galat asli ada di `cause`). */
function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let i = 0; i < 5 && current && typeof current === "object"; i++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let i = 0; i < 5 && current; i++) {
    if (current instanceof Error) parts.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

async function expectRejected(promise: Promise<unknown>, code: string, messagePart: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, "operasi seharusnya ditolak").toBeDefined();
  expect(sqlState(caught)).toBe(code);
  expect(errorText(caught)).toContain(messagePart);
  expect(isHardeningViolation(caught)).toBe(true);
}

describe("F2 — skema DB terpasang di PGlite (createTestDb)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(() => t.close());

  it("DDL seluruh modul terpasang (core, M1–M12, P2, P3)", async () => {
    const names = await tableNames(t.db);
    expect(names.length).toBeGreaterThanOrEqual(150);
    for (const required of [
      "tenants",
      "outlets",
      "employees",
      "users",
      "user_roles",
      "user_scopes",
      "devices",
      "audit_logs",
      "access_logs",
      "domain_events",
      "parameters",
      "approval_requests",
      "sync_commands",
      "customers",
      "customer_addresses",
      "tariff_zones",
      "zone_tariffs",
      "products",
      "product_prices",
      "orders",
      "trips",
      "daily_schedules",
      "crew_assignments",
      "trip_payments",
      "trip_expenses",
      "deposits",
      "discrepancies",
      "incoming_transfers",
      "cash_days",
      "invoices",
      "customer_payments",
      "payment_allocations",
      "shifts",
      "pos_sales",
      "stock_ledger",
      "stock_balances",
      "purchase_receipts",
      "internal_transfers",
      "meter_readings",
      "truck_fills",
      "water_balances",
      "daily_summaries",
      "report_snapshots",
      "accounts",
      "journals",
      "journal_lines",
      "accounting_periods",
      "gps_positions",
      "fleet_events",
      "customer_accounts",
      "otp_codes",
      "partner_contracts",
      "partner_support_requests",
    ]) {
      expect(names, `tabel ${required}`).toContain(required);
    }
  });

  it("penjaga skema: identifier DDL ≤ 63 karakter dan tanpa constraint UNIQUE multi-kolom (db:push idempoten)", async () => {
    const ddl = await generateSchemaDdl();
    const identifiers = new Set(ddl.flatMap((s) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)));
    expect([...identifiers].filter((id) => id.length > 63)).toEqual([]);
    // Pakai uniqueIndex() untuk unik multi-kolom — constraint UNIQUE multi-kolom selalu terdeteksi berubah oleh drizzle-kit.
    expect(ddl.filter((s) => /UNIQUE\("[^"]+",/.test(s))).toEqual([]);
  });

  it("seedId deterministik dan berbentuk UUID v7 sah", () => {
    expect(seedId("outlet:D01")).toBe(seedId("outlet:D01"));
    expect(seedId("outlet:D01")).not.toBe(seedId("outlet:D02"));
    expect(isUuidV7(seedId("apa saja"))).toBe(true);
  });

  it("enum status di DB sama dengan glosarium ARCHITECTURE §4 (labels)", async () => {
    const res = await t.db.execute<{ v: string }>(sql`select unnest(enum_range(null::order_status))::text as v`);
    expect(res.rows.map((r) => r.v)).toEqual(enumValues("order_status"));
    expect(orderStatusEnum.enumValues).toEqual(enumValues("order_status"));
    const trip = await t.db.execute<{ v: string }>(sql`select unnest(enum_range(null::trip_status))::text as v`);
    expect(trip.rows.map((r) => r.v)).toEqual(enumValues("trip_status"));
  });

  it("NFR-11 setiap tabel bisnis memiliki trigger penolak DELETE; tabel teknis dikecualikan", async () => {
    const names = await tableNames(t.db);
    const res = await t.db.execute<{ table_name: string }>(
      sql`select c.relname as table_name from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
          where tg.tgname = 'equa_no_delete' and not tg.tgisinternal`,
    );
    const guarded = new Set(res.rows.map((r) => r.table_name));
    for (const name of names) {
      if ((DELETABLE_TECHNICAL_TABLES as readonly string[]).includes(name)) expect(guarded.has(name), name).toBe(false);
      else expect(guarded.has(name), `trigger no-delete pada ${name}`).toBe(true);
    }
    const appendOnly = await t.db.execute<{ table_name: string }>(
      sql`select c.relname as table_name from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
          where tg.tgname = 'equa_append_only' and not tg.tgisinternal order by 1`,
    );
    expect(appendOnly.rows.map((r) => r.table_name).sort()).toEqual([...APPEND_ONLY_TABLES].sort());
  });

  it("BR-38 / Bab 6.1 trigger menolak DELETE & TRUNCATE pada tabel bisnis dengan pesan Bahasa Indonesia", async () => {
    const tenantId = newId();
    await t.db.insert(tenants).values({ id: tenantId, code: "UJI-DEL", name: "Tenant uji hapus" });
    await expectRejected(t.db.delete(tenants).where(eq(tenants.id, tenantId)), SQLSTATE_NO_DELETE, "tidak boleh dihapus");
    // Tabel yang dirujuk FK sudah ditolak Postgres sendiri; tabel tanpa rujukan ditolak trigger TRUNCATE.
    await expectRejected(t.db.execute(sql`truncate table feature_flags`), SQLSTATE_NO_DELETE, "tidak boleh dihapus");
    const still = await t.db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(still).toHaveLength(1);
  });

  it("tabel teknis sementara (sessions) boleh dihapus", async () => {
    const tenantId = newId();
    const employeeId = newId();
    const userId = newId();
    await t.db.insert(tenants).values({ id: tenantId, code: "UJI-SES", name: "Tenant uji sesi" });
    await t.db.insert(employees).values({ id: employeeId, tenantId, employeeNo: "S-1", fullName: "Uji Sesi", position: "Uji" });
    await t.db.insert(users).values({ id: userId, tenantId, employeeId, username: "uji.sesi" });
    const sessionId = newId();
    await t.db.insert(sessions).values({
      id: sessionId,
      userId,
      kind: "web",
      tokenHash: `hash-${sessionId}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await t.db.delete(sessions).where(eq(sessions.id, sessionId));
    expect(await t.db.select().from(sessions).where(eq(sessions.id, sessionId))).toHaveLength(0);
  });

  it("US-M10-05 KP-2 / NFR-11 audit_logs tidak dapat di-UPDATE atau di-DELETE", async () => {
    const id = newId();
    await t.db.insert(auditLogs).values({
      id,
      source: "system",
      objectType: "uji",
      objectId: "1",
      action: "create",
      after: { a: 1 },
      hash: "h1",
    });
    await expectRejected(
      t.db.update(auditLogs).set({ reason: "ubah" }).where(eq(auditLogs.id, id)),
      SQLSTATE_APPEND_ONLY,
      "tidak dapat diubah atau dihapus",
    );
    await expectRejected(t.db.delete(auditLogs).where(eq(auditLogs.id, id)), SQLSTATE_APPEND_ONLY, "tidak dapat diubah");
    const [row] = await t.db.select().from(auditLogs).where(eq(auditLogs.id, id));
    expect(row?.reason).toBeNull();
    expect(row?.seq).toBeGreaterThan(0);
  });

  it("NFR-11 access_logs & domain_events append-only; retensi hanya lewat transaksi retensi (US-M10-06 KP-3)", async () => {
    const logId = newId();
    await t.db.insert(accessLogs).values({ id: logId, event: "login_failed", success: false, usernameAttempted: "x" });
    await expectRejected(
      t.db.update(accessLogs).set({ reason: "x" }).where(eq(accessLogs.id, logId)),
      SQLSTATE_APPEND_ONLY,
      "tidak dapat diubah",
    );
    await expectRejected(t.db.delete(accessLogs).where(eq(accessLogs.id, logId)), SQLSTATE_APPEND_ONLY, "tidak dapat diubah");

    const eventId = newId();
    await t.db.insert(domainEvents).values({ id: eventId, type: "trip.completed", payload: { tripId: "x" } });
    await expectRejected(
      t.db.update(domainEvents).set({ type: "trip.failed" }).where(eq(domainEvents.id, eventId)),
      SQLSTATE_APPEND_ONLY,
      "tidak dapat diubah",
    );

    // Job retensi: SET LOCAL equa.retention_purge = 'on' → DELETE access_logs diizinkan, audit_logs tetap ditolak.
    await withRetentionPurge(t.db, async (tx) => {
      await tx.delete(accessLogs).where(eq(accessLogs.id, logId));
    });
    expect(await t.db.select().from(accessLogs).where(eq(accessLogs.id, logId))).toHaveLength(0);
    await expectRejected(
      withRetentionPurge(t.db, async (tx) => {
        await tx.delete(domainEvents).where(eq(domainEvents.id, eventId));
      }),
      SQLSTATE_APPEND_ONLY,
      "tidak dapat diubah",
    );
  });

  it("BR-36 / US-M10-01 KP-2 satu karyawan hanya satu akun pengguna", async () => {
    const tenantId = newId();
    const employeeId = newId();
    await t.db.insert(tenants).values({ id: tenantId, code: "UJI-BR36", name: "Tenant uji BR-36" });
    await t.db.insert(employees).values({ id: employeeId, tenantId, employeeNo: "B-1", fullName: "Uji Satu Akun", position: "Uji" });
    await t.db.insert(users).values({ tenantId, employeeId, username: "akun.pertama" });
    await expect(t.db.insert(users).values({ tenantId, employeeId, username: "akun.kedua" })).rejects.toThrow();
    // Nama pengguna unik tanpa membedakan huruf besar/kecil.
    const otherEmployee = newId();
    await t.db.insert(employees).values({ id: otherEmployee, tenantId, employeeNo: "B-2", fullName: "Uji Lain", position: "Uji" });
    await expect(t.db.insert(users).values({ tenantId, employeeId: otherEmployee, username: "AKUN.PERTAMA" })).rejects.toThrow();
  });

  it("US-M6-02 KP-1 hanya satu shift terbuka per outlet (partial unique index)", async () => {
    const tenantId = newId();
    const outlet = newId();
    const employeeId = newId();
    const userId = newId();
    await t.db.insert(tenants).values({ id: tenantId, code: "UJI-SHIFT", name: "Tenant uji shift" });
    await t.db.insert(outlets).values({ id: outlet, tenantId, code: "DX1", name: "Depot uji", kind: "depot" });
    await t.db.insert(employees).values({ id: employeeId, tenantId, employeeNo: "O-1", fullName: "Operator Uji", position: "Operator" });
    await t.db.insert(users).values({ id: userId, tenantId, employeeId, username: "operator.uji" });
    const base = {
      tenantId,
      outletId: outlet,
      operatorUserId: userId,
      businessDate: "2026-09-27",
      openedAt: new Date(),
      openingCashFixed: 200_000,
    };
    const first = newId();
    await t.db.insert(shifts).values({ id: first, ...base });
    await expect(t.db.insert(shifts).values({ id: newId(), ...base })).rejects.toThrow();
    // Setelah shift pertama ditutup, shift baru boleh dibuka.
    await t.db.update(shifts).set({ status: "closed", closedAt: new Date() }).where(eq(shifts.id, first));
    await t.db.insert(shifts).values({ id: newId(), ...base });
    const open = await t.db.select().from(shifts).where(eq(shifts.outletId, outlet));
    expect(open.filter((s) => s.status === "open")).toHaveLength(1);
  });
});

describe("F2 — seed data awal & demo", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(() => t.close());

  it("seed berjalan di PGlite in-memory tanpa error dan idempoten (dijalankan dua kali)", async () => {
    const first = await runSeed(t.db);
    expect(first.parameters).toBeGreaterThanOrEqual(89);
    const second = await runSeed(t.db);
    expect(second.parameters).toBe(0);
    expect(second.users).toBe(0);
    expect(second.counts).toEqual(first.counts);
    expect(first.counts).toMatchObject({
      tenants: 1,
      outlets: 11,
      water_sources: 2,
      water_meters: 2,
      pool_locations: 1,
      trucks: 7,
      employees: 39,
      users: 39,
      tariff_zones: 4,
      profit_centers: 6,
    });
    expect(first.counts.customers).toBe(CUSTOMER_SEEDS.length + 10);
    expect(first.counts.wa_templates).toBeGreaterThanOrEqual(4);
  });

  it("Lampiran B: PAR-01..PAR-89 lengkap dengan nilai terstruktur", async () => {
    expect(LAMPIRAN_B_PARAMETERS.map((p) => p.key)).toEqual(
      Array.from({ length: 89 }, (_, i) => `PAR-${String(i + 1).padStart(2, "0")}`),
    );
    const rows = await t.db.select().from(parameters);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("PAR-01")?.value).toEqual({ amount: 50_000 });
    expect(byKey.get("PAR-05")?.value).toEqual({ time: "15:00" });
    expect(byKey.get("PAR-83")?.value).toMatchObject({ enabled: false });
    expect(byKey.get("company.identity")?.value).toMatchObject({ name: "EQUA" });
  });

  it("peran lengkap: 7 sopir, 7 kernet, 2 dispatcher, 2 admin keuangan, 10 operator depot, 1 kasir, 6 produksi, 1 pemilik, 2 admin sistem, 1 akuntan", () => {
    const count = (role: string) => EMPLOYEE_SEEDS.filter((e) => e.role === role).length;
    expect({
      driver: count("driver"),
      helper: count("helper"),
      dispatcher: count("dispatcher"),
      finance_admin: count("finance_admin"),
      depot_operator: count("depot_operator"),
      store_cashier: count("store_cashier"),
      production_operator: count("production_operator"),
      owner: count("owner"),
      system_admin: count("system_admin"),
      accountant: count("accountant"),
    }).toEqual({
      driver: 7,
      helper: 7,
      dispatcher: 2,
      finance_admin: 2,
      depot_operator: 10,
      store_cashier: 1,
      production_operator: 6,
      owner: 1,
      system_admin: 2,
      accountant: 1,
    });
  });

  it("akun demo: kata sandi & PIN ter-hash argon2; TOTP demo untuk pemilik/Admin Keuangan/admin sistem (PTB-35)", async () => {
    const [owner] = await t.db.select().from(users).where(eq(users.id, userIdByUsername("pemilik")));
    expect(owner?.status).toBe("active");
    expect(await verify(owner!.passwordHash!, SEED_DEMO_PASSWORD)).toBe(true);
    expect(await verify(owner!.pinHash!, SEED_DEMO_PIN)).toBe(true);
    expect(owner?.totpEnabled).toBe(true);
    const [driver] = await t.db.select().from(users).where(eq(users.id, userIdByUsername("sopir1")));
    expect(driver?.totpEnabled).toBe(false);
    for (const secret of Object.values(SEED_TOTP_SECRETS)) {
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    }
  });

  it("relasi Drizzle valid: kueri relasional pelanggan → alamat → zona", async () => {
    const hotel = await t.db.query.customers.findFirst({
      where: eq(customers.code, "PLG-0034"),
      with: { addresses: { with: { tariffZone: true, referenceWaterSource: true } } },
    });
    expect(hotel?.monthlyBilling).toBe(true);
    expect(hotel?.creditStatus).toBe("credit");
    expect(hotel?.addresses[0]?.tariffZone?.code).toMatch(/^Z[1-4]$/);
    const user = await t.db.query.users.findFirst({
      where: eq(users.id, userIdByUsername("depot01")),
      with: { employee: true, roles: true, scopes: true },
    });
    expect(user?.roles.map((r) => r.role)).toEqual(["depot_operator"]);
    expect(user?.scopes[0]?.refId).toBe(outletId("D01"));
  });

  it("alamat berkoordinat terpetakan otomatis ke zona; tanpa koordinat = zona manual (US-M1-01 KP-2, US-M1-05 KP-3)", async () => {
    const rows = await t.db.select().from(customerAddresses);
    const locked = rows.filter((r) => r.coordinateStatus === "locked");
    const unlocked = rows.filter((r) => r.coordinateStatus === "unlocked");
    expect(locked.length).toBeGreaterThan(40);
    expect(locked.every((r) => r.zoneAssignment === "auto" && r.tariffZoneId && r.referenceWaterSourceId)).toBe(true);
    expect(unlocked.length).toBeGreaterThan(0);
    expect(unlocked.every((r) => r.zoneAssignment === "manual" && r.zoneManualReason)).toBe(true);
    const segments = new Set((await t.db.select().from(customers).where(eq(customers.tenantId, EQUA_TENANT_ID))).map((c) => c.segment));
    expect(segments.size).toBe(7);
  });
});
