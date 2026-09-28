/**
 * M1 — Master Data (PRD 7.1): pelanggan & alamat kirim, status kredit, harga khusus, zona tarif & komponen BBM,
 * produk & harga tiga lini, resep bahan depot, armada, sumber air & meter, pool/garasi, impor data awal, template WA.
 * Depot/toko = `outlets` (core); karyawan = `employees` (core).
 *
 * Aturan impor: hanya memakai enum/pembantu dari `core` & `_columns` di tingkat atas; rujukan ke tabel modul lain
 * hanya di dalam callback `.references(() => …)` / `relations()` (lazy).
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  time,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { enumValues } from "../../lib/labels";
import { coord, dateStr, meterLiters, meters, money, pk, refId, timestamps, createdAtOnly, tstz } from "./_columns";
import {
  approvalRef,
  approvalRequests,
  attachmentRef,
  attachments,
  createdBy,
  customerSegmentEnum,
  deactivation,
  devices,
  employeeRef,
  employees,
  outletRef,
  outlets,
  priceKindEnum,
  priceStatusEnum,
  tenantRef,
  tenants,
  userRef,
  waMessageKindEnum,
} from "./core";
import { orders, trips } from "./m2-orders";

// =====================================================================================================================
// Enum M1
// =====================================================================================================================

export const creditStatusEnum = pgEnum("credit_status", enumValues("credit_status"));
export const coordinateStatusEnum = pgEnum("coordinate_status", enumValues("coordinate_status"));
export const coordinateSourceEnum = pgEnum("coordinate_source", enumValues("coordinate_source"));
export const zoneAssignmentEnum = pgEnum("zone_assignment", enumValues("zone_assignment"));
export const distanceMethodEnum = pgEnum("distance_method", enumValues("distance_method"));
export const storePartnerSourceEnum = pgEnum("store_partner_source", enumValues("store_partner_source"));
export const truckStatusEnum = pgEnum("truck_status", enumValues("truck_status"));
export const productLineEnum = pgEnum("product_line", enumValues("product_line"));
export const productStatusEnum = pgEnum("product_status", enumValues("product_status"));
export const meterUnitEnum = pgEnum("meter_unit", enumValues("meter_unit"));
export const meterStatusEnum = pgEnum("meter_status", enumValues("meter_status"));
export const importKindEnum = pgEnum("import_kind", enumValues("import_kind"));
export const importStatusEnum = pgEnum("import_status", enumValues("import_status"));
export const importRowStatusEnum = pgEnum("import_row_status", enumValues("import_row_status"));

// =====================================================================================================================
// Sumber air, meter, pool
// =====================================================================================================================

/** Sumber air (US-M1-04 KP-2): kapasitas harian 50.000 L, geofence, meter. */
export const waterSources = pgTable(
  "water_sources",
  {
    id: pk(),
    tenantId: tenantRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    address: text("address"),
    lat: coord("lat").notNull(),
    lng: coord("lng").notNull(),
    /** Kosong = PAR-54. */
    geofenceRadiusM: meters("geofence_radius_m"),
    /** K1: 50.000 L/hari. Dasar utilisasi (US-M8-05). */
    dailyCapacityL: integer("daily_capacity_l").notNull(),
    ...deactivation(),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [uniqueIndex("water_sources_tenant_code_uq").on(t.tenantId, t.code)],
);

/** Meter air per sumber (US-M1-04 KP-2, US-M8-01). Pembacaan disimpan dalam liter (bigint). */
export const waterMeters = pgTable(
  "water_meters",
  {
    id: pk(),
    waterSourceId: uuid("water_source_id")
      .notNull()
      .references((): AnyPgColumn => waterSources.id),
    code: text("code").notNull().unique(),
    name: text("name"),
    unit: meterUnitEnum("unit").notNull().default("liter"),
    /** Angka awal saat cut-over (liter). */
    initialReadingL: meterLiters("initial_reading_l").notNull(),
    initialPhotoAttachmentId: attachmentRef("initial_photo_attachment_id"),
    installedAt: dateStr("installed_at"),
    status: meterStatusEnum("status").notNull().default("active"),
    /** Meter rusak/diganti (7.8.6): pembacaan terakhir meter lama ditutup. */
    replacedByMeterId: uuid("replaced_by_meter_id").references((): AnyPgColumn => waterMeters.id),
    replacedAt: tstz("replaced_at"),
    finalReadingL: meterLiters("final_reading_l"),
    notes: text("notes"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("water_meters_source_idx").on(t.waterSourceId)],
);

/** Pool/garasi truk — lokasi sah untuk deteksi perjalanan (PTB-34, US-M12-05). */
export const poolLocations = pgTable(
  "pool_locations",
  {
    id: pk(),
    tenantId: tenantRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    address: text("address"),
    lat: coord("lat").notNull(),
    lng: coord("lng").notNull(),
    geofenceRadiusM: meters("geofence_radius_m"),
    /** Pool per truk (sopir membawa truk pulang) disetujui pemilik (7.12.6). */
    approvedBy: userRef("approved_by"),
    approvedAt: tstz("approved_at"),
    ...deactivation(),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [uniqueIndex("pool_locations_tenant_code_uq").on(t.tenantId, t.code)],
);

// =====================================================================================================================
// Zona tarif, komponen BBM
// =====================================================================================================================

/**
 * Zona tarif — rentang jarak dari sumber air acuan (US-M1-05 KP-1): tidak tumpang tindih, tanpa celah.
 * `min_distance_m`/`max_distance_m` = batas yang BERLAKU saat ini (salinan dari `tariff_zone_boundaries` aktif terbaru,
 * diperbarui layanan M1 saat batas baru berlaku). Riwayat, persetujuan & tanggal berlaku ada di `tariff_zone_boundaries`.
 */
export const tariffZones = pgTable(
  "tariff_zones",
  {
    id: pk(),
    tenantId: tenantRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Batas jarak dalam meter: [min, max). `max` kosong = tanpa batas atas. */
    minDistanceM: meters("min_distance_m").notNull(),
    maxDistanceM: meters("max_distance_m"),
    ...deactivation(),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [uniqueIndex("tariff_zones_tenant_code_uq").on(t.tenantId, t.code)],
);

/**
 * Batas jarak zona berversi per tanggal berlaku (US-M1-05 KP-1/KP-4, 6.2a "perubahan harga master, zona, komponen BBM",
 * 6.2b, BR-19): jalur baku `pending` → persetujuan pemilik → `active`; input pemilik sendiri = keputusan langsung
 * (`is_owner_direct`). Lewat tenggat → batas lama tetap berlaku. Dasar daftar "alamat yang berpindah zona".
 */
export const tariffZoneBoundaries = pgTable(
  "tariff_zone_boundaries",
  {
    id: pk(),
    tariffZoneId: uuid("tariff_zone_id")
      .notNull()
      .references((): AnyPgColumn => tariffZones.id),
    /** [min, max) dalam meter; `max` kosong = tanpa batas atas. */
    minDistanceM: meters("min_distance_m").notNull(),
    maxDistanceM: meters("max_distance_m"),
    effectiveFrom: dateStr("effective_from").notNull(),
    status: priceStatusEnum("status").notNull().default("pending"),
    approvalRequestId: uuid("approval_request_id"),
    isOwnerDirect: boolean("is_owner_direct").notNull().default(false),
    reason: text("reason"),
    approvedBy: userRef("approved_by"),
    approvedAt: tstz("approved_at"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    foreignKey({
      name: "tariff_zone_boundaries_approval_fk",
      columns: [t.approvalRequestId],
      foreignColumns: [approvalRequests.id],
    }),
    index("tariff_zone_boundaries_zone_from_idx").on(t.tariffZoneId, t.effectiveFrom),
    uniqueIndex("tariff_zone_boundaries_active_uq")
      .on(t.tariffZoneId, t.effectiveFrom)
      .where(sql`${t.status} = 'active'`),
    check(
      "tariff_zone_boundaries_range_chk",
      sql`${t.minDistanceM} >= 0 and (${t.maxDistanceM} is null or ${t.maxDistanceM} > ${t.minDistanceM})`,
    ),
  ],
);

/**
 * Tarif per rit per zona, berlaku per tanggal (BR-19, BR-15), opsional per segmen (US-M1-05 KP-1).
 * Jalur baku: status `pending` → persetujuan pemilik → `active`; input pemilik sendiri = keputusan langsung (6.2b).
 */
export const zoneTariffs = pgTable(
  "zone_tariffs",
  {
    id: pk(),
    tariffZoneId: uuid("tariff_zone_id")
      .notNull()
      .references((): AnyPgColumn => tariffZones.id),
    /** Kosong = berlaku untuk semua segmen. */
    segment: customerSegmentEnum("segment"),
    pricePerTrip: money("price_per_trip").notNull(),
    effectiveFrom: dateStr("effective_from").notNull(),
    status: priceStatusEnum("status").notNull().default("pending"),
    approvalRequestId: approvalRef(),
    /** 6.2b: diinput pemilik sendiri (tanpa langkah persetujuan). */
    isOwnerDirect: boolean("is_owner_direct").notNull().default(false),
    reason: text("reason"),
    approvedBy: userRef("approved_by"),
    approvedAt: tstz("approved_at"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    index("zone_tariffs_zone_from_idx").on(t.tariffZoneId, t.effectiveFrom),
    // BR-15/BR-19, US-M1-02 KP-4: satu tarif aktif per (zona, segmen, tanggal berlaku) — harga deterministik.
    uniqueIndex("zone_tariffs_active_segment_uq")
      .on(t.tariffZoneId, t.segment, t.effectiveFrom)
      .where(sql`${t.status} = 'active' and ${t.segment} is not null`),
    uniqueIndex("zone_tariffs_active_all_uq")
      .on(t.tariffZoneId, t.effectiveFrom)
      .where(sql`${t.status} = 'active' and ${t.segment} is null`),
  ],
);

/** Komponen BBM — satu nilai rupiah per rit untuk seluruh zona, berlaku per tanggal (US-M1-02 KP-2, PTB-03). */
export const fuelComponents = pgTable(
  "fuel_components",
  {
    id: pk(),
    tenantId: tenantRef(),
    amountPerTrip: money("amount_per_trip").notNull(),
    effectiveFrom: dateStr("effective_from").notNull(),
    status: priceStatusEnum("status").notNull().default("pending"),
    approvalRequestId: approvalRef(),
    isOwnerDirect: boolean("is_owner_direct").notNull().default(false),
    reason: text("reason"),
    approvedBy: userRef("approved_by"),
    approvedAt: tstz("approved_at"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    index("fuel_components_tenant_from_idx").on(t.tenantId, t.effectiveFrom),
    uniqueIndex("fuel_components_active_uq")
      .on(t.tenantId, t.effectiveFrom)
      .where(sql`${t.status} = 'active'`),
  ],
);

// =====================================================================================================================
// Pelanggan & alamat
// =====================================================================================================================

/** Pelanggan (US-M1-01). Status kredit bawaan Tunai (BR-01); rumah tangga tunai saja (BR-04). */
export const customers = pgTable(
  "customers",
  {
    id: pk(),
    tenantId: tenantRef(),
    /** Nomor pelanggan opsional (hasil impor / tampilan). */
    code: text("code"),
    name: text("name").notNull(),
    segment: customerSegmentEnum("segment").notNull(),
    /** Nomor WA ternormalisasi (format Indonesia, mis. 6281234567890). Duplikat diperingatkan, tidak diblokir (KP-7). */
    waPhone: text("wa_phone").notNull(),
    contactName: text("contact_name"),
    /** Catatan khusus: akses lokasi, dll. (FR-M2-08) — ikut ke aplikasi sopir. */
    notes: text("notes"),
    /** Jam terima tetap (BR-21; terisi otomatis di pesanan). */
    fixedReceiveTime: time("fixed_receive_time"),
    creditStatus: creditStatusEnum("credit_status").notNull().default("cash"),
    /** Batas kredit (BR-04/PAR-10 dari segmen); ubah hanya oleh pemilik dengan alasan. */
    creditLimit: money("credit_limit").notNull().default(0),
    creditLimitOverridden: boolean("credit_limit_overridden").notNull().default(false),
    /** Tempo standar 14 hari (BR-02, PAR-08); pengecualian per pelanggan oleh pemilik. */
    paymentTermDays: integer("payment_term_days").notNull().default(14),
    /** BR-05: tagihan bulanan hanya dengan perjanjian tertulis terlampir & disetujui pemilik. */
    monthlyBilling: boolean("monthly_billing").notNull().default(false),
    monthlyBillingAgreementAttachmentId: uuid("monthly_billing_agreement_attachment_id"),
    monthlyBillingApprovalId: approvalRef("monthly_billing_approval_id"),
    /** BR-18: penanda mitra toko (otomatis untuk depot pihak ketiga aktif, manual untuk mitra depot EQUA). */
    isStorePartner: boolean("is_store_partner").notNull().default(false),
    storePartnerSource: storePartnerSourceEnum("store_partner_source"),
    /** Mitra depot EQUA (RL-7, US-P3-08) — tertaut ke tenant & outlet mitra. */
    isEquaPartner: boolean("is_equa_partner").notNull().default(false),
    partnerTenantId: uuid("partner_tenant_id").references((): AnyPgColumn => tenants.id),
    partnerOutletId: outletRef("partner_outlet_id"),
    /** PTB-01: pelanggan internal = depot sendiri (pesanan pasokan depot, tanpa uang). */
    internalOutletId: outletRef("internal_outlet_id"),
    /** PAR-41 / R07: penundaan penahanan otomatis per pelanggan (maks. 2 bulan sejak go-live; 6.2b). */
    holdDeferralUntil: dateStr("hold_deferral_until"),
    holdDeferralReason: text("hold_deferral_reason"),
    holdDeferralSetBy: userRef("hold_deferral_set_by"),
    /**
     * Pembukaan Ditahan sebelum lunas oleh pemilik (US-M5-03 KP-3, BR-03, 6.2a): berlaku sampai keterlambatan
     * berikutnya — faktur dengan due_date ≤ `hold_release_covers_due_until` tidak memicu Ditahan ulang.
     */
    holdReleasedAt: tstz("hold_released_at"),
    holdReleasedBy: userRef("hold_released_by"),
    holdReleaseApprovalId: approvalRef("hold_release_approval_id"),
    holdReleaseCoversDueUntil: dateStr("hold_release_covers_due_until"),
    /** US-M1-06 KP-3: data awal hasil impor produksi — tidak dapat diubah kecuali lewat koreksi berjejak. */
    isInitialData: boolean("is_initial_data").notNull().default(false),
    importBatchId: uuid("import_batch_id").references((): AnyPgColumn => importBatches.id),
    ...deactivation(),
    /** Anonimisasi (US-M10-06 KP-2). */
    anonymizedAt: tstz("anonymized_at"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    index("customers_tenant_segment_idx").on(t.tenantId, t.segment),
    index("customers_wa_idx").on(t.waPhone),
    index("customers_name_lower_idx").on(sql`lower(${t.name})`),
    index("customers_credit_status_idx").on(t.creditStatus),
    uniqueIndex("customers_tenant_code_uq")
      .on(t.tenantId, t.code)
      .where(sql`${t.code} is not null`),
    uniqueIndex("customers_internal_outlet_uq")
      .on(t.internalOutletId)
      .where(sql`${t.internalOutletId} is not null`),
    foreignKey({
      name: "customers_monthly_agreement_fk",
      columns: [t.monthlyBillingAgreementAttachmentId],
      foreignColumns: [attachments.id],
    }),
    // BR-04 (ditegaskan CR-12), US-M1-01 KP-4: rumah tangga tunai saja, tanpa pengecualian.
    check(
      "customers_household_cash_chk",
      sql`${t.segment} <> 'household' or (${t.creditStatus} = 'cash' and ${t.creditLimit} = 0 and ${t.monthlyBilling} = false)`,
    ),
    check("customers_credit_values_chk", sql`${t.creditLimit} >= 0 and ${t.paymentTermDays} > 0`),
  ],
);

/**
 * Alamat kirim (US-M1-01 KP-2, US-M1-05): koordinat Belum dikunci/Dikunci, zona Otomatis/Manual (+alasan),
 * sumber air acuan (bawaan terdekat, dapat diubah dengan alasan — PTB-02), jarak & metode.
 */
export const customerAddresses = pgTable(
  "customer_addresses",
  {
    id: pk(),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => customers.id),
    label: text("label").notNull(),
    addressText: text("address_text").notNull(),
    lat: coord("lat"),
    lng: coord("lng"),
    coordinateStatus: coordinateStatusEnum("coordinate_status").notNull().default("unlocked"),
    coordinateSource: coordinateSourceEnum("coordinate_source"),
    coordinateLockedAt: tstz("coordinate_locked_at"),
    coordinateLockedBy: userRef("coordinate_locked_by"),
    /** Usulan koordinat dari lokasi Selesai rit pertama, menunggu konfirmasi Dispatcher (KP-2; US-M3-03 KP-4). */
    proposedLat: coord("proposed_lat"),
    proposedLng: coord("proposed_lng"),
    proposedFromTripId: uuid("proposed_from_trip_id").references((): AnyPgColumn => trips.id),
    proposedAt: tstz("proposed_at"),
    notes: text("notes"),
    tariffZoneId: uuid("tariff_zone_id").references((): AnyPgColumn => tariffZones.id),
    zoneAssignment: zoneAssignmentEnum("zone_assignment").notNull().default("auto"),
    zoneManualReason: text("zone_manual_reason"),
    /** Versi batas zona yang dipakai saat pemetaan (US-M1-05 KP-4: daftar tinjauan alamat yang berpindah zona). */
    zoneBoundaryId: uuid("zone_boundary_id"),
    zoneAssignedAt: tstz("zone_assigned_at"),
    /** Sumber air acuan (PTB-02): bawaan terdekat; ubah Dispatcher dengan alasan. */
    referenceWaterSourceId: uuid("reference_water_source_id"),
    referenceSourceManual: boolean("reference_source_manual").notNull().default(false),
    referenceSourceReason: text("reference_source_reason"),
    distanceM: meters("distance_m"),
    distanceMethod: distanceMethodEnum("distance_method"),
    /** 7.1.6: peta tidak tersedia → jarak cadangan, ditandai untuk hitung ulang. */
    distanceNeedsRecalc: boolean("distance_needs_recalc").notNull().default(false),
    ...deactivation(),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    index("customer_addresses_customer_idx").on(t.customerId),
    index("customer_addresses_zone_idx").on(t.tariffZoneId),
    foreignKey({
      name: "customer_addresses_ref_source_fk",
      columns: [t.referenceWaterSourceId],
      foreignColumns: [waterSources.id],
    }),
    foreignKey({
      name: "customer_addresses_zone_boundary_fk",
      columns: [t.zoneBoundaryId],
      foreignColumns: [tariffZoneBoundaries.id],
    }),
  ],
);

/** Riwayat status kredit, batas & tempo per pelanggan (US-M5-03 KP-4). */
export const customerCreditHistory = pgTable(
  "customer_credit_history",
  {
    id: pk(),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => customers.id),
    fromStatus: creditStatusEnum("from_status"),
    toStatus: creditStatusEnum("to_status").notNull(),
    creditLimitBefore: money("credit_limit_before"),
    creditLimitAfter: money("credit_limit_after"),
    termDaysBefore: integer("term_days_before"),
    termDaysAfter: integer("term_days_after"),
    reason: text("reason"),
    /** Kosong = sistem (mis. Ditahan otomatis). */
    changedBy: userRef("changed_by"),
    /** Aturan pemicu otomatis, mis. "BR-03". */
    rule: text("rule"),
    approvalRequestId: uuid("approval_request_id"),
    changedAt: tstz("changed_at").notNull().defaultNow(),
    ...createdAtOnly(),
  },
  (t) => [
    index("customer_credit_history_cust_idx").on(t.customerId, t.changedAt),
    foreignKey({
      name: "customer_credit_history_approval_fk",
      columns: [t.approvalRequestId],
      foreignColumns: [approvalRequests.id],
    }),
  ],
);

// =====================================================================================================================
// Produk & harga
// =====================================================================================================================

/**
 * Produk tiga lini (US-M1-02): air truk (harga = tarif zona + BBM atau harga khusus), produk depot (harga tunggal per
 * tenant), barang toko (harga umum & mitra, satuan, stok minimum). Dinonaktifkan, tidak dihapus.
 */
export const products = pgTable(
  "products",
  {
    id: pk(),
    tenantId: tenantRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    line: productLineEnum("line").notNull(),
    /** Kategori bebas: isi_ulang, galon_baru, bahan_habis_pakai, spare_part, peralatan, … */
    category: text("category"),
    unit: text("unit").notNull(),
    /** US-M1-02 KP-5: "air truk — transfer internal" (pasokan depot sendiri, BR-33). */
    isInternalTransfer: boolean("is_internal_transfer").notNull().default(false),
    /** Bahan habis pakai (tutup, tisu, galon kosong) — resep & kartu stok depot (US-M6-04). */
    isConsumable: boolean("is_consumable").notNull().default(false),
    /** Ukuran galon (L) untuk neraca air (A9: 19 L). Kosong = bukan produk air galon. */
    gallonSizeL: integer("gallon_size_l"),
    /** Stok minimum (barang toko; US-M7-03). */
    minStock: integer("min_stock"),
    barcode: text("barcode"),
    /** Tampil di kisi POS (maks. 12 tombol, US-M6-01 KP-1). */
    posVisible: boolean("pos_visible").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Bahan depot ini dipasok dari barang toko X (transfer internal toko → depot, US-M7-06). */
    storeProductId: uuid("store_product_id").references((): AnyPgColumn => products.id),
    /** Katalog standar EQUA disalin ke tenant mitra (Bab 4.3): produk asal. */
    sourceProductId: uuid("source_product_id").references((): AnyPgColumn => products.id),
    /** Barang toko baru dibuat kasir → berlaku setelah disetujui Admin Keuangan (BRD 10.2). */
    status: productStatusEnum("status").notNull().default("active"),
    approvalRequestId: approvalRef(),
    deactivatedAt: tstz("deactivated_at"),
    deactivatedBy: userRef("deactivated_by"),
    deactivationReason: text("deactivation_reason"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [uniqueIndex("products_tenant_code_uq").on(t.tenantId, t.code), index("products_tenant_line_idx").on(t.tenantId, t.line)],
);

/** Harga produk berlaku per tanggal (BR-15): standar (depot), umum & mitra (toko); riwayat tidak dapat dihapus. */
export const productPrices = pgTable(
  "product_prices",
  {
    id: pk(),
    /** NFR-30: disalin dari `products.tenant_id`. */
    tenantId: tenantRef(),
    productId: uuid("product_id")
      .notNull()
      .references((): AnyPgColumn => products.id),
    kind: priceKindEnum("kind").notNull(),
    /**
     * Harga khusus outlet (US-M6-07 KP-3, US-P3-02 KP-1: pengaturan harga per tenant/outlet tanpa kode). Kosong =
     * berlaku untuk seluruh outlet tenant.
     */
    outletId: outletRef(),
    price: money("price").notNull(),
    /** Harga anjuran EQUA yang ditampilkan ke mitra (PTB-56); harga jual mitra = `price`. */
    recommendedPrice: money("recommended_price"),
    effectiveFrom: dateStr("effective_from").notNull(),
    status: priceStatusEnum("status").notNull().default("pending"),
    approvalRequestId: approvalRef(),
    isOwnerDirect: boolean("is_owner_direct").notNull().default(false),
    reason: text("reason"),
    approvedBy: userRef("approved_by"),
    approvedAt: tstz("approved_at"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    index("product_prices_product_idx").on(t.productId, t.kind, t.effectiveFrom),
    index("product_prices_tenant_idx").on(t.tenantId, t.productId),
    // BR-15, US-M1-02 KP-3/KP-4: satu harga aktif per (produk, jenis, [outlet], tanggal berlaku).
    uniqueIndex("product_prices_active_uq")
      .on(t.productId, t.kind, t.effectiveFrom)
      .where(sql`${t.status} = 'active' and ${t.outletId} is null`),
    uniqueIndex("product_prices_active_outlet_uq")
      .on(t.productId, t.kind, t.outletId, t.effectiveFrom)
      .where(sql`${t.status} = 'active' and ${t.outletId} is not null`),
  ],
);

/**
 * Harga khusus per pelanggan per produk (BR-16, US-M1-01 KP-5): alasan, tanggal mulai, tanggal tinjauan otomatis
 * 6 bulan (PAR-24); berlaku setelah persetujuan pemilik; lewat tinjauan tetap berlaku tetapi masuk daftar tinjauan.
 */
export const specialPrices = pgTable(
  "special_prices",
  {
    id: pk(),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => customers.id),
    productId: uuid("product_id")
      .notNull()
      .references((): AnyPgColumn => products.id),
    price: money("price").notNull(),
    reason: text("reason").notNull(),
    validFrom: dateStr("valid_from").notNull(),
    reviewDate: dateStr("review_date").notNull(),
    validUntil: dateStr("valid_until"),
    status: priceStatusEnum("status").notNull().default("pending"),
    approvalRequestId: approvalRef(),
    isOwnerDirect: boolean("is_owner_direct").notNull().default(false),
    approvedBy: userRef("approved_by"),
    approvedAt: tstz("approved_at"),
    lastReviewedAt: tstz("last_reviewed_at"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    index("special_prices_customer_idx").on(t.customerId, t.productId, t.validFrom),
    // BR-16: satu harga khusus aktif per (pelanggan, produk, tanggal mulai).
    uniqueIndex("special_prices_active_uq")
      .on(t.customerId, t.productId, t.validFrom)
      .where(sql`${t.status} = 'active'`),
  ],
);

/** Resep bahan per produk depot per tenant (US-M6-04 KP-2): mis. 1 isi ulang = 1 tutup + 1 tisu. */
export const depotRecipes = pgTable(
  "depot_recipes",
  {
    id: pk(),
    tenantId: tenantRef(),
    productId: uuid("product_id")
      .notNull()
      .references((): AnyPgColumn => products.id),
    materialProductId: uuid("material_product_id")
      .notNull()
      .references((): AnyPgColumn => products.id),
    quantity: integer("quantity").notNull(),
    effectiveFrom: dateStr("effective_from").notNull(),
    ...deactivation(),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [uniqueIndex("depot_recipes_product_material_from_uq").on(t.productId, t.materialProductId, t.effectiveFrom)],
);

// =====================================================================================================================
// Armada
// =====================================================================================================================

/** Truk (US-M1-03 KP-1): kapasitas bawaan 5.000 L; satu karyawan hanya satu truk default (KP-3). */
export const trucks = pgTable(
  "trucks",
  {
    id: pk(),
    tenantId: tenantRef(),
    /** Nomor polisi, mis. "F 8231 KA". */
    plateNumber: text("plate_number").notNull().unique(),
    /** Kode singkat (T1..T7) untuk papan jadwal. */
    code: text("code").notNull(),
    capacityL: integer("capacity_l").notNull().default(5000),
    status: truckStatusEnum("status").notNull().default("active"),
    statusChangedAt: tstz("status_changed_at"),
    statusReason: text("status_reason"),
    defaultDriverEmployeeId: employeeRef("default_driver_employee_id").unique("trucks_default_driver_uq"),
    defaultHelperEmployeeId: employeeRef("default_helper_employee_id").unique("trucks_default_helper_uq"),
    gpsDeviceId: uuid("gps_device_id")
      .unique("trucks_gps_device_uq")
      .references((): AnyPgColumn => devices.id),
    fieldDeviceId: uuid("field_device_id").references((): AnyPgColumn => devices.id),
    /** Kapasitas rit harian per truk (PAR-33 bawaan 3; dapat diatur per truk). */
    dailyTripCapacity: integer("daily_trip_capacity"),
    /** Pool/garasi truk (PTB-34). */
    poolLocationId: uuid("pool_location_id").references((): AnyPgColumn => poolLocations.id),
    /** Deteksi perjalanan M12 aktif (7.12.6: nonaktif sampai perangkat GPS terpasang). */
    fleetDetectionEnabled: boolean("fleet_detection_enabled").notNull().default(true),
    ...deactivation(),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [uniqueIndex("trucks_tenant_code_uq").on(t.tenantId, t.code)],
);

// =====================================================================================================================
// Impor data awal & template WA
// =====================================================================================================================

/** Batch impor data awal (US-M1-06): validasi per baris; tidak ada baris masuk sebelum semua kesalahan diselesaikan. */
export const importBatches = pgTable(
  "import_batches",
  {
    id: pk(),
    tenantId: tenantRef(),
    kind: importKindEnum("kind").notNull(),
    fileAttachmentId: attachmentRef("file_attachment_id"),
    originalFilename: text("original_filename"),
    status: importStatusEnum("status").notNull().default("uploaded"),
    /** KP-3: impor produksi ditandai "data awal". */
    isInitialData: boolean("is_initial_data").notNull().default(false),
    rowCount: integer("row_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    excludedCount: integer("excluded_count").notNull().default(0),
    /** Ringkasan (jumlah per segmen/zona, Tempo & batas) untuk tanda tangan pemilik (KP-4). */
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    signoffId: refId("signoff_id"),
    committedAt: tstz("committed_at"),
    committedBy: userRef("committed_by"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("import_batches_tenant_kind_idx").on(t.tenantId, t.kind)],
);

/** Baris impor dengan hasil validasi (KP-2): wajib kosong, format WA, segmen, duplikat + usulan penggabungan. */
export const importBatchRows = pgTable(
  "import_batch_rows",
  {
    id: pk(),
    batchId: uuid("batch_id")
      .notNull()
      .references((): AnyPgColumn => importBatches.id),
    rowNumber: integer("row_number").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    status: importRowStatusEnum("status").notNull().default("valid"),
    errors: jsonb("errors").$type<string[]>(),
    duplicateCandidates: jsonb("duplicate_candidates").$type<Record<string, unknown>[]>(),
    mergeProposal: jsonb("merge_proposal").$type<Record<string, unknown>>(),
    exclusionReason: text("exclusion_reason"),
    createdEntityType: text("created_entity_type"),
    createdEntityId: refId("created_entity_id"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("import_batch_rows_batch_row_uq").on(t.batchId, t.rowNumber)],
);

/** Template pesan WA dikelola pemilik (US-M2-07, US-M3-03 KP-7, US-M5-05; NFR-20). */
export const waTemplates = pgTable(
  "wa_templates",
  {
    id: pk(),
    tenantId: tenantRef(),
    kind: waMessageKindEnum("kind").notNull(),
    name: text("name").notNull(),
    /** Isi dengan penanda `{{nama_variabel}}`. */
    body: text("body").notNull(),
    variables: jsonb("variables").$type<string[]>().notNull().default([]),
    version: integer("version").notNull().default(1),
    ...deactivation(),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [uniqueIndex("wa_templates_tenant_kind_version_uq").on(t.tenantId, t.kind, t.version)],
);

// =====================================================================================================================
// Relasi
// =====================================================================================================================

export const waterSourcesRelations = relations(waterSources, ({ one, many }) => ({
  tenant: one(tenants, { fields: [waterSources.tenantId], references: [tenants.id] }),
  meters: many(waterMeters),
}));

export const waterMetersRelations = relations(waterMeters, ({ one }) => ({
  waterSource: one(waterSources, { fields: [waterMeters.waterSourceId], references: [waterSources.id] }),
}));

export const tariffZonesRelations = relations(tariffZones, ({ many }) => ({
  tariffs: many(zoneTariffs),
  boundaries: many(tariffZoneBoundaries),
  addresses: many(customerAddresses),
}));

export const tariffZoneBoundariesRelations = relations(tariffZoneBoundaries, ({ one }) => ({
  zone: one(tariffZones, { fields: [tariffZoneBoundaries.tariffZoneId], references: [tariffZones.id] }),
}));

export const zoneTariffsRelations = relations(zoneTariffs, ({ one }) => ({
  zone: one(tariffZones, { fields: [zoneTariffs.tariffZoneId], references: [tariffZones.id] }),
}));

export const customersRelations = relations(customers, ({ one, many }) => ({
  tenant: one(tenants, { fields: [customers.tenantId], references: [tenants.id] }),
  addresses: many(customerAddresses),
  creditHistory: many(customerCreditHistory),
  specialPrices: many(specialPrices),
  orders: many(orders),
  internalOutlet: one(outlets, { fields: [customers.internalOutletId], references: [outlets.id] }),
}));

export const customerAddressesRelations = relations(customerAddresses, ({ one }) => ({
  customer: one(customers, { fields: [customerAddresses.customerId], references: [customers.id] }),
  tariffZone: one(tariffZones, { fields: [customerAddresses.tariffZoneId], references: [tariffZones.id] }),
  zoneBoundary: one(tariffZoneBoundaries, {
    fields: [customerAddresses.zoneBoundaryId],
    references: [tariffZoneBoundaries.id],
  }),
  referenceWaterSource: one(waterSources, {
    fields: [customerAddresses.referenceWaterSourceId],
    references: [waterSources.id],
  }),
}));

export const customerCreditHistoryRelations = relations(customerCreditHistory, ({ one }) => ({
  customer: one(customers, { fields: [customerCreditHistory.customerId], references: [customers.id] }),
}));

export const productsRelations = relations(products, ({ many }) => ({
  prices: many(productPrices),
  recipes: many(depotRecipes, { relationName: "recipe_product" }),
}));

export const productPricesRelations = relations(productPrices, ({ one }) => ({
  product: one(products, { fields: [productPrices.productId], references: [products.id] }),
  outlet: one(outlets, { fields: [productPrices.outletId], references: [outlets.id] }),
}));

export const specialPricesRelations = relations(specialPrices, ({ one }) => ({
  customer: one(customers, { fields: [specialPrices.customerId], references: [customers.id] }),
  product: one(products, { fields: [specialPrices.productId], references: [products.id] }),
}));

export const depotRecipesRelations = relations(depotRecipes, ({ one }) => ({
  product: one(products, { fields: [depotRecipes.productId], references: [products.id], relationName: "recipe_product" }),
  material: one(products, { fields: [depotRecipes.materialProductId], references: [products.id] }),
}));

export const trucksRelations = relations(trucks, ({ one }) => ({
  tenant: one(tenants, { fields: [trucks.tenantId], references: [tenants.id] }),
  defaultDriver: one(employees, {
    fields: [trucks.defaultDriverEmployeeId],
    references: [employees.id],
    relationName: "truck_default_driver",
  }),
  defaultHelper: one(employees, {
    fields: [trucks.defaultHelperEmployeeId],
    references: [employees.id],
    relationName: "truck_default_helper",
  }),
  gpsDevice: one(devices, { fields: [trucks.gpsDeviceId], references: [devices.id], relationName: "truck_gps_device" }),
  pool: one(poolLocations, { fields: [trucks.poolLocationId], references: [poolLocations.id] }),
}));

export const importBatchesRelations = relations(importBatches, ({ many }) => ({
  rows: many(importBatchRows),
}));

export const importBatchRowsRelations = relations(importBatchRows, ({ one }) => ({
  batch: one(importBatches, { fields: [importBatchRows.batchId], references: [importBatches.id] }),
}));

// =====================================================================================================================
// Tambahan modul M1 (agen M1 — append): harga berlaku sebelum sistem per pelanggan (dari impor data awal)
// =====================================================================================================================

/**
 * Harga air truk yang berlaku SAAT INI per pelanggan sebelum sistem (US-M1-06 KP-1 "harga saat ini per pelanggan"),
 * hasil impor data awal. Dipakai simulasi harga zona baru vs harga berlaku (US-M1-05 KP-5, K23, R14) — BUKAN harga
 * transaksi (harga transaksi hanya dari master: tarif zona + BBM atau harga khusus, BR-19). Impor ulang (mode uji)
 * menandai baris lama `is_current = false` (tanpa DELETE).
 */
export const customerLegacyPrices = pgTable(
  "customer_legacy_prices",
  {
    id: pk(),
    tenantId: tenantRef(),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => customers.id),
    /** Kosong = berlaku untuk semua alamat pelanggan. */
    addressId: uuid("address_id").references((): AnyPgColumn => customerAddresses.id),
    pricePerTrip: money("price_per_trip").notNull(),
    notes: text("notes"),
    importBatchId: uuid("import_batch_id").references((): AnyPgColumn => importBatches.id),
    isCurrent: boolean("is_current").notNull().default(true),
    supersededAt: tstz("superseded_at"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    index("customer_legacy_prices_customer_idx").on(t.customerId, t.isCurrent),
    index("customer_legacy_prices_tenant_idx").on(t.tenantId),
    check("customer_legacy_prices_price_chk", sql`${t.pricePerTrip} > 0`),
  ],
);

export const customerLegacyPricesRelations = relations(customerLegacyPrices, ({ one }) => ({
  customer: one(customers, { fields: [customerLegacyPrices.customerId], references: [customers.id] }),
  address: one(customerAddresses, { fields: [customerLegacyPrices.addressId], references: [customerAddresses.id] }),
}));
