/**
 * Data master uji beban (NFR-05, 3× volume): dasar = seed NON-demo (`runSeed` tanpa data demo modul — parameter
 * Lampiran B, tenant EQUA, 10 depot + toko, 7 truk, akun, katalog, pelanggan awal, bagan akun & pemetaan M11), lalu
 * diperbesar: 30 depot EQUA, 20 truk (+ sopir/kernet/perangkat), 25 tenant mitra × 2 outlet (+ katalog, operator,
 * tablet), 1.000 pelanggan luar dengan alamat berkoordinat & zona. Semua data SINTETIS (NFR-27): nama "… Sintetis NN",
 * nomor WA berawalan `620000` (bukan nomor seluler Indonesia yang sah), alamat "Alamat sintetis …".
 */
import { hash } from "@node-rs/argon2";
import { and, eq, sql } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import {
  accountingPeriods,
  customerAddresses,
  customers,
  devices,
  employees,
  featureFlags,
  outletWaterLedger,
  outlets,
  parameters,
  productPrices,
  products,
  stockBalances,
  stockLedger,
  tenants,
  trucks,
  userRoles,
  users,
  userScopes,
} from "@/db/schema";
import { seedAccounting } from "@/db/seed/accounting";
import { FUEL_COMPONENT_PER_TRIP, productId, seedCatalog, TARIFF_ZONE_SEEDS, tariffZoneBoundaryId, tariffZoneId, zoneCodeForDistance } from "@/db/seed/catalog";
import { SEED_DEMO_PASSWORD, SEED_DEMO_PIN } from "@/db/seed/constants";
import { internalCustomerId, nearestSource, seedCustomers } from "@/db/seed/customers";
import { seedM11AccountingDefaults } from "@/db/seed/demo-m11-accounting";
import { seedId } from "@/db/seed/ids";
import { EQUA_TENANT_ID, outletId, POOL_ID, POOL_SEED, seedOrganization, WATER_SOURCE_SEEDS, waterSourceId } from "@/db/seed/org";
import { DEFAULT_FEATURE_FLAGS, EXTRA_SETTINGS, LAMPIRAN_B_PARAMETERS, PARAMETER_EFFECTIVE_FROM } from "@/db/seed/parameters";
import { seedWaTemplates } from "@/db/seed/templates";
import type { CustomerSegment } from "@/lib/labels";
import { addDays, firstDayOfMonth, lastDayOfMonth, monthOf, wibToUtc, type BusinessDate } from "@/lib/time";

import { insertMany } from "./bulk";
import { VOLUME, type Rng } from "./config";

export type LatLng = { lat: number; lng: number };

export type OutletInfo = {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  kind: "depot" | "store";
  isPartner: boolean;
  point: LatLng;
  operatorUserId: string;
  operatorEmployeeId: string;
  deviceId: string;
  deviceCode: string;
  /** Produk per kode (katalog tenant outlet). */
  product: Record<string, string>;
  /** Harga jual per kode produk. */
  price: Record<string, number>;
  /** Harga pokok per kode (toko: HPP; depot: nilai bahan). */
  unitCost: Record<string, number>;
  /** Pelanggan internal (depot EQUA) untuk rit pasokan. */
  internalCustomerId: string | null;
  internalAddressId: string | null;
};

export type TruckInfo = {
  id: string;
  code: string;
  plate: string;
  driverUserId: string;
  driverEmployeeId: string;
  helperEmployeeId: string;
  phoneDeviceId: string;
  gpsDeviceId: string;
};

export type CustomerInfo = {
  id: string;
  code: string;
  segment: CustomerSegment;
  creditStatus: "cash" | "credit" | "credit_migrated" | "on_hold";
  termDays: number;
  monthlyBilling: boolean;
  addressId: string;
  point: LatLng;
  zoneId: string;
  price: number;
};

export type World = {
  tenantId: string;
  outlets: OutletInfo[];
  equaDepots: OutletInfo[];
  partnerOutlets: OutletInfo[];
  store: OutletInfo;
  trucks: TruckInfo[];
  customers: CustomerInfo[];
  sources: { id: string; point: LatLng }[];
  pool: LatLng;
  users: { owner: string; finance: string; dispatcher: string };
  periods: Map<string, string>;
};

