/**
 * M3 — pencatatan darurat "dicatat kantor" (Bab 6.1, US-M3-09 KP-5): perangkat sopir rusak/hilang dengan antrean
 * belum terkirim → Admin Keuangan mencatat Selesai + pembayaran atau Gagal atas nama sopir berdasarkan bukti yang ada,
 * dengan alasan wajib & penanda `recorded_by_office` (dihitung "tidak di sumber" pada KPI-01); kejadian dilaporkan ke
 * pemilik (`device.lost_queue`). Tidak ada jalur lain untuk "input rit atas nama sopir" di kantor.
 */
import "server-only";

import { and, asc, desc, eq, gte, isNotNull, lte, or } from "drizzle-orm";

import { customerPayments, customers, deposits, devices, employees, orders, tripPayments, trips, trucks, users } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, toBusinessDate, wibToUtc, type BusinessDate } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, parseInput } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import { authorize, runService } from "@/server/core/rbac";
import { getAttachment, put as putAttachment } from "@/server/core/storage";
import { resolveDayCrews } from "@/server/modules/m2-orders";

import { officeCompleteSchema, officeFailSchema } from "../schemas";
import { loadTrip, type M3WriteMeta, type TripRow } from "./common";
import { driverDaySyncStatus, type DriverDaySyncStatus } from "./deposits";
import { completeTrip, failTrip } from "./trips";

/** Sopir atas nama siapa rit dicatat: pelaksana rit (bila sudah Berangkat) atau pengemudi hari itu (jadwal kru). */
async function onBehalfOf(tx: Tx, trip: TripRow): Promise<{ userId: string; employeeId: string | null; name: string | null }> {
  if (trip.driverUserId) {
    const r = (await tx.select({ employeeId: users.employeeId, name: employees.fullName }).from(users).leftJoin(employees, eq(employees.id, users.employeeId)).where(eq(users.id, trip.driverUserId)).limit(1))[0];
    return { userId: trip.driverUserId, employeeId: r?.employeeId ?? null, name: r?.name ?? null };
  }
  if (!trip.truckId) throw new DomainError("TRIP_NOT_SCHEDULED", "Rit belum ditugaskan ke truk — tidak dapat dicatat atas nama sopir.");
  const crews = await resolveDayCrews(tx, trip.tenantId, trip.scheduledDate, trip.scheduledDate, [trip.truckId]);
  const emp = crews.get(trip.truckId)?.driverEmployeeId ?? null;
  if (!emp) throw new DomainError("NO_DRIVER", "Pengemudi truk pada tanggal rit tidak ditemukan di jadwal kru. Tetapkan pengemudi di Jadwal kru dulu.");
  const u = (await tx.select({ id: users.id, name: employees.fullName }).from(users).innerJoin(employees, eq(employees.id, users.employeeId)).where(eq(users.employeeId, emp)).limit(1))[0];
  if (!u) throw new DomainError("NO_DRIVER_ACCOUNT", "Pengemudi rit belum memiliki akun aplikasi. Hubungi admin sistem.");
  return { userId: u.id, employeeId: emp, name: u.name };
}

function officeMeta(tx: Tx, ctx: ActorContext, trip: TripRow, occurredTime: string, reason: string): M3WriteMeta {
  const date = trip.scheduledDate;
  return {
    tx,
    deviceId: null,
    deviceTime: wibToUtc(date, occurredTime),
    businessDate: date,
    commandId: null,
    receivedAt: ctx.now,
    lateSync: date < toBusinessDate(ctx.now),
    clockSkewFlagged: false,
    attachments: [],
    office: { reason, recordedBy: ctx.userId! },
  };
}

async function reportToOwner(tx: Tx, ctx: ActorContext, trip: TripRow, what: string, driverName: string | null, reason: string): Promise<void> {
  await notify(tx, {
    event: "device.lost_queue",
    tenantId: trip.tenantId,
    title: `Dicatat kantor: ${what} rit ${trip.number}`,
    body: `Atas nama ${driverName ?? "sopir"} oleh Admin Keuangan. Alasan: ${reason}. Dihitung "tidak di sumber" pada KPI-01.`,
    objectType: "trip",
    objectId: trip.id,
    link: "/sopir-kantor/laporan",
    groupKey: `office_entry:${trip.id}`,
    now: ctx.now,
  });
}

