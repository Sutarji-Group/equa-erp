/**
 * P2 — reaksi atas event domain Tahap 1 (handler didaftarkan `events.ts`, terisolasi savepoint).
 *
 * - `order.status_changed` → Terjadwal: pesanan aplikasi dianggap Dikonfirmasi (Dispatcher menjadwalkan) + notifikasi
 *   "Dikonfirmasi" (US-P2-02 KP-4, US-P2-03 KP-4); pelanggan tanpa aplikasi tetap menerima WA konfirmasi bila Cloud API
 *   aktif dan belum dikirim dari layar M2 (US-P2-08 KP-1/KP-2). → Dibatalkan oleh kantor: pemberitahuan beralasan.
 * - `trip.departed` / `trip.completed` / `trip.failed` → notifikasi Berangkat / Selesai (+ struk digital WA otomatis,
 *   US-M3-03 KP-7 versi Tahap 2) / Gagal beralasan layak pelanggan (US-P2-03 KP-1/KP-4).
 * - `transfer.matched` transfer "pembayaran digital" → status pembayaran Dicocokkan (US-P2-04 KP-3).
 * Rit internal (pasokan depot) diabaikan.
 */
import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { customerAppOrders, employees, orders, trips, trucks, waMessageLogs } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggalJam } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { systemContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import type { DomainEvent } from "@/server/core/events";

import { firstName } from "./common";
import { isAutoWaActive, notifyCustomer } from "./messaging";
import { notifyConfirmed } from "./orders";
import { markIntentMatched } from "./payments";

async function loadTripView(tx: Tx, tripId: string) {
  const [row] = await tx
    .select({ t: trips, orderNumber: orders.number, isInternal: orders.isInternal, plate: trucks.plateNumber, driverName: employees.fullName })
    .from(trips)
    .innerJoin(orders, eq(orders.id, trips.orderId))
    .leftJoin(trucks, eq(trucks.id, trips.truckId))
    .leftJoin(employees, eq(employees.id, trips.driverEmployeeId))
    .where(eq(trips.id, tripId))
    .limit(1);
  return row ?? null;
}

async function waAlreadySent(tx: Tx, orderId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: waMessageLogs.id })
    .from(waMessageLogs)
    .where(and(eq(waMessageLogs.objectType, "order"), eq(waMessageLogs.objectId, orderId), eq(waMessageLogs.kind, "order_confirmation"), inArray(waMessageLogs.status, ["sent", "delivered", "read"])))
    .limit(1);
  return !!row;
}

export async function onOrderStatusChanged(event: DomainEvent<"order.status_changed">, tx: Tx): Promise<void> {
  const p = event.payload;
  const [order] = await tx.select().from(orders).where(eq(orders.id, p.orderId)).limit(1);
  if (!order || order.isInternal) return;
  const [app] = await tx.select().from(customerAppOrders).where(eq(customerAppOrders.orderId, order.id)).limit(1).for("update");
  if (p.to === "scheduled") {
    if (app && !app.confirmedAt && !app.rejectedAt) {
      await tx.update(customerAppOrders).set({ confirmedAt: event.occurredAt, confirmedBy: event.actorUserId, updatedAt: event.occurredAt }).where(eq(customerAppOrders.id, app.id));
      await auditRecord(tx, {
        ctx: systemContext({ tenantId: order.tenantId, now: event.occurredAt }),
        objectType: "order",
        objectId: order.id,
        action: "confirm",
        after: { confirmedAt: event.occurredAt, via: "schedule", late: !!app.confirmDueAt && app.confirmDueAt < event.occurredAt },
        rule: "US-P2-02 KP-4, PAR-75",
      });
    }
    // Pelanggan tanpa aplikasi: WA otomatis hanya bila Cloud API aktif dan konfirmasi belum dikirim dari layar M2.
    const wa = isAutoWaActive() && !(await waAlreadySent(tx, order.id));
    await notifyConfirmed(tx, { tenantId: order.tenantId, order, now: event.occurredAt, waEvenWithoutApp: wa, skipWa: !wa });
    return;
  }
  if (p.to === "cancelled") {
    if (app?.cancelledByCustomerAt || p.cancelReason === "customer_cancelled") return;
    const rejected = p.cancelReason === "rejected_by_dispatcher";
    const reason = p.reason ?? order.cancelNote ?? label("order_cancel_reason", p.cancelReason ?? order.cancelReason);
    await notifyCustomer(tx, {
      tenantId: order.tenantId,
      customerId: order.customerId,
      kind: rejected ? "order_rejected" : "order_cancelled",
      title: rejected ? `Pesanan ${order.number} tidak dapat dilayani` : `Pesanan ${order.number} dibatalkan kantor`,
      body: `${reason ?? "Hubungi kantor EQUA untuk keterangan."}${rejected ? " Anda dapat memesan untuk tanggal lain atau menelepon kantor." : ""}`,
      link: `/app/pesanan/${order.id}`,
      objectType: "order",
      objectId: order.id,
      dedupeKey: `order_cancelled:${order.id}`,
      now: event.occurredAt,
      wa: { kind: "order_status", text: `EQUA: pesanan ${order.number} ${rejected ? "tidak dapat dilayani" : "dibatalkan"}. ${reason ?? ""}`.trim(), variables: { nomor_pesanan: order.number, status: rejected ? "Ditolak" : "Dibatalkan" } },
    });
  }
}

