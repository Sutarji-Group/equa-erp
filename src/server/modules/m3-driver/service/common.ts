/**
 * M3 — pembantu internal layanan aplikasi sopir (tidak diekspor lewat index.ts kecuali disebut): konteks tulis
 * perintah lapangan / pencatatan kantor, pemuatan rit dengan cek lingkup & pelaksana (US-M2-11), aturan parameter,
 * setoran berjalan (Bab 5.2), dan kunci BR-10 / PAR-83.
 */
import "server-only";

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";

import {
  crewAssignments,
  customerAddresses,
  customers,
  deposits,
  discrepancies,
  employees,
  orders,
  outlets,
  scheduleChangeLogs,
  trips,
  trucks,
  users,
} from "@/db/schema";
import type { EnumValue } from "@/lib/labels";
import { addDays, formatTanggal, type BusinessDate } from "@/lib/time";

import { isActingDriver } from "@/server/core/auth";
import { ctxBusinessDate, isSystem, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, ForbiddenError, NotFoundError } from "@/server/core/errors";
import { nextNumber } from "@/server/core/numbering";
import * as params from "@/server/core/params";
import { authorize, inTruckScope } from "@/server/core/rbac";
import type { AttachmentRow } from "@/server/core/storage";
import { fieldMetaValues, type SyncMeta } from "@/server/core/sync";

export type TripRow = typeof trips.$inferSelect;
export type DepositRow = typeof deposits.$inferSelect;

/**
 * Konteks tulis satu aksi lapangan: dari perintah sinkron (`fromSyncMeta`) atau dari pencatatan kantor "dicatat kantor"
 * (Bab 6.1, US-M3-09 KP-5). Waktu transaksi = waktu PERANGKAT (Bab 5.3); tanggal bisnis = tanggal WIB perangkat.
 */
export type M3WriteMeta = {
  tx: Tx;
  deviceId: string | null;
  /** Waktu transaksi (perangkat; kantor: waktu kejadian menurut bukti). */
  deviceTime: Date;
  businessDate: BusinessDate;
  commandId: string | null;
  receivedAt: Date;
  lateSync: boolean;
  clockSkewFlagged: boolean;
  attachments: AttachmentRow[];
  /** Pencatatan darurat Admin Keuangan atas nama sopir. */
  office: { reason: string; recordedBy: string } | null;
};

export function fromSyncMeta(meta: SyncMeta): M3WriteMeta {
  return {
    tx: meta.tx,
    deviceId: meta.device.id,
    deviceTime: meta.command.deviceTime,
    businessDate: meta.command.businessDate,
    commandId: meta.command.id,
    receivedAt: meta.receivedAt,
    lateSync: meta.lateSync,
    clockSkewFlagged: meta.clockSkewFlagged,
    attachments: meta.attachments,
    office: null,
  };
}

/** Nilai kolom `fieldMeta()` untuk baris transaksi lapangan / dicatat kantor. */
export function fieldValues(meta: M3WriteMeta) {
  if (meta.office) {
    return {
      deviceId: null,
      deviceTime: meta.deviceTime,
      syncedAt: meta.receivedAt,
      syncCommandId: null,
      lateSync: meta.lateSync,
      clockSkewFlagged: false,
      recordedByOffice: true,
      officeRecordReason: meta.office.reason,
    };
  }
  return {
    deviceId: meta.deviceId,
    deviceTime: meta.deviceTime,
    syncedAt: meta.receivedAt,
    syncCommandId: meta.commandId,
    lateSync: meta.lateSync,
    clockSkewFlagged: meta.clockSkewFlagged,
    recordedByOffice: false,
    officeRecordReason: null,
  };
}

export { fieldMetaValues };

// =====================================================================================================================
// Parameter
// =====================================================================================================================

export type M3Rules = {
  standardVolumeL: number;
  reasonRequiredGtM: number;
  ownerReviewGtM: number;
  maxPhotoKb: number;
  cashCloseTime: string;
  historyDays: number;
  gpsIntervalS: number;
  fieldCreditWaitMinutes: number;
  fieldCreditMaxDelayMinutes: number;
  maxDeliveryPhotos: number;
};