async function assertEvidence(tx: Tx, ctx: ActorContext, attachmentId: string | null | undefined): Promise<void> {
  if (!attachmentId) return;
  const att = await getAttachment(tx, attachmentId);
  if (!att || att.tenantId !== ctx.tenantId || att.uploadedBy !== ctx.userId || att.objectType) {
    throw new DomainError("EVIDENCE_INVALID", "Berkas bukti tidak valid. Unggah ulang foto/berkas bukti.");
  }
}

/** Admin Keuangan mencatat rit Selesai + pembayaran atas nama sopir (US-M3-09 KP-5). */
export async function officeCompleteTrip(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m3.office_entry.create", { tx: opts.tx });
  const data = parseInput(officeCompleteSchema, input, { reason: "Alasan", recipientName: "Nama penerima", deliveredVolumeL: "Volume", occurredTime: "Jam kejadian" });
  return runService(ctx, opts, async (tx) => {
    const trip = await loadTrip(tx, data.tripId, { forUpdate: true });
    if (trip.tenantId !== ctx.tenantId) throw new DomainError("NOT_FOUND", "Rit tidak ditemukan.");
    if (trip.status === "completed" || trip.status === "failed") {
      throw new DomainError("TRIP_DONE", `Rit ${trip.number} sudah ${label("trip_status", trip.status)} — tidak perlu dicatat kantor. Koreksi lewat transaksi pembalik.`);
    }
    await assertEvidence(tx, ctx, data.evidenceAttachmentId);
    const who = await onBehalfOf(tx, trip);
    const meta = officeMeta(tx, ctx, trip, data.occurredTime, data.reason);
    const res = await completeTrip(
      ctx,
      {
        tripId: trip.id,
        recipientName: data.recipientName,
        deliveredVolumeL: data.deliveredVolumeL,
        partialVolumeReason: data.partialVolumeReason ?? null,
        partialVolumeNote: data.partialVolumeNote ?? null,
        location: null,
        payment: data.payment,
      },
      meta,
      { actingUserId: who.userId, actingEmployeeId: who.employeeId, officeEvidenceAttachmentId: data.evidenceAttachmentId ?? null },
    );
    await reportToOwner(tx, ctx, trip, "Selesai + pembayaran", who.name, data.reason);
    return { ...res, driverName: who.name };
  });
}

/** Admin Keuangan mencatat rit Gagal atas nama sopir (US-M3-09 KP-5). */
export async function officeFailTrip(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m3.office_entry.create", { tx: opts.tx });
  const data = parseInput(officeFailSchema, input, { reason: "Alasan", failReason: "Alasan gagal", occurredTime: "Jam kejadian" });
  return runService(ctx, opts, async (tx) => {
    const trip = await loadTrip(tx, data.tripId, { forUpdate: true });
    if (trip.tenantId !== ctx.tenantId) throw new DomainError("NOT_FOUND", "Rit tidak ditemukan.");
    if (trip.status === "completed" || trip.status === "failed") {
      throw new DomainError("TRIP_DONE", `Rit ${trip.number} sudah ${label("trip_status", trip.status)} — tidak perlu dicatat kantor.`);
    }
    await assertEvidence(tx, ctx, data.evidenceAttachmentId);
    const who = await onBehalfOf(tx, trip);
    const meta = officeMeta(tx, ctx, trip, data.occurredTime, data.reason);
    const res = await failTrip(
      ctx,
      { tripId: trip.id, reason: data.failReason, note: data.note ?? null, loadedWaterDisposition: data.loadedWaterDisposition, location: null },
      meta,
      { actingUserId: who.userId, actingEmployeeId: who.employeeId, officeEvidenceAttachmentId: data.evidenceAttachmentId ?? null },
    );
    await reportToOwner(tx, ctx, trip, "Gagal", who.name, data.reason);
    return { ...res, driverName: who.name };
  });
}

/** Unggah bukti (foto nota kertas, tangkapan layar transfer) untuk pencatatan kantor. */
export async function uploadOfficeEvidence(ctx: ActorContext, file: { bytes: Uint8Array; contentType: string; name?: string | null }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m3.office_entry.create", { tx: opts.tx });
  return runService(ctx, opts, (tx) => putAttachment(tx, ctx, { blob: file.bytes, contentType: file.contentType, kind: "office_evidence", originalName: file.name ?? null }));
}

