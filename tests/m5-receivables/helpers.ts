/**
 * Pembantu uji modul M5 (bukan berkas uji): pelanggan Tempo baru per kasus (data demo tidak memengaruhi hasil),
 * penerbitan faktur lewat buku piutang M5 dengan tanggal eksplisit, konteks aktor seed dengan waktu terkendali,
 * dan lampiran uji (bukti transfer/perjanjian).
 */
import { and, eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import { customers, invoices, notifications } from "@/db/schema";
import type { EnumValue, InvoiceKind } from "@/lib/labels";
import { addDays, toBusinessDate, wibToUtc, type BusinessDate } from "@/lib/time";
import { systemContext, type ActorContext } from "@/server/core/context";
import { withTx } from "@/server/core/db";
import { put } from "@/server/core/storage";

import { issueInvoice } from "@/server/modules/m5-receivables/service/ledger";

import { seededContext } from "../helpers/context";
import { createCustomer, type CustomerFixture } from "../helpers/fixtures";

export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
export const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

/** Tanggal bisnis hari ini (WIB) & waktu tengah hari WIB untuk tanggal tertentu. */
export const today = (): BusinessDate => toBusinessDate(new Date());
export const noonOf = (date: BusinessDate): Date => wibToUtc(date, "12:00");

export const owner = (date?: BusinessDate) => seededContext("pemilik", date ? { now: noonOf(date) } : {});
export const finance = (date?: BusinessDate) => seededContext("keuangan1", date ? { now: noonOf(date) } : {});
export const dispatcher = (date?: BusinessDate) => seededContext("dispatcher1", date ? { now: noonOf(date) } : {});
export const accountant = () => seededContext("akuntan");
export const system = (date?: BusinessDate) => systemContext({ now: date ? noonOf(date) : new Date() });

/** Pelanggan Tempo baru (bukan rumah tangga) dengan batas & tempo. */
export async function creditCustomer(
  db: Db,
  o: { creditStatus?: EnumValue<"credit_status">; creditLimit?: number; term?: number; monthly?: boolean; segment?: EnumValue<"customer_segment">; name?: string } = {},
): Promise<CustomerFixture> {
  const c = await createCustomer(db, { segment: o.segment ?? "hotel", creditStatus: o.creditStatus ?? "credit", creditLimit: o.creditLimit ?? 10_000_000, name: o.name });
  await db
    .update(customers)
    .set({ paymentTermDays: o.term ?? 14, monthlyBilling: o.monthly ?? false })
    .where(eq(customers.id, c.id));
  return c;
}

/** Terbitkan faktur lewat buku piutang (nomor resmi, audit, event). */
export async function invoiceFor(
  db: Db,
  customerId: string,
  o: { amount: number; issueDate: BusinessDate; dueDate?: BusinessDate; kind?: InvoiceKind; ctx?: ActorContext; opening?: boolean },
) {
  void db;
  return withTx((tx) =>
    issueInvoice(tx, o.ctx ?? system(o.issueDate), {
      tenantId: o.ctx?.tenantId ?? system().tenantId,
      customerId,
      kind: o.kind ?? "delivery",
      issueDate: o.issueDate,
      dueDate: o.dueDate ?? addDays(o.issueDate, 14),
      isOpeningBalance: o.opening ?? false,
      lines: [{ component: o.kind === "store_sale" ? "store_item" : "trip", description: "Uji", quantity: 1, unitPrice: o.amount, amount: o.amount }],
    }),
  );
}

export async function invoiceRow(db: Db, id: string) {
  const [row] = await db.select().from(invoices).where(eq(invoices.id, id));
  return row!;
}

export async function customerRow(db: Db, id: string) {
  const [row] = await db.select().from(customers).where(eq(customers.id, id));
  return row!;
}

/** Lampiran uji (JPEG/PDF) yang diunggah pelaku. */
export async function attachment(ctx: ActorContext, kind: string, pdf = false) {
  return withTx((tx) => put(tx, ctx, { blob: pdf ? PDF : JPEG, contentType: pdf ? "application/pdf" : "image/jpeg", kind, originalName: pdf ? "perjanjian.pdf" : "bukti.jpg" }));
}

export async function notificationsFor(db: Db, event: string, objectId?: string) {
  return db.select().from(notifications).where(objectId ? and(eq(notifications.event, event), eq(notifications.objectId, objectId)) : eq(notifications.event, event));
}
