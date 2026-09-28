/**
 * Seed katalog EQUA: 4 zona tarif (jarak dari sumber air acuan) + tarif per rit, komponen BBM, produk tiga lini
 * (air truk, air truk — transfer internal, produk depot, barang toko termasuk bahan habis pakai), harga berlaku,
 * resep bahan depot (US-M6-04 KP-2).
 */
import type { DbOrTx } from "../client";
import { depotRecipes, fuelComponents, productPrices, products, tariffZones, zoneTariffs } from "../schema";
import { SEED_EFFECTIVE_FROM } from "./constants";
import { seedId } from "./ids";
import { EQUA_TENANT_ID } from "./org";

export const TARIFF_ZONE_SEEDS = [
  { code: "Z1", name: "Zona 1 (0–5 km)", minDistanceM: 0, maxDistanceM: 5_000, pricePerTrip: 180_000 },
  { code: "Z2", name: "Zona 2 (5–10 km)", minDistanceM: 5_000, maxDistanceM: 10_000, pricePerTrip: 220_000 },
  { code: "Z3", name: "Zona 3 (10–15 km)", minDistanceM: 10_000, maxDistanceM: 15_000, pricePerTrip: 260_000 },
  { code: "Z4", name: "Zona 4 (> 15 km)", minDistanceM: 15_000, maxDistanceM: null, pricePerTrip: 300_000 },
] as const;

/** Komponen BBM per rit untuk seluruh zona (PTB-03). */
export const FUEL_COMPONENT_PER_TRIP = 20_000;

export const tariffZoneId = (code: string) => seedId(`tariff_zone:${code}`);
export const productId = (code: string) => seedId(`product:${code}`);

/** Zona untuk jarak (meter) tertentu: [min, max). */
export function zoneCodeForDistance(distanceM: number): string {
  const zone = TARIFF_ZONE_SEEDS.find((z) => distanceM >= z.minDistanceM && (z.maxDistanceM === null || distanceM < z.maxDistanceM));
  return zone ? zone.code : TARIFF_ZONE_SEEDS[TARIFF_ZONE_SEEDS.length - 1]!.code;
}

type ProductSeed = {
  code: string;
  name: string;
  line: "truck_water" | "depot" | "store";
  unit: string;
  category: string;
  isInternalTransfer?: boolean;
  isConsumable?: boolean;
  gallonSizeL?: number;
  minStock?: number;
  posVisible?: boolean;
  sortOrder?: number;
  storeProductCode?: string;
  /** Harga: standar (depot) atau umum+mitra (toko). */
  standard?: number;
  general?: number;
  partner?: number;
};

export const PRODUCT_SEEDS: ProductSeed[] = [
  // --- Air truk ---
  { code: "AIR-TRUK", name: "Air truk 5.000 L", line: "truck_water", unit: "rit", category: "air_truk", posVisible: false, sortOrder: 1 },
  {
    code: "AIR-TRUK-INT",
    name: "Air truk — transfer internal",
    line: "truck_water",
    unit: "rit",
    category: "air_truk",
    isInternalTransfer: true,
    posVisible: false,
    sortOrder: 2,
  },
  // --- Barang toko (termasuk bahan habis pakai yang dipasok ke depot) ---
  { code: "TK-GALON-KOSONG", name: "Galon kosong 19 L", line: "store", unit: "pcs", category: "bahan_habis_pakai", minStock: 20, general: 40_000, partner: 35_000, sortOrder: 1 },
  { code: "TK-TUTUP", name: "Tutup galon", line: "store", unit: "pcs", category: "bahan_habis_pakai", minStock: 500, general: 800, partner: 600, sortOrder: 2 },
  { code: "TK-TISU", name: "Tisu segel galon", line: "store", unit: "pcs", category: "bahan_habis_pakai", minStock: 500, general: 400, partner: 300, sortOrder: 3 },
  { code: "TK-SABUN", name: "Sabun cuci galon 1 L", line: "store", unit: "botol", category: "bahan_habis_pakai", minStock: 6, general: 30_000, partner: 26_000, sortOrder: 4 },
  { code: "TK-FILTER-10", name: "Filter cartridge 10 inci", line: "store", unit: "pcs", category: "spare_part", minStock: 10, general: 35_000, partner: 30_000, sortOrder: 5 },
  { code: "TK-LAMPU-UV", name: "Lampu UV 40 watt", line: "store", unit: "pcs", category: "spare_part", minStock: 3, general: 150_000, partner: 135_000, sortOrder: 6 },
  { code: "TK-POMPA", name: "Pompa galon manual", line: "store", unit: "pcs", category: "peralatan", minStock: 5, general: 25_000, partner: 22_000, sortOrder: 7 },
  { code: "TK-SIKAT", name: "Sikat galon", line: "store", unit: "pcs", category: "peralatan", minStock: 5, general: 20_000, partner: 17_000, sortOrder: 8 },
  { code: "TK-DISPENSER", name: "Dispenser air panas-dingin", line: "store", unit: "unit", category: "peralatan", minStock: 2, general: 850_000, partner: 780_000, sortOrder: 9 },
  // --- Produk depot ---
  { code: "ISI-ULANG", name: "Isi ulang galon 19 L", line: "depot", unit: "galon", category: "isi_ulang", gallonSizeL: 19, standard: 5_000, sortOrder: 1 },
  { code: "GALON-BARU", name: "Galon baru + isi 19 L", line: "depot", unit: "galon", category: "galon_baru", gallonSizeL: 19, standard: 45_000, sortOrder: 2 },
  {
    code: "TUTUP",
    name: "Tutup galon",
    line: "depot",
    unit: "pcs",
    category: "bahan_habis_pakai",
    isConsumable: true,
    storeProductCode: "TK-TUTUP",
    standard: 1_000,
    sortOrder: 3,
  },
  {
    code: "TISU",
    name: "Tisu segel galon",
    line: "depot",
    unit: "pcs",
    category: "bahan_habis_pakai",
    isConsumable: true,
    storeProductCode: "TK-TISU",
    standard: 500,
    sortOrder: 4,
  },
  { code: "CUCI-GALON", name: "Cuci galon", line: "depot", unit: "galon", category: "jasa", standard: 2_000, sortOrder: 5 },
  {
    code: "GALON-KOSONG",
    name: "Galon kosong 19 L (bahan)",
    line: "depot",
    unit: "pcs",
    category: "bahan_habis_pakai",
    isConsumable: true,
    posVisible: false,
    storeProductCode: "TK-GALON-KOSONG",
    sortOrder: 6,
  },
];

