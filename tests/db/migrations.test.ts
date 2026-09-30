/**
 * Migrasi produksi (S5-C; D-12 butir 4 / B-79, D-13 butir 2 / B-83, NFR-32).
 *
 * Membuktikan secara otomatis bahwa `pnpm db:migrate` (migrasi `drizzle/` + hardening.sql) pada DB PGlite KOSONG
 * menghasilkan katalog skema IDENTIK dengan jalur dev `pnpm db:push` (pre-push.sql + drizzle-kit push + hardening.sql),
 * idempoten, dan memuat skema pengerasan S5-A/S5-B. Bila uji "migrasi mutakhir" gagal: skema Drizzle berubah tanpa
 * migrasi — jalankan `pnpm db:generate --name <perubahan>` lalu commit berkas `drizzle/` baru.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/db/client";
import { pendingMigrationStatements } from "@/db/ddl";
import { applyDbHardening, applyPrePushFixups } from "@/db/hardening";
import { describeSchema, diffSchemas, formatSchemaDifferences, type SchemaSnapshot } from "@/db/introspect";
import { appliedMigrationCount, MIGRATIONS_FOLDER, migrateDatabase, readMigrationJournal } from "@/db/migrations";
import { planPush, pushDatabase } from "@/db/push";

import { wrapPglite } from "../helpers/db";

const LONG = 240_000;

let migratedClient: PGlite;
let pushedClient: PGlite;
let migrated: Db;
let pushed: Db;
let migratedSnapshot: SchemaSnapshot;
let pushedSnapshot: SchemaSnapshot;

beforeAll(async () => {
  migratedClient = new PGlite();
  pushedClient = new PGlite();
  migrated = wrapPglite(migratedClient);
  pushed = wrapPglite(pushedClient);
  const result = await migrateDatabase(migrated, "injected");
  expect(result).toEqual({ appliedBefore: 0, appliedAfter: readMigrationJournal().length, newlyApplied: readMigrationJournal().length });
  const push = await pushDatabase(pushed);
  expect(push.applied).toBe(true);
  migratedSnapshot = await describeSchema(migrated);
  pushedSnapshot = await describeSchema(pushed);
}, LONG);

afterAll(async () => {
  await migratedClient?.close();
  await pushedClient?.close();
});

describe("migrasi produksi drizzle/ (B-79, B-83)", () => {
  it("B-79 B-83 jurnal migrasi diawali baseline 0000_baseline_v1 dan setiap berkas SQL ada", () => {
    const journal = readMigrationJournal();
    expect(journal.length).toBeGreaterThan(0);
    expect(journal[0]!.tag).toBe("0000_baseline_v1");
    for (const entry of journal) {
      expect(existsSync(path.join(process.cwd(), MIGRATIONS_FOLDER, `${entry.tag}.sql`)), entry.tag).toBe(true);
    }
  });

  it("B-79 B-83 migrasi mutakhir: skema Drizzle tidak punya DDL yang belum dibangkitkan (pnpm db:generate)", async () => {
    const pending = await pendingMigrationStatements();
    expect(pending, `DDL belum ada di drizzle/ — jalankan \`pnpm db:generate\`:\n${pending.join("\n")}`).toEqual([]);
  }, LONG);

  it("B-79 B-83 NFR-32 db:migrate pada PGlite kosong = db:push (pre-push + push + hardening): katalog identik", () => {
    const diffs = diffSchemas(pushedSnapshot, migratedSnapshot);
    expect(diffs, formatSchemaDifferences(diffs)).toEqual([]);
    // Potret tidak kosong (uji tidak lolos karena dua DB sama-sama kosong).
    expect(Object.keys(migratedSnapshot.columns).length).toBeGreaterThan(1_000);
    expect(Object.keys(migratedSnapshot.triggers).length).toBeGreaterThan(100);
  });

  it("B-79 B-83 NFR-32 db:migrate idempoten: jalankan ulang 0 migrasi baru, pre-push no-op, katalog tetap, push sesudahnya 0 perubahan", async () => {
    const again = await migrateDatabase(migrated, "injected");
    expect(again.newlyApplied).toBe(0);
    expect(await appliedMigrationCount(migrated)).toBe(readMigrationJournal().length);
    await applyPrePushFixups(migrated);
    await applyDbHardening(migrated);
    const after = await describeSchema(migrated);
    const diffs = diffSchemas(migratedSnapshot, after);
    expect(diffs, formatSchemaDifferences(diffs)).toEqual([]);
    // drizzle-kit sendiri tidak melihat perbedaan antara DB hasil migrasi dan skema Drizzle.
    const plan = await planPush(migrated);
    expect(plan.statements, plan.statements.join("\n")).toEqual([]);
    expect(plan.hasDataLoss).toBe(false);
  }, LONG);

  it("B-79 B-83 baseline memuat skema pengerasan S5-A/S5-B beserta trigger tanpa-hapus", () => {
    const cols = migratedSnapshot.columns;
    // B-37 / B-79: lini asal faktur saldo awal.
    expect(cols["invoices.opening_line"]).toMatch(/receivable_line \| null/);
    // B-53 / B-79: satu akun buku per rekening bank.
    expect(migratedSnapshot.indexes["bank_accounts.bank_accounts_gl_account_uq"]).toMatch(/CREATE UNIQUE INDEX .*\(gl_account_id\)/);
    // B-83 (S5-B): kolom baru nullable + tabel service_outages.
    expect(cols["partner_contracts.terms_history"]).toMatch(/^jsonb \| jsonb \| null/);
    expect(cols["customer_advances.order_id"]).toMatch(/^uuid \| uuid \| null/);
    expect(cols["manual_journal_details.asset_disposal"]).toMatch(/^jsonb \| jsonb \| null/);
    expect(cols["otp_codes.request_ip"]).toMatch(/^text \| text \| null/);
    expect(Object.keys(migratedSnapshot.indexes).some((k) => k.startsWith("otp_codes.") && /request_ip/.test(migratedSnapshot.indexes[k]!))).toBe(true);
    expect(Object.keys(migratedSnapshot.indexes).some((k) => k.startsWith("customer_advances.") && /order_id/.test(migratedSnapshot.indexes[k]!))).toBe(true);
    expect(Object.keys(cols).filter((k) => k.startsWith("service_outages.")).length).toBeGreaterThan(3);
    expect(migratedSnapshot.triggers["service_outages.equa_no_delete"]).toBeDefined();
    // Pengerasan (bukan drizzle-kit): FK komposit tenant & penjaga jurnal.
    expect(migratedSnapshot.constraints["pos_sales.pos_sales_outlet_tenant_fk"]).toMatch(/FOREIGN KEY \(outlet_id, tenant_id\)/);
    expect(Object.keys(migratedSnapshot.functions).some((f) => f.startsWith("equa_guard_journal_posting"))).toBe(true);
  });

  it("pembanding katalog tidak hampa: indeks hilang & kolom berubah terdeteksi", async () => {
    let caught: unknown;
    try {
      await migrated.transaction(async (tx) => {
        await tx.execute(sql.raw('DROP INDEX "bank_accounts_gl_account_uq"'));
        await tx.execute(sql.raw('ALTER TABLE "otp_codes" ALTER COLUMN "request_ip" SET DEFAULT \'0.0.0.0\''));
        const diffs = diffSchemas(migratedSnapshot, await describeSchema(tx));
        expect(diffs.map((d) => `${d.kind}:${d.key}`).sort()).toEqual([
          "columns:otp_codes.request_ip",
          "indexes:bank_accounts.bank_accounts_gl_account_uq",
        ]);
        throw new Error("batalkan");
      });
    } catch (error) {
      caught = error;
    }
    expect(String((caught as Error)?.message ?? caught)).toContain("batalkan");
    const diffs = diffSchemas(migratedSnapshot, await describeSchema(migrated));
    expect(diffs).toEqual([]);
  });
});
