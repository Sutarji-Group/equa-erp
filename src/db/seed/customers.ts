/**
 * Seed pelanggan demo: 40 pelanggan lintas segmen dengan alamat berkoordinat (zona otomatis dari sumber air terdekat,
 * jarak garis lurus × 1,3 — cadangan US-M1-05 KP-2), beberapa Tempo, satu tagihan bulanan (perjanjian terlampir),
 * satu Ditahan, satu Tempo migrasi, penanda mitra toko; ditambah 10 pelanggan internal (depot sendiri, PTB-01).
 */
import { straightLineKmX13, type LatLng } from "@/lib/geo";
import type { CustomerSegment, EnumValue } from "@/lib/labels";

import type { DbOrTx } from "../client";
import { attachments, customerAddresses, customerCreditHistory, customers, specialPrices } from "../schema";
import { SEED_EFFECTIVE_FROM } from "./constants";
import { productId, tariffZoneBoundaryId, tariffZoneId, zoneCodeForDistance } from "./catalog";
import { seedId } from "./ids";
import { EQUA_TENANT_ID, OUTLET_SEEDS, WATER_SOURCE_SEEDS, outletId, waterSourceId } from "./org";

type CustomerSeed = {
  code: string;
  name: string;
  segment: CustomerSegment;
  address: string;
  /** Kosong = koordinat Belum dikunci (zona manual). */
  point: LatLng | null;
  manualZone?: string;
  contactName?: string;
  notes?: string;
  fixedReceiveTime?: string;
  credit?: "credit" | "credit_migrated" | "on_hold";
  monthlyBilling?: boolean;
  storePartner?: boolean;
  extraAddress?: { label: string; address: string; point: LatLng };
};

/** Batas kredit bawaan per segmen (PAR-10). */
const SEGMENT_LIMIT: Record<CustomerSegment, number> = {
  household: 0,
  third_party_depot: 3_000_000,
  housing: 3_000_000,
  industry: 10_000_000,
  construction: 10_000_000,
  hotel: 10_000_000,
  swimming_pool: 10_000_000,
};