/** Ambang aturan M3 dari parameter (tanggal bisnis wajib; tidak ada angka aturan di kode). */
export async function m3Rules(tx: Tx, date: BusinessDate, tenantId?: string): Promise<M3Rules> {
  const scope = tenantId ? { tenantId } : undefined;
  const [vol, loc, photo, close, rules] = await Promise.all([
    params.get(tx, "PAR-15", date, scope),
    params.get(tx, "PAR-16", date, scope),
    params.get(tx, "PAR-38", date, scope),
    params.get(tx, "PAR-06", date, scope),
    params.get(tx, "m3.driver_rules", date, scope),
  ]);
  return {
    standardVolumeL: vol.liters,
    reasonRequiredGtM: loc.reason_required_gt_m,
    ownerReviewGtM: loc.owner_review_gt_m,
    maxPhotoKb: photo.max_kb,
    cashCloseTime: close.time,
    historyDays: rules.history_days,
    gpsIntervalS: rules.gps_phone_interval_s,
    fieldCreditWaitMinutes: rules.field_credit_wait_minutes,
    fieldCreditMaxDelayMinutes: rules.field_credit_max_delay_minutes,
    maxDeliveryPhotos: rules.max_delivery_photos,
  };
}

// =====================================================================================================================
// Rit & pelaksana
// =====================================================================================================================

export async function loadTrip(tx: Tx, tripId: string, opts: { forUpdate?: boolean } = {}): Promise<TripRow> {
  const q = tx.select().from(trips).where(eq(trips.id, tripId)).limit(1);
  const rows = opts.forUpdate ? await q.for("update") : await q;
  if (!rows[0]) throw new NotFoundError("Rit tidak ditemukan. Tarik data terbaru (Kirim sekarang) lalu coba lagi.");
  return rows[0];
}

/** Truk rit (dipakai `conditions` handler sinkron untuk kernet pengganti). */
export async function truckIdOfTrip(tx: Tx, tripId: string): Promise<string> {
  const rows = await tx.select({ truckId: trips.truckId }).from(trips).where(eq(trips.id, tripId)).limit(1);
  return rows[0]?.truckId ?? "";
}

/** Kondisi izin bersyarat kernet pengganti (US-M2-11) untuk rit pada tanggal bisnis & waktu perangkat perintah. */
export async function substituteConditionsForTrip(tx: Tx, ctx: ActorContext, tripId: string) {
  const trip = (await tx.select({ truckId: trips.truckId, driverUserId: trips.driverUserId }).from(trips).where(eq(trips.id, tripId)).limit(1))[0];
  return trip?.truckId ? substituteConditionsAt(tx, ctx, trip.truckId, ctxBusinessDate(ctx), trip) : { substitute_driver: false };
}

/**
 * Status pelaksana pelaku atas truk pada WAKTU PERANGKAT (Bab 6.4 butir 3 — lapangan tidak ditimpa kantor):
 * - `current`: pengemudi truk itu sekarang (penetapan harian berlaku / cadangan lingkup);
 * - `trip_driver`: ia yang memberangkatkan rit ini (rit yang sudah Berangkat tetap milik pengemudi lama, US-M2-11 KP-3);
 * - `at_device_time`: pengemudi truk itu saat tindakan dicatat di ponsel, tetapi Dispatcher menggantinya sebelum data
 *   tersinkron (penetapan `superseded_at` > waktu perangkat) → diterima sebagai KONFLIK untuk ditinjau;
 * - `none`: bukan pengemudi truk itu.
 */
export type ActingStatus = "current" | "trip_driver" | "at_device_time" | "none";

