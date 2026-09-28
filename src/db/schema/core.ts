/**
 * Skema platform inti (BERKAS BERSAMA — hanya boleh DITAMBAH, jangan ubah/rename; docs/ARCHITECTURE.md §11).
 *
 * Isi: enum lintas modul, pembantu kolom yang merujuk tabel inti (`createdBy`, `fieldMeta`, `deactivation`), serta tabel
 * tenant/outlet, karyawan & pengguna (M10), perangkat, sesi, log akses, jejak audit, parameter, feature flag,
 * persetujuan, notifikasi, event domain, penomoran, sinkron lapangan, lampiran, ekspor, tanda tangan data awal,
 * dukungan, insiden, tinjauan akses, anonimisasi, status cadangan, delegasi, job terjadwal, dan log pesan WA.
 *
 * ATURAN IMPOR: berkas ini TIDAK BOLEH mengimpor berkas skema modul (m1…p3) — modul mengimpor core, bukan sebaliknya,
 * agar tidak terjadi siklus impor (TDZ) saat skema dimuat. Rujukan ke tabel modul memakai `refId` (tanpa FK).
 * Enum yang dipakai lebih dari satu modul didefinisikan DI SINI.
 */
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { enumValues } from "../../lib/labels";
import {
  businessDate,
  coord,
  createdAtOnly,
  dateStr,
  meters,
  money,
  pk,
  refId,
  timestamps,
  tstz,
} from "./_columns";

// =====================================================================================================================
// Enum lintas modul (nilai = src/lib/labels.ts)
// =====================================================================================================================

export const roleCodeEnum = pgEnum("role_code", enumValues("role"));
export const actorSourceEnum = pgEnum("actor_source", enumValues("actor_source"));
export const outletKindEnum = pgEnum("outlet_kind", enumValues("outlet_kind"));
export const tenantKindEnum = pgEnum("tenant_kind", enumValues("tenant_kind"));
export const profitCenterEnum = pgEnum("profit_center", enumValues("profit_center"));
export const approvalStatusEnum = pgEnum("approval_status", enumValues("approval_status"));
export const deviceStatusEnum = pgEnum("device_status", enumValues("device_status"));
export const deviceKindEnum = pgEnum("device_kind", enumValues("device_kind"));
export const gpsStateEnum = pgEnum("gps_state", enumValues("gps_state"));
export const notificationStatusEnum = pgEnum("notification_status", enumValues("notification_status"));
export const notificationSeverityEnum = pgEnum("notification_severity", enumValues("notification_severity"));
export const notificationModeEnum = pgEnum("notification_mode", enumValues("notification_mode"));
export const userStatusEnum = pgEnum("user_status", enumValues("user_status"));
export const grantStatusEnum = pgEnum("grant_status", enumValues("grant_status"));
export const scopeTypeEnum = pgEnum("scope_type", enumValues("scope_type"));
export const sessionKindEnum = pgEnum("session_kind", enumValues("session_kind"));
export const accessEventEnum = pgEnum("access_event", enumValues("access_event"));
export const syncCommandStatusEnum = pgEnum("sync_command_status", enumValues("sync_command_status"));
export const featureFlagScopeEnum = pgEnum("feature_flag_scope", enumValues("feature_flag_scope"));
export const dataSignoffGroupEnum = pgEnum("data_signoff_group", enumValues("data_signoff_group"));
export const signoffStatusEnum = pgEnum("signoff_status", enumValues("signoff_status"));
export const ticketCategoryEnum = pgEnum("ticket_category", enumValues("ticket_category"));
export const ticketStatusEnum = pgEnum("ticket_status", enumValues("ticket_status"));
export const incidentKindEnum = pgEnum("incident_kind", enumValues("incident_kind"));
export const incidentSeverityEnum = pgEnum("incident_severity", enumValues("incident_severity"));
export const incidentStatusEnum = pgEnum("incident_status", enumValues("incident_status"));
export const accessReviewStatusEnum = pgEnum("access_review_status", enumValues("access_review_status"));
export const anonymizationSubjectEnum = pgEnum("anonymization_subject", enumValues("anonymization_subject"));
export const anonymizationStatusEnum = pgEnum("anonymization_status", enumValues("anonymization_status"));
export const backupKindEnum = pgEnum("backup_kind", enumValues("backup_kind"));
export const backupStatusEnum = pgEnum("backup_status", enumValues("backup_status"));
export const jobRunStatusEnum = pgEnum("job_run_status", enumValues("job_run_status"));
export const waMessageKindEnum = pgEnum("wa_message_kind", enumValues("wa_message_kind"));
export const waMessageStatusEnum = pgEnum("wa_message_status", enumValues("wa_message_status"));
export const waProviderEnum = pgEnum("wa_provider", enumValues("wa_provider"));
export const exportFormatEnum = pgEnum("export_format", enumValues("export_format"));
/** Cara bayar — dipakai pesanan, rit, pelunasan, POS. */
export const paymentMethodEnum = pgEnum("payment_method", enumValues("payment_method"));
/** Lulus / tidak lulus — uji mutu (M8), daftar periksa mutu (P3). */
export const checkResultEnum = pgEnum("check_result", enumValues("check_result"));
/** Slot pengiriman Tahap 2 (PAR-73) — pesanan (M2), langganan pelanggan (P2). */
export const deliverySlotEnum = pgEnum("delivery_slot", enumValues("delivery_slot"));
/** Satuan lokasi pencatatan: truk / outlet (M9 periode paralel, dll.). */
export const unitTypeEnum = pgEnum("unit_type", enumValues("unit_type"));
/** Segmen pelanggan (BRD 1.1) — pelanggan (M1), tarif per segmen, parameter PAR-10. */
export const customerSegmentEnum = pgEnum("customer_segment", enumValues("customer_segment"));
/** Status harga/tarif berlaku per tanggal — M1, M7. */
export const priceStatusEnum = pgEnum("price_status", enumValues("price_status"));
/** Jenis harga produk (standar depot / umum / mitra) — M1, M6/M7. */
export const priceKindEnum = pgEnum("price_kind", enumValues("price_kind"));
/** Arah mutasi kas (masuk/keluar). */
export const cashDirectionEnum = pgEnum("cash_direction", enumValues("cash_direction"));
/** Lokasi geofence/lokasi sah (M12) & uji mutu. */
export const geofenceLocationTypeEnum = pgEnum("geofence_location_type", enumValues("geofence_location_type"));

