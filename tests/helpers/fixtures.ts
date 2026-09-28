/**
 * Pembuat data uji tingkat MODUL (docs/ARCHITECTURE.md §10) — pelanggan, truk + kru, pesanan, rit terjadwal, shift,
 * setoran. Menulis baris nyata langsung ke DB (tanpa lapisan layanan) sesuai hardening (tenant_id anak diisi dari
 * induk, FK komposit tenant, tanpa DELETE). Semua fungsi menerima `db | tx` dan TANGGAL eksplisit (bawaan hari WIB
 * saat ini) — jangan bergantung tanggal tetap.
 *
 * ```ts
 * const t = useTestDb({ seed: true });
 * const date = today();
 * const cust = await createCustomer(t.db, { segment: "hotel", creditStatus: "credit", withAddress: true });
 * const truck = await createTruck(t.db, { code: "TX1" });
 * await assignCrew(t.db, { truckId: truck.id, driverEmployeeId: sopir.employeeId, date });
 * const order = await createOrder(t.db, { customerId: cust.id, addressId: cust.addressId!, date });
 * const trip = await createScheduledTrip(t.db, { order, truckId: truck.id, date });
 * ```
 * Pengguna per peran: `createTestUser` (./factories). Perangkat + perintah sinkron bertanda tangan: ./field.
 */
import { and, eq } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import { crewAssignments, crewRosters, customerAddresses, customers, dailySchedules, deposits, orders, shifts, trips, trucks } from "@/db/schema";
import { EQUA_TENANT_ID, productId, userIdByUsername } from "@/db/seed";
import type { EnumValue } from "@/lib/labels";
import { toBusinessDate } from "@/lib/time";

import { uniqueSeq } from "./db-fixtures";

/** Tanggal bisnis WIB hari ini (untuk argumen `date`). */
export function today(now: Date = new Date()): string {
  return toBusinessDate(now);
}

export type CustomerFixture = { id: string; code: string; addressId: string | null; tenantId: string };

export async function createCustomer(
  db: DbOrTx,
  opts: {
    tenantId?: string;
    name?: string;
    segment?: EnumValue<"customer_segment">;
    creditStatus?: EnumValue<"credit_status">;
    creditLimit?: number;
    /** `tariff_zones.id` untuk alamat (mis. `tariffZoneId("Z1")` dari @/db/seed). */
    zoneId?: string | null;
    withAddress?: boolean;
    lat?: number;
    lng?: number;
  } = {},
): Promise<CustomerFixture> {
  const tenantId = opts.tenantId ?? EQUA_TENANT_ID;
  const n = uniqueSeq();
  const code = `UJI-${n}`;
  const [row] = await db
    .insert(customers)
    .values({
      tenantId,
      code,
      name: opts.name ?? `Pelanggan uji ${n}`,
      segment: opts.segment ?? "household",
      waPhone: `62812${String(n).padStart(8, "0")}`,
      creditStatus: opts.creditStatus ?? "cash",
      creditLimit: opts.creditLimit ?? 0,
    })
    .returning({ id: customers.id });
  let addressId: string | null = null;
  if (opts.withAddress ?? true) {
    const [addr] = await db
      .insert(customerAddresses)
      .values({
        customerId: row!.id,
        label: "Utama",
        addressText: `Jl. Uji No. ${n}, Cianjur`,
        lat: opts.lat ?? -6.82,
        lng: opts.lng ?? 107.14,
        tariffZoneId: opts.zoneId ?? null,
      })
      .returning({ id: customerAddresses.id });
    addressId = addr!.id;
  }
  return { id: row!.id, code, addressId, tenantId };
}

export type TruckFixture = { id: string; code: string; tenantId: string };

export async function createTruck(db: DbOrTx, opts: { tenantId?: string; code?: string; capacityL?: number } = {}): Promise<TruckFixture> {
  const tenantId = opts.tenantId ?? EQUA_TENANT_ID;
  const n = uniqueSeq();
  const code = opts.code ?? `TU${n}`;
  const [row] = await db
    .insert(trucks)
    .values({ tenantId, code, plateNumber: `F ${n} UJI`, capacityL: opts.capacityL ?? 5000 })
    .returning({ id: trucks.id });
  return { id: row!.id, code, tenantId };
}

/**
 * Pengemudi harian truk (crew_assignments) + opsional kernet (crew_rosters). `substituteHelper: true` = kernet
 * ditetapkan sebagai PENGEMUDI PENGGANTI (US-M2-11) — `driverEmployeeId` berisi karyawan kernet.
 */
export async function assignCrew(
  db: DbOrTx,
  opts: {
    truckId: string;
    driverEmployeeId: string;
    date: string;
    tenantId?: string;
    helperEmployeeId?: string | null;
    substituteHelper?: boolean;
    reason?: string;
  },
): Promise<{ assignmentId: string }> {
  const tenantId = opts.tenantId ?? EQUA_TENANT_ID;
  const [row] = await db
    .insert(crewAssignments)
    .values({
      tenantId,
      truckId: opts.truckId,
      businessDate: opts.date,
      driverEmployeeId: opts.driverEmployeeId,
      source: opts.substituteHelper ? "helper" : "default_driver",
      reason: opts.reason ?? (opts.substituteHelper ? "Kernet pengganti (uji)" : null),
    })
    .returning({ id: crewAssignments.id });
  if (opts.helperEmployeeId) {
    await db
      .insert(crewRosters)
      .values({ tenantId, employeeId: opts.helperEmployeeId, businessDate: opts.date, status: "on_duty", truckId: opts.truckId, role: "helper" });
  }
  return { assignmentId: row!.id };
}