export async function actingStatusAt(
  tx: Tx,
  ctx: ActorContext,
  truckId: string,
  date: BusinessDate,
  at: Date | null | undefined,
  trip?: Pick<TripRow, "driverUserId" | "truckId"> | null,
): Promise<ActingStatus> {
  if (await isActingDriver(tx, ctx, truckId, date)) return "current";
  if (trip && ctx.userId && trip.driverUserId === ctx.userId) return "trip_driver";
  if (!ctx.employeeId || !at) return "none";
  const rows = await tx
    .select({ id: crewAssignments.id })
    .from(crewAssignments)
    .where(
      and(
        eq(crewAssignments.truckId, truckId),
        eq(crewAssignments.businessDate, date),
        eq(crewAssignments.driverEmployeeId, ctx.employeeId),
        isNotNull(crewAssignments.supersededAt),
        gt(crewAssignments.supersededAt, at),
        lte(crewAssignments.createdAt, at),
      ),
    )
    .limit(1);
  return rows[0] ? "at_device_time" : "none";
}

/**
 * Kondisi izin bersyarat kernet pengganti (US-M2-11) dinilai pada waktu perangkat (`ctx.deviceTime`), bukan saat
 * sinkron: kernet yang menjadi pengemudi pengganti saat tindakan dicatat tetap sah walau Dispatcher sudah
 * mengembalikan pengemudi semula sebelum data terkirim.
 */
export async function substituteConditionsAt(
  tx: Tx,
  ctx: ActorContext,
  truckId: string,
  date: BusinessDate,
  trip?: Pick<TripRow, "driverUserId" | "truckId"> | null,
): Promise<{ substitute_driver: boolean }> {
  if (!ctx.roles.includes("helper")) return { substitute_driver: false };
  return { substitute_driver: (await actingStatusAt(tx, ctx, truckId, date, ctx.deviceTime ?? null, trip)) !== "none" };
}

/**
 * Pelaku boleh bertindak atas truk ini: izin (+ kondisi kernet pengganti) dan ia PENGEMUDI truk itu pada waktu
 * perangkat (sopir yang digantikan kernet/sopir lain hanya membaca — US-M2-11 KP-3). Rit yang sudah ia Berangkatkan
 * tetap miliknya. Pengemudi yang digantikan SETELAH tindakan dicatat di ponsel (belum tersinkron) tetap diterima;
 * fungsi mengembalikan catatan konflik untuk ditinjau (Bab 6.4 butir 3). Kantor (dicatat kantor) dilewati.
 */
export async function assertActingOnTruck(
  tx: Tx,
  ctx: ActorContext,
  permission: string,
  truckId: string | null,
  date: BusinessDate,
  meta: M3WriteMeta,
  trip?: Pick<TripRow, "driverUserId" | "truckId" | "number"> | null,
): Promise<string | null> {
  if (meta.office || isSystem(ctx)) return null;
  if (!truckId) throw new DomainError("TRIP_NOT_SCHEDULED", "Rit ini belum ditugaskan ke truk. Hubungi Dispatcher.");
  const status = await actingStatusAt(tx, ctx, truckId, date, meta.deviceTime, trip);
  const conditions = { substitute_driver: ctx.roles.includes("helper") && status !== "none" };
  await authorize(ctx, permission, { tx, conditions, objectType: "truck", objectId: truckId });
  if (status === "none" && !inTruckScope(ctx, truckId)) {
    throw new ForbiddenError("Rit ini milik truk lain. Sopir tidak dapat mengambil rit truk lain — minta Dispatcher memindahkannya dulu.", {
      rule: "SCOPE",
      objectType: "truck",
      objectId: truckId,
    });
  }
  if (status === "none") {
    throw new ForbiddenError("Hari ini Anda bukan pengemudi truk ini (pengemudi pengganti ditetapkan Dispatcher). Anda hanya dapat melihat daftar rit.", {
      rule: "US-M2-11",
      objectType: "truck",
      objectId: truckId,
    });
  }
  if (status === "at_device_time") {
    return `Pengemudi truk diganti Dispatcher setelah tindakan${trip?.number ? ` rit ${trip.number}` : ""} dicatat di ponsel; data lapangan diterima untuk ditinjau.`;
  }
  return null;
}