const CIANJUR = { latMin: -6.95, latMax: -6.73, lngMin: 107.03, lngMax: 107.29 };

export function randomPoint(r: Rng): LatLng {
  return {
    lat: Math.round((CIANJUR.latMin + r.next() * (CIANJUR.latMax - CIANJUR.latMin)) * 1e6) / 1e6,
    lng: Math.round((CIANJUR.lngMin + r.next() * (CIANJUR.lngMax - CIANJUR.lngMin)) * 1e6) / 1e6,
  };
}

/** Nomor WA sintetis — `620000…` bukan nomor seluler Indonesia yang sah (NFR-27). */
export const syntheticPhone = (n: number) => `620000${String(n).padStart(7, "0")}`;

/** Seed dasar NON-demo (bagian awal `runSeed`) — data demo modul (tanggal relatif) sengaja tidak dimuat. */
export async function seedBase(tx: DbOrTx): Promise<void> {
  await tx
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
        reason: "Nilai bawaan Lampiran B PRD v1.1 (seed uji beban).",
      })),
    )
    .onConflictDoNothing();
  await tx
    .insert(featureFlags)
    .values(
      DEFAULT_FEATURE_FLAGS.map((f) => ({
        id: seedId(`feature_flag:${f.key}:global`),
        key: f.key,
        scopeType: "global" as const,
        enabled: f.enabled,
        description: f.description,
        reason: "Bawaan (seed uji beban).",
      })),
    )
    .onConflictDoNothing();
  await seedOrganization(tx);
  await seedCatalog(tx);
  await seedCustomers(tx);
  await seedAccounting(tx);
  await seedWaTemplates(tx);
  await seedM11AccountingDefaults(tx);
}

type Person = {
  no: string;
  tenantId: string;
  username: string;
  fullName: string;
  position: string;
  role: "driver" | "helper" | "depot_operator";
  scope: { type: "truck" | "outlet"; refId: string };
  outletId?: string | null;
};

async function insertPeople(tx: DbOrTx, people: Person[], hashes: { password: string; pin: string }, validFrom: BusinessDate, now: Date): Promise<void> {
  await insertMany(
    tx,
    employees,
    people.map((p) => ({
      id: seedId(`perf:employee:${p.tenantId}:${p.no}`),
      tenantId: p.tenantId,
      employeeNo: p.no,
      fullName: p.fullName,
      nickname: p.fullName.split(" ")[0]!,
      position: p.position,
      phone: syntheticPhone(900_000 + people.indexOf(p)),
      workLocation: p.outletId ? "Outlet (sintetis)" : "Pool truk (sintetis)",
      primaryOutletId: p.outletId ?? null,
      intendedRoles: [p.role],
      hireDate: validFrom,
    })),
  );
  await insertMany(
    tx,
    users,
    people.map((p) => ({
      id: seedId(`user:${p.username}`),
      tenantId: p.tenantId,
      employeeId: seedId(`perf:employee:${p.tenantId}:${p.no}`),
      username: p.username,
      passwordHash: hashes.password,
      passwordChangedAt: now,
      pinHash: hashes.pin,
      pinSetAt: now,
      status: "active" as const,
      activatedAt: now,
    })),
  );
  await insertMany(
    tx,
    userRoles,
    people.map((p) => ({
      id: seedId(`user_role:${p.username}:${p.role}`),
      userId: seedId(`user:${p.username}`),
      role: p.role,
      status: "active" as const,
      validFrom,
      reason: "Akun sintetis uji beban (NFR-05).",
      grantedAt: now,
    })),
  );
  await insertMany(
    tx,
    userScopes,
    people.map((p) => ({
      id: seedId(`user_scope:${p.username}:${p.scope.type}:${p.scope.refId}`),
      userId: seedId(`user:${p.username}`),
      scopeType: p.scope.type,
      refId: p.scope.refId,
      status: "active" as const,
      validFrom,
      reason: "Lingkup sintetis uji beban.",
    })),
  );
}

