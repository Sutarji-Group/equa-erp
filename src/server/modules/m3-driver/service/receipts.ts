/**
 * M3 — struk WA versi tautan (US-M3-03 KP-7, PTB-29; bukti pelunasan US-M3-05 KP-5 S). Perangkat merender template
 * (pull `m3.today`) dan membuka `wa.me` dalam satu ketukan; perintah `m3.receipt.record` mencatat "dibuka"
 * (`wa_message_logs`) atau "dilewati" dengan alasan singkat (`trips.receipt_skipped_reason`).
 */
import "server-only";

import { and, eq } from "drizzle-orm";

import { customerPayments, customers, tripPayments, trips, waMessageLogs, waTemplates } from "@/db/schema";
import { label } from "@/lib/labels";

import { record as auditRecord } from "@/server/core/audit";
import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, parseInput } from "@/server/core/errors";
import { normalizeWaNumber, recordWaOpened } from "@/server/core/wa";

import { receiptSchema } from "../schemas";
import { assertActingOnTruck, loadTrip, type M3WriteMeta } from "./common";

export async function activeTemplates(tx: Tx, tenantId: string): Promise<{ trip_receipt: string | null; payment_receipt: string | null }> {
  const rows = await tx
    .select({ kind: waTemplates.kind, body: waTemplates.body })
    .from(waTemplates)
    .where(and(eq(waTemplates.tenantId, tenantId), eq(waTemplates.isActive, true)));
  return {
    trip_receipt: rows.find((r) => r.kind === "trip_receipt")?.body ?? null,
    payment_receipt: rows.find((r) => r.kind === "payment_receipt")?.body ?? null,
  };
}

export async function recordReceipt(ctx: ActorContext, input: unknown, meta: M3WriteMeta): Promise<{ status: "opened" | "skipped"; objectId: string; duplicate: boolean }> {
  const data = parseInput(receiptSchema, input, { reasonText: "Alasan", toPhone: "Nomor WA" });
  const tx = meta.tx;
  let tripId: string;
  let customerId: string;
  let objectType: "trip" | "customer_payment";
  let objectId: string;
  if (data.kind === "trip_receipt") {
    const trip = await loadTrip(tx, data.tripId!);
    await assertActingOnTruck(tx, ctx, "m3.receipt.send_wa", trip.truckId, meta.businessDate, meta);
    const paid = await tx.select({ id: tripPayments.id }).from(tripPayments).where(eq(tripPayments.tripId, trip.id)).limit(1);
    if (trip.status !== "completed" || !paid[0]) throw new DomainError("PAYMENT_NOT_RECORDED", "Struk dikirim setelah rit Selesai dan pembayaran tercatat.");
    tripId = trip.id;
    customerId = trip.customerId;
    objectType = "trip";
    objectId = trip.id;
  } else {
    const rows = await tx.select().from(customerPayments).where(eq(customerPayments.id, data.customerPaymentId!)).limit(1);
    const pay = rows[0];
    if (!pay || pay.channel !== "driver") throw new DomainError("PAYMENT_NOT_FOUND", "Pelunasan tidak ditemukan. Kirim data dulu lalu coba lagi.");
    const trip = pay.tripId ? await loadTrip(tx, pay.tripId) : null;
    await assertActingOnTruck(tx, ctx, "m3.receipt.send_wa", trip?.truckId ?? null, meta.businessDate, meta);
    tripId = trip?.id ?? "";
    customerId = pay.customerId;
    objectType = "customer_payment";
    objectId = pay.id;
  }
  if (data.action === "opened") {
    const dup = meta.commandId
      ? await tx.select({ id: waMessageLogs.id }).from(waMessageLogs).where(and(eq(waMessageLogs.objectType, objectType), eq(waMessageLogs.objectId, objectId), eq(waMessageLogs.kind, data.kind))).limit(1)
      : [];
    const cust = (await tx.select({ waPhone: customers.waPhone }).from(customers).where(eq(customers.id, customerId)).limit(1))[0];
    const phone = normalizeWaNumber(data.toPhone ?? cust?.waPhone ?? null);
    if (!phone) throw new DomainError("WA_NUMBER_INVALID", "Nomor WA pelanggan tidak valid. Lewati struk dengan alasan, lalu minta Dispatcher memperbaiki nomor.");
    if (dup[0]) return { status: "opened", objectId, duplicate: true };
    await recordWaOpened(tx, { ...ctx, now: meta.deviceTime }, { kind: data.kind, toPhone: phone, renderedText: data.renderedText ?? "", customerId, objectType, objectId });
    if (tripId) await tx.update(trips).set({ updatedAt: ctx.now }).where(eq(trips.id, tripId));
    return { status: "opened", objectId, duplicate: false };
  }
  // Dilewati dengan alasan singkat (pelanggan tidak memakai WA).
  const reason = data.reasonCode ? `${label("receipt_skip_reason", data.reasonCode)}${data.reasonText ? `: ${data.reasonText}` : ""}` : (data.reasonText ?? "");
  if (reason.trim().length < 3) throw new DomainError("REASON_REQUIRED", "Pilih alasan melewati struk WA.");
  if (data.kind === "trip_receipt") {
    await tx.update(trips).set({ receiptSkippedReason: reason, updatedAt: ctx.now }).where(eq(trips.id, tripId));
    await auditRecord(tx, { ctx, objectType: "trip", objectId: tripId, action: "receipt_skipped", after: { receiptSkippedReason: reason }, rule: "US-M3-03 KP-7", businessDate: meta.businessDate });
  }
  return { status: "skipped", objectId, duplicate: false };
}