// =====================================================================================================================
// Tampilan kantor
// =====================================================================================================================

export type OfficeTripRow = {
  id: string;
  number: string;
  status: TripRow["status"];
  truckCode: string | null;
  customerName: string;
  price: number;
  paymentMethod: string;
  isInternal: boolean;
  plannedVolumeL: number;
  scheduledDate: string;
  driverName: string | null;
  recordedByOffice: boolean;
  syncConflict: boolean;
  lateSync: boolean;
};

export type OfficeDeviceRow = { id: string; code: string; name: string; truckCode: string | null; status: string; lastSyncAt: Date | null; reportedQueueCount: number | null; lastUserName: string | null };

/** Rit terbit pada tanggal (untuk memilih rit yang dicatat kantor) + kesehatan perangkat truk & status sinkron setoran. */
export async function officeEntryBoard(ctx: ActorContext, input: { date?: BusinessDate } = {}, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m3.office_entry.create", { tx: opts.tx });
  const db = opts.tx ?? getDb();
  const date = input.date ?? ctxBusinessDate(ctx);
  const rows = await db
    .select({ t: trips, truckCode: trucks.code, customerName: customers.name, driverName: employees.fullName })
    .from(trips)
    .innerJoin(customers, eq(customers.id, trips.customerId))
    .innerJoin(orders, eq(orders.id, trips.orderId))
    .leftJoin(trucks, eq(trucks.id, trips.truckId))
    .leftJoin(users, eq(users.id, trips.driverUserId))
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .where(and(eq(trips.tenantId, ctx.tenantId), eq(trips.scheduledDate, date), isNotNull(trips.truckId), isNotNull(trips.publishedAt)))
    .orderBy(asc(trucks.code), asc(trips.routeOrder));
  const tripsOut: OfficeTripRow[] = rows.map((r) => ({
    id: r.t.id,
    number: r.t.number,
    status: r.t.status,
    truckCode: r.truckCode,
    customerName: r.customerName,
    price: r.t.price,
    paymentMethod: r.t.paymentMethod,
    isInternal: r.t.isInternal,
    plannedVolumeL: r.t.plannedVolumeL,
    scheduledDate: r.t.scheduledDate,
    driverName: r.driverName,
    recordedByOffice: r.t.recordedByOffice,
    syncConflict: r.t.syncConflict,
    lateSync: r.t.lateSync,
  }));
  const deviceRows = await db
    .select({ d: devices, truckCode: trucks.code, lastUserName: employees.fullName })
    .from(devices)
    .innerJoin(trucks, eq(trucks.id, devices.truckId))
    .leftJoin(users, eq(users.id, devices.lastUserId))
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .where(eq(devices.tenantId, ctx.tenantId))
    .orderBy(asc(trucks.code));
  const deviceOut: OfficeDeviceRow[] = deviceRows.map((r) => ({
    id: r.d.id,
    code: r.d.deviceCode,
    name: r.d.name,
    truckCode: r.truckCode,
    status: r.d.status,
    lastSyncAt: r.d.lastSyncAt,
    reportedQueueCount: r.d.reportedQueueCount,
    lastUserName: r.lastUserName,
  }));
  const deps = await db
    .select({ id: deposits.id, number: deposits.number, status: deposits.status, userId: deposits.depositorUserId, name: employees.fullName, expectedNet: deposits.expectedNet })
    .from(deposits)
    .leftJoin(users, eq(users.id, deposits.depositorUserId))
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .where(and(eq(deposits.tenantId, ctx.tenantId), eq(deposits.sourceType, "driver"), eq(deposits.businessDate, date)));
  const sync: (DriverDaySyncStatus & { name: string | null; expectedNet: number })[] = [];
  for (const d of deps) if (d.userId) sync.push({ ...(await driverDaySyncStatus(db, d.userId, date)), name: d.name, expectedNet: d.expectedNet });
  return { date, trips: tripsOut, devices: deviceOut, deposits: sync };
}

export type OfficeEntryReportRow = {
  kind: "trip_completed" | "trip_failed" | "collection";
  businessDate: string;
  tripNumber: string | null;
  truckCode: string | null;
  customerName: string;
  driverName: string | null;
  amount: number | null;
  paymentMethod: string | null;
  reason: string | null;
  recordedAt: Date;
  recordedByName: string | null;
};

