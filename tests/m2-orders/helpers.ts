/**
 * Pembantu uji modul M2 (bukan berkas uji). Waktu tetap (Senin 5 Okt 2026), konteks akun seed, pelanggan berzona,
 * truk + sopir default uji, dan penulis baris faktur/setoran (baca-saja bagi M2).
 */
import { eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import { invoices, trucks } from "@/db/schema";
import { EQUA_TENANT_ID, tariffZoneId } from "@/db/seed";
import type { EnumValue } from "@/lib/labels";
import { addDays, toBusinessDate } from "@/lib/time";
import { emit } from "@/server/core/events";
import { withTx } from "@/server/core/db";
import type { DomainEventMap } from "@/server/core/events.types";
import { systemContext } from "@/server/core/context";

import { seededContext } from "../helpers/context";
import { createCustomer, createDeposit, createTruck } from "../helpers/fixtures";
import { createTestUser } from "../helpers/factories";

/** Senin 5 Okt 2026 10.00 WIB (sebelum batas H+0 PAR-05 15.00). */
export const T0 = new Date("2026-10-05T03:00:00Z");
export const TODAY = toBusinessDate(T0);
export const TOMORROW = addDays(TODAY, 1);
export const YESTERDAY = addDays(TODAY, -1);
/** 16.00 WIB (setelah batas H+0). */
export const AFTER_CUTOFF = new Date("2026-10-05T09:00:00Z");
export const at = (hoursFromT0: number) => new Date(T0.getTime() + hoursFromT0 * 3_600_000);

export const ctxOf = (username: string, now: Date = T0) => seededContext(username, { now });
export const dispatcher = (now?: Date) => ctxOf("dispatcher1", now);
export const dispatcher2 = (now?: Date) => ctxOf("dispatcher2", now);
export const owner = (now?: Date) => ctxOf("pemilik", now);
export const finance = (now?: Date) => ctxOf("keuangan1", now);

let invSeq = 0;

/** Pelanggan uji berzona (bawaan Z1, hotel, Tunai). */
export async function customer(
  db: Db,
  opts: { segment?: EnumValue<"customer_segment">; creditStatus?: EnumValue<"credit_status">; creditLimit?: number; zone?: string | null } = {},
) {
  return createCustomer(db, {
    segment: opts.segment ?? "hotel",
    creditStatus: opts.creditStatus ?? "cash",
    creditLimit: opts.creditLimit ?? 0,
    zoneId: opts.zone === null ? null : tariffZoneId(opts.zone ?? "Z1"),
  });
}

/** Truk uji dengan sopir default (akun sopir aktif) & kernet default (akun kernet). */
export async function truckWithCrew(db: Db, opts: { code?: string; capacity?: number | null } = {}) {
  const t = await createTruck(db, { code: opts.code });
  const driver = await createTestUser(db, { role: "driver", fullName: `Sopir ${t.code}`, scope: { truckIds: [t.id] } });
  const helper = await createTestUser(db, { role: "helper", fullName: `Kernet ${t.code}`, scope: { truckIds: [t.id] } });
  await db
    .update(trucks)
    .set({ defaultDriverEmployeeId: driver.employeeId, defaultHelperEmployeeId: helper.employeeId, dailyTripCapacity: opts.capacity ?? null })
    .where(eq(trucks.id, t.id));
  return { ...t, driver, helper };
}

/** Faktur terbuka (baca-saja M5) untuk eksposur/kurang bayar. */
export async function openInvoice(db: Db, customerId: string, amount: number, kind: EnumValue<"invoice_kind"> = "delivery") {
  invSeq++;
  const [row] = await db
    .insert(invoices)
    .values({
      tenantId: EQUA_TENANT_ID,
      number: `F-26-9${String(invSeq).padStart(5, "0")}${Math.floor(Math.random() * 10)}`,
      kind,
      customerId,
      issueDate: YESTERDAY,
      dueDate: YESTERDAY,
      amount,
      outstandingAmount: amount,
      status: "open",
    })
    .returning();
  return row!;
}

/** Setoran sopir (baca-saja M4) untuk BR-10. */
export async function driverDeposit(db: Db, input: { employeeId: string; userId?: string; date: string; status: EnumValue<"deposit_status">; truckId?: string }) {
  return createDeposit(db, { date: input.date, status: input.status, depositorEmployeeId: input.employeeId, depositorUserId: input.userId ?? null, truckId: input.truckId ?? null });
}

/** Pancarkan event lapangan (tiruan M3) dalam transaksi baru. */
export async function emitEvent<T extends keyof DomainEventMap>(type: T, payload: DomainEventMap[T], opts: { now?: Date; actorUserId?: string } = {}) {
  const now = opts.now ?? T0;
  const ctx = { ...systemContext({ now }), ...(opts.actorUserId ? { userId: opts.actorUserId, source: "field" as const } : {}) };
  await withTx((tx) => emit(tx, type, payload, { ctx }));
}