export async function onTripDeparted(event: DomainEvent<"trip.departed">, tx: Tx): Promise<void> {
  const v = await loadTripView(tx, event.payload.tripId);
  if (!v || v.isInternal || event.payload.isInternal) return;
  const who = `${v.plate ?? "truk EQUA"}${v.driverName ? ` (sopir ${firstName(v.driverName)})` : ""}`;
  await notifyCustomer(tx, {
    tenantId: v.t.tenantId,
    customerId: v.t.customerId,
    kind: "delivery_departed",
    title: `Truk berangkat — pesanan ${v.orderNumber}`,
    body: `Truk ${who} sedang menuju alamat Anda. Lihat posisi & perkiraan tiba di aplikasi.`,
    link: `/app/pesanan/${v.t.orderId}`,
    objectType: "trip",
    objectId: v.t.id,
    dedupeKey: `trip_departed:${v.t.id}`,
    now: event.occurredAt,
    wa: { kind: "order_status", text: `EQUA: truk ${who} berangkat menuju alamat Anda (pesanan ${v.orderNumber}).`, variables: { nomor_pesanan: v.orderNumber, status: "Berangkat", truk: who } },
    waEvenWithoutApp: true,
  });
}

export async function onTripCompleted(event: DomainEvent<"trip.completed">, tx: Tx): Promise<void> {
  const p = event.payload;
  if (p.isInternal) return;
  const v = await loadTripView(tx, p.tripId);
  if (!v || v.isInternal) return;
  const volume = `${(p.volumeL ?? v.t.deliveredVolumeL ?? 0).toLocaleString("id-ID")} L`;
  const pay = label("payment_method", p.paymentMethod);
  const when = formatTanggalJam(new Date(p.completedAt));
  await notifyCustomer(tx, {
    tenantId: v.t.tenantId,
    customerId: v.t.customerId,
    kind: "delivery_completed",
    title: `Air sudah diterima — ${v.t.number}`,
    body: `${volume} diterima ${when}${v.t.recipientName ? ` oleh ${v.t.recipientName}` : ""}. Struk digital & penilaian tersedia di aplikasi.`,
    link: `/app/struk/${v.t.id}`,
    objectType: "trip",
    objectId: v.t.id,
    dedupeKey: `trip_completed:${v.t.id}`,
    now: event.occurredAt,
    // Struk digital (US-M3-03 KP-7 versi otomatis Tahap 2; US-P2-08 KP-1).
    wa: {
      kind: "trip_receipt",
      text: `Struk EQUA ${v.t.number}: ${volume}, ${when}, harga ${formatRupiah(p.price)}, bayar ${pay}${p.creditAmount > 0 ? ` (tempo ${formatRupiah(p.creditAmount)})` : ""}${p.underpaymentAmount > 0 ? ` (kurang bayar ${formatRupiah(p.underpaymentAmount)})` : ""}. Terima kasih.`,
      variables: { nomor_rit: v.t.number, volume, waktu: when, harga: formatRupiah(p.price), cara_bayar: pay },
    },
    waEvenWithoutApp: true,
  });
}

export async function onTripFailed(event: DomainEvent<"trip.failed">, tx: Tx): Promise<void> {
  const p = event.payload;
  if (p.isInternal) return;
  const v = await loadTripView(tx, p.tripId);
  if (!v || v.isInternal) return;
  const reason = label("customer_fail_reason", p.reason);
  await notifyCustomer(tx, {
    tenantId: v.t.tenantId,
    customerId: v.t.customerId,
    kind: "delivery_failed",
    title: `Pengiriman ${v.t.number} gagal`,
    body: `${reason}. Kantor EQUA akan menghubungi Anda untuk jadwal ulang.`,
    link: `/app/pesanan/${v.t.orderId}`,
    objectType: "trip",
    objectId: v.t.id,
    dedupeKey: `trip_failed:${v.t.id}`,
    now: event.occurredAt,
    wa: { kind: "order_status", text: `EQUA: pengiriman ${v.t.number} gagal — ${reason}. Kantor akan menghubungi Anda untuk jadwal ulang.`, variables: { nomor_pesanan: v.orderNumber, status: "Gagal", alasan: reason } },
    waEvenWithoutApp: true,
  });
}

export async function onTransferMatched(event: DomainEvent<"transfer.matched">, tx: Tx): Promise<void> {
  if (event.payload.sourceKind !== "digital_payment") return;
  await markIntentMatched(tx, { incomingTransferId: event.payload.incomingTransferId, now: event.occurredAt });
}
