/**
 * Pembantu uji modul M8 (bukan berkas uji): "dunia" satu sumber air uji — sumber + meter, operator produksi (akun + PIN,
 * lingkup sumber itu), ponsel sumber terdaftar, truk + pelanggan beralamat dengan sumber acuan = sumber uji, rit TERBIT,
 * plus pembangun perintah sinkron `m8.*` bertanda tangan (dengan foto) lewat jalur perangkat yang sama (`processPush`).
 *
 * Waktu dikendalikan penuh: `at("06:30")` = instan WIB pada tanggal dunia; perintah dikirim dengan waktu perangkat itu dan
 * `now` server = waktu perangkat + 1 menit (bawaan). Setiap `productionWorld()` memakai sumber/meter/truk BARU agar uji
 * dalam satu berkas tidak saling memengaruhi.
 */
import { hash } from "@node-rs/argon2";
import { and, eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import { customerAddresses, dailyProductions, devices, notifications, trips, truckFills, users, waterBalances, waterMeters, waterSources } from "@/db/schema";
import { EQUA_TENANT_ID, SEED_DEMO_PIN } from "@/db/seed";
import { newId } from "@/lib/ids";
import { addDays, wibToUtc } from "@/lib/time";
import type { FieldLoginResult } from "@/server/core/auth";
import { processUpload, type PushResult } from "@/server/core/sync";

import type { M8Today } from "@/client/m8-production/contract";

import { seededContext } from "../helpers/context";
import { createTestUser, type TestUser } from "../helpers/factories";
import { fieldDevice, sha256Hex, type FieldDevice, type SignedCommandOptions } from "../helpers/field";
import { createCustomer, createOrder, createScheduledTrip, createTruck, type CustomerFixture, type TruckFixture } from "../helpers/fixtures";

export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x20, 0x30, 0x40, 0x50]);
export const PDF = Buffer.from("%PDF-1.4\n%uji\n");

export const owner = (now?: Date) => seededContext("pemilik", { now });
export const finance = (now?: Date) => seededContext("keuangan1", { now });
export const dispatcher = (now?: Date) => seededContext("dispatcher1", { now });
export const sysadmin = (now?: Date) => seededContext("admin1", { now });

let seq = 0;

export type Attach = { kind: string; bytes?: Buffer; contentType?: string };

export type ProdWorld = {
  db: Db;
  date: string;
  /** Instan WIB `HH:mm` pada tanggal dunia (atau tanggal lain). */
  at: (hhmm: string, date?: string) => Date;
  source: { id: string; code: string; name: string; dailyCapacityL: number };
  meter: { id: string; code: string; initialReadingL: number };
  operator: TestUser;
  deviceId: string;
  hp: FieldDevice;
  op: FieldLoginResult;
  truck: TruckFixture;
  customer: CustomerFixture;
  /** Rit TERBIT hari dunia untuk truk (urutan rencana `routeOrder`). */
  addTrip: (opts?: { truckId?: string; routeOrder?: number; isInternal?: boolean; destinationOutletId?: string; customer?: CustomerFixture; date?: string }) => Promise<{ id: string; number: string; orderId: string }>;
  /** Unggah satu lampiran perangkat untuk perintah `commandId` dengan jam uji `now` (bukan jam dinding). */
  upload: (kind: string, opts: { commandId: string; capturedAt: Date; now: Date; bytes?: Buffer; contentType?: string; actor?: FieldLoginResult }) => Promise<{ attachmentId: string; sha256: string }>;
  /** Kirim satu perintah m8.* (lampiran diunggah dulu untuk perintah itu). */
  send: (type: string, payload: unknown, opts?: SignedCommandOptions & { attach?: Attach[]; at?: Date; now?: Date; actor?: FieldLoginResult }) => Promise<PushResult>;
  /** Pembacaan meter + foto. */
  reading: (phase: "morning" | "evening", readingL: number, opts?: { at?: Date; lateReason?: string; meterId?: string; readingId?: string; noPhoto?: boolean }) => Promise<PushResult>;
  /** Pengisian truk (foto opsional). */
  fill: (opts: { tripId?: string | null; volumeL?: number; volumeReason?: string; truckId?: string; at?: Date; fillId?: string; photo?: boolean; unplannedConfirmed?: boolean }) => Promise<PushResult>;
  today: (at?: Date) => Promise<M8Today>;
  balance: (date?: string) => Promise<typeof waterBalances.$inferSelect | undefined>;
  production: (date?: string) => Promise<typeof dailyProductions.$inferSelect | undefined>;
  notificationsFor: (event: string, objectId?: string) => Promise<(typeof notifications.$inferSelect)[]>;
};