/**
 * Rit dapat dikerjakan pelaku: truk dalam lingkupnya, ATAU rit dipindah ke truk lain / ditarik / dikeluarkan dari
 * jadwal SETELAH perangkat mengunduhnya (konflik — lapangan tidak ditimpa kantor, Bab 6.4 butir 3). Pengecualian
 * konflik hanya untuk rit yang PERNAH berada di truk dalam lingkup pelaku (truk rit sekarang, riwayat perubahan jadwal
 * `before.truckId`, atau rit yang ia Berangkatkan) — rit truk lain yang tidak pernah ada di perangkatnya ditolak
 * (US-M10-03 KP-1, SOD-05). Mengembalikan catatan konflik bila ada.
 */
export async function tripConflictNote(tx: Tx, ctx: ActorContext, trip: TripRow, meta: M3WriteMeta): Promise<string | null> {
  if (meta.office) return null;
  const inScopeNow = !!trip.truckId && inTruckScope(ctx, trip.truckId);
  if (inScopeNow && !trip.withdrawnAt) return null;
  let wasMine = inScopeNow || (!!ctx.userId && trip.driverUserId === ctx.userId);
  let moved = false;
  if (!wasMine) {
    const logs = await tx
      .select({ before: scheduleChangeLogs.before, changeType: scheduleChangeLogs.changeType })
      .from(scheduleChangeLogs)
      .where(and(eq(scheduleChangeLogs.tripId, trip.id), inArray(scheduleChangeLogs.changeType, ["truck_changed", "withdrawn", "moved"])))
      .orderBy(desc(scheduleChangeLogs.changedAt));
    const mine = logs.filter((l) => typeof l.before?.truckId === "string" && inTruckScope(ctx, l.before.truckId as string));
    wasMine = mine.length > 0;
    moved = mine.some((l) => l.changeType === "truck_changed");
  }
  if (!wasMine) {
    throw new ForbiddenError("Rit ini milik truk lain. Sopir tidak dapat mengambil rit truk lain — minta Dispatcher memindahkannya dulu.", {
      rule: "SCOPE",
      objectType: "trip",
      objectId: trip.id,
    });
  }
  if (trip.withdrawnAt) return `Rit ${trip.number} sudah ditarik Dispatcher dari jadwal, tetapi dikerjakan di lapangan.`;
  if (moved || trip.truckId) return `Rit ${trip.number} sudah dipindah Dispatcher ke truk lain, tetapi dikerjakan truk ini.`;
  return `Rit ${trip.number} sudah dikeluarkan Dispatcher dari jadwal truk ini, tetapi dikerjakan di lapangan.`;
}

/** Truk yang dikemudikan pelaku pada tanggal (penetapan harian, lalu lingkup). */
export async function actingTruckId(tx: Tx, ctx: ActorContext, date: BusinessDate): Promise<string | null> {
  if (ctx.employeeId) {
    const rows = await tx
      .select({ truckId: crewAssignments.truckId })
      .from(crewAssignments)
      .where(and(eq(crewAssignments.driverEmployeeId, ctx.employeeId), eq(crewAssignments.businessDate, date), isNull(crewAssignments.supersededAt)))
      .limit(1);
    if (rows[0]) return rows[0].truckId;
  }
  for (const truckId of ctx.scope.truckIds) if (await isActingDriver(tx, ctx, truckId, date)) return truckId;
  return ctx.scope.truckIds[0] ?? null;
}

export type TripContext = {
  trip: TripRow;
  order: { id: string; number: string };
  customer: { id: string; name: string; creditStatus: string; waPhone: string; contactName: string | null };
  address: { id: string; label: string; addressText: string; lat: number | null; lng: number | null; coordinateLocked: boolean };
  truck: { id: string; code: string } | null;
  outletName: string | null;
  /** Koordinat depot tujuan rit internal (B-48): acuan jarak Selesai/Tiba, sama dengan M12 (US-M12-04 KP-5). */
  outletPoint?: { lat: number; lng: number } | null;
};