const DEPOT_CODES = ["ISI-ULANG", "GALON-BARU", "CUCI-GALON", "TUTUP", "TISU", "GALON-KOSONG"] as const;
const STORE_CODES = ["TK-GALON-KOSONG", "TK-TUTUP", "TK-TISU", "TK-SABUN", "TK-FILTER-10", "TK-LAMPU-UV", "TK-POMPA", "TK-SIKAT", "TK-DISPENSER"] as const;
const MATERIAL_COST: Record<string, number> = { TUTUP: 600, TISU: 300, "GALON-KOSONG": 35_000 };

/** Perbesar data master ke volume NFR-05 dan kembalikan peta dunia untuk pembangkit harian. */
export async function scaleMasters(tx: DbOrTx, r: Rng, startDate: BusinessDate, anchorDate: BusinessDate): Promise<World> {
  const now = wibToUtc(startDate, "06:00");
  const validFrom = addDays(startDate, -30);
  const [password, pin] = await Promise.all([hash(SEED_DEMO_PASSWORD), hash(SEED_DEMO_PIN)]);
  const hashes = { password, pin };

  // --- Harga EQUA dari katalog seed ----------------------------------------------------------------------------------
  const priceRows = await tx
    .select({ productId: productPrices.productId, kind: productPrices.kind, price: productPrices.price })
    .from(productPrices)
    .where(and(eq(productPrices.tenantId, EQUA_TENANT_ID), eq(productPrices.status, "active"), sql`${productPrices.outletId} is null`));
  const priceOf = (code: string, kind: "standard" | "general") => priceRows.find((p) => p.productId === productId(code) && p.kind === kind)?.price ?? 0;

  // --- Depot EQUA D11..D30 + operator + tablet ----------------------------------------------------------------------
  const newDepots: { code: string; name: string; point: LatLng }[] = [];
  for (let i = 11; i <= VOLUME.equaDepots; i++) {
    const code = `D${String(i).padStart(2, "0")}`;
    newDepots.push({ code, name: `Depot EQUA Sintetis ${i}`, point: randomPoint(r) });
  }
  await insertMany(
    tx,
    outlets,
    newDepots.map((d) => ({
      id: outletId(d.code),
      tenantId: EQUA_TENANT_ID,
      code: d.code,
      name: d.name,
      kind: "depot" as const,
      address: `Alamat sintetis depot ${d.code}, Kab. Cianjur`,
      lat: d.point.lat,
      lng: d.point.lng,
      storageCapacityL: 5_000,
      qrisEnabled: true,
    })),
  );
  const depotPeople: Person[] = newDepots.map((d, i) => ({
    no: `EQ-P${String(100 + i).padStart(3, "0")}`,
    tenantId: EQUA_TENANT_ID,
    username: `depot${d.code.slice(1)}`,
    fullName: `Operator Depot Sintetis ${d.code.slice(1)}`,
    position: "Operator Depot",
    role: "depot_operator",
    scope: { type: "outlet", refId: outletId(d.code) },
    outletId: outletId(d.code),
  }));
  await insertPeople(tx, depotPeople, hashes, validFrom, now);
  await insertMany(
    tx,
    devices,
    newDepots.map((d) => ({
      id: seedId(`device:POS-${d.code}`),
      tenantId: EQUA_TENANT_ID,
      deviceCode: `POS-${d.code}`,
      name: `Tablet POS ${d.name}`,
      kind: "tablet" as const,
      status: "active" as const,
      outletId: outletId(d.code),
      activatedAt: now,
    })),
  );
  for (const p of depotPeople) {
    await tx.update(outlets).set({ defaultOperatorEmployeeId: seedId(`perf:employee:${p.tenantId}:${p.no}`) }).where(eq(outlets.id, p.outletId!));
  }
  // Pelanggan internal + alamat depot baru (rit pasokan, PTB-01).
  await insertMany(
    tx,
    customers,
    newDepots.map((d, i) => ({
      id: internalCustomerId(d.code),
      tenantId: EQUA_TENANT_ID,
      code: `INT-${d.code}`,
      name: `${d.name} (internal)`,
      segment: "third_party_depot" as const,
      waPhone: syntheticPhone(800_000 + i),
      notes: "Pelanggan internal sintetis (uji beban).",
      creditStatus: "cash" as const,
      creditLimit: 0,
      internalOutletId: outletId(d.code),
      isInitialData: true,
    })),
  );
  await insertMany(
    tx,
    customerAddresses,
    newDepots.map((d) => addressRow(seedId(`address:internal:${d.code}`), internalCustomerId(d.code), "Depot", `Alamat sintetis depot ${d.code}`, d.point, now)),
  );

  // --- Truk T8..T20 + sopir/kernet + ponsel & GPS ---------------------------------------------------------------------
  const newTrucks: { code: string; plate: string }[] = [];
  for (let i = 8; i <= VOLUME.trucks; i++) newTrucks.push({ code: `T${i}`, plate: `F 9${String(i).padStart(3, "0")} UJ` });
  const truckPeople: Person[] = newTrucks.flatMap((t, i) => [
    { no: `EQ-S${String(100 + i).padStart(3, "0")}`, tenantId: EQUA_TENANT_ID, username: `sopir${t.code.slice(1)}`, fullName: `Sopir Sintetis ${t.code.slice(1)}`, position: "Sopir", role: "driver" as const, scope: { type: "truck" as const, refId: seedId(`truck:${t.code}`) } },
    { no: `EQ-K${String(100 + i).padStart(3, "0")}`, tenantId: EQUA_TENANT_ID, username: `kernet${t.code.slice(1)}`, fullName: `Kernet Sintetis ${t.code.slice(1)}`, position: "Kernet", role: "helper" as const, scope: { type: "truck" as const, refId: seedId(`truck:${t.code}`) } },
  ]);
  await insertPeople(tx, truckPeople, hashes, validFrom, now);
  await insertMany(
    tx,
    devices,
    newTrucks.flatMap((t, i) => [
      { id: seedId(`device:HP-${t.code}`), tenantId: EQUA_TENANT_ID, deviceCode: `HP-${t.code}`, name: `Ponsel truk ${t.code}`, kind: "phone" as const, status: "active" as const, truckId: seedId(`truck:${t.code}`), holderEmployeeId: seedId(`perf:employee:${EQUA_TENANT_ID}:EQ-S${String(100 + i).padStart(3, "0")}`), activatedAt: now },
      {
        id: seedId(`device:GPS-${t.code}`),
        tenantId: EQUA_TENANT_ID,
        deviceCode: `GPS-${t.code}`,
        name: `GPS truk ${t.code}`,
        kind: "gps" as const,
        status: "active" as const,
        truckId: seedId(`truck:${t.code}`),
        vendor: "Vendor GPS (sintetis)",
        imei: `86${String(2_000_000_000_000 + i).padStart(13, "0")}`,
        gpsState: "active" as const,
        activatedAt: now,
      },
    ]),
  );
  await insertMany(
    tx,
    trucks,
    newTrucks.map((t, i) => ({
      id: seedId(`truck:${t.code}`),
      tenantId: EQUA_TENANT_ID,
      plateNumber: t.plate,
      code: t.code,
      capacityL: 5_000,
      status: "active" as const,
      defaultDriverEmployeeId: seedId(`perf:employee:${EQUA_TENANT_ID}:EQ-S${String(100 + i).padStart(3, "0")}`),
      defaultHelperEmployeeId: seedId(`perf:employee:${EQUA_TENANT_ID}:EQ-K${String(100 + i).padStart(3, "0")}`),
      gpsDeviceId: seedId(`device:GPS-${t.code}`),
      fieldDeviceId: seedId(`device:HP-${t.code}`),
      poolLocationId: POOL_ID,
    })),
  );
  // Perangkat seed (ponsel truk, tablet POS) dianggap sudah aktif.
  await tx.update(devices).set({ status: "active", activatedAt: now }).where(and(eq(devices.tenantId, EQUA_TENANT_ID), eq(devices.status, "registered"), eq(devices.isSpare, false)));

  // --- Tenant mitra: 25 × 2 outlet, katalog tersalin, harga mitra, operator, tablet ----------------------------------
  const equaDepotProducts = await tx.select().from(products).where(and(eq(products.tenantId, EQUA_TENANT_ID), eq(products.line, "depot")));
  const partnerOutletRows: { tenantId: string; tenantCode: string; code: string; name: string; point: LatLng }[] = [];
  for (let t = 1; t <= VOLUME.partnerTenants; t++) {
    const tenantCode = `MTRS${String(t).padStart(2, "0")}`;
    const tenantId = seedId(`tenant:${tenantCode}`);
    await tx.insert(tenants).values({ id: tenantId, code: tenantCode, name: `Mitra Sintetis ${String(t).padStart(2, "0")}`, kind: "partner", settings: { createdFromStandardCatalog: true, synthetic: true } });
    await insertMany(
      tx,
      products,
      equaDepotProducts.map((p) => ({
        id: seedId(`perf:product:${tenantCode}:${p.code}`),
        tenantId,
        code: p.code,
        name: p.name,
        line: p.line,
        category: p.category,
        unit: p.unit,
        isInternalTransfer: false,
        isConsumable: p.isConsumable,
        gallonSizeL: p.gallonSizeL,
        minStock: p.minStock,
        posVisible: p.posVisible,
        sortOrder: p.sortOrder,
        sourceProductId: p.id,
        status: "active" as const,
      })),
    );
    await insertMany(
      tx,
      productPrices,
      equaDepotProducts
        .filter((p) => !p.isConsumable && priceOf(p.code, "standard") > 0)
        .map((p) => ({
          id: seedId(`perf:price:${tenantCode}:${p.code}`),
          tenantId,
          productId: seedId(`perf:product:${tenantCode}:${p.code}`),
          kind: "standard" as const,
          price: p.code === "ISI-ULANG" ? 6_000 : priceOf(p.code, "standard"),
          recommendedPrice: priceOf(p.code, "standard"),
          effectiveFrom: validFrom,
          status: "active" as const,
          isOwnerDirect: true,
          reason: "Harga jual mitra sintetis (PTB-56).",
          approvedAt: now,
        })),
    );
    for (let o = 1; o <= VOLUME.outletsPerPartner; o++) {
      partnerOutletRows.push({ tenantId, tenantCode, code: `M${String(o).padStart(2, "0")}`, name: `Depot Mitra Sintetis ${String(t).padStart(2, "0")}-${o}`, point: randomPoint(r) });
    }
  }
  await insertMany(
    tx,
    outlets,
    partnerOutletRows.map((o) => ({
      id: seedId(`perf:outlet:${o.tenantCode}:${o.code}`),
      tenantId: o.tenantId,
      code: o.code,
      name: o.name,
      kind: "depot" as const,
      address: `Alamat sintetis ${o.tenantCode}-${o.code}, Kab. Cianjur`,
      lat: o.point.lat,
      lng: o.point.lng,
      storageCapacityL: 5_000,
      qrisEnabled: true,
      activatedOn: validFrom,
    })),
  );
  const partnerPeople: Person[] = partnerOutletRows.map((o) => ({
    no: `${o.tenantCode}-${o.code}`,
    tenantId: o.tenantId,
    username: `op${o.tenantCode.toLowerCase()}${o.code.toLowerCase()}`,
    fullName: `Operator Mitra Sintetis ${o.tenantCode.slice(4)}-${o.code.slice(1)}`,
    position: "Operator depot mitra",
    role: "depot_operator",
    scope: { type: "outlet", refId: seedId(`perf:outlet:${o.tenantCode}:${o.code}`) },
    outletId: seedId(`perf:outlet:${o.tenantCode}:${o.code}`),
  }));
  await insertPeople(tx, partnerPeople, hashes, validFrom, now);
  await insertMany(
    tx,
    devices,
    partnerOutletRows.map((o) => ({
      id: seedId(`perf:device:TAB-${o.tenantCode}-${o.code}`),
      tenantId: o.tenantId,
      deviceCode: `TAB-${o.tenantCode}-${o.code}`,
      name: `Tablet POS ${o.name}`,
      kind: "tablet" as const,
      status: "active" as const,
      outletId: seedId(`perf:outlet:${o.tenantCode}:${o.code}`),
      activatedAt: now,
    })),
  );

  // --- Pelanggan luar sampai 1.000 -----------------------------------------------------------------------------------
  const existing = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.tenantId, EQUA_TENANT_ID), sql`${customers.internalOutletId} is null`));
  const toAdd = Math.max(0, VOLUME.customers - existing.length);
  const segments: { s: CustomerSegment; w: number; limit: number }[] = [
    { s: "household", w: 45, limit: 0 },
    { s: "housing", w: 12, limit: 3_000_000 },
    { s: "third_party_depot", w: 15, limit: 3_000_000 },
    { s: "industry", w: 10, limit: 10_000_000 },
    { s: "construction", w: 8, limit: 10_000_000 },
    { s: "hotel", w: 6, limit: 10_000_000 },
    { s: "swimming_pool", w: 4, limit: 10_000_000 },
  ];
  const totalW = segments.reduce((s, x) => s + x.w, 0);
  const pickSegment = () => {
    let x = r.next() * totalW;
    for (const s of segments) {
      x -= s.w;
      if (x <= 0) return s;
    }
    return segments[0]!;
  };
  const custRows: (typeof customers.$inferInsert)[] = [];
  const addrRows: (typeof customerAddresses.$inferInsert)[] = [];
  for (let i = 0; i < toAdd; i++) {
    const n = 1_001 + i;
    const code = `PLG-${n}`;
    const seg = pickSegment();
    const credit = seg.s === "household" ? "cash" : r.chance(0.45) ? (r.chance(0.08) ? "on_hold" : "credit") : "cash";
    const id = seedId(`perf:customer:${code}`);
    custRows.push({
      id,
      tenantId: EQUA_TENANT_ID,
      code,
      name: `Pelanggan Sintetis ${n}`,
      segment: seg.s,
      waPhone: syntheticPhone(n),
      creditStatus: credit,
      creditLimit: seg.s === "household" ? 0 : seg.limit,
      paymentTermDays: 14,
      isInitialData: true,
    });
    addrRows.push(addressRow(seedId(`perf:address:${code}`), id, "Utama", `Alamat sintetis No. ${n}, Blok Uji, Kab. Cianjur`, randomPoint(r), now));
  }
  await insertMany(tx, customers, custRows);
  await insertMany(tx, customerAddresses, addrRows);

  // --- Stok bahan & air awal semua depot (EQUA + mitra) -------------------------------------------------------------
  const allOutlets = await loadOutlets(tx, priceOf);
  const openingDate = addDays(startDate, -1);
  const openingAt = wibToUtc(openingDate, "07:00");
  const balances: (typeof stockBalances.$inferInsert)[] = [];
  const ledger: (typeof stockLedger.$inferInsert)[] = [];
  const water: (typeof outletWaterLedger.$inferInsert)[] = [];
  for (const o of allOutlets) {
    const materials: [string, number][] =
      o.kind === "store" ? STORE_CODES.map((c) => [c, c === "TK-DISPENSER" ? 400 : c.startsWith("TK-TUTUP") || c.startsWith("TK-TISU") ? 40_000 : 3_000]) : [["TUTUP", 12_000], ["TISU", 12_000], ["GALON-KOSONG", 600]];
    for (const [code, qty] of materials) {
      const pid = o.product[code];
      if (!pid) continue;
      const cost = o.unitCost[code] ?? 0;
      balances.push({ id: seedId(`perf:stock_balance:${o.id}:${code}`), tenantId: o.tenantId, outletId: o.id, productId: pid, quantity: qty, avgCost: cost, totalValue: qty * cost, lastMovementAt: openingAt });
      ledger.push({ tenantId: o.tenantId, outletId: o.id, productId: pid, kind: "opening", quantity: qty, unitCost: cost, totalCost: qty * cost, balanceAfter: qty, avgCostAfter: cost, businessDate: openingDate, occurredAt: openingAt, note: "Stok awal (sintetis uji beban)" });
    }
    if (o.kind === "depot") water.push({ tenantId: o.tenantId, outletId: o.id, businessDate: openingDate, kind: "opening", volumeL: 4_000, balanceAfterL: 4_000, occurredAt: openingAt });
  }
  // Stok seed yang sudah ada (tidak ada — seed non-demo tidak mengisi stok) → sisipkan saja.
  await insertMany(tx, stockBalances, balances);
  await insertMany(tx, stockLedger, ledger);
  await insertMany(tx, outletWaterLedger, water);

  // --- Periode akuntansi terbuka untuk seluruh rentang --------------------------------------------------------------
  const periods = new Map<string, string>();
  for (let d = firstDayOfMonth(startDate); d <= anchorDate; d = addDays(lastDayOfMonth(d), 1)) {
    const period = monthOf(d);
    await tx.insert(accountingPeriods).values({ tenantId: EQUA_TENANT_ID, period, startDate: d, endDate: lastDayOfMonth(d), status: "open" }).onConflictDoNothing();
    const [p] = await tx.select({ id: accountingPeriods.id }).from(accountingPeriods).where(and(eq(accountingPeriods.tenantId, EQUA_TENANT_ID), eq(accountingPeriods.period, period))).limit(1);
    periods.set(period, p!.id);
  }

  return {
    tenantId: EQUA_TENANT_ID,
    outlets: allOutlets,
    equaDepots: allOutlets.filter((o) => !o.isPartner && o.kind === "depot"),
    partnerOutlets: allOutlets.filter((o) => o.isPartner),
    store: allOutlets.find((o) => o.kind === "store")!,
    trucks: await loadTrucks(tx),
    customers: await loadCustomers(tx),
    sources: WATER_SOURCE_SEEDS.map((s) => ({ id: waterSourceId(s.code), point: { lat: s.lat, lng: s.lng } })),
    pool: { lat: POOL_SEED.lat, lng: POOL_SEED.lng },
    users: { owner: seedId("user:pemilik"), finance: seedId("user:keuangan1"), dispatcher: seedId("user:dispatcher1") },
    periods,
  };
}

