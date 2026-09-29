/**
 * Pembantu uji modul P3 (bukan berkas uji). Semua waktu TETAP (D-10 butir 6): tidak ada ketergantungan jam dinding.
 *
 * - `setupPartner(db, …)`: tenant + outlet mitra (M6 `createPartnerTenant`, katalog standar tersalin), pelanggan mitra
 *   (segmen depot pihak ketiga, zona Z1) ditautkan lewat layanan P3, akun pemilik mitra & operator, kontrak (opsional,
 *   disetujui pemilik).
 * - `insertSale`: transaksi POS mitra (galon 19 L) langsung ke DB pada tanggal tertentu.
 * - `completeTrip`: rit pelanggan mitra Selesai + event `trip.completed` (kontrak M3, payload mandiri).
 */
import { hash } from "@node-rs/argon2";
import { eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import { devices, orders, outlets, posSaleLines, posSales, products, shifts, trips, users } from "@/db/schema";
import { EQUA_TENANT_ID, productId, SEED_DEMO_PIN, tariffZoneId, userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";
import { toBusinessDate } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { systemContext, type ActorContext } from "@/server/core/context";
import { withTx } from "@/server/core/db";
import { emit } from "@/server/core/events";
import * as flags from "@/server/core/flags";
import { createPartnerTenant } from "@/server/modules/m6-pos";
import { createContract, linkPartnerCustomer, type CreateContractInput } from "@/server/modules/p3-partner";

import { seededContext } from "../helpers/context";
import { uniqueSeq } from "../helpers/db-fixtures";
import { createTestUser, type TestUser } from "../helpers/factories";
import { fieldDevice, type FieldDevice } from "../helpers/field";
import { createCustomer } from "../helpers/fixtures";

export const at = (iso: string) => new Date(iso);
/** 10 Sep 2026 10.00 WIB. */
export const T_SEPT = at("2026-09-10T03:00:00Z");
/** 1 Okt 2026 09.00 WIB — tanggal terbit tagihan bulan September (PAR-12). */
export const T_OCT1 = at("2026-10-01T02:00:00Z");

export const owner = (now: Date = T_SEPT) => seededContext("pemilik", { now });
export const finance = (now: Date = T_SEPT) => seededContext("keuangan1", { now });
export const dispatcher = (now: Date = T_SEPT) => seededContext("dispatcher1", { now });
export const admin = (now: Date = T_SEPT) => seededContext("admin1", { now });
export const accountant = (now: Date = T_SEPT) => seededContext("akuntan", { now });

export type PartnerFixture = {
  tenantId: string;
  tenantCode: string;
  outletId: string;
  outletCode: string;
  customerId: string;
  addressId: string;
  partnerOwner: TestUser;
  operator: TestUser;
  deviceId: string;
  contractId: string | null;
  /** Konteks pemilik mitra (portal) pada waktu tertentu. */
  portal: (now?: Date) => ActorContext;
  pos: () => Promise<{ hp: FieldDevice; op: Awaited<ReturnType<FieldDevice["login"]>> }>;
};

export async function setupPartner(
  db: Db,
  opts: {
    now?: Date;
    activatedOn?: string | null;
    lat?: number;
    lng?: number;
    contract?: Partial<CreateContractInput> | false;
    creditStatus?: "cash" | "credit";
    creditLimit?: number;
  } = {},
): Promise<PartnerFixture> {
  const now = opts.now ?? T_SEPT;
  const code = `MT${uniqueSeq()}`;
  const created = await createPartnerTenant(admin(now), {
    code,
    name: `Mitra Uji ${code}`,
    outlets: [{ code: "M01", name: `Depot Mitra ${code}`, storageCapacityL: 5_000 }],
    reason: "Tenant mitra uji P3",
  });
  const tenantId = created.tenant.id;
  const outletId = created.outlets[0]!.id;
  await db
    .update(outlets)
    .set({ lat: opts.lat ?? -6.75, lng: opts.lng ?? 107.05, ...(opts.activatedOn !== undefined ? { activatedOn: opts.activatedOn } : {}) })
    .where(eq(outlets.id, outletId));
  const cust = await createCustomer(db, { segment: "third_party_depot", zoneId: tariffZoneId("Z1"), creditStatus: opts.creditStatus ?? "cash", creditLimit: opts.creditLimit ?? 0, name: `Pelanggan mitra ${code}` });
  await linkPartnerCustomer(finance(now), { customerId: cust.id, tenantId, outletId, reason: "Perjanjian kemitraan uji" });
  const partnerOwner = await createTestUser(db, { role: "partner_owner", tenantId, scope: { tenantIds: [tenantId] }, now });
  const operator = await createTestUser(db, { role: "depot_operator", tenantId, scope: { outletIds: [outletId] }, now });
  await db.update(users).set({ pinHash: await hash(SEED_DEMO_PIN), pinSetAt: new Date() }).where(eq(users.id, operator.userId));
  const sysadmin = await createTestUser(db, { role: "system_admin", tenantId, scope: { tenantIds: [tenantId] } });
  const deviceId = newId();
  await db.insert(devices).values({ id: deviceId, tenantId, deviceCode: `POS-${code}`, name: `Tablet ${code}`, kind: "tablet", status: "registered", outletId });
  let contractId: string | null = null;
  if (opts.contract !== false) {
    const res = await createContract(finance(now), {
      tenantId,
      customerId: cust.id,
      startDate: "2026-08-01",
      reason: "Kontrak kemitraan Opsi B uji",
      ...(opts.contract ?? {}),
    });
    await approvals.decide(owner(now), res.approval.id, "approve", "Disetujui sesuai perjanjian");
    contractId = res.contract.id;
  }
  return {
    tenantId,
    tenantCode: code,
    outletId,
    outletCode: "M01",
    customerId: cust.id,
    addressId: cust.addressId!,
    partnerOwner,
    operator,
    deviceId,
    contractId,
    portal: (n?: Date) => ({ ...partnerOwner.ctx, now: n ?? now, source: "partner_portal" }),
    pos: async () => {
      const hp = await fieldDevice(deviceId, { admin: sysadmin.ctx });
      const op = await hp.login(operator.userId);
      return { hp, op };
    },
  };
}

/** Shift ditutup + transaksi galon isi ulang (19 L) pada tanggal bisnis tertentu (langsung ke DB). */
export async function insertSale(db: Db, p: Pick<PartnerFixture, "tenantId" | "outletId" | "operator">, input: { businessDate: string; gallons: number; unitPrice?: number; status?: "valid" | "voided" }) {
  const [isi] = await db.select().from(products).where(eq(products.tenantId, p.tenantId)).then((rows) => rows.filter((r) => r.code === "ISI-ULANG"));
  const soldAt = new Date(`${input.businessDate}T03:00:00Z`);
  const [shift] = await db
    .insert(shifts)
    .values({ tenantId: p.tenantId, outletId: p.outletId, operatorUserId: p.operator.userId, businessDate: input.businessDate, status: "closed", openedAt: soldAt, closedAt: new Date(soldAt.getTime() + 3_600_000), openingCashFixed: 200_000 })
    .returning({ id: shifts.id });
  const unit = input.unitPrice ?? 5_000;
  const total = unit * input.gallons;
  const [sale] = await db
    .insert(posSales)
    .values({
      tenantId: p.tenantId,
      outletId: p.outletId,
      shiftId: shift!.id,
      number: `M01-${input.businessDate.slice(2).replace(/-/g, "")}-${String(uniqueSeq()).padStart(4, "0")}`,
      localNumber: `L-${newId()}`,
      deviceSeq: uniqueSeq(),
      priceKind: "standard",
      businessDate: input.businessDate,
      soldAt,
      subtotal: total,
      total,
      paymentMethod: "cash",
      cashReceived: total,
      changeAmount: 0,
      operatorUserId: p.operator.userId,
      status: input.status ?? "valid",
      ...(input.status === "voided" ? { voidRequestedAt: new Date(soldAt.getTime() + 600_000), voidedAt: new Date(soldAt.getTime() + 600_000), voidReason: "wrong_product" as const } : {}),
    })
    .returning({ id: posSales.id });
  await db.insert(posSaleLines).values({ posSaleId: sale!.id, tenantId: p.tenantId, outletId: p.outletId, businessDate: input.businessDate, lineNo: 1, productId: isi!.id, quantity: input.gallons, unitPrice: unit, lineTotal: total, gallonSizeL: 19 });
  return { saleId: sale!.id, shiftId: shift!.id, total };
}

/** Pesanan + rit pelanggan mitra (langsung ke DB) — untuk uji yang tidak menguji M2. */
export async function insertOrderTrip(db: Db, p: Pick<PartnerFixture, "customerId" | "addressId">, input: { date: string; createdAt?: Date; price?: number; paymentMethod?: "cash" | "credit" | "transfer" }) {
  const number = `P-26-${String(900_000 + uniqueSeq()).padStart(6, "0")}`;
  const price = input.price ?? 200_000;
  const [order] = await db
    .insert(orders)
    .values({
      tenantId: EQUA_TENANT_ID,
      number,
      customerId: p.customerId,
      addressId: p.addressId,
      productId: productId("AIR-TRUK"),
      requestedDate: input.date,
      pricePerTrip: price,
      totalAmount: price,
      priceSource: "zone",
      paymentMethod: input.paymentMethod ?? "cash",
      createdAt: input.createdAt ?? new Date(`${input.date}T01:00:00Z`),
    })
    .returning();
  const [trip] = await db
    .insert(trips)
    .values({ tenantId: order!.tenantId, orderId: order!.id, number: `${number}/1`, sequenceInOrder: 1, customerId: p.customerId, addressId: p.addressId, scheduledDate: input.date, price, paymentMethod: input.paymentMethod ?? "cash" })
    .returning();
  return { order: order!, trip: trip! };
}

/** Rit Selesai (M3) + `trip.completed` — pasokan mitra tiba lewat handler P3. */
export async function completeTrip(db: Db, trip: { id: string; orderId: string; customerId: string; number: string; price: number; tenantId: string }, input: { volumeL: number; completedAt: Date }) {
  const businessDate = toBusinessDate(input.completedAt);
  await db.update(trips).set({ status: "completed", completedAt: input.completedAt, deliveredVolumeL: input.volumeL, completionBusinessDate: businessDate }).where(eq(trips.id, trip.id));
  await withTx((tx) =>
    emit(
      tx,
      "trip.completed",
      {
        tripId: trip.id,
        orderId: trip.orderId,
        customerId: trip.customerId,
        truckId: newId(),
        driverUserId: userIdByUsername("sopir1"),
        isInternal: false,
        destinationOutletId: null,
        volumeL: input.volumeL,
        price: trip.price,
        paymentMethod: "cash",
        cashReceived: trip.price,
        transferAmount: 0,
        creditAmount: 0,
        underpaymentAmount: 0,
        completedAt: input.completedAt.toISOString(),
        recordedByOffice: false,
        lateSync: false,
        tripNumber: trip.number,
        businessDate,
      },
      { ctx: systemContext({ tenantId: trip.tenantId, now: input.completedAt }), tenantId: trip.tenantId, businessDate, objectType: "trip", objectId: trip.id },
    ),
  );
}

/** Aktifkan portal kemitraan lengkap Tahap 3 (flag global; pemilik). */
export async function enablePhase3(now: Date = T_SEPT, tenantId?: string) {
  await flags.set(owner(now), "phase3.partner_portal", true, { reason: "Uji Tahap 3", ...(tenantId ? { scope: { type: "tenant", refId: tenantId } } : {}) });
}

export async function disablePhase3(now: Date = T_SEPT) {
  await flags.set(owner(now), "phase3.partner_portal", false, { reason: "Uji selesai" });
}