export const CUSTOMER_SEEDS: CustomerSeed[] = [
  // Depot pihak ketiga (5)
  { code: "PLG-0001", name: "Depot Air Tirta Sari", segment: "third_party_depot", address: "Jl. Raya Cibeber No. 12, Cibeber", point: { lat: -6.9051, lng: 107.131 }, credit: "credit", storePartner: true, contactName: "Pak Rahmat" },
  { code: "PLG-0002", name: "Depot Barokah Cilaku", segment: "third_party_depot", address: "Jl. Raya Cilaku No. 45, Cilaku", point: { lat: -6.8612, lng: 107.1455 }, storePartner: true, contactName: "Bu Yeti" },
  { code: "PLG-0003", name: "Depot Segar Jaya Ciranjang", segment: "third_party_depot", address: "Jl. Raya Ciranjang No. 8, Ciranjang", point: { lat: -6.8198, lng: 107.2701 }, storePartner: true },
  { code: "PLG-0004", name: "Depot Amanah Sukaresmi", segment: "third_party_depot", address: "Jl. Raya Sukaresmi, Sukaresmi", point: { lat: -6.7542, lng: 107.1418 } },
  { code: "PLG-0005", name: "Depot Mandiri Gekbrong", segment: "third_party_depot", address: "Jl. Raya Gekbrong No. 3, Gekbrong", point: { lat: -6.8702, lng: 107.0402 } },
  // Rumah tangga (12) — tunai saja (BR-04)
  { code: "PLG-0006", name: "Bapak Dadang Suhendar", segment: "household", address: "Perum Bumi Cianjur Indah Blok C-7, Cianjur", point: { lat: -6.8301, lng: 107.1502 } },
  { code: "PLG-0007", name: "Ibu Neneng Rohaeni", segment: "household", address: "Kp. Sayang RT 02/05, Cianjur", point: { lat: -6.8155, lng: 107.1333 }, notes: "Gang sempit, truk parkir di mulut gang." },
  { code: "PLG-0008", name: "Bapak Ujang Rahmat", segment: "household", address: "Kp. Cibinong Hilir RT 01/03, Cilaku", point: { lat: -6.8402, lng: 107.122 } },
  { code: "PLG-0009", name: "Ibu Wiwin Winarsih", segment: "household", address: "Sukamulya RT 04/02, Karangtengah", point: { lat: -6.8012, lng: 107.181 } },
  { code: "PLG-0010", name: "Bapak Enjang Sutisna", segment: "household", address: "Nagrak RT 03/01, Cianjur", point: { lat: -6.8244, lng: 107.1255 } },
  { code: "PLG-0011", name: "Ibu Iis Aisyah", segment: "household", address: "Sirnagalih RT 02/04, Cilaku", point: { lat: -6.852, lng: 107.118 } },
  { code: "PLG-0012", name: "Bapak Yusuf Maulana", segment: "household", address: "Limbangansari RT 05/06, Cianjur", point: { lat: -6.829, lng: 107.1601 } },
  { code: "PLG-0013", name: "Ibu Cucu Sumiati", segment: "household", address: "Kp. Pasir Kuda RT 01/02, Cugenang", point: null, manualZone: "Z2" },
  { code: "PLG-0014", name: "Bapak Hendi Kurniawan", segment: "household", address: "Warungkondang RT 02/03, Warungkondang", point: { lat: -6.882, lng: 107.105 } },
  { code: "PLG-0015", name: "Ibu Popon Suryani", segment: "household", address: "Kp. Mande RT 03/02, Mande", point: { lat: -6.7702, lng: 107.2105 } },
  { code: "PLG-0016", name: "Bapak Asep Mulyadi", segment: "household", address: "Sukaluyu RT 01/01, Sukaluyu", point: { lat: -6.825, lng: 107.215 } },
  { code: "PLG-0017", name: "Ibu Tuti Alawiyah", segment: "household", address: "Kp. Cikanyere RT 04/01, Gekbrong", point: null, manualZone: "Z2" },
  // Perumahan (6)
  {
    code: "PLG-0018",
    name: "Perumahan Griya Cianjur Asri",
    segment: "housing",
    address: "Griya Cianjur Asri Blok A (tandon utama), Cilaku",
    point: { lat: -6.8398, lng: 107.1587 },
    credit: "credit",
    contactName: "Pengelola: Pak Wawan",
    extraAddress: { label: "Blok B (tandon cadangan)", address: "Griya Cianjur Asri Blok B, Cilaku", point: { lat: -6.842, lng: 107.1612 } },
  },
  { code: "PLG-0019", name: "Perumahan Bumi Pasir Hayam", segment: "housing", address: "Bumi Pasir Hayam, Cilaku", point: { lat: -6.8505, lng: 107.1395 } },
  { code: "PLG-0020", name: "Perumahan Citra Cianjur Residence", segment: "housing", address: "Citra Cianjur Residence, Cianjur", point: { lat: -6.8095, lng: 107.152 } },
  { code: "PLG-0021", name: "Perumahan Taman Sukaluyu", segment: "housing", address: "Taman Sukaluyu, Sukaluyu", point: { lat: -6.8203, lng: 107.2352 } },
  { code: "PLG-0022", name: "Perumahan Graha Karangtengah", segment: "housing", address: "Graha Karangtengah, Karangtengah", point: { lat: -6.7985, lng: 107.1745 } },
  { code: "PLG-0023", name: "Perumahan Villa Cugenang Asri", segment: "housing", address: "Villa Cugenang Asri, Cugenang", point: { lat: -6.7802, lng: 107.0801 } },
  // Industri (5)
  {
    code: "PLG-0024",
    name: "PT Sinar Tekstil Cianjur",
    segment: "industry",
    address: "Jl. Raya Sukaluyu Km 5 (pabrik 1), Sukaluyu",
    point: { lat: -6.814, lng: 107.2455 },
    credit: "credit",
    fixedReceiveTime: "07:00",
    contactName: "Bagian Umum: Pak Iwan",
    extraAddress: { label: "Gudang 2", address: "Jl. Raya Sukaluyu Km 6 (gudang 2), Sukaluyu", point: { lat: -6.8165, lng: 107.2502 } },
  },
  { code: "PLG-0025", name: "CV Tahu Cibuntu Sejahtera", segment: "industry", address: "Jl. Cibuntu No. 21, Cianjur", point: { lat: -6.835, lng: 107.165 }, credit: "credit", fixedReceiveTime: "06:00" },
  { code: "PLG-0026", name: "PT Kerupuk Mekar Sari", segment: "industry", address: "Jl. Raya Karangtengah No. 88, Karangtengah", point: { lat: -6.8455, lng: 107.2003 }, credit: "on_hold" },
  { code: "PLG-0027", name: "CV Batako Ciranjang", segment: "industry", address: "Jl. Raya Ciranjang Km 2, Ciranjang", point: { lat: -6.8278, lng: 107.2805 } },
  { code: "PLG-0028", name: "PT Pakan Ternak Sukamaju", segment: "industry", address: "Jl. Raya Mande Km 4, Mande", point: { lat: -6.7688, lng: 107.2398 }, credit: "credit_migrated" },
  // Proyek konstruksi (4)
  { code: "PLG-0029", name: "Proyek Jalan Cibeber — PT Karya Bangun", segment: "construction", address: "Lokasi proyek Jalan Cibeber, Cibeber", point: { lat: -6.912, lng: 107.1455 } },
  { code: "PLG-0030", name: "Proyek Perumahan Warungkondang", segment: "construction", address: "Lokasi proyek Warungkondang", point: { lat: -6.895, lng: 107.115 } },
  { code: "PLG-0031", name: "Proyek Gedung Sekolah Mande", segment: "construction", address: "Lokasi proyek SD Mande", point: { lat: -6.763, lng: 107.2201 } },
  { code: "PLG-0032", name: "Proyek Jembatan Ciranjang", segment: "construction", address: "Lokasi proyek jembatan Ciranjang", point: null, manualZone: "Z4" },
  // Hotel (4)
  { code: "PLG-0033", name: "Hotel Puncak Cianjur", segment: "hotel", address: "Jl. Raya Puncak–Cianjur Km 78, Cugenang", point: { lat: -6.755, lng: 107.0725 }, credit: "credit", fixedReceiveTime: "08:00" },
  {
    code: "PLG-0034",
    name: "Hotel Bukit Indah Cugenang",
    segment: "hotel",
    address: "Jl. Raya Cugenang Km 3, Cugenang",
    point: { lat: -6.7625, lng: 107.061 },
    credit: "credit",
    monthlyBilling: true,
    contactName: "Front office: Bu Rani",
  },
  { code: "PLG-0035", name: "Hotel Sabda Alam Cipanas", segment: "hotel", address: "Jl. Raya Cipanas, Cipanas", point: { lat: -6.732, lng: 107.042 } },
  { code: "PLG-0036", name: "Hotel Tirta Cianjur Kota", segment: "hotel", address: "Jl. HOS Cokroaminoto No. 5, Cianjur", point: { lat: -6.8205, lng: 107.1405 } },
  // Kolam renang (4)
  { code: "PLG-0037", name: "Kolam Renang Tirta Kencana", segment: "swimming_pool", address: "Jl. Pramuka No. 10, Cianjur", point: { lat: -6.826, lng: 107.145 }, credit: "credit" },
  { code: "PLG-0038", name: "Kolam Renang Cibodas Pakis", segment: "swimming_pool", address: "Kp. Pakis, Cugenang", point: { lat: -6.744, lng: 107.055 } },
  { code: "PLG-0039", name: "Kolam Renang Bojong Sari", segment: "swimming_pool", address: "Bojong Sari, Cilaku", point: { lat: -6.87, lng: 107.125 } },
  { code: "PLG-0040", name: "Kolam Renang Taman Air Mande", segment: "swimming_pool", address: "Taman Air Mande, Mande", point: { lat: -6.78, lng: 107.23 } },
];