/** Laporan pencatatan "dicatat kantor" (US-M3-09 KP-5; KPI-01 "tidak di sumber") — pemilik & Admin Keuangan. */
export async function officeEntryReport(ctx: ActorContext, input: { from?: BusinessDate; to?: BusinessDate } = {}, opts: { tx?: Tx } = {}): Promise<OfficeEntryReportRow[]> {
  await authorize(ctx, "m3.office_entry.read", { tx: opts.tx });
  const db = opts.tx ?? getDb();
  const to = input.to ?? ctxBusinessDate(ctx);
  const from = input.from ?? addDays(to, -30);
  const tripRows = await db
    .select({ t: trips, truckCode: trucks.code, customerName: customers.name, driverName: employees.fullName, pay: tripPayments })
    .from(trips)
    .innerJoin(customers, eq(customers.id, trips.customerId))
    .leftJoin(trucks, eq(trucks.id, trips.truckId))
    .leftJoin(users, eq(users.id, trips.driverUserId))
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .leftJoin(tripPayments, and(eq(tripPayments.tripId, trips.id), eq(tripPayments.recordedByOffice, true)))
    .where(
      and(
        eq(trips.tenantId, ctx.tenantId),
        eq(trips.recordedByOffice, true),
        or(and(gte(trips.completionBusinessDate, from), lte(trips.completionBusinessDate, to)), and(gte(trips.scheduledDate, from), lte(trips.scheduledDate, to))),
      ),
    )
    .orderBy(desc(trips.syncedAt));
  const recorders = new Map<string, string | null>();
  const nameOf = async (userId: string | null) => {
    if (!userId) return null;
    if (!recorders.has(userId)) {
      const r = (await db.select({ name: employees.fullName }).from(users).innerJoin(employees, eq(employees.id, users.employeeId)).where(eq(users.id, userId)).limit(1))[0];
      recorders.set(userId, r?.name ?? null);
    }
    return recorders.get(userId)!;
  };
  const out: OfficeEntryReportRow[] = [];
  for (const r of tripRows) {
    out.push({
      kind: r.t.status === "failed" ? "trip_failed" : "trip_completed",
      businessDate: r.t.completionBusinessDate ?? r.t.scheduledDate,
      tripNumber: r.t.number,
      truckCode: r.truckCode,
      customerName: r.customerName,
      driverName: r.driverName,
      amount: r.pay ? (r.pay.method === "credit" ? r.pay.expectedAmount : r.pay.receivedAmount) : null,
      paymentMethod: r.pay?.method ?? null,
      reason: r.t.officeRecordReason,
      recordedAt: r.t.syncedAt ?? r.t.updatedAt,
      recordedByName: await nameOf(r.pay?.createdBy ?? null),
    });
  }
  const cols = await db
    .select({ p: customerPayments, customerName: customers.name })
    .from(customerPayments)
    .innerJoin(customers, eq(customers.id, customerPayments.customerId))
    .where(and(eq(customerPayments.tenantId, ctx.tenantId), eq(customerPayments.recordedByOffice, true), eq(customerPayments.channel, "driver"), gte(customerPayments.businessDate, from), lte(customerPayments.businessDate, to)));
  for (const c of cols) {
    out.push({
      kind: "collection",
      businessDate: c.p.businessDate,
      tripNumber: null,
      truckCode: null,
      customerName: c.customerName,
      driverName: await nameOf(c.p.driverUserId),
      amount: c.p.amount,
      paymentMethod: c.p.method,
      reason: c.p.officeRecordReason,
      recordedAt: c.p.syncedAt ?? c.p.createdAt,
      recordedByName: await nameOf(c.p.createdBy),
    });
  }
  return out.sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());
}

/** Ringkasan teks untuk notifikasi/laporan. */
export function describeOfficeEntry(row: OfficeEntryReportRow): string {
  return `${row.kind === "collection" ? "Pelunasan" : row.kind === "trip_failed" ? "Rit gagal" : "Rit selesai"} ${row.tripNumber ?? ""} ${row.customerName}${row.amount !== null ? ` ${formatRupiah(row.amount)}` : ""}`.trim();
}
