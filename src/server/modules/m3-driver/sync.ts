/**
 * M3 — handler perintah sinkron aplikasi sopir (outbox offline, docs/ARCHITECTURE.md §7; US-M3-09) + penyedia pull.
 *
 * | Perintah                         | Layanan               | Izin (kernet pengganti lewat `conditions`, US-M2-11) |
 * |----------------------------------|-----------------------|-------------------------------------------------------|
 * | `m3.trip.depart`                 | `departTrip`          | m3.trip.depart                                        |
 * | `m3.trip.arrive`                 | `arriveTrip`          | m3.trip.arrive                                        |
 * | `m3.trip.complete`               | `completeTrip`        | m3.trip.complete (+ m3.trip_payment.create)           |
 * | `m3.trip.fail`                   | `failTrip`            | m3.trip.fail                                          |
 * | `m3.field_credit.request`        | `requestFieldCredit`  | m3.field_credit.request                               |
 * | `m3.collection.create`           | `recordCollection`    | m3.collection.create                                  |
 * | `m3.trip_incident.create`        | `reportIncident`      | m3.trip_incident.create                               |
 * | `m3.travel_explanation.create`   | `explainFleetEvent`   | m3.travel_explanation.create                          |
 * | `m3.trip_expense.create`         | `recordExpense`       | m3.trip_expense.create                                |
 * | `m3.deposit.submit`              | `submitDeposit`       | m3.deposit.submit                                     |
 * | `m3.deposit.note`                | `addDepositorNote`    | m3.deposit.submit                                     |
 * | `m3.receipt.record`              | `recordReceipt`       | m3.receipt.send_wa                                    |
 * | `gps.phone_positions`            | `recordPhonePositions`| m3.trip.read (posisi ponsel cadangan, bukan tindakan) |
 *
 * Idempoten: ID perintah = kunci `sync_commands`; objek memakai ID perangkat (pelunasan, kendala, pengeluaran) atau
 * satu status per rit. Rit yang ditarik/dipindah kantor setelah diunduh tetap sah → `conflict` (Bab 6.4 butir 3).
 * Pull: `m3.today` (rit hari ini & semua data referensi offline) dan `m3.deposits` (riwayat setoran sendiri 90 hari).
 */
import "server-only";

import { eq } from "drizzle-orm";

import { fleetEvents, trips } from "@/db/schema";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { registerPullProvider, registerSyncHandler, type SyncHandlerResult } from "@/server/core/sync";

import {
  arriveSchema,
  collectionSchema,
  completeSchema,
  departSchema,
  depositNoteSchema,
  depositSubmitSchema,
  expenseSchema,
  explanationSchema,
  failSchema,
  fieldCreditSchema,
  incidentSchema,
  phonePositionsSchema,
  receiptSchema,
} from "./schemas";
import { recordCollection } from "./service/collections";
import { actingTruckId, fromSyncMeta, substituteConditionsAt } from "./service/common";
import { addDepositorNote, depositHolderConditions, submitDeposit } from "./service/deposits";
import { recordExpense } from "./service/expenses";
import { recordPhonePositions } from "./service/gps";
import { explainFleetEvent, reportIncident } from "./service/incidents";
import { requestFieldCredit } from "./service/payments";
import { buildDepositHistory, buildToday } from "./service/pull";
import { recordReceipt } from "./service/receipts";
import { arriveTrip, completeTrip, departTrip, failTrip, type TripActionResult } from "./service/trips";

/**
 * Kondisi izin kernet pengganti (US-M2-11) dinilai pada WAKTU PERANGKAT (`ctx.deviceTime`, Bab 6.4 butir 3): kernet
 * yang menjadi pengemudi pengganti saat tindakan dicatat tetap sah walau Dispatcher mengubah penetapan sebelum sinkron.
 */
async function conditionsFor(tx: Tx, ctx: ActorContext, tripId?: string | null) {
  const date = ctxBusinessDate(ctx);
  const trip = tripId ? (await tx.select({ truckId: trips.truckId, driverUserId: trips.driverUserId }).from(trips).where(eq(trips.id, tripId)).limit(1))[0] ?? null : null;
  const truckId = trip?.truckId ?? (await actingTruckId(tx, ctx, date));
  return truckId ? substituteConditionsAt(tx, ctx, truckId, date, trip) : { substitute_driver: false };
}

function tripResult(res: TripActionResult): SyncHandlerResult {
  const base = {
    objectType: "trip",
    objectId: res.trip.id,
    result: { status: res.trip.status, duplicate: res.duplicate, ...(res.payment ? { tripPaymentId: res.payment.id } : {}), ...(res.details ?? {}) },
  };
  return res.conflict ? { ...base, status: "conflict", message: res.conflict } : base;
}