function addressRow(id: string, customerId: string, label: string, text: string, point: LatLng, lockedAt: Date): typeof customerAddresses.$inferInsert {
  const src = nearestSource(point);
  const zone = zoneCodeForDistance(src.distanceM);
  return {
    id,
    customerId,
    label,
    addressText: text,
    lat: point.lat,
    lng: point.lng,
    coordinateStatus: "locked",
    coordinateSource: "import",
    coordinateLockedAt: lockedAt,
    tariffZoneId: tariffZoneId(zone),
    zoneAssignment: "auto",
    zoneBoundaryId: tariffZoneBoundaryId(zone),
    zoneAssignedAt: lockedAt,
    referenceWaterSourceId: waterSourceId(src.code),
    distanceM: src.distanceM,
    distanceMethod: "straight_line_x1_3",
  };
}

async function loadOutlets(tx: DbOrTx, priceOf: (code: string, kind: "standard" | "general") => number): Promise<OutletInfo[]> {
  const rows = await tx
    .select({ o: outlets, t: tenants })
    .from(outlets)
    .innerJoin(tenants, eq(tenants.id, outlets.tenantId))
    .orderBy(tenants.code, outlets.code);
  const devRows = await tx.select({ id: devices.id, code: devices.deviceCode, outletId: devices.outletId }).from(devices).where(sql`${devices.outletId} is not null and ${devices.isSpare} = false`);
  const opRows = await tx
    .select({ userId: users.id, employeeId: users.employeeId, outletId: userScopes.refId, role: userRoles.role })
    .from(users)
    .innerJoin(userScopes, and(eq(userScopes.userId, users.id), eq(userScopes.scopeType, "outlet")))
    .innerJoin(userRoles, eq(userRoles.userId, users.id));
  const prodRows = await tx.select({ id: products.id, tenantId: products.tenantId, code: products.code }).from(products);
  const partnerPrices = await tx.select({ productId: productPrices.productId, price: productPrices.price }).from(productPrices).where(sql`${productPrices.tenantId} <> ${EQUA_TENANT_ID}`);
  const out: OutletInfo[] = [];
  for (const { o, t } of rows) {
    const dev = devRows.find((d) => d.outletId === o.id);
    const op = opRows.find((u) => u.outletId === o.id && (u.role === "depot_operator" || u.role === "store_cashier"));
    if (!dev || !op) continue;
    const isPartner = t.kind === "partner";
    const product: Record<string, string> = {};
    for (const p of prodRows) if (p.tenantId === o.tenantId) product[p.code] = p.id;
    const price: Record<string, number> = {};
    const unitCost: Record<string, number> = {};
    if (o.kind === "store") {
      for (const c of STORE_CODES) {
        price[c] = priceOf(c, "general");
        unitCost[c] = Math.round(price[c] * 0.78);
      }
    } else {
      for (const c of DEPOT_CODES) {
        price[c] = isPartner ? (partnerPrices.find((p) => p.productId === product[c])?.price ?? 0) : priceOf(c, "standard");
        if (MATERIAL_COST[c]) unitCost[c] = MATERIAL_COST[c];
      }
    }
    out.push({
      id: o.id,
      tenantId: o.tenantId,
      code: o.code,
      name: o.name,
      kind: o.kind,
      isPartner,
      point: { lat: o.lat ?? -6.82, lng: o.lng ?? 107.14 },
      operatorUserId: op.userId,
      operatorEmployeeId: op.employeeId,
      deviceId: dev.id,
      deviceCode: dev.code,
      product,
      price,
      unitCost,
      internalCustomerId: !isPartner && o.kind === "depot" ? internalCustomerId(o.code) : null,
      internalAddressId: !isPartner && o.kind === "depot" ? seedId(`address:internal:${o.code}`) : null,
    });
  }
  return out;
}