/** Dunia uji satu sumber air (lihat keterangan berkas). */
export async function productionWorld(db: Db, opts: { date?: string; capacityL?: number; initialReadingL?: number; loginAt?: string } = {}): Promise<ProdWorld> {
  seq++;
  const tag = `${seq}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const date = opts.date ?? "2026-09-21";
  const at = (hhmm: string, d = date) => wibToUtc(d, hhmm);
  const capacity = opts.capacityL ?? 50_000;
  const [source] = await db
    .insert(waterSources)
    .values({ tenantId: EQUA_TENANT_ID, code: `SU${tag}`.slice(0, 10), name: `Sumber Uji ${tag}`, lat: -6.77, lng: 107.08, dailyCapacityL: capacity })
    .returning();
  const initial = opts.initialReadingL ?? 1_000_000;
  const [meter] = await db
    .insert(waterMeters)
    .values({ waterSourceId: source!.id, code: `MTR-U${tag}`, initialReadingL: initial, installedAt: "2025-01-01" })
    .returning();
  const operator = await createTestUser(db, { role: "production_operator", fullName: `Operator Produksi ${tag}`, scope: { sourceIds: [source!.id] } });
  const pin = await hash(SEED_DEMO_PIN);
  await db.update(users).set({ pinHash: pin, pinSetAt: new Date() }).where(eq(users.id, operator.userId));
  const deviceId = newId();
  await db.insert(devices).values({
    id: deviceId,
    tenantId: EQUA_TENANT_ID,
    deviceCode: `HP-SU-${tag}`,
    name: `Ponsel sumber uji ${tag}`,
    kind: "phone",
    status: "registered",
    waterSourceId: source!.id,
  });
  const hp = await fieldDevice(deviceId);
  const loginAt = at(opts.loginAt ?? "05:00");
  const op = await hp.login(operator.userId, { now: loginAt });

  const truck = await createTruck(db, { code: `M8T${tag}`.slice(0, 10) });
  const customer = await createCustomer(db, { segment: "household", lat: -6.8, lng: 107.1 });
  await db.update(customerAddresses).set({ referenceWaterSourceId: source!.id }).where(eq(customerAddresses.id, customer.addressId!));

  let route = 0;
  const addTrip: ProdWorld["addTrip"] = async (o = {}) => {
    const cust = o.customer ?? customer;
    const d = o.date ?? date;
    const order = await createOrder(db, { customerId: cust.id, addressId: cust.addressId!, date: d });
    const trip = await createScheduledTrip(db, { order, truckId: o.truckId ?? truck.id, date: d });
    route++;
    await db
      .update(trips)
      .set({ routeOrder: o.routeOrder ?? route, publishedAt: at("04:00", d), isInternal: !!o.isInternal, destinationOutletId: o.destinationOutletId ?? null })
      .where(eq(trips.id, trip.id));
    return { id: trip.id, number: trip.number, orderId: order.id };
  };

  const upload: ProdWorld["upload"] = async (kind, u) => {
    // Unggah dengan jam uji (bukan jam dinding) agar sesi PIN dunia uji tetap berlaku untuk tanggal lampau.
    const bytes = u.bytes ?? JPEG;
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(bytes)], { type: u.contentType ?? "image/jpeg" }), "berkas");
    form.set("attachmentId", newId());
    form.set("userId", (u.actor ?? op).user.id);
    form.set("kind", kind);
    form.set("capturedAt", u.capturedAt.toISOString());
    form.set("commandId", u.commandId);
    const up = await processUpload(await hp.auth({ now: u.now }), form);
    return { attachmentId: up.attachmentId, sha256: sha256Hex(bytes) };
  };

  const send: ProdWorld["send"] = async (type, payload, o = {}) => {
    const actor = o.actor ?? op;
    const id = o.id ?? newId();
    const deviceTime = o.at ?? (o.deviceTime instanceof Date ? o.deviceTime : at("07:00"));
    const now = o.now ?? new Date(deviceTime.getTime() + 60_000);
    const attachmentIds: string[] = [];
    const attachmentHashes: string[] = [];
    for (const a of o.attach ?? []) {
      const up = await upload(a.kind, { commandId: id, capturedAt: deviceTime, now, bytes: a.bytes, contentType: a.contentType, actor });
      attachmentIds.push(up.attachmentId);
      attachmentHashes.push(up.sha256);
    }
    const res = await hp.push(
      [hp.command(actor, type, payload, { ...o, id, deviceTime, attachmentIds: o.attachmentIds ?? attachmentIds, attachmentHashes: o.attachmentHashes ?? attachmentHashes })],
      { now },
    );
    return res.results[0]!;
  };

  const reading: ProdWorld["reading"] = (phase, readingL, o = {}) =>
    send(
      "m8.meter_reading.create",
      { readingId: o.readingId ?? newId(), waterMeterId: o.meterId ?? meter!.id, phase, readingL, ...(o.lateReason ? { lateReason: o.lateReason } : {}) },
      { at: o.at ?? at(phase === "morning" ? "06:30" : "21:30"), attach: o.noPhoto ? [] : [{ kind: "meter_photo" }] },
    );

  const fill: ProdWorld["fill"] = (o) =>
    send(
      "m8.truck_fill.create",
      {
        fillId: o.fillId ?? newId(),
        truckId: o.truckId ?? truck.id,
        tripId: o.tripId ?? null,
        volumeL: o.volumeL ?? 5_000,
        ...(o.volumeReason ? { volumeReason: o.volumeReason } : {}),
        ...(o.unplannedConfirmed ? { unplannedConfirmed: true } : {}),
      },
      { at: o.at ?? at("09:00"), attach: o.photo ? [{ kind: "truck_fill_photo" }] : [] },
    );

  const today: ProdWorld["today"] = async (atTime = at("12:00")) => {
    const pull = await hp.pull(op, { keys: "m8.today" }, { now: atTime });
    return pull.data["m8.today"] as M8Today;
  };

  const balance: ProdWorld["balance"] = async (d = date) =>
    (await db.select().from(waterBalances).where(and(eq(waterBalances.waterSourceId, source!.id), eq(waterBalances.businessDate, d))).limit(1))[0];
  const production: ProdWorld["production"] = async (d = date) =>
    (await db.select().from(dailyProductions).where(and(eq(dailyProductions.waterSourceId, source!.id), eq(dailyProductions.businessDate, d))).limit(1))[0];
  const notificationsFor: ProdWorld["notificationsFor"] = async (event, objectId) =>
    db
      .select()
      .from(notifications)
      .where(and(eq(notifications.event, event), ...(objectId ? [eq(notifications.objectId, objectId)] : [])));

  return {
    db,
    date,
    at,
    source: { id: source!.id, code: source!.code, name: source!.name, dailyCapacityL: capacity },
    meter: { id: meter!.id, code: meter!.code, initialReadingL: initial },
    operator,
    deviceId,
    hp,
    op,
    truck,
    customer,
    addTrip,
    upload,
    send,
    reading,
    fill,
    today,
    balance,
    production,
    notificationsFor,
  };
}

/** Riwayat produksi lengkap N hari sebelum `date` (untuk rata-rata 7 hari PAR-68) — ditulis langsung (data historis). */
export async function seedProductionHistory(db: Db, sourceId: string, date: string, producedL: number, days = 7): Promise<void> {
  for (let i = 1; i <= days; i++) {
    await db.insert(dailyProductions).values({ tenantId: EQUA_TENANT_ID, waterSourceId: sourceId, businessDate: addDays(date, -i), producedL, status: "complete" });
  }
}

/** Pengisian historis langsung (utilisasi berturut, US-M8-05). */
export async function seedFill(db: Db, input: { sourceId: string; truckId: string; date: string; volumeL: number }): Promise<string> {
  const [row] = await db
    .insert(truckFills)
    .values({ tenantId: EQUA_TENANT_ID, waterSourceId: input.sourceId, truckId: input.truckId, businessDate: input.date, volumeL: input.volumeL, filledAt: wibToUtc(input.date, "10:00"), status: "unlinked" })
    .returning({ id: truckFills.id });
  return row!.id;
}
