/**
 * Seed organisasi EQUA: tenant, 10 depot + 1 toko, 2 sumber air + meter, 1 pool, karyawan semua peran + akun pengguna
 * (peran & lingkup aktif), perangkat terdaftar (ponsel truk, ponsel sumber, tablet POS, GPS), 7 truk.
 * Koordinat realistis wilayah Kabupaten Cianjur. Semua ID deterministik (`seedId`) → idempoten.
 */
import { hash } from "@node-rs/argon2";
import { and, eq, isNull } from "drizzle-orm";

import type { RoleCode, ScopeType } from "@/lib/labels";

import type { DbOrTx } from "../client";
import {
  devices,
  employees,
  outlets,
  poolLocations,
  tenants,
  trucks,
  userRoles,
  users,
  userScopes,
  waterMeters,
  waterSources,
} from "../schema";
import { EQUA_TENANT_CODE, PLAIN_SECRET_PREFIX, SEED_DEMO_PASSWORD, SEED_DEMO_PIN, SEED_TOTP_SECRETS } from "./constants";
import { seedId } from "./ids";

export const EQUA_TENANT_ID = seedId(`tenant:${EQUA_TENANT_CODE}`);

export type OutletSeed = { code: string; name: string; kind: "depot" | "store"; address: string; lat: number; lng: number };

export const OUTLET_SEEDS: OutletSeed[] = [
  { code: "D01", name: "Depot EQUA Pasir Hayam", kind: "depot", address: "Jl. Raya Bandung, Pasir Hayam, Cilaku", lat: -6.8453, lng: 107.1328 },
  { code: "D02", name: "Depot EQUA Muka", kind: "depot", address: "Jl. Siliwangi, Muka, Cianjur", lat: -6.8172, lng: 107.1428 },
  { code: "D03", name: "Depot EQUA Sabandar", kind: "depot", address: "Jl. Raya Sabandar, Karangtengah", lat: -6.8055, lng: 107.1702 },
  { code: "D04", name: "Depot EQUA Sukaluyu", kind: "depot", address: "Jl. Raya Sukaluyu, Sukaluyu", lat: -6.8187, lng: 107.2276 },
  { code: "D05", name: "Depot EQUA Warungkondang", kind: "depot", address: "Jl. Raya Warungkondang, Warungkondang", lat: -6.8756, lng: 107.1108 },
  { code: "D06", name: "Depot EQUA Cugenang", kind: "depot", address: "Jl. Raya Cugenang, Cugenang", lat: -6.7899, lng: 107.0965 },
  { code: "D07", name: "Depot EQUA Mande", kind: "depot", address: "Jl. Raya Mande, Mande", lat: -6.7753, lng: 107.2253 },
  { code: "D08", name: "Depot EQUA Ciranjang", kind: "depot", address: "Jl. Raya Ciranjang, Ciranjang", lat: -6.8231, lng: 107.2587 },
  { code: "D09", name: "Depot EQUA Cibeber", kind: "depot", address: "Jl. Raya Cibeber, Cibeber", lat: -6.8993, lng: 107.1227 },
  { code: "D10", name: "Depot EQUA Gekbrong", kind: "depot", address: "Jl. Raya Gekbrong, Gekbrong", lat: -6.8563, lng: 107.0506 },
  { code: "TK1", name: "Toko EQUA Cianjur", kind: "store", address: "Jl. Dr. Muwardi, Bojongherang, Cianjur", lat: -6.8229, lng: 107.1386 },
];

export const outletId = (code: string) => seedId(`outlet:${code}`);

export const WATER_SOURCE_SEEDS = [
  { code: "SA1", name: "Sumber Air Cugenang", address: "Kp. Pasirkampung, Cugenang", lat: -6.7712, lng: 107.0853, meterCode: "MTR-SA1-01", initialReadingL: 12_450_000 },
  { code: "SA2", name: "Sumber Air Warungkondang", address: "Kp. Cisarua, Warungkondang", lat: -6.8905, lng: 107.0921, meterCode: "MTR-SA2-01", initialReadingL: 8_730_000 },
] as const;