export const customerId = (code: string) => seedId(`customer:${code}`);
export const internalCustomerId = (outletCode: string) => seedId(`customer:internal:${outletCode}`);

/** Sumber air terdekat & jarak cadangan (garis lurus × 1,3) dalam meter. */
export function nearestSource(point: LatLng): { code: string; distanceM: number } {
  let best = { code: WATER_SOURCE_SEEDS[0]!.code as string, distanceM: Number.POSITIVE_INFINITY };
  for (const s of WATER_SOURCE_SEEDS) {
    const d = Math.round(straightLineKmX13(point, { lat: s.lat, lng: s.lng }) * 1000);
    if (d < best.distanceM) best = { code: s.code, distanceM: d };
  }
  return best;
}

type AddressInput = { id: string; customerId: string; label: string; addressText: string; point: LatLng | null; manualZone?: string };

function addressRow(a: AddressInput, lockedAt: Date) {
  if (a.point) {
    const src = nearestSource(a.point);
    return {
      id: a.id,
      customerId: a.customerId,
      label: a.label,
      addressText: a.addressText,
      lat: a.point.lat,
      lng: a.point.lng,
      coordinateStatus: "locked" as const,
      coordinateSource: "import" as const,
      coordinateLockedAt: lockedAt,
      tariffZoneId: tariffZoneId(zoneCodeForDistance(src.distanceM)),
      zoneAssignment: "auto" as const,
      zoneBoundaryId: tariffZoneBoundaryId(zoneCodeForDistance(src.distanceM)),
      zoneAssignedAt: lockedAt,
      referenceWaterSourceId: waterSourceId(src.code),
      distanceM: src.distanceM,
      distanceMethod: "straight_line_x1_3" as const,
      distanceNeedsRecalc: true,
    };
  }
  return {
    id: a.id,
    customerId: a.customerId,
    label: a.label,
    addressText: a.addressText,
    coordinateStatus: "unlocked" as const,
    tariffZoneId: tariffZoneId(a.manualZone ?? "Z2"),
    zoneAssignment: "manual" as const,
    zoneManualReason: "Koordinat belum dikunci — zona ditetapkan Dispatcher sampai pengiriman pertama (US-M1-01 KP-2).",
  };
}