/** Resep bahan per produk depot: 1 isi ulang = 1 tutup + 1 tisu; 1 galon baru = 1 galon kosong + 1 tutup (PRD US-M6-04 KP-2). */
export const RECIPE_SEEDS: { product: string; material: string; quantity: number }[] = [
  { product: "ISI-ULANG", material: "TUTUP", quantity: 1 },
  { product: "ISI-ULANG", material: "TISU", quantity: 1 },
  { product: "GALON-BARU", material: "GALON-KOSONG", quantity: 1 },
  { product: "GALON-BARU", material: "TUTUP", quantity: 1 },
  { product: "TUTUP", material: "TUTUP", quantity: 1 },
  { product: "TISU", material: "TISU", quantity: 1 },
];

const PRICE_REASON = "Harga awal (data demo) — keputusan langsung pemilik (6.2b).";

export async function seedCatalog(tx: DbOrTx): Promise<void> {
  await tx
    .insert(tariffZones)
    .values(
      TARIFF_ZONE_SEEDS.map((z, i) => ({
        id: tariffZoneId(z.code),
        tenantId: EQUA_TENANT_ID,
        code: z.code,
        name: z.name,
        sortOrder: i + 1,
        minDistanceM: z.minDistanceM,
        maxDistanceM: z.maxDistanceM,
      })),
    )
    .onConflictDoNothing();

  await tx
    .insert(zoneTariffs)
    .values(
      TARIFF_ZONE_SEEDS.map((z) => ({
        id: seedId(`zone_tariff:${z.code}:${SEED_EFFECTIVE_FROM}`),
        tariffZoneId: tariffZoneId(z.code),
        segment: null,
        pricePerTrip: z.pricePerTrip,
        effectiveFrom: SEED_EFFECTIVE_FROM,
        status: "active" as const,
        isOwnerDirect: true,
        reason: PRICE_REASON,
        approvedAt: new Date(`${SEED_EFFECTIVE_FROM}T00:00:00Z`),
      })),
    )
    .onConflictDoNothing();

  await tx
    .insert(fuelComponents)
    .values({
      id: seedId(`fuel_component:${SEED_EFFECTIVE_FROM}`),
      tenantId: EQUA_TENANT_ID,
      amountPerTrip: FUEL_COMPONENT_PER_TRIP,
      effectiveFrom: SEED_EFFECTIVE_FROM,
      status: "active",
      isOwnerDirect: true,
      reason: PRICE_REASON,
      approvedAt: new Date(`${SEED_EFFECTIVE_FROM}T00:00:00Z`),
    })
    .onConflictDoNothing();

  // Barang toko dulu (dirujuk `store_product_id` bahan depot).
  const ordered = [...PRODUCT_SEEDS].sort((a, b) => Number(Boolean(a.storeProductCode)) - Number(Boolean(b.storeProductCode)));
  await tx
    .insert(products)
    .values(
      ordered.map((p) => ({
        id: productId(p.code),
        tenantId: EQUA_TENANT_ID,
        code: p.code,
        name: p.name,
        line: p.line,
        category: p.category,
        unit: p.unit,
        isInternalTransfer: p.isInternalTransfer ?? false,
        isConsumable: p.isConsumable ?? false,
        gallonSizeL: p.gallonSizeL ?? null,
        minStock: p.minStock ?? null,
        posVisible: p.posVisible ?? true,
        sortOrder: p.sortOrder ?? 0,
        storeProductId: p.storeProductCode ? productId(p.storeProductCode) : null,
        status: "active" as const,
      })),
    )
    .onConflictDoNothing();

  const priceRows = PRODUCT_SEEDS.flatMap((p) =>
    (
      [
        ["standard", p.standard],
        ["general", p.general],
        ["partner", p.partner],
      ] as const
    )
      .filter((entry): entry is readonly ["standard" | "general" | "partner", number] => typeof entry[1] === "number")
      .map(([kind, price]) => ({
        id: seedId(`product_price:${p.code}:${kind}:${SEED_EFFECTIVE_FROM}`),
        productId: productId(p.code),
        kind,
        price,
        effectiveFrom: SEED_EFFECTIVE_FROM,
        status: "active" as const,
        isOwnerDirect: true,
        reason: PRICE_REASON,
        approvedAt: new Date(`${SEED_EFFECTIVE_FROM}T00:00:00Z`),
      })),
  );
  await tx.insert(productPrices).values(priceRows).onConflictDoNothing();

  await tx
    .insert(depotRecipes)
    .values(
      RECIPE_SEEDS.map((r) => ({
        id: seedId(`recipe:${r.product}:${r.material}:${SEED_EFFECTIVE_FROM}`),
        tenantId: EQUA_TENANT_ID,
        productId: productId(r.product),
        materialProductId: productId(r.material),
        quantity: r.quantity,
        effectiveFrom: SEED_EFFECTIVE_FROM,
      })),
    )
    .onConflictDoNothing();
}
