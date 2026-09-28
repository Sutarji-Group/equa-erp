/**
 * Pembantu uji modul M3 (bukan berkas uji): "dunia" satu truk uji — truk, sopir & kernet (akun + PIN), ponsel truk
 * terdaftar, penetapan pengemudi hari ini, pelanggan beralamat terkunci, rit TERBIT — plus pembangun perintah sinkron
 * `m3.*` bertanda tangan (dengan lampiran foto) lewat jalur perangkat yang sama (`processPush`).
 *
 * Setiap `driverWorld()` memakai truk & pengguna BARU agar uji dalam satu berkas tidak saling memengaruhi (satu
 * penetapan pengemudi per orang per hari).
 */
import { hash } from "@node-rs/argon2";
import { and, eq } from "drizzle-orm";
import { expect } from "vitest";

import type { Db } from "@/db/client";
import { customerAddresses, customers, devices, notifications, trips, users } from "@/db/schema";
import { EQUA_TENANT_ID, SEED_DEMO_PIN } from "@/db/seed";
import { newId } from "@/lib/ids";
import type { EnumValue } from "@/lib/labels";
import { toBusinessDate } from "@/lib/time";
import type { FieldLoginResult } from "@/server/core/auth";
import type { PushResult } from "@/server/core/sync";

import type { M3Today } from "@/client/m3-driver/contract";

import { seededContext } from "../helpers/context";
import { createTestUser, type TestUser } from "../helpers/factories";
import { fieldDevice, type FieldDevice, type SignedCommandOptions } from "../helpers/field";
import { assignCrew, createCustomer, createOrder, createScheduledTrip, createTruck, type CustomerFixture, type TruckFixture } from "../helpers/fixtures";

export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x20, 0x30, 0x40, 0x50]);
export const PRICE = 250_000;
/** Koordinat alamat pelanggan uji (Cianjur). */
export const HOME = { lat: -6.82, lng: 107.14 };

export const owner = () => seededContext("pemilik");
export const finance = () => seededContext("keuangan1");
export const dispatcher = () => seededContext("dispatcher1");

let seq = 0;

export type Attach = { kind: string; bytes?: Buffer };

export type Actor = FieldLoginResult;

export type World = {
  db: Db;
  date: string;
  truck: TruckFixture;
  driver: TestUser;
  helper: TestUser;
  deviceId: string;
  hp: FieldDevice;
  sopir: Actor;
  kernet: Actor;
  customer: CustomerFixture;
  /** Tambah rit terbit (urutan rencana `routeOrder`). */
  addTrip: (opts?: { paymentMethod?: EnumValue<"payment_method">; routeOrder?: number; customer?: CustomerFixture; price?: number; isInternal?: boolean; destinationOutletId?: string }) => Promise<{ id: string; number: string; orderId: string }>;
  /** Kirim satu perintah (lampiran diunggah dulu untuk perintah itu) dan kembalikan hasilnya. */
  send: (actor: Actor, type: string, payload: unknown, opts?: SignedCommandOptions & { attach?: Attach[]; now?: Date }) => Promise<PushResult>;
  today: (actor?: Actor) => Promise<M3Today>;
};