export const waterSourceId = (code: string) => seedId(`water_source:${code}`);

export const POOL_SEED = { code: "PL1", name: "Pool Truk EQUA Karangtengah", address: "Jl. Raya Karangtengah, Karangtengah", lat: -6.8121, lng: 107.1605 };
export const POOL_ID = seedId(`pool:${POOL_SEED.code}`);

type EmployeeSeed = {
  no: string;
  fullName: string;
  nickname: string;
  position: string;
  role: RoleCode;
  username: string;
  phone: string;
  outletCode?: string;
  /** Lingkup: kode truk / outlet / sumber air. */
  scope?: { type: "truck" | "outlet" | "water_source"; code: string };
  allowBankDeposit?: boolean;
};

const DRIVERS = ["Asep Saepudin", "Ujang Suryana", "Dede Rohmat", "Cecep Hidayat", "Iwan Setiawan", "Yayan Sopyan", "Endang Kurnia"];
const HELPERS = ["Agus Salim", "Deden Mulyana", "Rudi Hartono", "Jajang Nurjaman", "Ade Supriatna", "Ayi Rustandi", "Hendra Gunawan"];
const DEPOT_OPERATORS = [
  "Euis Komariah",
  "Imas Masitoh",
  "Rika Rahmawati",
  "Sri Mulyati",
  "Wawan Gunawan",
  "Nia Kurniasih",
  "Elis Suryani",
  "Dadan Ramdani",
  "Tati Suhartini",
  "Ikah Atikah",
];
const PRODUCTION_OPERATORS = ["Maman Suherman", "Engkos Kosasih", "Oman Abdurahman", "Tatang Sutisna", "Ujang Koswara", "Didin Wahyudin"];

function phone(n: number): string {
  return `62812${String(20_000_000 + n).padStart(8, "0")}`;
}

function firstName(fullName: string): string {
  return fullName.replace(/^H\.\s*/, "").split(" ")[0]!;
}

export const TRUCK_CODES = ["T1", "T2", "T3", "T4", "T5", "T6", "T7"] as const;

/** Karyawan untuk semua peran (7 sopir, 7 kernet, 2 dispatcher, 2 admin keuangan, 10 operator depot, 1 kasir, 6 operator produksi, 1 pemilik, 2 admin sistem, 1 akuntan). */
export const EMPLOYEE_SEEDS: EmployeeSeed[] = (() => {
  const list: EmployeeSeed[] = [];
  let n = 1;
  const push = (e: Omit<EmployeeSeed, "no" | "nickname" | "phone">) => {
    list.push({ ...e, no: `EQ-${String(n).padStart(3, "0")}`, nickname: firstName(e.fullName), phone: phone(n) });
    n++;
  };
  push({ fullName: "H. Ahmad Syarifudin", position: "Pemilik", role: "owner", username: "pemilik" });
  push({ fullName: "Lina Herlina", position: "Admin Keuangan", role: "finance_admin", username: "keuangan1" });
  push({ fullName: "Yuyun Wahyuni", position: "Admin Keuangan (cadangan)", role: "finance_admin", username: "keuangan2" });
  push({ fullName: "Rina Marlina", position: "Dispatcher", role: "dispatcher", username: "dispatcher1" });
  push({ fullName: "Neng Siti Nurhasanah", position: "Dispatcher", role: "dispatcher", username: "dispatcher2" });
  push({ fullName: "Fajar Nugraha", position: "Admin Sistem (IT)", role: "system_admin", username: "admin1" });
  push({ fullName: "Gilang Ramadhan", position: "Admin Sistem (IT)", role: "system_admin", username: "admin2" });
  push({ fullName: "Dewi Anggraeni", position: "Akuntan (pendamping)", role: "accountant", username: "akuntan" });
  DRIVERS.forEach((fullName, i) =>
    push({
      fullName,
      position: "Sopir",
      role: "driver",
      username: `sopir${i + 1}`,
      scope: { type: "truck", code: TRUCK_CODES[i]! },
      allowBankDeposit: i === 0,
    }),
  );
  HELPERS.forEach((fullName, i) =>
    push({ fullName, position: "Kernet", role: "helper", username: `kernet${i + 1}`, scope: { type: "truck", code: TRUCK_CODES[i]! } }),
  );
  DEPOT_OPERATORS.forEach((fullName, i) => {
    const code = `D${String(i + 1).padStart(2, "0")}`;
    push({
      fullName,
      position: "Operator Depot",
      role: "depot_operator",
      username: `depot${String(i + 1).padStart(2, "0")}`,
      outletCode: code,
      scope: { type: "outlet", code },
      allowBankDeposit: true,
    });
  });
  push({
    fullName: "Fitri Handayani",
    position: "Kasir Toko",
    role: "store_cashier",
    username: "kasir",
    outletCode: "TK1",
    scope: { type: "outlet", code: "TK1" },
    allowBankDeposit: true,
  });
  PRODUCTION_OPERATORS.forEach((fullName, i) =>
    push({
      fullName,
      position: "Operator Produksi",
      role: "production_operator",
      username: `produksi${i + 1}`,
      scope: { type: "water_source", code: i < 3 ? "SA1" : "SA2" },
    }),
  );
  return list;
})();

