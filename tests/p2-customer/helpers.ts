/**
 * Pembantu uji modul P2 (bukan berkas uji). Waktu tetap (Senin 5 Okt 2026 10.00 WIB), aplikasi pelanggan diaktifkan
 * per tenant, masuk pelanggan lewat OTP (kode "mode uji" dari penyedia tautan), penyedia WA Cloud API tiruan.
 */
import { eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import { customers, trips, trucks } from "@/db/schema";
import { EQUA_TENANT_ID, tariffZoneId } from "@/db/seed";
import type { EnumValue } from "@/lib/labels";
import { addDays, toBusinessDate } from "@/lib/time";
import { withTx } from "@/server/core/db";
import { emit } from "@/server/core/events";
import type { DomainEventMap } from "@/server/core/events.types";
import { systemContext } from "@/server/core/context";
import * as flags from "@/server/core/flags";
import type { WaSendRequest, WhatsAppProvider } from "@/server/core/wa";
import * as p2 from "@/server/modules/p2-customer";

import { seededContext } from "../helpers/context";
import { createCustomer, createTruck } from "../helpers/fixtures";
import { createTestUser } from "../helpers/factories";

/** Senin 5 Okt 2026 10.00 WIB. */
export const T0 = new Date("2026-10-05T03:00:00Z");
export const TODAY = toBusinessDate(T0);
export const TOMORROW = addDays(TODAY, 1);
export const at = (hoursFromT0: number) => new Date(T0.getTime() + hoursFromT0 * 3_600_000);
export const minutes = (m: number, from: Date = T0) => new Date(from.getTime() + m * 60_000);

export const ctxOf = (username: string, now: Date = T0) => seededContext(username, { now });
export const owner = (now?: Date) => ctxOf("pemilik", now);
export const dispatcher = (now?: Date) => ctxOf("dispatcher1", now);
export const finance = (now?: Date) => ctxOf("keuangan1", now);
export const sysadmin = (now?: Date) => ctxOf("admin1", now);

/** Aktifkan flag `phase2.customer_app` untuk tenant EQUA (idempoten per DB uji). */
export async function enableApp(): Promise<void> {
  if (await withTx((tx) => flags.isEnabled(tx, "phase2.customer_app", { tenantId: EQUA_TENANT_ID }))) return;
  await flags.set(owner(), "phase2.customer_app", true, { scope: { type: "tenant", refId: EQUA_TENANT_ID }, reason: "Uji Tahap 2 (TG-9 terpenuhi)" });
}

let phoneSeq = 0;
/** Nomor WA unik & deterministik 62819… (berbeda dari fixture 62812… dan seed 62813…; tanpa jam dinding, D-10). */
export function uniquePhone(): string {
  phoneSeq++;
  return `62819${String(phoneSeq).padStart(8, "0")}`;
}

/** Masuk lewat OTP; mengembalikan konteks pelanggan dari sesi. */
export async function login(db: Db, phone: string, now: Date = T0): Promise<{ cctx: p2.CustomerContext; token: string; login: p2.LoginResult }> {
  const otp = await p2.requestLoginOtp({ phone }, { now });
  if (!otp.devCode) throw new Error("kode uji tidak tersedia");
  const res = await p2.verifyLoginOtp({ phone, code: otp.devCode }, { now });
  const cctx = await withTx((tx) => p2.resolveCustomerSession(tx, res.token, now));
  if (!cctx) throw new Error("sesi tidak sah");
  return { cctx, token: res.token, login: res };
}

/** Konteks pelanggan terbaru (status/tautan berubah) dari token. */
export async function refresh(token: string, now: Date = T0): Promise<p2.CustomerContext> {
  const cctx = await withTx((tx) => p2.resolveCustomerSession(tx, token, now));
  if (!cctx) throw new Error("sesi tidak sah");
  return cctx;
}

/** Pelanggan M1 berzona (Z1) dengan nomor WA tertentu. */
export async function zonedCustomer(db: Db, opts: { name?: string; phone?: string; creditStatus?: EnumValue<"credit_status">; creditLimit?: number; segment?: EnumValue<"customer_segment"> } = {}) {
  const c = await createCustomer(db, { name: opts.name, segment: opts.segment ?? "hotel", creditStatus: opts.creditStatus ?? "cash", creditLimit: opts.creditLimit ?? 0, zoneId: tariffZoneId("Z1") });
  if (opts.phone) await db.update(customers).set({ waPhone: opts.phone }).where(eq(customers.id, c.id));
  return c;
}

/** Pelanggan M1 + akun aplikasi tertaut (daftar lewat OTP + konfirmasi nama yang sama). */
export async function linkedCustomer(db: Db, opts: { creditStatus?: EnumValue<"credit_status">; creditLimit?: number; now?: Date } = {}) {
  const phone = uniquePhone();
  const name = `Hotel Uji ${phoneSeq} ${Math.random().toString(36).slice(2, 6)}`;
  const c = await zonedCustomer(db, { name, phone, creditStatus: opts.creditStatus, creditLimit: opts.creditLimit });
  const { cctx, token } = await login(db, phone, opts.now ?? T0);
  const reg = await p2.completeRegistration(cctx, { name, consent: true });
  if (reg.status !== "linked") throw new Error(`tidak tertaut: ${reg.status}`);
  return { customer: c, phone, name, token, cctx: await refresh(token, opts.now ?? T0) };
}

/** Truk uji + sopir (nama lengkap) untuk rit. */
export async function truckWithDriver(db: Db, fullName = "Asep Sunandar Uji") {
  const t = await createTruck(db);
  const driver = await createTestUser(db, { role: "driver", fullName, scope: { truckIds: [t.id] } });
  await db.update(trucks).set({ defaultDriverEmployeeId: driver.employeeId }).where(eq(trucks.id, t.id));
  const [row] = await db.select().from(trucks).where(eq(trucks.id, t.id));
  return { ...t, plate: row!.plateNumber, driver };
}

/** Terapkan status rit langsung (tiruan M3) — tanpa event. */
export async function setTrip(db: Db, tripId: string, patch: Partial<typeof trips.$inferInsert>) {
  await db.update(trips).set(patch).where(eq(trips.id, tripId));
}

/** Pancarkan event (tiruan modul lain) dalam transaksi baru. */
export async function emitEvent<T extends keyof DomainEventMap>(type: T, payload: DomainEventMap[T], opts: { now?: Date } = {}) {
  await withTx((tx) => emit(tx, type, payload, { ctx: systemContext({ now: opts.now ?? T0 }) }));
}

/** Penyedia WA Cloud API tiruan: mencatat kiriman, id pesan `wamid.<n>`. */
export function fakeCloudProvider() {
  const sent: WaSendRequest[] = [];
  const provider: WhatsAppProvider = {
    kind: "cloud_api",
    async send(req) {
      sent.push(req);
      return { mode: "cloud_api", status: "sent", providerMessageId: `wamid.${Date.now()}.${sent.length}.${Math.random().toString(36).slice(2, 8)}` };
    },
  };
  return { provider, sent };
}
