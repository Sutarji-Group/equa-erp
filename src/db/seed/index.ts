/**
 * Seed data awal & demo EQUA (idempoten — aman dijalankan ulang; memakai ID deterministik + ON CONFLICT DO NOTHING).
 *
 * Isi: parameter Lampiran B (PAR-01..PAR-89) + pengaturan non-PAR + feature flag; tenant EQUA; 10 depot + 1 toko;
 * 2 sumber air + meter; 1 pool; 7 truk; karyawan semua peran + akun (kata sandi/PIN/TOTP demo, lihat README);
 * peran & lingkup; perangkat; zona tarif + komponen BBM; produk tiga lini + harga + resep; ±40 pelanggan demo + 10
 * pelanggan internal depot; bagan akun & pusat laba & pemetaan event→akun; template WA.
 *
 * Pakai: `await runSeed(db)` (skrip `pnpm db:seed`, atau di uji lewat `createTestDb({ seed: true })`).
 */
import { sql } from "drizzle-orm";

import type { Db, DbOrTx } from "../client";
import { featureFlags, parameters } from "../schema";
import { seedAccounting } from "./accounting";
import { seedCatalog } from "./catalog";
import { seedCustomers } from "./customers";
import { seedDemoM1Master } from "./demo-m1-master";
import { seedDemoM10Access } from "./demo-m10-access";
import { seedDemoM11Accounting } from "./demo-m11-accounting";
import { seedDemoM12Fleet } from "./demo-m12-fleet";
import { seedDemoM2Orders } from "./demo-m2-orders";
import { seedDemoM3Driver } from "./demo-m3-driver";
import { seedDemoM4Cash } from "./demo-m4-cash";
import { seedDemoM5Receivables } from "./demo-m5-receivables";
import { seedDemoM6Pos } from "./demo-m6-pos";
import { seedDemoM7Store } from "./demo-m7-store";
import { seedDemoM8Production } from "./demo-m8-production";
import { seedDemoM9Reports } from "./demo-m9-reports";
import { seedId } from "./ids";
import { seedOrganization } from "./org";
import { DEFAULT_FEATURE_FLAGS, EXTRA_SETTINGS, LAMPIRAN_B_PARAMETERS, PARAMETER_EFFECTIVE_FROM } from "./parameters";
import { seedWaTemplates } from "./templates";

export { seedId } from "./ids";
export * from "./constants";
export { LAMPIRAN_B_PARAMETERS, EXTRA_SETTINGS, DEFAULT_FEATURE_FLAGS } from "./parameters";
export { EQUA_TENANT_ID, EMPLOYEE_SEEDS, OUTLET_SEEDS, TRUCK_SEEDS, WATER_SOURCE_SEEDS } from "./org";
export {
  employeeId,
  outletId,
  truckId,
  userIdByUsername,
  waterSourceId,
  deviceId,
  POOL_ID,
} from "./org";
export {
  PRODUCT_SEEDS,
  TARIFF_ZONE_SEEDS,
  productId,
  tariffZoneId,
  tariffZoneBoundaryId,
  FUEL_COMPONENT_PER_TRIP,
} from "./catalog";
export { CUSTOMER_SEEDS, customerId, internalCustomerId } from "./customers";
export { CHART_OF_ACCOUNTS, EVENT_MAPPING_SEEDS, accountId } from "./accounting";
export { WA_TEMPLATE_SEEDS } from "./templates";

export type SeedSummary = {
  parameters: number;
  users: number;
  customers: number;
  counts: Record<string, number>;
};

/** Jalankan seed lengkap dalam satu transaksi. */
export async function runSeed(db: Db): Promise<SeedSummary> {
  return db.transaction(async (tx) => {
    const paramRows = await tx
      .insert(parameters)
      .values(
        [...LAMPIRAN_B_PARAMETERS, ...EXTRA_SETTINGS].map((p) => ({
          id: seedId(`parameter:${p.key}:global:${PARAMETER_EFFECTIVE_FROM}`),
          key: p.key,
          name: p.name,
          value: p.value,
          unit: p.unit,
          reference: p.reference,
          description: p.description ?? null,
          effectiveFrom: PARAMETER_EFFECTIVE_FROM,
          reason: "Nilai bawaan Lampiran B PRD v1.1 (seed).",
        })),
      )
      .onConflictDoNothing()
      .returning({ id: parameters.id });

    await tx
      .insert(featureFlags)
      .values(
        DEFAULT_FEATURE_FLAGS.map((f) => ({
          id: seedId(`feature_flag:${f.key}:global`),
          key: f.key,
          scopeType: "global" as const,
          enabled: f.enabled,
          description: f.description,
          reason: "Bawaan (seed).",
        })),
      )
      .onConflictDoNothing();

    const org = await seedOrganization(tx);
    await seedCatalog(tx);
    const cust = await seedCustomers(tx);
    await seedAccounting(tx);
    await seedWaTemplates(tx);
    // Demo modul (tambahan per modul; idempoten).
    await seedDemoM1Master(tx);
    await seedDemoM10Access(tx);
    await seedDemoM2Orders(tx);
    await seedDemoM6Pos(tx);
    await seedDemoM3Driver(tx);
    await seedDemoM7Store(tx);
    await seedDemoM5Receivables(tx);
    // M4 (Kas & Setoran) memakai data demo M3/M6/M7 di atas — jalankan paling akhir.
    await seedDemoM4Cash(tx);
    // M8 (Produksi & Stok Air): meter, pengisian truk T3/T4, neraca air, mutu air (tidak memengaruhi demo kas M4).
    await seedDemoM8Production(tx);
    // M12 (Armada/GPS) menyelaraskan jejak dengan rit demo M2/M3 di atas.
    await seedDemoM12Fleet(tx);
    // M11 (Akuntansi & Pajak): pelengkap pemetaan wajib 7.11.4 (selalu) + jurnal/aset demo (dev/demo saja).
    await seedDemoM11Accounting(tx);
    // M9 (Laporan & Dashboard): input KPI-10 & periode paralel; angka laporan dihitung dari demo modul di atas.
    await seedDemoM9Reports(tx);

    const counts = await countRows(tx);
    return { parameters: paramRows.length, users: org.usersInserted, customers: cust.customers, counts };
  });
}

const COUNTED_TABLES = [
  "parameters",
  "feature_flags",
  "tenants",
  "outlets",
  "water_sources",
  "water_meters",
  "pool_locations",
  "trucks",
  "employees",
  "users",
  "user_roles",
  "user_scopes",
  "devices",
  "tariff_zones",
  "tariff_zone_boundaries",
  "zone_tariffs",
  "fuel_components",
  "products",
  "product_prices",
  "depot_recipes",
  "customers",
  "customer_addresses",
  "special_prices",
  "profit_centers",
  "accounts",
  "event_account_mappings",
  "wa_templates",
] as const;

async function countRows(tx: DbOrTx): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    const res = await tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from "${table}"`));
    out[table] = Number(res.rows[0]?.n ?? 0);
  }
  return out;
}