export type OrderFixture = { id: string; number: string; customerId: string; addressId: string; tenantId: string; pricePerTrip: number };

export async function createOrder(
  db: DbOrTx,
  opts: { customerId: string; addressId: string; date: string; tenantId?: string; pricePerTrip?: number; productCode?: string; trips?: number },
): Promise<OrderFixture> {
  const tenantId = opts.tenantId ?? EQUA_TENANT_ID;
  const price = opts.pricePerTrip ?? 200_000;
  const number = `P-${opts.date.slice(2, 4)}-${String(uniqueSeq()).padStart(6, "0")}`;
  const [row] = await db
    .insert(orders)
    .values({
      tenantId,
      number,
      customerId: opts.customerId,
      addressId: opts.addressId,
      productId: productId(opts.productCode ?? "AIR-TRUK"),
      requestedDate: opts.date,
      pricePerTrip: price,
      totalAmount: price * (opts.trips ?? 1),
      priceSource: "zone",
    })
    .returning({ id: orders.id });
  return { id: row!.id, number, customerId: opts.customerId, addressId: opts.addressId, tenantId, pricePerTrip: price };
}

export type TripFixtureRow = { id: string; number: string; scheduleId: string; orderId: string; truckId: string };

/** Jadwal harian truk (dibuat bila belum ada, status `published`) + rit ke-`sequence` pesanan pada truk itu. */
export async function createScheduledTrip(
  db: DbOrTx,
  opts: {
    order: OrderFixture;
    truckId: string;
    date: string;
    sequence?: number;
    paymentMethod?: EnumValue<"payment_method">;
    driverEmployeeId?: string | null;
    scheduleStatus?: EnumValue<"schedule_status">;
  },
): Promise<TripFixtureRow> {
  const existing = await db
    .select({ id: dailySchedules.id })
    .from(dailySchedules)
    .where(and(eq(dailySchedules.truckId, opts.truckId), eq(dailySchedules.businessDate, opts.date)))
    .limit(1);
  const scheduleId =
    existing[0]?.id ??
    (
      await db
        .insert(dailySchedules)
        .values({ tenantId: opts.order.tenantId, businessDate: opts.date, truckId: opts.truckId, status: opts.scheduleStatus ?? "published" })
        .returning({ id: dailySchedules.id })
    )[0]!.id;
  const seq = opts.sequence ?? 1;
  const number = `${opts.order.number}/${seq}`;
  const [row] = await db
    .insert(trips)
    .values({
      tenantId: opts.order.tenantId,
      orderId: opts.order.id,
      number,
      sequenceInOrder: seq,
      customerId: opts.order.customerId,
      addressId: opts.order.addressId,
      scheduledDate: opts.date,
      truckId: opts.truckId,
      scheduleId,
      price: opts.order.pricePerTrip,
      paymentMethod: opts.paymentMethod ?? "cash",
      driverEmployeeId: opts.driverEmployeeId ?? null,
    })
    .returning({ id: trips.id });
  return { id: row!.id, number, scheduleId, orderId: opts.order.id, truckId: opts.truckId };
}

/** Shift terbuka outlet (satu shift terbuka per outlet). */
export async function createOpenShift(
  db: DbOrTx,
  opts: { outletId: string; operatorUserId?: string; date: string; tenantId?: string; openingCash?: number; openedAt?: Date },
): Promise<{ shiftId: string; outletId: string; tenantId: string }> {
  const tenantId = opts.tenantId ?? EQUA_TENANT_ID;
  const [row] = await db
    .insert(shifts)
    .values({
      tenantId,
      outletId: opts.outletId,
      operatorUserId: opts.operatorUserId ?? userIdByUsername("depot01"),
      businessDate: opts.date,
      status: "open",
      openedAt: opts.openedAt ?? new Date(),
      openingCashFixed: opts.openingCash ?? 200_000,
    })
    .returning({ id: shifts.id });
  return { shiftId: row!.id, outletId: opts.outletId, tenantId };
}

/** Setoran (bawaan: sopir, status Berjalan) — untuk uji M4. */
export async function createDeposit(
  db: DbOrTx,
  opts: {
    date: string;
    sourceType?: EnumValue<"deposit_source_type">;
    status?: EnumValue<"deposit_status">;
    tenantId?: string;
    depositorUserId?: string | null;
    depositorEmployeeId?: string | null;
    truckId?: string | null;
    outletId?: string | null;
    shiftId?: string | null;
    expectedCash?: number;
  },
): Promise<{ id: string; number: string }> {
  const number = `S-${opts.date.slice(2, 4)}-${String(uniqueSeq()).padStart(6, "0")}`;
  const [row] = await db
    .insert(deposits)
    .values({
      tenantId: opts.tenantId ?? EQUA_TENANT_ID,
      number,
      sourceType: opts.sourceType ?? "driver",
      businessDate: opts.date,
      status: opts.status ?? "running",
      depositorUserId: opts.depositorUserId ?? null,
      depositorEmployeeId: opts.depositorEmployeeId ?? null,
      truckId: opts.truckId ?? null,
      outletId: opts.outletId ?? null,
      shiftId: opts.shiftId ?? null,
      expectedCash: opts.expectedCash ?? 0,
      expectedNet: opts.expectedCash ?? 0,
    })
    .returning({ id: deposits.id });
  return { id: row!.id, number };
}