async function loadTrucks(tx: DbOrTx): Promise<TruckInfo[]> {
  const rows = await tx.select().from(trucks).where(eq(trucks.tenantId, EQUA_TENANT_ID)).orderBy(sql`length(${trucks.code})`, trucks.code);
  const us = await tx.select({ id: users.id, employeeId: users.employeeId }).from(users);
  return rows.map((t) => ({
    id: t.id,
    code: t.code,
    plate: t.plateNumber,
    driverEmployeeId: t.defaultDriverEmployeeId!,
    driverUserId: us.find((u) => u.employeeId === t.defaultDriverEmployeeId)!.id,
    helperEmployeeId: t.defaultHelperEmployeeId!,
    phoneDeviceId: t.fieldDeviceId!,
    gpsDeviceId: t.gpsDeviceId!,
  }));
}

async function loadCustomers(tx: DbOrTx): Promise<CustomerInfo[]> {
  const rows = await tx
    .select({ c: customers, a: customerAddresses })
    .from(customers)
    .innerJoin(customerAddresses, eq(customerAddresses.customerId, customers.id))
    .where(and(eq(customers.tenantId, EQUA_TENANT_ID), sql`${customers.internalOutletId} is null`, eq(customers.isActive, true), eq(customerAddresses.isActive, true)))
    .orderBy(customers.code, customerAddresses.label);
  const seen = new Set<string>();
  const out: CustomerInfo[] = [];
  for (const { c, a } of rows) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const zone = TARIFF_ZONE_SEEDS.find((z) => tariffZoneId(z.code) === a.tariffZoneId) ?? TARIFF_ZONE_SEEDS[1];
    out.push({
      id: c.id,
      code: c.code ?? c.id,
      segment: c.segment,
      creditStatus: c.creditStatus,
      termDays: c.paymentTermDays,
      monthlyBilling: c.monthlyBilling,
      addressId: a.id,
      point: { lat: a.lat ?? -6.82, lng: a.lng ?? 107.14 },
      zoneId: tariffZoneId(zone.code),
      price: zone.pricePerTrip + FUEL_COMPONENT_PER_TRIP,
    });
  }
  return out;
}