/** Koleksi delta pull `m3.today` (jalur → ukuran ember sasaran). */
export const DRIVER_TODAY_PULL_COLLECTIONS = {
  trips: 1,
  payments: 2,
  collections: 2,
  expenses: 2,
  invoicesByCustomer: 1,
  explanationTasks: 2,
  notices: 2,
  withdrawn: 2,
  bankAccounts: 4,
  receiptTemplates: 1,
} as const;

export function registerSync(): void {
  const labels = { tripId: "Rit", location: "Lokasi" };

  registerSyncHandler("m3.trip.depart", {
    permission: "m3.trip.depart",
    conditions: (ctx, p, { tx }) => conditionsFor(tx, ctx, p.tripId),
    schema: departSchema,
    labels,
    description: "Berangkat (waktu perangkat + GPS + akurasi; US-M3-02).",
    handle: async (ctx, p, meta) => tripResult(await departTrip(ctx, p, fromSyncMeta(meta))),
  });

  registerSyncHandler("m3.trip.arrive", {
    permission: "m3.trip.arrive",
    conditions: (ctx, p, { tx }) => conditionsFor(tx, ctx, p.tripId),
    schema: arriveSchema,
    labels,
    description: "Tiba (jarak ke alamat; US-M3-02 KP-3).",
    handle: async (ctx, p, meta) => tripResult(await arriveTrip(ctx, p, fromSyncMeta(meta))),
  });

  registerSyncHandler("m3.trip.complete", {
    permission: "m3.trip.complete",
    conditions: (ctx, p, { tx }) => conditionsFor(tx, ctx, p.tripId),
    schema: completeSchema,
    labels: { ...labels, recipientName: "Nama penerima", deliveredVolumeL: "Volume terkirim", payment: "Pembayaran" },
    description: "Selesai: bukti kirim + pembayaran (US-M3-03, US-M3-04).",
    handle: async (ctx, p, meta) => tripResult(await completeTrip(ctx, p, fromSyncMeta(meta))),
  });

  registerSyncHandler("m3.trip.fail", {
    permission: "m3.trip.fail",
    conditions: (ctx, p, { tx }) => conditionsFor(tx, ctx, p.tripId),
    schema: failSchema,
    labels: { ...labels, reason: "Alasan", loadedWaterDisposition: "Tindak lanjut air dimuat" },
    description: "Rit gagal (US-M3-06 KP-1/KP-2).",
    handle: async (ctx, p, meta) => tripResult(await failTrip(ctx, p, fromSyncMeta(meta))),
  });

  registerSyncHandler("m3.field_credit.request", {
    permission: "m3.field_credit.request",
    conditions: (ctx, p, { tx }) => conditionsFor(tx, ctx, p.tripId),
    schema: fieldCreditSchema,
    labels: { reason: "Alasan" },
    description: "Permintaan tunai → tempo di lokasi (persetujuan Dispatcher, PTB-19).",
    handle: async (ctx, p, meta) => {
      const res = await requestFieldCredit(ctx, p, fromSyncMeta(meta));
      return { objectType: "approval_request", objectId: res.approval.id, result: { number: res.approval.number, deadlineAt: res.approval.deadlineAt?.toISOString() ?? null } };
    },
  });

  registerSyncHandler("m3.collection.create", {
    permission: "m3.collection.create",
    conditions: (ctx, p, { tx }) => conditionsFor(tx, ctx, p.tripId),
    schema: collectionSchema,
    labels: { amount: "Jumlah pelunasan", invoiceIds: "Faktur" },
    description: "Pelunasan piutang pelanggan rit hari ini (US-M3-05).",
    handle: async (ctx, p, meta) => {
      const res = await recordCollection(ctx, p, fromSyncMeta(meta));
      const base = { objectType: "customer_payment", objectId: res.payment.id, result: { allocations: res.allocations, advanceAmount: res.advanceAmount, duplicate: res.duplicate } };
      return res.conflict ? { ...base, status: "conflict" as const, message: res.conflict } : base;
    },
  });

  registerSyncHandler("m3.trip_incident.create", {
    permission: "m3.trip_incident.create",
    conditions: (ctx, p, { tx }) => conditionsFor(tx, ctx, p.tripId ?? null),
    schema: incidentSchema,
    labels: { kind: "Jenis kendala", description: "Catatan" },
    description: "Kendala perjalanan tanpa mengakhiri rit (US-M3-06 KP-3).",
    handle: async (ctx, p, meta) => {
      const res = await reportIncident(ctx, p, fromSyncMeta(meta));
      return { objectType: "trip_incident", objectId: res.incident.id, result: { duplicate: res.duplicate } };
    },
  });

  registerSyncHandler("m3.travel_explanation.create", {
    permission: "m3.travel_explanation.create",
    conditions: async (ctx, p, { tx }) => {
      const ev = (await tx.select({ truckId: fleetEvents.truckId }).from(fleetEvents).where(eq(fleetEvents.id, p.fleetEventId)).limit(1))[0];
      return ev?.truckId ? substituteConditionsAt(tx, ctx, ev.truckId, ctxBusinessDate(ctx)) : { substitute_driver: false };
    },
    schema: explanationSchema,
    labels: { explanation: "Keterangan" },
    description: "Keterangan perjalanan di luar jadwal/jam (BR-25).",
    handle: async (ctx, p, meta) => {
      const res = await explainFleetEvent(ctx, p, fromSyncMeta(meta));
      const base = { objectType: "fleet_event", objectId: res.event.id, result: { late: res.event.explanationLate, duplicate: res.duplicate } };
      return res.conflict ? { ...base, status: "conflict" as const, message: res.conflict } : base;
    },
  });

  registerSyncHandler("m3.trip_expense.create", {
    permission: "m3.trip_expense.create",
    conditions: (ctx, p, { tx }) => conditionsFor(tx, ctx, p.tripId ?? null),
    schema: expenseSchema,
    labels: { kind: "Jenis", amount: "Jumlah", fundingSource: "Sumber dana" },
    description: "Pengeluaran rit dengan foto nota (US-M3-08).",
    handle: async (ctx, p, meta) => {
      const res = await recordExpense(ctx, p, fromSyncMeta(meta));
      const base = { objectType: "trip_expense", objectId: res.expense.id, result: { status: res.expense.status, duplicate: res.duplicate } };
      return res.conflict ? { ...base, status: "conflict" as const, message: res.conflict } : base;
    },
  });

  registerSyncHandler("m3.deposit.submit", {
    permission: "m3.deposit.submit",
    // US-M2-11 KP-3: masing-masing menyetor kas yang diterimanya — kernet yang memegang kas dari masa pengganti tetap dapat Setor.
    conditions: (ctx, _p, { tx }) => depositHolderConditions(tx, ctx),
    schema: depositSubmitSchema,
    labels: { method: "Cara setor" },
    description: "Setor: ringkasan terkunci, status Diajukan (US-M3-07).",
    handle: async (ctx, p, meta) => {
      const res = await submitDeposit(ctx, p, fromSyncMeta(meta));
      return {
        objectType: "deposit",
        objectId: res.deposit.id,
        result: { number: res.deposit.number, expectedNet: res.deposit.expectedNet, late: res.late, waitingSync: res.waitingSync, duplicate: res.duplicate },
      };
    },
  });

  registerSyncHandler("m3.deposit.note", {
    permission: "m3.deposit.submit",
    conditions: (ctx, _p, { tx }) => depositHolderConditions(tx, ctx, { anyStatus: true }),
    schema: depositNoteSchema,
    labels: { note: "Keterangan" },
    description: "Keterangan sopir atas selisih setoran (US-M3-07 KP-4).",
    handle: async (ctx, p, meta) => {
      const res = await addDepositorNote(ctx, p, fromSyncMeta(meta));
      return { objectType: "deposit", objectId: res.deposit.id, result: { duplicate: res.duplicate } };
    },
  });

  registerSyncHandler("m3.receipt.record", {
    permission: "m3.receipt.send_wa",
    conditions: async (ctx, p, { tx }) => conditionsFor(tx, ctx, p.tripId ?? null),
    schema: receiptSchema,
    labels: { reasonText: "Alasan" },
    description: "Struk WA dibuka / dilewati beralasan (US-M3-03 KP-7).",
    handle: async (ctx, p, meta) => {
      const res = await recordReceipt(ctx, p, fromSyncMeta(meta));
      return { objectType: p.kind === "trip_receipt" ? "trip" : "customer_payment", objectId: res.objectId, result: { status: res.status, duplicate: res.duplicate } };
    },
  });

  registerSyncHandler("gps.phone_positions", {
    permission: "m3.trip.read",
    schema: phonePositionsSchema,
    labels: { positions: "Posisi" },
    description: "Posisi GPS ponsel cadangan selama rit aktif (US-M3-02 KP-5).",
    handle: async (ctx, p, meta) => {
      const res = await recordPhonePositions(ctx, p, fromSyncMeta(meta));
      return { objectType: "truck", objectId: p.truckId, result: res };
    },
  });

  registerPullProvider("m3.today", {
    roles: ["driver", "helper"],
    fetch: ({ ctx, tx, since, now }) => buildToday(tx, ctx, since, { now }),
    // Pull bersyarat v1.0.1 (D-14 butir 3): rit berubah per butir (Berangkat/Tiba/Selesai), pembayaran/pelunasan/
    // pengeluaran tumbuh sepanjang hari → hanya butir yang berubah dikirim ulang setelah push.
    collections: DRIVER_TODAY_PULL_COLLECTIONS,
  });
  registerPullProvider("m3.deposits", {
    roles: ["driver", "helper"],
    fetch: ({ ctx, tx, since }) => buildDepositHistory(tx, ctx, since),
  });
}
