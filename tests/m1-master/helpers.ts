/**
 * Pembantu uji modul M1 (bukan berkas uji). Konteks akun seed pada waktu tetap, buku kerja Excel impor, dan penulis
 * baris pesanan/rit untuk kelayakan Tempo.
 */
import * as ExcelJSNs from "exceljs";
import { eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import { orders, trips } from "@/db/schema";
import { toBusinessDate } from "@/lib/time";

import { seededContext } from "../helpers/context";
import {
  createOrder,
  createScheduledTrip,
  createTruck,
} from "../helpers/fixtures";

const ExcelJS = ((ExcelJSNs as unknown as { default?: typeof ExcelJSNs })
  .default ?? ExcelJSNs) as typeof ExcelJSNs;

/** Senin 5 Okt 2026 10.00 WIB. */
export const T0 = new Date("2026-10-05T03:00:00Z");
export const TODAY = toBusinessDate(T0);
export const days = (n: number, base: Date = T0) =>
  new Date(base.getTime() + n * 86_400_000);

export const ctxOf = (username: string, now: Date = T0) =>
  seededContext(username, { now });
export const dispatcher = (now?: Date) => ctxOf("dispatcher1", now);
export const owner = (now?: Date) => ctxOf("pemilik", now);
export const finance = (now?: Date) => ctxOf("keuangan1", now);
export const sysadmin = (now?: Date) => ctxOf("admin1", now);

let waSeq = 0;
/** Nomor WA unik (format lokal) untuk pelanggan uji. */
export function uniqueWa(): string {
  waSeq++;
  return `0857${String(Date.now() % 1_000_000).padStart(6, "0")}${String(waSeq).padStart(2, "0")}`.slice(
    0,
    13,
  );
}

/** Buku kerja Excel "Data" dari header + baris (untuk uji impor). */
export async function workbook(
  headers: string[],
  rows: (string | number | null)[][],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Data");
  sheet.addRow(headers);
  for (const r of rows) sheet.addRow(r);
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

/** Tulis n pesanan Selesai (completed_at mundur `startDaysAgo` hari) untuk pelanggan/alamat. */
export async function completedOrders(
  db: Db,
  input: {
    customerId: string;
    addressId: string;
    count: number;
    startDaysAgo: number;
    now?: Date;
  },
) {
  const now = input.now ?? T0;
  for (let i = 0; i < input.count; i++) {
    const at = days(-(input.startDaysAgo - i), now);
    const o = await createOrder(db, {
      customerId: input.customerId,
      addressId: input.addressId,
      date: toBusinessDate(at),
    });
    await db
      .update(orders)
      .set({ status: "completed", completedAt: at })
      .where(eq(orders.id, o.id));
  }
}

/** Rit gagal karena pelanggan menolak (untuk PAR-82). */
export async function failedRefusedTrip(
  db: Db,
  input: { customerId: string; addressId: string; at: Date },
) {
  const truck = await createTruck(db);
  const date = toBusinessDate(input.at);
  const o = await createOrder(db, {
    customerId: input.customerId,
    addressId: input.addressId,
    date,
  });
  const t = await createScheduledTrip(db, {
    order: o,
    truckId: truck.id,
    date,
  });
  await db
    .update(trips)
    .set({
      status: "failed",
      failReason: "customer_refused",
      failedAt: input.at,
    })
    .where(eq(trips.id, t.id));
  return t;
}