/**
 * Acuan jarak lokasi Tiba/Selesai (BR-23, PAR-16) — B-48: rit internal (pasokan depot) dibandingkan dengan koordinat
 * DEPOT TUJUAN (sama dengan M12 US-M12-04 KP-5); rit pelanggan dengan titik alamat yang Dikunci. `null` = tidak dinilai.
 */
export function deviationTarget(tc: Pick<TripContext, "trip" | "address" | "outletPoint">): { kind: "address" | "depot"; lat: number; lng: number } | null {
  if (tc.trip.isInternal && tc.trip.destinationOutletId) {
    return tc.outletPoint ? { kind: "depot", lat: tc.outletPoint.lat, lng: tc.outletPoint.lng } : null;
  }
  if (tc.address.coordinateLocked && tc.address.lat !== null && tc.address.lng !== null) return { kind: "address", lat: tc.address.lat, lng: tc.address.lng };
  return null;
}

export async function loadTripContext(tx: Tx, tripId: string, opts: { forUpdate?: boolean } = {}): Promise<TripContext> {
  const trip = await loadTrip(tx, tripId, opts);
  const [row] = await tx
    .select({
      orderNumber: orders.number,
      customerName: customers.name,
      creditStatus: customers.creditStatus,
      waPhone: customers.waPhone,
      contactName: customers.contactName,
      addressLabel: customerAddresses.label,
      addressText: customerAddresses.addressText,
      lat: customerAddresses.lat,
      lng: customerAddresses.lng,
      coordinateStatus: customerAddresses.coordinateStatus,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, trip.customerId))
    .innerJoin(customerAddresses, eq(customerAddresses.id, trip.addressId))
    .where(eq(orders.id, trip.orderId))
    .limit(1);
  const truck = trip.truckId ? (await tx.select({ id: trucks.id, code: trucks.code }).from(trucks).where(eq(trucks.id, trip.truckId)).limit(1))[0] ?? null : null;
  const outlet = trip.destinationOutletId
    ? (await tx.select({ name: outlets.name, lat: outlets.lat, lng: outlets.lng }).from(outlets).where(eq(outlets.id, trip.destinationOutletId)).limit(1))[0]
    : null;
  return {
    trip,
    order: { id: trip.orderId, number: row?.orderNumber ?? trip.number.split("/")[0]! },
    customer: { id: trip.customerId, name: row?.customerName ?? "Pelanggan", creditStatus: row?.creditStatus ?? "cash", waPhone: row?.waPhone ?? "", contactName: row?.contactName ?? null },
    address: {
      id: trip.addressId,
      label: row?.addressLabel ?? "",
      addressText: row?.addressText ?? "",
      lat: row?.lat ?? null,
      lng: row?.lng ?? null,
      coordinateLocked: row?.coordinateStatus === "locked",
    },
    truck,
    outletName: outlet?.name ?? null,
    outletPoint: outlet && outlet.lat !== null && outlet.lng !== null ? { lat: outlet.lat, lng: outlet.lng } : null,
  };
}

// =====================================================================================================================
// Setoran sopir (Bab 5.2): Berjalan → Diajukan (M3) → Diterima → Ditutup (M4)
// =====================================================================================================================

export async function depositOf(tx: Tx, userId: string, date: BusinessDate, opts: { forUpdate?: boolean } = {}): Promise<DepositRow | null> {
  const q = tx
    .select()
    .from(deposits)
    .where(and(eq(deposits.sourceType, "driver"), eq(deposits.depositorUserId, userId), eq(deposits.businessDate, date)))
    .limit(1);
  const rows = opts.forUpdate ? await q.for("update") : await q;
  return rows[0] ?? null;
}