export async function seedCustomers(tx: DbOrTx): Promise<{ customers: number }> {
  const now = new Date();
  const agreementId = seedId("attachment:agreement:PLG-0034");
  await tx
    .insert(attachments)
    .values({
      id: agreementId,
      tenantId: EQUA_TENANT_ID,
      storageKey: "seed/perjanjian-tagihan-bulanan-PLG-0034.pdf",
      contentType: "application/pdf",
      sizeBytes: 0,
      kind: "agreement",
      originalName: "Perjanjian tagihan bulanan — Hotel Bukit Indah Cugenang (demo).pdf",
      objectType: "customer",
      objectId: customerId("PLG-0034"),
    })
    .onConflictDoNothing();

  const creditStatusOf = (c: CustomerSeed): EnumValue<"credit_status"> => c.credit ?? "cash";
  const inserted = await tx
    .insert(customers)
    .values([
      ...CUSTOMER_SEEDS.map((c) => ({
        id: customerId(c.code),
        tenantId: EQUA_TENANT_ID,
        code: c.code,
        name: c.name,
        segment: c.segment,
        waPhone: `62813${String(10_000_000 + Number(c.code.slice(4))).padStart(8, "0")}`,
        contactName: c.contactName ?? null,
        notes: c.notes ?? null,
        fixedReceiveTime: c.fixedReceiveTime ?? null,
        creditStatus: creditStatusOf(c),
        creditLimit: c.segment === "household" ? 0 : SEGMENT_LIMIT[c.segment],
        paymentTermDays: 14,
        monthlyBilling: c.monthlyBilling ?? false,
        monthlyBillingAgreementAttachmentId: c.monthlyBilling ? agreementId : null,
        isStorePartner: c.storePartner ?? false,
        storePartnerSource: c.storePartner ? ("auto" as const) : null,
        isInitialData: true,
      })),
      ...OUTLET_SEEDS.filter((o) => o.kind === "depot").map((o) => ({
        id: internalCustomerId(o.code),
        tenantId: EQUA_TENANT_ID,
        code: `INT-${o.code}`,
        name: `${o.name} (internal)`,
        segment: "third_party_depot" as const,
        waPhone: `62814${String(10_000_000 + Number(o.code.slice(1))).padStart(8, "0")}`,
        notes: "Pelanggan internal untuk pesanan pasokan depot sendiri (PTB-01) — tanpa pencatatan uang.",
        creditStatus: "cash" as const,
        creditLimit: 0,
        internalOutletId: outletId(o.code),
        isInitialData: true,
      })),
    ])
    .onConflictDoNothing()
    .returning({ id: customers.id });

  const addressInputs: AddressInput[] = [
    ...CUSTOMER_SEEDS.flatMap((c) => {
      const main: AddressInput = {
        id: seedId(`address:${c.code}:utama`),
        customerId: customerId(c.code),
        label: "Utama",
        addressText: c.address,
        point: c.point,
        manualZone: c.manualZone,
      };
      if (!c.extraAddress) return [main];
      return [
        main,
        {
          id: seedId(`address:${c.code}:2`),
          customerId: customerId(c.code),
          label: c.extraAddress.label,
          addressText: c.extraAddress.address,
          point: c.extraAddress.point,
        },
      ];
    }),
    ...OUTLET_SEEDS.filter((o) => o.kind === "depot").map((o) => ({
      id: seedId(`address:internal:${o.code}`),
      customerId: internalCustomerId(o.code),
      label: "Depot",
      addressText: o.address,
      point: { lat: o.lat, lng: o.lng },
    })),
  ];
  await tx
    .insert(customerAddresses)
    .values(addressInputs.map((a) => addressRow(a, now)))
    .onConflictDoNothing();

  // Riwayat status kredit untuk pelanggan non-Tunai.
  type CreditHistoryInsert = typeof customerCreditHistory.$inferInsert;
  const historyRows = CUSTOMER_SEEDS.filter((c) => c.credit).flatMap((c): CreditHistoryInsert[] => {
    const limit = SEGMENT_LIMIT[c.segment];
    if (c.credit === "credit_migrated") {
      return [
        {
          id: seedId(`credit_history:${c.code}:migrated`),
          customerId: customerId(c.code),
          fromStatus: null,
          toStatus: "credit_migrated" as const,
          creditLimitAfter: limit,
          termDaysAfter: 14,
          reason: "Tempo migrasi pelanggan lama — bagian tanda tangan data awal (US-M1-06 KP-6, NFR-34).",
          rule: "US-M1-06 KP-6",
          changedAt: now,
        },
      ];
    }
    const rows: CreditHistoryInsert[] = [
      {
        id: seedId(`credit_history:${c.code}:credit`),
        customerId: customerId(c.code),
        fromStatus: "cash" as const,
        toStatus: "credit" as const,
        creditLimitBefore: limit,
        creditLimitAfter: limit,
        termDaysBefore: 14,
        termDaysAfter: 14,
        reason: "Pemberian status Tempo (data demo) — disetujui pemilik.",
        rule: null,
        changedAt: now,
      },
    ];
    if (c.credit === "on_hold") {
      rows.push({
        id: seedId(`credit_history:${c.code}:on_hold`),
        customerId: customerId(c.code),
        fromStatus: "credit" as const,
        toStatus: "on_hold" as const,
        creditLimitBefore: limit,
        creditLimitAfter: limit,
        termDaysBefore: 14,
        termDaysAfter: 14,
        reason: "Ditahan otomatis: faktur lewat jatuh tempo lebih dari 7 hari (data demo).",
        rule: "BR-03",
        changedAt: now,
      });
    }
    return rows;
  });
  if (historyRows.length > 0) await tx.insert(customerCreditHistory).values(historyRows).onConflictDoNothing();

  // Harga khusus (BR-16): Hotel Puncak Cianjur, air truk Rp 240.000/rit, tinjauan 6 bulan.
  await tx
    .insert(specialPrices)
    .values({
      id: seedId("special_price:PLG-0033:AIR-TRUK"),
      customerId: customerId("PLG-0033"),
      productId: productId("AIR-TRUK"),
      price: 240_000,
      reason: "Pelanggan langganan harian sejak 2024 (data demo).",
      validFrom: SEED_EFFECTIVE_FROM,
      reviewDate: "2025-07-01",
      status: "active",
      isOwnerDirect: true,
      approvedAt: now,
    })
    .onConflictDoNothing();

  return { customers: inserted.length };
}