// =====================================================================================================================
// Tenant, outlet, karyawan, pengguna
// =====================================================================================================================

/** Tenant = satu pemilik usaha (Bab 4.3). EQUA = tenant pertama; mitra depot (RL-7/Tahap 3) = tenant terpisah. */
export const tenants = pgTable(
  "tenants",
  {
    id: pk(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    kind: tenantKindEnum("kind").notNull().default("owner"),
    /** US-P3-02 KP-4: tenant menunggak beralih ke mode baca-saja setelah teguran (bukan diblokir mendadak). */
    readOnly: boolean("read_only").notNull().default(false),
    /** Pengaturan tanpa kode per tenant (US-M6-07 KP-3), mis. identitas struk. */
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    isActive: boolean("is_active").notNull().default(true),
    deactivatedAt: tstz("deactivated_at"),
    deactivationReason: text("deactivation_reason"),
    ...timestamps(),
  },
);

/** Outlet = depot atau toko di bawah satu tenant (US-M1-04 KP-1, US-M6-07). */
export const outlets = pgTable(
  "outlets",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references((): AnyPgColumn => tenants.id),
    /** Kode outlet (D01..D10, TK1) — dipakai pada nomor transaksi POS `{kode}-YYMMDD-NNNN` (D-04). */
    code: text("code").notNull(),
    name: text("name").notNull(),
    kind: outletKindEnum("kind").notNull(),
    address: text("address"),
    lat: coord("lat"),
    lng: coord("lng"),
    /** Radius geofence (m). Kosong = PAR-54. */
    geofenceRadiusM: meters("geofence_radius_m"),
    /** Kapasitas simpan air (L) — US-M1-04 KP-1, US-M6-05 KP-3. */
    storageCapacityL: integer("storage_capacity_l"),
    /** Kas awal tetap per outlet (PTB-40). Kosong = PAR-57. */
    fixedOpeningCash: money("fixed_opening_cash"),
    /** QRIS statis aktif di outlet ini (US-M6-07 KP-3, PTB-04). */
    qrisEnabled: boolean("qris_enabled").notNull().default(true),
    printerEnabled: boolean("printer_enabled").notNull().default(false),
    defaultOperatorEmployeeId: uuid("default_operator_employee_id").references((): AnyPgColumn => employees.id),
    phone: text("phone"),
    isActive: boolean("is_active").notNull().default(true),
    deactivatedAt: tstz("deactivated_at"),
    deactivationReason: text("deactivation_reason"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("outlets_tenant_code_uq").on(t.tenantId, t.code), index("outlets_tenant_idx").on(t.tenantId)],
);

/** Karyawan (US-M1-04 KP-3). Akun pengguna terikat tepat satu karyawan (BR-36). */
export const employees = pgTable(
  "employees",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references((): AnyPgColumn => tenants.id),
    employeeNo: text("employee_no").notNull(),
    fullName: text("full_name").notNull(),
    /** Nama panggilan untuk tampilan lapangan (mis. "Pak Asep"). */
    nickname: text("nickname"),
    position: text("position").notNull(),
    phone: text("phone"),
    /** Lokasi tugas (teks bebas) + outlet utama bila ada. */
    workLocation: text("work_location"),
    primaryOutletId: uuid("primary_outlet_id").references((): AnyPgColumn => outlets.id),
    /** Peran sistem yang direncanakan (BRD 4.2) — peran efektif ada di `user_roles`. */
    intendedRoles: roleCodeEnum("intended_roles").array(),
    hireDate: dateStr("hire_date"),
    /** Tanggal keluar mencabut akses hari itu (BR-37, US-M10-01 KP-5). */
    exitDate: dateStr("exit_date"),
    /** PTB-23: sopir hanya boleh setor bank dengan slip bila diizinkan pemilik per orang. */
    allowBankDeposit: boolean("allow_bank_deposit").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    deactivatedAt: tstz("deactivated_at"),
    deactivationReason: text("deactivation_reason"),
    /** Anonimisasi data pribadi (US-M10-06 KP-2). */
    anonymizedAt: tstz("anonymized_at"),
    ...timestamps(),
    createdBy: uuid("created_by").references((): AnyPgColumn => users.id),
  },
  (t) => [uniqueIndex("employees_tenant_no_uq").on(t.tenantId, t.employeeNo), index("employees_tenant_idx").on(t.tenantId)],
);

/** Pengguna — satu orang satu akun (BR-36): `employee_id` UNIQUE, wajib. */
export const users = pgTable(
  "users",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references((): AnyPgColumn => tenants.id),
    employeeId: uuid("employee_id")
      .notNull()
      .unique("users_employee_uq")
      .references((): AnyPgColumn => employees.id),
    /** Nama pengguna (disimpan huruf kecil; unik case-insensitive lewat indeks lower()). */
    username: text("username").notNull(),
    /** Hash argon2 kata sandi web kantor (≥ 10 karakter, US-M10-02 KP-4). */
    passwordHash: text("password_hash"),
    passwordChangedAt: tstz("password_changed_at"),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    /** Hash argon2 PIN 6 digit (US-M10-02 KP-3). */
    pinHash: text("pin_hash"),
    pinSetAt: tstz("pin_set_at"),
    pinFailedCount: integer("pin_failed_count").notNull().default(0),
    /** PAR-36: 5 kali salah → terkunci 15 menit. */
    pinLockedUntil: tstz("pin_locked_until"),
    /** Rahasia TOTP terenkripsi (PTB-35). Seed dev memakai awalan 'plain:' — lihat README. */
    totpSecretEnc: text("totp_secret_enc"),
    totpEnabled: boolean("totp_enabled").notNull().default(false),
    totpConfirmedAt: tstz("totp_confirmed_at"),
    status: userStatusEnum("status").notNull().default("pending_approval"),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: tstz("locked_until"),
    lastLoginAt: tstz("last_login_at"),
    /** US-M10-01 KP-8: akun baru aktif setelah disetujui pemilik. */
    approvalRequestId: uuid("approval_request_id").references((): AnyPgColumn => approvalRequests.id),
    activatedAt: tstz("activated_at"),
    deactivatedAt: tstz("deactivated_at"),
    deactivatedBy: uuid("deactivated_by").references((): AnyPgColumn => users.id),
    deactivationReason: text("deactivation_reason"),
    ...timestamps(),
    createdBy: uuid("created_by").references((): AnyPgColumn => users.id),
  },
  (t) => [
    uniqueIndex("users_username_lower_uq").on(sql`lower(${t.username})`),
    index("users_tenant_idx").on(t.tenantId),
    index("users_status_idx").on(t.status),
  ],
);