/**
 * Setoran tempat uang/pengeluaran lapangan pengguna untuk tanggal bisnis (dibuat saat penerimaan tunai pertama —
 * Bab 5.2 "Berjalan"):
 * - setoran tanggal itu Berjalan → dipakai;
 * - setoran tanggal itu Diajukan (belum Diterima) → dipakai: data tercatat SEBELUM Setor yang baru tersinkron
 *   ("menunggu sinkron", US-M3-09 KP-3); M4 menghitung item tertaut saat menerima;
 * - setoran tanggal itu sudah Diterima/Ditutup (data terlambat sinkron, Bab 5.3) → uangnya masuk setoran BERJALAN
 *   berikutnya (hari server bila tanggalnya sudah lewat, selain itu hari berikutnya) dengan penanda terbawa (M4
 *   menampilkannya sebagai "tunai terlambat sinkron"). Tidak pernah ditautkan ke setoran yang sudah Diterima/Ditutup.
 */
export async function ensureRunningDeposit(
  tx: Tx,
  ctx: ActorContext,
  input: { tenantId: string; userId: string; date: BusinessDate; truckId: string | null; today: BusinessDate },
): Promise<{ deposit: DepositRow; carriedOver: boolean }> {
  let date = input.date;
  let carriedOver = false;
  // Batas aman: setoran pengguna unik per tanggal, jadi paling banyak beberapa hari berturut sudah Diajukan.
  for (let i = 0; i < 31; i++) {
    const existing = await depositOf(tx, input.userId, date, { forUpdate: true });
    if (!existing) return { deposit: await createRunningDeposit(tx, ctx, { ...input, date }), carriedOver };
    if (existing.status === "running") return { deposit: existing, carriedOver };
    if (existing.status === "submitted" && !carriedOver) return { deposit: existing, carriedOver };
    date = date < input.today ? input.today : addDays(date, 1);
    carriedOver = true;
  }
  throw new DomainError("DEPOSIT_CARRY_OVER", "Setoran berjalan tidak ditemukan. Hubungi Admin Keuangan.");
}