export const employeeId = (no: string) => seedId(`employee:${no}`);
export const userIdByUsername = (username: string) => seedId(`user:${username}`);
export const truckId = (code: string) => seedId(`truck:${code}`);
export const deviceId = (code: string) => seedId(`device:${code}`);

/** Truk: nopol format "F 1234 XX", kapasitas 5.000 L. */
export const TRUCK_SEEDS = TRUCK_CODES.map((code, i) => ({
  code,
  plateNumber: `F 82${String(i + 1).padStart(2, "0")} ${"N" + String.fromCharCode(65 + i)}`,
}));

const OFFICE_ROLES: RoleCode[] = ["owner", "finance_admin", "dispatcher", "system_admin", "accountant"];

export type OrgSeedResult = { usersInserted: number; employeesInserted: number };

/** Tenant pemilik EQUA (ID deterministik `EQUA_TENANT_ID`, dipakai `src/server/core/context.ts`). Idempoten. */
export async function seedEquaTenant(tx: DbOrTx): Promise<void> {
  await tx
    .insert(tenants)
    .values({ id: EQUA_TENANT_ID, code: EQUA_TENANT_CODE, name: "EQUA", kind: "owner", settings: {} })
    .onConflictDoNothing();
}

export async function seedOrganization(tx: DbOrTx): Promise<OrgSeedResult> {
  const now = new Date();

  await seedEquaTenant(tx);

  await tx
    .insert(outlets)
    .values(
      OUTLET_SEEDS.map((o) => ({
        id: outletId(o.code),
        tenantId: EQUA_TENANT_ID,
        code: o.code,
        name: o.name,
        kind: o.kind,
        address: o.address,
        lat: o.lat,
        lng: o.lng,
        storageCapacityL: o.kind === "depot" ? 5_000 : null,
        qrisEnabled: true,
      })),
    )
    .onConflictDoNothing();

  await tx
    .insert(waterSources)
    .values(
      WATER_SOURCE_SEEDS.map((s) => ({
        id: waterSourceId(s.code),
        tenantId: EQUA_TENANT_ID,
        code: s.code,
        name: s.name,
        address: s.address,
        lat: s.lat,
        lng: s.lng,
        dailyCapacityL: 50_000,
      })),
    )
    .onConflictDoNothing();

  await tx
    .insert(waterMeters)
    .values(
      WATER_SOURCE_SEEDS.map((s) => ({
        id: seedId(`water_meter:${s.meterCode}`),
        waterSourceId: waterSourceId(s.code),
        code: s.meterCode,
        name: `Meter utama ${s.name}`,
        unit: "liter" as const,
        initialReadingL: s.initialReadingL,
        installedAt: "2025-01-01",
      })),
    )
    .onConflictDoNothing();

  await tx
    .insert(poolLocations)
    .values({ id: POOL_ID, tenantId: EQUA_TENANT_ID, ...POOL_SEED })
    .onConflictDoNothing();

  const employeeRows = await tx
    .insert(employees)
    .values(
      EMPLOYEE_SEEDS.map((e) => ({
        id: employeeId(e.no),
        tenantId: EQUA_TENANT_ID,
        employeeNo: e.no,
        fullName: e.fullName,
        nickname: e.nickname,
        position: e.position,
        phone: e.phone,
        workLocation: e.outletCode ? OUTLET_SEEDS.find((o) => o.code === e.outletCode)?.name : "Kantor EQUA Cianjur",
        primaryOutletId: e.outletCode ? outletId(e.outletCode) : null,
        intendedRoles: [e.role],
        hireDate: "2025-01-01",
        allowBankDeposit: e.allowBankDeposit ?? false,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: employees.id });

  // Operator bawaan per outlet (hanya bila belum diisi → tidak mengubah data yang sudah diatur).
  for (const e of EMPLOYEE_SEEDS) {
    if (e.outletCode && (e.role === "depot_operator" || e.role === "store_cashier")) {
      await tx
        .update(outlets)
        .set({ defaultOperatorEmployeeId: employeeId(e.no) })
        .where(and(eq(outlets.id, outletId(e.outletCode)), isNull(outlets.defaultOperatorEmployeeId)));
    }
  }

  // Akun pengguna (hash dihitung sekali; semua akun demo memakai kata sandi & PIN yang sama).
  const [passwordHash, pinHash] = await Promise.all([hash(SEED_DEMO_PASSWORD), hash(SEED_DEMO_PIN)]);
  const totpSecretFor = (username: string): string | null => {
    const secret = (SEED_TOTP_SECRETS as Record<string, string>)[username];
    return secret ? `${PLAIN_SECRET_PREFIX}${secret}` : null;
  };
  const userRows = await tx
    .insert(users)
    .values(
      EMPLOYEE_SEEDS.map((e) => {
        const totp = totpSecretFor(e.username);
        return {
          id: userIdByUsername(e.username),
          tenantId: EQUA_TENANT_ID,
          employeeId: employeeId(e.no),
          username: e.username,
          passwordHash,
          passwordChangedAt: now,
          pinHash,
          pinSetAt: now,
          totpSecretEnc: totp,
          totpEnabled: totp !== null,
          totpConfirmedAt: totp ? now : null,
          status: "active" as const,
          activatedAt: now,
        };
      }),
    )
    .onConflictDoNothing()
    .returning({ id: users.id });

  await tx
    .insert(userRoles)
    .values(
      EMPLOYEE_SEEDS.map((e) => ({
        id: seedId(`user_role:${e.username}:${e.role}`),
        userId: userIdByUsername(e.username),
        role: e.role,
        status: "active" as const,
        validFrom: "2025-01-01",
        reason: "Akun awal (data demo) — disetujui bersama tanda tangan data awal (US-M10-01 KP-8).",
        grantedAt: now,
      })),
    )
    .onConflictDoNothing();

  const scopeRows = EMPLOYEE_SEEDS.flatMap((e): { username: string; scopeType: ScopeType; refId: string }[] => {
    if (e.scope) {
      const refId =
        e.scope.type === "truck"
          ? truckId(e.scope.code)
          : e.scope.type === "outlet"
            ? outletId(e.scope.code)
            : waterSourceId(e.scope.code);
      return [{ username: e.username, scopeType: e.scope.type, refId }];
    }
    if (OFFICE_ROLES.includes(e.role)) return [{ username: e.username, scopeType: "tenant" as const, refId: EQUA_TENANT_ID }];
    return [];
  });
  await tx
    .insert(userScopes)
    .values(
      scopeRows.map((s) => ({
        id: seedId(`user_scope:${s.username}:${s.scopeType}:${s.refId}`),
        userId: userIdByUsername(s.username),
        scopeType: s.scopeType,
        refId: s.refId,
        status: "active" as const,
        validFrom: "2025-01-01",
        reason: "Lingkup awal (data demo).",
      })),
    )
    .onConflictDoNothing();

  // Perangkat: ponsel truk (7 + 2 cadangan), ponsel sumber air (2), tablet POS (10 depot + 1 toko + 1 cadangan), GPS (7 + 1 cadangan).
  const holderOf = (username: string) => employeeId(EMPLOYEE_SEEDS.find((e) => e.username === username)!.no);
  const deviceRows = [
    ...TRUCK_CODES.map((code, i) => ({
      code: `HP-${code}`,
      name: `Ponsel truk ${code}`,
      kind: "phone" as const,
      truckId: truckId(code),
      holderEmployeeId: holderOf(`sopir${i + 1}`),
    })),
    { code: "HP-CAD-1", name: "Ponsel lapangan cadangan 1", kind: "phone" as const, isSpare: true },
    { code: "HP-CAD-2", name: "Ponsel lapangan cadangan 2", kind: "phone" as const, isSpare: true },
    ...WATER_SOURCE_SEEDS.map((s, i) => ({
      code: `HP-${s.code}`,
      name: `Ponsel ${s.name}`,
      kind: "phone" as const,
      waterSourceId: waterSourceId(s.code),
      holderEmployeeId: holderOf(`produksi${i * 3 + 1}`),
    })),
    ...OUTLET_SEEDS.map((o) => ({
      code: `POS-${o.code}`,
      name: `Tablet POS ${o.name}`,
      kind: "tablet" as const,
      outletId: outletId(o.code),
    })),
    { code: "POS-CAD-1", name: "Tablet POS cadangan", kind: "tablet" as const, isSpare: true },
    ...TRUCK_CODES.map((code) => ({
      code: `GPS-${code}`,
      name: `GPS truk ${code}`,
      kind: "gps" as const,
      truckId: truckId(code),
      vendor: "Vendor GPS (demo)",
      imei: `86${String(1_000_000_000_000 + TRUCK_CODES.indexOf(code)).padStart(13, "0")}`,
    })),
    { code: "GPS-CAD-1", name: "GPS cadangan", kind: "gps" as const, isSpare: true, vendor: "Vendor GPS (demo)" },
  ];
  await tx
    .insert(devices)
    .values(
      deviceRows.map((d) => ({
        id: deviceId(d.code),
        tenantId: EQUA_TENANT_ID,
        deviceCode: d.code,
        name: d.name,
        kind: d.kind,
        status: d.kind === "gps" && !("isSpare" in d && d.isSpare) ? ("active" as const) : ("registered" as const),
        isSpare: "isSpare" in d ? Boolean(d.isSpare) : false,
        holderEmployeeId: "holderEmployeeId" in d ? d.holderEmployeeId : null,
        truckId: "truckId" in d ? d.truckId : null,
        outletId: "outletId" in d ? d.outletId : null,
        waterSourceId: "waterSourceId" in d ? d.waterSourceId : null,
        vendor: "vendor" in d ? d.vendor : null,
        imei: "imei" in d ? d.imei : null,
        gpsState: d.kind === "gps" && !("isSpare" in d && d.isSpare) ? ("active" as const) : null,
        activatedAt: d.kind === "gps" && !("isSpare" in d && d.isSpare) ? now : null,
      })),
    )
    .onConflictDoNothing();

  await tx
    .insert(trucks)
    .values(
      TRUCK_SEEDS.map((t, i) => ({
        id: truckId(t.code),
        tenantId: EQUA_TENANT_ID,
        plateNumber: t.plateNumber,
        code: t.code,
        capacityL: 5_000,
        status: "active" as const,
        defaultDriverEmployeeId: holderOf(`sopir${i + 1}`),
        defaultHelperEmployeeId: holderOf(`kernet${i + 1}`),
        gpsDeviceId: deviceId(`GPS-${t.code}`),
        fieldDeviceId: deviceId(`HP-${t.code}`),
        poolLocationId: POOL_ID,
      })),
    )
    .onConflictDoNothing();

  return { usersInserted: userRows.length, employeesInserted: employeeRows.length };
}