// ---------------------------------------------------------------------------------------------------------------------
// Pembantu kolom yang merujuk tabel inti. Dideklarasikan sebagai `function` (di-hoist) agar aman dipakai modul lain.
// ---------------------------------------------------------------------------------------------------------------------

/** `created_by` → users.id (pembuat transaksi; kosong = sistem). */
export function createdBy() {
  return uuid("created_by").references((): AnyPgColumn => users.id);
}

/** Rujukan ke pengguna dengan nama kolom bebas. */
export function userRef(name: string) {
  return uuid(name).references((): AnyPgColumn => users.id);
}

/** Rujukan ke karyawan dengan nama kolom bebas. */
export function employeeRef(name: string) {
  return uuid(name).references((): AnyPgColumn => employees.id);
}

/** `tenant_id` wajib → tenants.id. */
export function tenantRef() {
  return uuid("tenant_id")
    .notNull()
    .references((): AnyPgColumn => tenants.id);
}

/** Rujukan ke outlet dengan nama kolom bebas (bawaan `outlet_id`). */
export function outletRef(name = "outlet_id") {
  return uuid(name).references((): AnyPgColumn => outlets.id);
}

/** Rujukan ke permintaan persetujuan (bawaan `approval_request_id`). */
export function approvalRef(name = "approval_request_id") {
  return uuid(name).references((): AnyPgColumn => approvalRequests.id);
}

/** Rujukan ke lampiran/berkas. */
export function attachmentRef(name: string) {
  return uuid(name).references((): AnyPgColumn => attachments.id);
}

/** Rujukan ke perangkat. */
export function deviceRef(name = "device_id") {
  return uuid(name).references((): AnyPgColumn => devices.id);
}

/**
 * Metadata transaksi lapangan offline (Bab 6.4, Bab 5.3, NFR-06..08): perangkat & waktu perangkat, waktu sinkron,
 * id perintah sinkron (idempotensi), penanda "dicatat kantor" (Bab 6.1, KPI-01), "terlambat sinkron", dan jam
 * perangkat menyimpang (PAR-42).
 */
export function fieldMeta() {
  return {
    deviceId: uuid("device_id").references((): AnyPgColumn => devices.id),
    deviceTime: tstz("device_time"),
    syncedAt: tstz("synced_at"),
    /** = sync_commands.id (ID klien UUID v7) yang membuat baris ini. */
    syncCommandId: uuid("sync_command_id"),
    /** Bab 6.1: pencatatan darurat oleh Admin Keuangan — dihitung "tidak di sumber" pada KPI-01. */
    recordedByOffice: boolean("recorded_by_office").notNull().default(false),
    officeRecordReason: text("office_record_reason"),
    /** Bab 5.3: tersinkron setelah hari kasnya ditutup. */
    lateSync: boolean("late_sync").notNull().default(false),
    /** PAR-42: selisih jam perangkat vs server > 10 menit. */
    clockSkewFlagged: boolean("clock_skew_flagged").notNull().default(false),
  };
}

/** Kolom nonaktif (master tidak dihapus, Bab 6.1). */
export function deactivation() {
  return {
    isActive: boolean("is_active").notNull().default(true),
    deactivatedAt: tstz("deactivated_at"),
    deactivatedBy: uuid("deactivated_by").references((): AnyPgColumn => users.id),
    deactivationReason: text("deactivation_reason"),
  };
}

// ---------------------------------------------------------------------------------------------------------------------

/** Peran per pengguna (US-M10-01). Multi-peran lewat persetujuan pemilik dengan masa berlaku (KP-4). */
export const userRoles = pgTable(
  "user_roles",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references((): AnyPgColumn => users.id),
    role: roleCodeEnum("role").notNull(),
    status: grantStatusEnum("status").notNull().default("pending"),
    validFrom: dateStr("valid_from"),
    /** Masa berlaku (multi-peran, akuntan pendampingan PTB-11). Kosong = tanpa batas. */
    validUntil: dateStr("valid_until"),
    reason: text("reason"),
    approvalRequestId: approvalRef(),
    grantedBy: userRef("granted_by"),
    grantedAt: tstz("granted_at"),
    revokedAt: tstz("revoked_at"),
    revokedBy: userRef("revoked_by"),
    revokeReason: text("revoke_reason"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    uniqueIndex("user_roles_live_uq")
      .on(t.userId, t.role)
      .where(sql`${t.status} in ('pending', 'active')`),
    index("user_roles_user_idx").on(t.userId),
  ],
);

/**
 * Lingkup akses (US-M10-01 KP-3): truk / outlet / sumber air / tenant. `ref_id` polimorfik (tanpa FK) sesuai
 * `scope_type`. Perluasan lingkup lewat persetujuan pemilik; pengurangan berlaku seketika (status revoked).
 */
export const userScopes = pgTable(
  "user_scopes",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references((): AnyPgColumn => users.id),
    scopeType: scopeTypeEnum("scope_type").notNull(),
    refId: refId("ref_id").notNull(),
    status: grantStatusEnum("status").notNull().default("pending"),
    validFrom: dateStr("valid_from"),
    validUntil: dateStr("valid_until"),
    reason: text("reason"),
    approvalRequestId: approvalRef(),
    revokedAt: tstz("revoked_at"),
    revokedBy: userRef("revoked_by"),
    revokeReason: text("revoke_reason"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    uniqueIndex("user_scopes_live_uq")
      .on(t.userId, t.scopeType, t.refId)
      .where(sql`${t.status} in ('pending', 'active')`),
    index("user_scopes_ref_idx").on(t.scopeType, t.refId),
  ],
);

/**
 * Perangkat terdaftar: ponsel/tablet lapangan & POS, serta perangkat GPS truk (US-M1-03 KP-4, US-M10-02, US-M12-08).
 * Penugasan ke truk/sumber air disimpan sebagai `truck_id`/`water_source_id` tanpa FK (tabel ada di m1-master);
 * sisi truk menyimpan `trucks.gps_device_id` / `trucks.field_device_id` (ber-FK).
 */