/** Dunia uji satu truk (lihat keterangan berkas). */
export async function driverWorld(db: Db, opts: { date?: string; customerCredit?: EnumValue<"credit_status">; creditLimit?: number; lockedAddress?: boolean } = {}): Promise<World> {
  seq++;
  const date = opts.date ?? toBusinessDate(new Date());
  const truck = await createTruck(db, { code: `M3T${seq}${Math.random().toString(36).slice(2, 5).toUpperCase()}` });
  const driver = await createTestUser(db, { role: "driver", fullName: `Sopir Uji ${seq}`, scope: { truckIds: [truck.id] } });
  const helper = await createTestUser(db, { role: "helper", fullName: `Kernet Uji ${seq}`, scope: { truckIds: [truck.id] } });
  const pin = await hash(SEED_DEMO_PIN);
  await db.update(users).set({ pinHash: pin, pinSetAt: new Date() }).where(eq(users.id, driver.userId));
  await db.update(users).set({ pinHash: pin, pinSetAt: new Date() }).where(eq(users.id, helper.userId));
  await assignCrew(db, { truckId: truck.id, driverEmployeeId: driver.employeeId, date, helperEmployeeId: helper.employeeId });
  const deviceId = newId();
  await db.insert(devices).values({ id: deviceId, tenantId: EQUA_TENANT_ID, deviceCode: `HP-M3-${seq}-${deviceId.slice(-4)}`, name: `Ponsel truk uji ${seq}`, kind: "phone", status: "registered", truckId: truck.id });
  const hp = await fieldDevice(deviceId);
  const sopir = await hp.login(driver.userId);
  const kernet = await hp.login(helper.userId);
  const customer = await makeCustomer(db, { creditStatus: opts.customerCredit, creditLimit: opts.creditLimit, locked: opts.lockedAddress ?? true });

  let route = 0;
  const addTrip: World["addTrip"] = async (o = {}) => {
    const cust = o.customer ?? customer;
    const order = await createOrder(db, { customerId: cust.id, addressId: cust.addressId!, date, pricePerTrip: o.price ?? PRICE });
    const trip = await createScheduledTrip(db, { order, truckId: truck.id, date, paymentMethod: o.paymentMethod ?? "cash", driverEmployeeId: driver.employeeId });
    route++;
    await db
      .update(trips)
      .set({ routeOrder: o.routeOrder ?? route, publishedAt: new Date(), isInternal: !!o.isInternal, destinationOutletId: o.destinationOutletId ?? null })
      .where(eq(trips.id, trip.id));
    return { id: trip.id, number: trip.number, orderId: order.id };
  };

  const send: World["send"] = async (actor, type, payload, o = {}) => {
    const id = o.id ?? newId();
    const attachmentIds: string[] = [];
    const attachmentHashes: string[] = [];
    for (const a of o.attach ?? []) {
      const up = await hp.upload(actor, { bytes: a.bytes ?? JPEG, kind: a.kind, commandId: id });
      attachmentIds.push(up.attachmentId);
      attachmentHashes.push(up.sha256);
    }
    const res = await hp.push([hp.command(actor, type, payload, { ...o, id, attachmentIds: o.attachmentIds ?? attachmentIds, attachmentHashes: o.attachmentHashes ?? attachmentHashes })], { now: o.now });
    return res.results[0]!;
  };

  const today: World["today"] = async (actor = sopir) => {
    const pull = await hp.pull(actor, { keys: "m3.today" });
    return pull.data["m3.today"] as M3Today;
  };

  return { db, date, truck, driver, helper, deviceId, hp, sopir, kernet, customer, addTrip, send, today };
}

export async function makeCustomer(db: Db, o: { creditStatus?: EnumValue<"credit_status">; creditLimit?: number; locked?: boolean; lat?: number; lng?: number } = {}): Promise<CustomerFixture> {
  const c = await createCustomer(db, { segment: o.creditStatus && o.creditStatus !== "cash" ? "hotel" : "household", creditStatus: o.creditStatus ?? "cash", creditLimit: o.creditLimit ?? 0, lat: o.lat ?? HOME.lat, lng: o.lng ?? HOME.lng });
  if (o.locked ?? true) await db.update(customerAddresses).set({ coordinateStatus: "locked" }).where(eq(customerAddresses.id, c.addressId!));
  await db.update(customers).set({ contactName: "Ibu Penerima" }).where(eq(customers.id, c.id));
  return c;
}

export const HERE = { lat: HOME.lat, lng: HOME.lng, accuracyM: 8 };
/** Titik ± `m` meter ke utara alamat. */
export function north(m: number) {
  return { lat: HOME.lat + m / 111_320, lng: HOME.lng, accuracyM: 10 };
}

export function completePayload(tripId: string, over: Record<string, unknown> = {}) {
  return {
    tripId,
    recipientName: "Ibu Penerima",
    deliveredVolumeL: 5000,
    location: HERE,
    clientDistanceM: 0,
    payment: { method: "cash", cashReceived: PRICE },
    ...over,
  };
}

export const PHOTO: Attach = { kind: "delivery_photo" };
export const SIGNATURE: Attach = { kind: "signature" };

/** Berangkat → Tiba untuk rit (siap Selesai). */
export async function departArrive(w: World, tripId: string, actor: Actor = w.sopir): Promise<void> {
  expectApplied(await w.send(actor, "m3.trip.depart", { tripId, location: HERE }));
  expectApplied(await w.send(actor, "m3.trip.arrive", { tripId, location: HERE, clientDistanceM: 0 }));
}

/** Rit Selesai tunai penuh (foto + tanda tangan). */
export async function completeCash(w: World, tripId: string, actor: Actor = w.sopir, over: Record<string, unknown> = {}): Promise<PushResult> {
  return w.send(actor, "m3.trip.complete", completePayload(tripId, over), { attach: [PHOTO, SIGNATURE] });
}

export function expectApplied(r: PushResult): void {
  expect(r.status, r.message ?? undefined).toBe("applied");
}

export function expectRejected(r: PushResult, text?: RegExp): void {
  expect(r.status).toBe("rejected");
  if (text) expect(r.message ?? "").toMatch(text);
}

export async function notificationsFor(db: Db, event: string, objectId?: string) {
  return db
    .select()
    .from(notifications)
    .where(objectId ? and(eq(notifications.event, event), eq(notifications.objectId, objectId)) : eq(notifications.event, event));
}