async function createRunningDeposit(tx: Tx, ctx: ActorContext, input: { tenantId: string; userId: string; date: BusinessDate; truckId: string | null }): Promise<DepositRow> {
  const employeeId = (await tx.select({ employeeId: users.employeeId }).from(users).where(eq(users.id, input.userId)).limit(1))[0]?.employeeId ?? null;
  const number = await nextNumber(tx, "deposit", input.date, { tenantId: input.tenantId });
  const [row] = await tx
    .insert(deposits)
    .values({
      tenantId: input.tenantId,
      number,
      sourceType: "driver",
      businessDate: input.date,
      status: "running",
      depositorUserId: input.userId,
      depositorEmployeeId: employeeId,
      truckId: input.truckId,
      method: "physical",
      createdBy: ctx.userId,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  return (await depositOf(tx, input.userId, input.date))!;
}

/** Setoran pengguna tanggal itu sudah Diajukan (tanpa dibuka kembali) → tidak ada rit baru (US-M3-07 KP-2). */
export async function assertDayNotSubmitted(tx: Tx, userId: string, date: BusinessDate, meta: M3WriteMeta): Promise<void> {
  if (meta.office) return;
  const dep = await depositOf(tx, userId, date);
  if (dep && dep.status !== "running") {
    throw new DomainError(
      "DEPOSIT_ALREADY_SUBMITTED",
      `Setoran hari ini (${dep.number}) sudah diajukan — tidak ada rit baru hari ini. Minta Admin Keuangan membuka kembali setoran bila masih ada rit.`,
    );
  }
}

/**
 * BR-07, US-M3-07 KP-2: setelah Setor tidak ada transaksi kas baru hari itu (pelunasan/pengeluaran). Data yang
 * dicatat di ponsel SEBELUM Setor tetapi baru tersinkron tetap diterima (menunggu sinkron / terbawa ke setoran
 * berikutnya, lihat `ensureRunningDeposit`); yang dicatat SETELAH Setor ditolak dengan tindakan.
 */
export async function assertCashDayOpen(tx: Tx, userId: string, date: BusinessDate, meta: M3WriteMeta, what: string): Promise<void> {
  if (meta.office) return;
  const dep = await depositOf(tx, userId, date);
  if (!dep || dep.status === "running") return;
  if (dep.submittedAt && meta.deviceTime.getTime() < dep.submittedAt.getTime()) return;
  throw new DomainError(
    "DEPOSIT_ALREADY_SUBMITTED",
    dep.status === "submitted"
      ? `Setoran hari ini (${dep.number}) sudah diajukan — ${what} tidak dapat dicatat lagi hari ini. Minta Admin Keuangan membuka kembali setoran, atau serahkan ke Admin Keuangan untuk dicatat di kantor.`
      : `Setoran hari ini (${dep.number}) sudah diterima Admin Keuangan — ${what} tidak dapat dicatat lagi hari ini. Serahkan ke Admin Keuangan untuk dicatat di kantor.`,
  );
}

/** Setoran sopir yang masih Berjalan dari tanggal SEBELUM `before` (belum sempat Setor, mis. lewat tengah malam). */
export async function staleRunningDeposits(tx: Tx, userId: string, before: BusinessDate, opts: { forUpdate?: boolean } = {}): Promise<DepositRow[]> {
  const q = tx
    .select()
    .from(deposits)
    .where(and(eq(deposits.sourceType, "driver"), eq(deposits.depositorUserId, userId), eq(deposits.status, "running"), lt(deposits.businessDate, before)))
    .orderBy(asc(deposits.businessDate));
  return opts.forUpdate ? q.for("update") : q;
}

// =====================================================================================================================
// Kunci BR-10 / PAR-83 (US-M3-01 KP-5)
// =====================================================================================================================

export type DriverLock = { kind: "br10" | "par83"; message: string; depositNumber: string | null; depositDate: string | null };

/**
 * Kunci tombol Berangkat: setoran sopir hari sebelumnya belum Ditutup (BR-10), atau — hanya bila PAR-83 aktif —
 * selisih kurang ≥ ambang yang belum diputuskan pemilik (PTB-62). Keputusan pemilik atas selisih biasa tidak memengaruhi.
 */
export async function driverLock(
  tx: Tx,
  input: { userId: string; employeeId: string | null; date: BusinessDate; tenantId: string; /** Hanya kunci yang sudah terbentuk pada waktu ini (waktu perangkat). */ asOf?: Date },
): Promise<DriverLock | null> {
  const open = await tx
    .select({ number: deposits.number, businessDate: deposits.businessDate, status: deposits.status })
    .from(deposits)
    .where(
      and(
        eq(deposits.sourceType, "driver"),
        ne(deposits.status, "closed"),
        lt(deposits.businessDate, input.date),
        or(eq(deposits.depositorUserId, input.userId), input.employeeId ? eq(deposits.depositorEmployeeId, input.employeeId) : sql`false`),
        ...(input.asOf ? [lte(deposits.createdAt, input.asOf)] : []),
      ),
    )
    .orderBy(asc(deposits.businessDate))
    .limit(1);
  if (open[0]) {
    const when = formatTanggal(open[0].businessDate, { weekday: false });
    return {
      kind: "br10",
      message:
        open[0].status === "running"
          ? `Setoran ${when} (${open[0].number}) belum diajukan. Buka menu Setor, ajukan setoran ${when}, lalu serahkan uangnya ke Admin Keuangan — tombol Berangkat terbuka otomatis setelah setoran ditutup.`
          : `Setoran kemarin belum ditutup Admin Keuangan (${open[0].number}, ${when}). Hubungi Admin Keuangan — tombol Berangkat terbuka otomatis setelah setoran ditutup.`,
      depositNumber: open[0].number,
      depositDate: open[0].businessDate,
    };
  }
  const par83 = await params.get(tx, "PAR-83", input.date, { tenantId: input.tenantId });
  if (!par83.enabled) return null;
  const big = await tx
    .select({ id: discrepancies.id, amount: discrepancies.amount, depositId: discrepancies.depositId, businessDate: discrepancies.businessDate, locksTrips: discrepancies.locksTrips })
    .from(discrepancies)
    .where(
      and(
        eq(discrepancies.source, "driver"),
        notInArray(discrepancies.status, ["approved", "rejected", "followed_up", "done"]),
        or(eq(discrepancies.userId, input.userId), input.employeeId ? eq(discrepancies.employeeId, input.employeeId) : sql`false`),
        or(eq(discrepancies.locksTrips, true), sql`${discrepancies.amount} <= ${-par83.amount_gte}`),
        ...(input.asOf ? [lte(discrepancies.createdAt, input.asOf)] : []),
      ),
    )
    .limit(1);
  if (!big[0]) return null;
  const dep = big[0].depositId ? (await tx.select({ number: deposits.number }).from(deposits).where(eq(deposits.id, big[0].depositId)).limit(1))[0] : null;
  return {
    kind: "par83",
    message: "Menunggu keputusan pemilik atas selisih besar. Tombol Berangkat terbuka setelah pemilik memutuskan selisih setoran Anda.",
    depositNumber: dep?.number ?? null,
    depositDate: big[0].businessDate,
  };
}

/**
 * Tolak Berangkat bila kunci BR-10/PAR-83 SUDAH terbentuk pada waktu perangkat. Kunci yang baru terbentuk setelah
 * tindakan dicatat di ponsel (mis. selisih besar diterima kantor sebelum data tersinkron) tidak menimpa data lapangan:
 * diterima sebagai konflik untuk ditinjau (Bab 6.4 butir 3). Mengembalikan catatan konflik bila ada.
 */
export async function assertNotLocked(tx: Tx, ctx: ActorContext, date: BusinessDate, meta: M3WriteMeta, actingUserId: string): Promise<string | null> {
  if (meta.office) return null;
  const input = { userId: actingUserId, employeeId: ctx.employeeId, date, tenantId: ctx.tenantId };
  const atDevice = await driverLock(tx, { ...input, asOf: meta.deviceTime });
  if (atDevice) throw new DomainError(atDevice.kind === "br10" ? "BR10_LOCKED" : "PAR83_LOCKED", atDevice.message);
  const current = await driverLock(tx, input);
  return current ? `Berangkat dicatat di ponsel sebelum kunci setoran terbentuk (${current.kind === "br10" ? "BR-10" : "PAR-83"}); diterima untuk ditinjau.` : null;
}

// =====================================================================================================================
// Lain-lain
// =====================================================================================================================

/** Nama karyawan pengguna. */
export async function userName(tx: Tx, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const rows = await tx.select({ name: employees.fullName }).from(users).innerJoin(employees, eq(employees.id, users.employeeId)).where(eq(users.id, userId)).limit(1);
  return rows[0]?.name ?? null;
}

/** Lampiran perintah menurut jenis. */
export function attachmentsOfKind(meta: M3WriteMeta, kind: string): AttachmentRow[] {
  return meta.attachments.filter((a) => a.kind === kind);
}

export function requireTextReason(code: string | null | undefined, text: string | null | undefined, field: string, message: string): string {
  const c = code?.trim() ?? "";
  const t = text?.trim() ?? "";
  if (!c && !t) throw new DomainError("REASON_REQUIRED", message, { field });
  if (c === "other" && t.length < 3) throw new DomainError("REASON_REQUIRED", `${message} (tulis keterangan untuk "Lainnya").`, { field });
  return c && t ? `${c}: ${t}` : c || t;
}

export type TripStatus = EnumValue<"trip_status">;

export async function tripsOfTruckDay(tx: Tx, truckId: string, date: BusinessDate): Promise<TripRow[]> {
  return tx.select().from(trips).where(and(eq(trips.truckId, truckId), eq(trips.scheduledDate, date), isNull(trips.withdrawnAt)));
}

/** Rit aktif (Berangkat/Tiba) truk selain `exceptTripId`. */
export async function activeTripOfTruck(tx: Tx, truckId: string, exceptTripId: string): Promise<TripRow | null> {
  const rows = await tx
    .select()
    .from(trips)
    .where(and(eq(trips.truckId, truckId), inArray(trips.status, ["departed", "arrived"]), ne(trips.id, exceptTripId)))
    .limit(1);
  return rows[0] ?? null;
}