export const devices = pgTable(
  "devices",
  {
    id: pk(),
    tenantId: tenantRef(),
    /** Pengenal unik perangkat (label aset / IMEI / nomor seri). */
    deviceCode: text("device_code").notNull().unique(),
    name: text("name").notNull(),
    kind: deviceKindEnum("kind").notNull(),
    status: deviceStatusEnum("status").notNull().default("registered"),
    /** Perangkat cadangan (US-M10-02 KP-2; 7.10.6): boleh dipakai pengguna selain pemegang terdaftar. */
    isSpare: boolean("is_spare").notNull().default(false),
    holderEmployeeId: employeeRef("holder_employee_id"),
    truckId: refId("truck_id"),
    outletId: outletRef(),
    waterSourceId: refId("water_source_id"),
    /** Kode aktivasi 8 karakter (hash) berlaku 24 jam (ARCHITECTURE §6). */
    activationCodeHash: text("activation_code_hash"),
    activationExpiresAt: tstz("activation_expires_at"),
    /** Hash secret perangkat (token perangkat JWT ditandatangani dengan secret ini). */
    secretHash: text("secret_hash"),
    activatedAt: tstz("activated_at"),
    activatedBy: userRef("activated_by"),
    appVersion: text("app_version"),
    lastSyncAt: tstz("last_sync_at"),
    lastSeenAt: tstz("last_seen_at"),
    lastUserId: userRef("last_user_id"),
    /** Laporan kesehatan perangkat (US-M10-07 KP-1). */
    reportedQueueCount: integer("reported_queue_count"),
    batteryPct: smallint("battery_pct"),
    blockedAt: tstz("blocked_at"),
    blockedBy: userRef("blocked_by"),
    blockedReason: text("blocked_reason"),
    wipeRequestedAt: tstz("wipe_requested_at"),
    wipedAt: tstz("wiped_at"),
    // --- khusus perangkat GPS (US-M12-01, US-M12-08; "gps_devices_status") ---
    vendor: text("vendor"),
    imei: text("imei"),
    firmwareVersion: text("firmware_version"),
    gpsState: gpsStateEnum("gps_state"),
    gpsStateSince: tstz("gps_state_since"),
    gpsLastPositionAt: tstz("gps_last_position_at"),
    gpsPowerConnected: boolean("gps_power_connected"),
    notes: text("notes"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("devices_tenant_kind_idx").on(t.tenantId, t.kind), index("devices_status_idx").on(t.status)],
);

/** Riwayat per perangkat: pengguna & waktu pemakaian, login gagal, sinkron, versi (US-M10-02 KP-7). */
export const deviceUsageLogs = pgTable(
  "device_usage_logs",
  {
    id: pk(),
    deviceId: uuid("device_id")
      .notNull()
      .references((): AnyPgColumn => devices.id),
    userId: userRef("user_id"),
    /** login | logout | sync | pin_failed | health_report | lock | wipe | ... */
    event: text("event").notNull(),
    occurredAt: tstz("occurred_at").notNull().defaultNow(),
    appVersion: text("app_version"),
    queueCount: integer("queue_count"),
    batteryPct: smallint("battery_pct"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    ...createdAtOnly(),
  },
  (t) => [index("device_usage_logs_device_idx").on(t.deviceId, t.occurredAt)],
);

/** Sesi login (tabel teknis — boleh dihapus). Token disimpan sebagai hash; cookie `equa_session`. */
export const sessions = pgTable(
  "sessions",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references((): AnyPgColumn => users.id),
    kind: sessionKindEnum("kind").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    deviceId: deviceRef(),
    /** 2FA terverifikasi (sesi web peran berisiko wajib TOTP sebelum dipakai). */
    totpVerifiedAt: tstz("totp_verified_at"),
    lastActiveAt: tstz("last_active_at").notNull().defaultNow(),
    /** Batas absolut (PAR-46: maksimal 12 jam). */
    expiresAt: tstz("expires_at").notNull(),
    revokedAt: tstz("revoked_at"),
    revokeReason: text("revoke_reason"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    ...createdAtOnly(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** Log akses (US-M10-05 KP-4; retensi PAR-29 1 tahun). Append-only: trigger menolak UPDATE/DELETE. */
export const accessLogs = pgTable(
  "access_logs",
  {
    id: pk(),
    tenantId: uuid("tenant_id").references((): AnyPgColumn => tenants.id),
    occurredAt: tstz("occurred_at").notNull().defaultNow(),
    event: accessEventEnum("event").notNull(),
    success: boolean("success").notNull().default(true),
    userId: userRef("user_id"),
    usernameAttempted: text("username_attempted"),
    deviceId: deviceRef(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    /** Izin yang diminta / aturan pemisahan tugas yang dilanggar (US-M10-03 KP-2). */
    permission: text("permission"),
    rule: text("rule"),
    reason: text("reason"),
    objectType: text("object_type"),
    objectId: text("object_id"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    ...createdAtOnly(),
  },
  (t) => [
    index("access_logs_user_idx").on(t.userId, t.occurredAt),
    index("access_logs_event_idx").on(t.event, t.occurredAt),
  ],
);

/**
 * Jejak audit (FR-M10-02, NFR-11, US-M10-05). Append-only (trigger menolak UPDATE/DELETE) dengan hash berantai:
 * `hash = sha256(prev_hash || isi baris kanonik)`; urutan = `seq`.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: pk(),
    seq: bigserial("seq", { mode: "number" }).notNull().unique("audit_logs_seq_uq"),
    tenantId: uuid("tenant_id").references((): AnyPgColumn => tenants.id),
    /** Waktu server. */
    serverTime: tstz("server_time").notNull().defaultNow(),
    /** Waktu perangkat (aksi lapangan). */
    deviceTime: tstz("device_time"),
    actorUserId: userRef("actor_user_id"),
    actorEmployeeId: employeeRef("actor_employee_id"),
    actorRoles: roleCodeEnum("actor_roles").array(),
    actorDeviceId: deviceRef("actor_device_id"),
    source: actorSourceEnum("source").notNull(),
    objectType: text("object_type").notNull(),
    objectId: text("object_id").notNull(),
    /** create | update | approve | reject | reverse | deactivate | void | close | lock | reopen | ... */
    action: text("action").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    /** Aturan pemicu untuk tindakan otomatis sistem (US-M10-05 KP-5), mis. "BR-03". */
    rule: text("rule"),
    businessDate: businessDate(),
    prevHash: text("prev_hash"),
    hash: text("hash").notNull(),
  },
  (t) => [
    index("audit_logs_object_idx").on(t.objectType, t.objectId),
    index("audit_logs_actor_idx").on(t.actorUserId, t.serverTime),
    index("audit_logs_time_idx").on(t.serverTime),
  ],
);

/**
 * Parameter Lampiran B (PAR-01..PAR-89) & pengaturan lain (mis. `company.identity`), berriwayat per `effective_from`.
 * Lingkup opsional per tenant/outlet (US-M6-07 KP-3). Perubahan hanya oleh pemilik, berjejak (6.2b).
 * `params.get(tx, key, date)` = baris dengan effective_from ≤ date terbaru (paling spesifik: outlet > tenant > global).
 */
export const parameters = pgTable(
  "parameters",
  {
    id: pk(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** Nilai terstruktur, mis. `{ "amount": 50000 }`, `{ "time": "15:00" }`. */
    value: jsonb("value").notNull(),
    unit: text("unit"),
    /** Rujukan PRD/BRD (mis. "BR-09, K12"). */
    reference: text("reference"),
    description: text("description"),
    effectiveFrom: dateStr("effective_from").notNull(),
    tenantId: uuid("tenant_id").references((): AnyPgColumn => tenants.id),
    outletId: outletRef(),
    reason: text("reason"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    // Satu nilai per (kunci, lingkup, tanggal berlaku). Setara UNIQUE NULLS NOT DISTINCT, dipecah menjadi indeks unik
    // parsial per lingkup (global / tenant / outlet) agar round-trip drizzle-kit push stabil.
    uniqueIndex("parameters_global_uq")
      .on(t.key, t.effectiveFrom)
      .where(sql`${t.tenantId} is null and ${t.outletId} is null`),
    uniqueIndex("parameters_tenant_uq")
      .on(t.key, t.tenantId, t.effectiveFrom)
      .where(sql`${t.tenantId} is not null and ${t.outletId} is null`),
    uniqueIndex("parameters_outlet_uq")
      .on(t.key, t.outletId, t.effectiveFrom)
      .where(sql`${t.outletId} is not null`),
    index("parameters_key_idx").on(t.key, t.effectiveFrom),
  ],
);

/** Feature flag per global/tenant/outlet/truk (PRD 2.1; D-02 `phase2.customer_app`, `phase3.partner_portal`). */
export const featureFlags = pgTable(
  "feature_flags",
  {
    id: pk(),
    key: text("key").notNull(),
    scopeType: featureFlagScopeEnum("scope_type").notNull().default("global"),
    scopeRefId: refId("scope_ref_id"),
    enabled: boolean("enabled").notNull().default(false),
    description: text("description"),
    reason: text("reason"),
    ...timestamps(),
    updatedBy: userRef("updated_by"),
  },
  (t) => [
    uniqueIndex("feature_flags_global_uq")
      .on(t.key, t.scopeType)
      .where(sql`${t.scopeRefId} is null`),
    uniqueIndex("feature_flags_scoped_uq")
      .on(t.key, t.scopeType, t.scopeRefId)
      .where(sql`${t.scopeRefId} is not null`),
  ],
);

/**
 * Permintaan persetujuan (Bab 6.2a, US-M10-04). `type` = teks (daftar di labels `approval_type`), handler per jenis
 * di registri modul. Pemohon ≠ penyetuju (FR-M10-03). Nomor `A-YY-NNNNNN` (D-04).
 */
export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: pk(),
    tenantId: tenantRef(),
    number: text("number").notNull().unique(),
    type: text("type").notNull(),
    status: approvalStatusEnum("status").notNull().default("submitted"),
    requesterUserId: uuid("requester_user_id")
      .notNull()
      .references((): AnyPgColumn => users.id),
    requesterRole: roleCodeEnum("requester_role"),
    /** Peran penyetuju (Tahap 1: pemilik, kecuali `field_payment_to_credit` → dispatcher). */
    approverRole: roleCodeEnum("approver_role").notNull().default("owner"),
    objectType: text("object_type").notNull(),
    objectId: text("object_id").notNull(),
    /** Nilai rupiah terkait (selisih, void, jurnal...). */
    amount: money("amount"),
    reason: text("reason").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    businessDate: businessDate(),
    deadlineAt: tstz("deadline_at"),
    /** Penanda lewat tenggat & pengingat (US-M10-04 KP-4). */
    overdueAt: tstz("overdue_at"),
    decidedBy: userRef("decided_by"),
    decidedAt: tstz("decided_at"),
    decisionReason: text("decision_reason"),
    /** Keputusan lewat delegasi (PTB-32, nonaktif bawaan). */
    delegationId: uuid("delegation_id").references((): AnyPgColumn => delegations.id),
    expiredAt: tstz("expired_at"),
    cancelledAt: tstz("cancelled_at"),
    cancelReason: text("cancel_reason"),
    /** Efek keputusan pada objek sumber (dicatat handler). */
    outcome: jsonb("outcome").$type<Record<string, unknown>>(),
    ...timestamps(),
  },
  (t) => [
    index("approval_requests_status_idx").on(t.status, t.approverRole, t.deadlineAt),
    index("approval_requests_object_idx").on(t.objectType, t.objectId),
    index("approval_requests_requester_idx").on(t.requesterUserId),
  ],
);

/** Pendelegasian persetujuan (PTB-32; bawaan tidak ada — feature flag `approvals.delegation`). */
export const delegations = pgTable(
  "delegations",
  {
    id: pk(),
    tenantId: tenantRef(),
    delegatorUserId: uuid("delegator_user_id")
      .notNull()
      .references((): AnyPgColumn => users.id),
    delegateUserId: uuid("delegate_user_id")
      .notNull()
      .references((): AnyPgColumn => users.id),
    /** Per jenis persetujuan (US-M10-04 KP-5). */
    approvalType: text("approval_type").notNull(),
    validFrom: tstz("valid_from").notNull(),
    validUntil: tstz("valid_until").notNull(),
    reason: text("reason").notNull(),
    revokedAt: tstz("revoked_at"),
    revokedBy: userRef("revoked_by"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("delegations_delegate_idx").on(t.delegateUserId, t.validUntil)],
);

/** Notifikasi (Bab 6.3, US-M9-04 KP-1). Tidak dihapus; status berubah. */
export const notifications = pgTable(
  "notifications",
  {
    id: pk(),
    tenantId: tenantRef(),
    recipientUserId: uuid("recipient_user_id")
      .notNull()
      .references((): AnyPgColumn => users.id),
    /** Jenis peristiwa (kunci katalog 6.3), mis. `discrepancy.over_threshold`. */
    event: text("event").notNull(),
    severity: notificationSeverityEnum("severity").notNull().default("normal"),
    title: text("title").notNull(),
    body: text("body"),
    objectType: text("object_type"),
    objectId: text("object_id"),
    /** Nilai yang disebut (rupiah/liter/…) — tampilan bebas. */
    valueAmount: money("value_amount"),
    valueText: text("value_text"),
    deadlineAt: tstz("deadline_at"),
    link: text("link"),
    status: notificationStatusEnum("status").notNull().default("new"),
    readAt: tstz("read_at"),
    actionedAt: tstz("actioned_at"),
    doneAt: tstz("done_at"),
    pushedAt: tstz("pushed_at"),
    emailedAt: tstz("emailed_at"),
    /** Kunci pengelompokan/deduplikasi. */
    groupKey: text("group_key"),
    ...timestamps(),
  },
  (t) => [
    index("notifications_recipient_idx").on(t.recipientUserId, t.status, t.createdAt),
    index("notifications_object_idx").on(t.objectType, t.objectId),
  ],
);

/** Preferensi notifikasi per pengguna per jenis (US-M9-04 KP-3; kritis tidak dapat dimatikan). */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references((): AnyPgColumn => users.id),
    event: text("event").notNull(),
    mode: notificationModeEnum("mode").notNull().default("immediate"),
    /** Jam tenang pribadi (bawaan PAR-56). */
    quietStart: time("quiet_start"),
    quietEnd: time("quiet_end"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("notification_preferences_user_event_uq").on(t.userId, t.event)],
);

/** Langganan Web Push (VAPID) — tabel teknis, boleh dihapus. */
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: pk(),
  userId: uuid("user_id")
    .notNull()
    .references((): AnyPgColumn => users.id),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  lastUsedAt: tstz("last_used_at"),
  revokedAt: tstz("revoked_at"),
  ...createdAtOnly(),
});

/** Event domain (ARCHITECTURE §8). Append-only (trigger menolak UPDATE/DELETE). */
export const domainEvents = pgTable(
  "domain_events",
  {
    id: pk(),
    seq: bigserial("seq", { mode: "number" }).notNull().unique("domain_events_seq_uq"),
    tenantId: uuid("tenant_id").references((): AnyPgColumn => tenants.id),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    occurredAt: tstz("occurred_at").notNull().defaultNow(),
    businessDate: businessDate(),
    actorUserId: userRef("actor_user_id"),
    source: actorSourceEnum("source"),
    objectType: text("object_type"),
    objectId: text("object_id"),
  },
  (t) => [index("domain_events_type_idx").on(t.type, t.occurredAt), index("domain_events_object_idx").on(t.objectType, t.objectId)],
);

/** Penomoran dokumen per jenis + lingkup (tahun / outlet+tanggal); baris dikunci saat `nextNumber` (D-04). */
export const documentSequences = pgTable(
  "document_sequences",
  {
    id: pk(),
    /** order | trip | invoice | credit_note | pos_sale | deposit | journal | approval | purchase_receipt | ... */
    kind: text("kind").notNull(),
    /** Mis. '27' (tahun), '2709' (tahun-bulan jurnal), 'D01-270926' (POS). */
    scopeKey: text("scope_key").notNull(),
    lastValue: bigint("last_value", { mode: "number" }).notNull().default(0),
    ...timestamps(),
  },
  (t) => [uniqueIndex("document_sequences_kind_scope_uq").on(t.kind, t.scopeKey)],
);

/** Perintah sinkron lapangan — PK = ID klien (UUID v7) → idempotensi (ARCHITECTURE §7). */
export const syncCommands = pgTable(
  "sync_commands",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").references((): AnyPgColumn => tenants.id),
    deviceId: deviceRef(),
    userId: userRef("user_id"),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    deviceTime: tstz("device_time"),
    businessDate: businessDate(),
    receivedAt: tstz("received_at").notNull().defaultNow(),
    processedAt: tstz("processed_at"),
    status: syncCommandStatusEnum("status").notNull(),
    result: jsonb("result"),
    /** Alasan penolakan/konflik (Bahasa Indonesia). */
    message: text("message"),
    objectType: text("object_type"),
    objectId: text("object_id"),
    clockSkewMs: integer("clock_skew_ms"),
    ...createdAtOnly(),
  },
  (t) => [index("sync_commands_device_idx").on(t.deviceId, t.receivedAt), index("sync_commands_status_idx").on(t.status)],
);

/** Lampiran/berkas (foto bukti kirim, meter, nota, slip, perjanjian…). PK boleh ID klien (unggah idempoten). */
export const attachments = pgTable(
  "attachments",
  {
    id: pk(),
    tenantId: uuid("tenant_id").references((): AnyPgColumn => tenants.id),
    /** Kunci penyimpanan (Vercel Blob pathname / jalur lokal). */
    storageKey: text("storage_key").notNull(),
    url: text("url"),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256"),
    /** delivery_photo | signature | meter_photo | receipt_note | transfer_proof | deposit_slip | agreement | ... */
    kind: text("kind").notNull(),
    originalName: text("original_name"),
    objectType: text("object_type"),
    objectId: text("object_id"),
    capturedAt: tstz("captured_at"),
    lat: coord("lat"),
    lng: coord("lng"),
    uploadedBy: userRef("uploaded_by"),
    deviceId: deviceRef(),
    /** Retensi foto: dipindah ke arsip setelah 2 tahun (PAR-29), tetap dapat dibuka. */
    archivedAt: tstz("archived_at"),
    ...timestamps(),
  },
  (t) => [index("attachments_object_idx").on(t.objectType, t.objectId)],
);

/** Log ekspor (US-M9-03 KP-2, BR-39: data pribadi hanya pemilik/Admin Keuangan + tujuan). */
export const exportLogs = pgTable(
  "export_logs",
  {
    id: pk(),
    tenantId: uuid("tenant_id").references((): AnyPgColumn => tenants.id),
    userId: uuid("user_id")
      .notNull()
      .references((): AnyPgColumn => users.id),
    reportKey: text("report_key").notNull(),
    format: exportFormatEnum("format").notNull(),
    filters: jsonb("filters").$type<Record<string, unknown>>(),
    containsPersonalData: boolean("contains_personal_data").notNull().default(false),
    purpose: text("purpose"),
    rowCount: integer("row_count"),
    /** Laporan Final menghasilkan berkas identik saat diekspor ulang (US-M9-03 KP-4). */
    fileSha256: text("file_sha256"),
    ...createdAtOnly(),
  },
  (t) => [index("export_logs_user_idx").on(t.userId, t.createdAt)],
);

/** Tanda tangan data awal per kelompok (NFR-34, Bab 11.6). */
export const dataSignoffs = pgTable(
  "data_signoffs",
  {
    id: pk(),
    tenantId: tenantRef(),
    group: dataSignoffGroupEnum("group").notNull(),
    title: text("title").notNull(),
    /** Ringkasan yang ditandatangani (jumlah per segmen/zona, total saldo, daftar Tempo migrasi, …). */
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull(),
    status: signoffStatusEnum("status").notNull().default("draft"),
    importBatchId: refId("import_batch_id"),
    signedBy: userRef("signed_by"),
    signedAt: tstz("signed_at"),
    /** Aset tetap & bagan akun juga disahkan akuntan (Bab 11.6). */
    accountantSignedBy: userRef("accountant_signed_by"),
    accountantSignedAt: tstz("accountant_signed_at"),
    attachmentId: attachmentRef("attachment_id"),
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => dataSignoffs.id),
    notes: text("notes"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("data_signoffs_group_idx").on(t.tenantId, t.group)],
);

/** Laporan kendala aplikasi & masukan lapangan (US-M10-07 KP-3; tenggat jawaban PAR-87). */
export const supportTickets = pgTable(
  "support_tickets",
  {
    id: pk(),
    tenantId: tenantRef(),
    category: ticketCategoryEnum("category").notNull().default("app_issue"),
    reporterUserId: uuid("reporter_user_id")
      .notNull()
      .references((): AnyPgColumn => users.id),
    deviceId: deviceRef(),
    subject: text("subject").notNull(),
    description: text("description").notNull(),
    appVersion: text("app_version"),
    /** Status sinkron otomatis saat melapor (antrean, sinkron terakhir). */
    syncStatus: jsonb("sync_status").$type<Record<string, unknown>>(),
    status: ticketStatusEnum("status").notNull().default("received"),
    answer: text("answer"),
    answeredBy: userRef("answered_by"),
    answeredAt: tstz("answered_at"),
    doneAt: tstz("done_at"),
    dueAt: tstz("due_at"),
    ...timestamps(),
  },
  (t) => [index("support_tickets_status_idx").on(t.status, t.createdAt)],
);

/** Insiden (NFR-28, NFR-31): tanggap ≤ 30 menit, pulih ≤ 4 jam. */
export const incidents = pgTable(
  "incidents",
  {
    id: pk(),
    tenantId: uuid("tenant_id").references((): AnyPgColumn => tenants.id),
    kind: incidentKindEnum("kind").notNull(),
    severity: incidentSeverityEnum("severity").notNull().default("major"),
    status: incidentStatusEnum("status").notNull().default("open"),
    title: text("title").notNull(),
    description: text("description"),
    objectType: text("object_type"),
    objectId: text("object_id"),
    detectedAt: tstz("detected_at").notNull().defaultNow(),
    acknowledgedAt: tstz("acknowledged_at"),
    acknowledgedBy: userRef("acknowledged_by"),
    resolvedAt: tstz("resolved_at"),
    resolvedBy: userRef("resolved_by"),
    resolution: text("resolution"),
    ...timestamps(),
  },
  (t) => [index("incidents_status_idx").on(t.status, t.detectedAt)],
);

/** Tinjauan hak akses kuartalan (US-M10-01 KP-6, PAR-47). */
export const accessReviews = pgTable(
  "access_reviews",
  {
    id: pk(),
    tenantId: tenantRef(),
    /** Mis. '2026-Q4'. */
    quarter: text("quarter").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    /** Pengguna tanpa login > 60 hari, multi-peran lewat masa berlaku. */
    flagged: jsonb("flagged").$type<Record<string, unknown>>(),
    status: accessReviewStatusEnum("status").notNull().default("draft"),
    reviewedBy: userRef("reviewed_by"),
    reviewedAt: tstz("reviewed_at"),
    notes: text("notes"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("access_reviews_tenant_quarter_uq").on(t.tenantId, t.quarter)],
);

/** Permintaan anonimisasi data pribadi (US-M10-06 KP-2; PTB-36: tunda bila piutang terbuka). */
export const anonymizationRequests = pgTable(
  "anonymization_requests",
  {
    id: pk(),
    tenantId: tenantRef(),
    subjectType: anonymizationSubjectEnum("subject_type").notNull(),
    subjectId: refId("subject_id").notNull(),
    reason: text("reason").notNull(),
    status: anonymizationStatusEnum("status").notNull().default("submitted"),
    approvalRequestId: uuid("approval_request_id"),
    blockedReason: text("blocked_reason"),
    executedAt: tstz("executed_at"),
    executedBy: userRef("executed_by"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    index("anonymization_requests_subject_idx").on(t.subjectType, t.subjectId),
    foreignKey({
      name: "anonymization_requests_approval_fk",
      columns: [t.approvalRequestId],
      foreignColumns: [approvalRequests.id],
    }),
  ],
);

/** Status cadangan & uji pemulihan (US-M10-06 KP-4, NFR-13/14). */
export const backupStatusLogs = pgTable(
  "backup_status_logs",
  {
    id: pk(),
    kind: backupKindEnum("kind").notNull(),
    status: backupStatusEnum("status").notNull(),
    startedAt: tstz("started_at").notNull(),
    finishedAt: tstz("finished_at"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    location: text("location"),
    /** Uji pemulihan: RPO/RTO tercapai (menit). */
    rpoMinutes: integer("rpo_minutes"),
    rtoMinutes: integer("rto_minutes"),
    notes: text("notes"),
    recordedBy: userRef("recorded_by"),
    ...createdAtOnly(),
  },
  (t) => [index("backup_status_logs_kind_idx").on(t.kind, t.startedAt)],
);

/** Catatan eksekusi job terjadwal (idempoten per job + run_key) — tabel teknis. */
export const jobRuns = pgTable(
  "job_runs",
  {
    id: pk(),
    jobKey: text("job_key").notNull(),
    /** Kunci jalan, mis. tanggal bisnis '2026-09-27' atau '2026-09'. */
    runKey: text("run_key").notNull(),
    status: jobRunStatusEnum("status").notNull().default("running"),
    startedAt: tstz("started_at").notNull().defaultNow(),
    finishedAt: tstz("finished_at"),
    attempts: integer("attempts").notNull().default(1),
    result: jsonb("result"),
    error: text("error"),
    ...createdAtOnly(),
  },
  (t) => [uniqueIndex("job_runs_job_run_uq").on(t.jobKey, t.runKey)],
);

/**
 * Log pesan WhatsApp (K21, NFR-20): versi tautan mencatat "dibuka" (tanpa klaim terkirim); Cloud API mencatat
 * terkirim/terbaca. `template_id` & `customer_id` merujuk tabel M1 tanpa FK (aturan impor core).
 */
export const waMessageLogs = pgTable(
  "wa_message_logs",
  {
    id: pk(),
    tenantId: tenantRef(),
    kind: waMessageKindEnum("kind").notNull(),
    templateId: refId("template_id"),
    customerId: refId("customer_id"),
    toPhone: text("to_phone").notNull(),
    renderedText: text("rendered_text").notNull(),
    objectType: text("object_type"),
    objectId: text("object_id"),
    provider: waProviderEnum("provider").notNull().default("link"),
    status: waMessageStatusEnum("status").notNull().default("link_opened"),
    openedAt: tstz("opened_at"),
    openedBy: userRef("opened_by"),
    providerMessageId: text("provider_message_id"),
    sentAt: tstz("sent_at"),
    deliveredAt: tstz("delivered_at"),
    readAt: tstz("read_at"),
    error: text("error"),
    ...timestamps(),
  },
  (t) => [index("wa_message_logs_object_idx").on(t.objectType, t.objectId), index("wa_message_logs_customer_idx").on(t.customerId)],
);

// =====================================================================================================================
// Relasi antar-tabel inti (relasi ke tabel modul didefinisikan di berkas modul pemilik tabel anak)
// =====================================================================================================================

export const tenantsRelations = relations(tenants, ({ many }) => ({
  outlets: many(outlets),
  employees: many(employees),
}));

export const outletsRelations = relations(outlets, ({ one }) => ({
  tenant: one(tenants, { fields: [outlets.tenantId], references: [tenants.id] }),
  defaultOperator: one(employees, { fields: [outlets.defaultOperatorEmployeeId], references: [employees.id] }),
}));

export const employeesRelations = relations(employees, ({ one }) => ({
  tenant: one(tenants, { fields: [employees.tenantId], references: [tenants.id] }),
  primaryOutlet: one(outlets, { fields: [employees.primaryOutletId], references: [outlets.id] }),
  user: one(users),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  employee: one(employees, { fields: [users.employeeId], references: [employees.id] }),
  tenant: one(tenants, { fields: [users.tenantId], references: [tenants.id] }),
  roles: many(userRoles),
  scopes: many(userScopes),
  sessions: many(sessions),
}));

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, { fields: [userRoles.userId], references: [users.id] }),
  approvalRequest: one(approvalRequests, { fields: [userRoles.approvalRequestId], references: [approvalRequests.id] }),
}));

export const userScopesRelations = relations(userScopes, ({ one }) => ({
  user: one(users, { fields: [userScopes.userId], references: [users.id] }),
}));

export const devicesRelations = relations(devices, ({ one, many }) => ({
  tenant: one(tenants, { fields: [devices.tenantId], references: [tenants.id] }),
  holder: one(employees, { fields: [devices.holderEmployeeId], references: [employees.id] }),
  outlet: one(outlets, { fields: [devices.outletId], references: [outlets.id] }),
  usageLogs: many(deviceUsageLogs),
}));

export const deviceUsageLogsRelations = relations(deviceUsageLogs, ({ one }) => ({
  device: one(devices, { fields: [deviceUsageLogs.deviceId], references: [devices.id] }),
  user: one(users, { fields: [deviceUsageLogs.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
  device: one(devices, { fields: [sessions.deviceId], references: [devices.id] }),
}));

export const approvalRequestsRelations = relations(approvalRequests, ({ one }) => ({
  requester: one(users, {
    fields: [approvalRequests.requesterUserId],
    references: [users.id],
    relationName: "approval_requester",
  }),
  decider: one(users, { fields: [approvalRequests.decidedBy], references: [users.id], relationName: "approval_decider" }),
  delegation: one(delegations, { fields: [approvalRequests.delegationId], references: [delegations.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  recipient: one(users, { fields: [notifications.recipientUserId], references: [users.id] }),
}));

export const dataSignoffsRelations = relations(dataSignoffs, ({ one }) => ({
  signer: one(users, { fields: [dataSignoffs.signedBy], references: [users.id] }),
}));

// =====================================================================================================================
// Tambahan F3c (autentikasi lapangan) — hanya tambah.
// =====================================================================================================================

/**
 * Kode aktivasi akun lapangan sekali pakai (US-M10-02 KP-3): admin sistem membuat kode untuk pengguna lapangan
 * ("di hadapan admin sistem"); pengguna memasukkannya di perangkat terdaftar lalu menetapkan PIN 6 digit sendiri.
 * Dipakai juga untuk reset PIN (`purpose = 'reset'`). Kode disimpan sebagai HMAC (bukan teks), berlaku terbatas,
 * sekali pakai; tidak pernah dihapus (dicabut/terpakai ditandai).
 */
export const pinEnrollments = pgTable(
  "pin_enrollments",
  {
    id: pk(),
    tenantId: tenantRef(),
    userId: uuid("user_id")
      .notNull()
      .references((): AnyPgColumn => users.id),
    /** initial | reset */
    purpose: text("purpose").notNull().default("initial"),
    codeHash: text("code_hash").notNull(),
    expiresAt: tstz("expires_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    usedAt: tstz("used_at"),
    usedDeviceId: deviceRef("used_device_id"),
    revokedAt: tstz("revoked_at"),
    ...createdAtOnly(),
    createdBy: createdBy(),
  },
  (t) => [index("pin_enrollments_code_idx").on(t.codeHash), index("pin_enrollments_user_idx").on(t.userId)],
);
