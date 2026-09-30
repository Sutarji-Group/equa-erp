/**
 * M3 — data referensi offline aplikasi sopir (pull `m3.today`, `m3.deposits`; US-M3-01, US-M3-09 KP-1).
 *
 * `m3.today`: rit TERBIT hari ini untuk truk yang dikemudikan (jadwal kru; kernet non-pengganti baca-saja), urutan,
 * pelanggan, alamat & koordinat, volume, jam diminta, cara bayar, catatan khusus, HARGA PESANAN (satu-satunya harga,
 * BR-19), kontak, faktur terbuka pelanggan rit hari itu (+ waktu data), template struk, rekening PT, kunci BR-10/PAR-83,
 * tugas keterangan perjalanan (BR-25), flag GPS ponsel cadangan, dan angka kas di tangan. `undefined` bila tidak ada
 * perubahan sejak kursor (hemat kuota NFR-17).
 */
import "server-only";

import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, max, ne, notInArray, or, sql } from "drizzle-orm";

import {
  approvalRequests,
  crewAssignments,
  customerAddresses,
  customerPayments,
  customers,
  dailySchedules,
  deposits,
  discrepancies,
  employees,
  fleetEvents,
  invoices,
  notifications,
  orders,
  outlets,
  phoneTrackingFlags,
  scheduleChangeLogs,
  tripExpenses,
  tripPayments,
  trips,
  trucks,
  userRoles,
  users,
  waMessageLogs,
} from "@/db/schema";
import { label } from "@/lib/labels";
import { toBusinessDate, wibToUtc, type BusinessDate } from "@/lib/time";

import {
  shortAddress,
  sortTripsForDriver,
  type M3DepositHistory,
  type M3InvoiceRef,
  type M3PaymentRef,
  type M3Today,
  type M3TripRef,
} from "@/client/m3-driver/contract";

import { isActingDriver } from "@/server/core/auth";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import * as params from "@/server/core/params";

import { collectionsOf, openInvoicesFor } from "./collections";
import { actingTruckId, depositOf, driverLock, m3Rules, staleRunningDeposits } from "./common";
import { dayFigures, depositHistory, paymentsOf } from "./deposits";
import { expensesOf } from "./expenses";
import { phoneTrackingActive } from "./gps";
import { openExplanationTasks } from "./incidents";
import { customerFacingBankAccounts } from "./payments";
import { activeTemplates } from "./receipts";

/** Pemberitahuan yang ditampilkan di aplikasi sopir (tanpa pusat notifikasi kantor). */
const NOTICE_EVENTS = ["deposit.driver_reminder", "deposit.reopened", "approval.decided"];

const CHANGE_LABEL: Record<string, string> = {
  added: "Rit ditambahkan ke jadwal",
  moved: "Tanggal/jadwal digeser",
  withdrawn: "Rit ditarik dari jadwal",
  reordered: "Urutan rit diubah",
  truck_changed: "Rit dipindah dari/ke truk lain",
};

function changeSummary(log: { changeType: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; reason: string | null }): string {
  const base = CHANGE_LABEL[log.changeType] ?? label("schedule_change_type", log.changeType);
  const b = log.before ?? {};
  const a = log.after ?? {};
  let detail = "";
  if (log.changeType === "reordered" && (b.routeOrder !== undefined || a.routeOrder !== undefined)) detail = ` (urutan ${String(b.routeOrder ?? "—")} → ${String(a.routeOrder ?? "—")})`;
  return `${base}${detail}${log.reason ? ` — ${log.reason}` : ""}`;
}

/** Waktu perubahan terakhir data yang dipakai `m3.today` (untuk kursor pull). */
async function lastChange(tx: Tx, input: { userId: string; truckIds: string[]; date: BusinessDate; customerIds: string[] }): Promise<number> {
  const stamps: (Date | null | undefined)[] = [];
  const pick = async (q: Promise<{ m: Date | null }[]>) => stamps.push((await q)[0]?.m);
  if (input.truckIds.length) {
    await pick(tx.select({ m: max(trips.updatedAt) }).from(trips).where(and(inArray(trips.truckId, input.truckIds), eq(trips.scheduledDate, input.date))));
    await pick(tx.select({ m: max(dailySchedules.updatedAt) }).from(dailySchedules).where(and(inArray(dailySchedules.truckId, input.truckIds), eq(dailySchedules.businessDate, input.date))));
    await pick(tx.select({ m: max(fleetEvents.updatedAt) }).from(fleetEvents).where(inArray(fleetEvents.truckId, input.truckIds)));
    await pick(tx.select({ m: max(phoneTrackingFlags.updatedAt) }).from(phoneTrackingFlags).where(inArray(phoneTrackingFlags.truckId, input.truckIds)));
    await pick(
      tx
        .select({ m: max(scheduleChangeLogs.changedAt) })
        .from(scheduleChangeLogs)
        .where(and(eq(scheduleChangeLogs.afterPublish, true), inArray(sql<string>`${scheduleChangeLogs.before}->>'truckId'`, input.truckIds), gte(scheduleChangeLogs.changedAt, wibToUtc(input.date, "00:00")))),
    );
  }
  await pick(tx.select({ m: max(trips.updatedAt) }).from(trips).where(eq(trips.driverUserId, input.userId)));
  await pick(tx.select({ m: max(crewAssignments.updatedAt) }).from(crewAssignments).where(eq(crewAssignments.businessDate, input.date)));
  await pick(tx.select({ m: max(deposits.updatedAt) }).from(deposits).where(and(eq(deposits.sourceType, "driver"), eq(deposits.depositorUserId, input.userId))));
  await pick(tx.select({ m: max(discrepancies.updatedAt) }).from(discrepancies).where(eq(discrepancies.userId, input.userId)));
  await pick(tx.select({ m: max(tripPayments.updatedAt) }).from(tripPayments).where(and(eq(tripPayments.driverUserId, input.userId), eq(tripPayments.businessDate, input.date))));
  await pick(tx.select({ m: max(customerPayments.updatedAt) }).from(customerPayments).where(and(eq(customerPayments.driverUserId, input.userId), eq(customerPayments.businessDate, input.date))));
  await pick(tx.select({ m: max(tripExpenses.updatedAt) }).from(tripExpenses).where(and(eq(tripExpenses.driverUserId, input.userId), eq(tripExpenses.businessDate, input.date))));
  await pick(tx.select({ m: max(notifications.createdAt) }).from(notifications).where(eq(notifications.recipientUserId, input.userId)));
  await pick(tx.select({ m: max(approvalRequests.updatedAt) }).from(approvalRequests).where(and(eq(approvalRequests.type, "field_payment_to_credit"), eq(approvalRequests.requesterUserId, input.userId))));
  if (input.customerIds.length) await pick(tx.select({ m: max(invoices.updatedAt) }).from(invoices).where(inArray(invoices.customerId, input.customerIds)));
  return Math.max(0, ...stamps.filter((d): d is Date => !!d).map((d) => new Date(d).getTime()));
}

/** Peran pelaksana di aplikasi (US-M3-01 KP-6). */
async function actingRoleOf(tx: Tx, ctx: ActorContext, truckId: string | null, date: BusinessDate): Promise<{ role: M3Today["actingRole"]; reason: string | null }> {
  if (!truckId) return { role: "readonly", reason: "Anda belum dijadwalkan pada truk mana pun hari ini. Hubungi Dispatcher." };
  const acting = await isActingDriver(tx, ctx, truckId, date);
  if (acting && ctx.roles.includes("helper") && !ctx.roles.includes("driver")) return { role: "substitute", reason: null };
  if (acting) return { role: "driver", reason: null };
  if (ctx.roles.includes("helper")) {
    return { role: "readonly", reason: "Anda kernet — daftar rit hanya untuk dibaca. Tombol tindakan muncul bila Dispatcher menetapkan Anda sebagai pengemudi pengganti." };
  }
  return { role: "readonly", reason: "Hari ini truk ini dikemudikan pengemudi pengganti yang ditetapkan Dispatcher. Anda hanya dapat melihat daftar rit." };
}

export async function buildToday(tx: Tx, ctx: ActorContext, since: Date | null, opts: { now?: Date } = {}): Promise<M3Today | undefined> {
  const now = opts.now ?? ctx.now;
  const date = ctxBusinessDate(ctx);
  const userId = ctx.userId!;
  const truckIds = ctx.scope.truckIds;
  const tripRows = truckIds.length
    ? await tx
        .select({
          t: trips,
          orderNumber: orders.number,
          requestedTime: orders.requestedTime,
          orderNotes: orders.notes,
          collectUnderpayment: orders.collectUnderpayment,
          customerName: customers.name,
          contactName: customers.contactName,
          customerPhone: customers.waPhone,
          customerNotes: customers.notes,
          fixedReceiveTime: customers.fixedReceiveTime,
          addressLabel: customerAddresses.label,
          addressText: customerAddresses.addressText,
          addressNotes: customerAddresses.notes,
          lat: customerAddresses.lat,
          lng: customerAddresses.lng,
          coordinateStatus: customerAddresses.coordinateStatus,
          truckCode: trucks.code,
          outletName: outlets.name,
          outletLat: outlets.lat,
          outletLng: outlets.lng,
        })
        .from(trips)
        .innerJoin(orders, eq(orders.id, trips.orderId))
        .innerJoin(customers, eq(customers.id, trips.customerId))
        .innerJoin(customerAddresses, eq(customerAddresses.id, trips.addressId))
        .innerJoin(trucks, eq(trucks.id, trips.truckId))
        .leftJoin(outlets, eq(outlets.id, trips.destinationOutletId))
        .where(
          and(
            inArray(trips.truckId, truckIds),
            eq(trips.scheduledDate, date),
            isNull(trips.withdrawnAt),
            or(isNotNull(trips.publishedAt), inArray(trips.status, ["departed", "arrived", "completed", "failed"])),
            or(ne(orders.status, "cancelled"), ne(trips.status, "assigned")),
          ),
        )
    : [];
  const customerIds = [...new Set(tripRows.filter((r) => !r.t.isInternal).map((r) => r.t.customerId))];
  if (since && toBusinessDate(since) === date) {
    const last = await lastChange(tx, { userId, truckIds, date, customerIds });
    if (last > 0 && last <= since.getTime()) return undefined;
  }

  const truckId = await actingTruckId(tx, ctx, date);
  const truck = truckId ? ((await tx.select({ id: trucks.id, code: trucks.code, plateNumber: trucks.plateNumber }).from(trucks).where(eq(trucks.id, truckId)).limit(1))[0] ?? null) : null;
  const acting = await actingRoleOf(tx, ctx, truckId, date);
  const lock = acting.role === "readonly" ? null : await driverLock(tx, { userId, employeeId: ctx.employeeId, date, tenantId: ctx.tenantId });
  const rules = await m3Rules(tx, date, ctx.tenantId);
  const tripIds = tripRows.map((r) => r.t.id);

  const [payments, collections, expenses, deposit, invoicesList, tasks, templates, identity, banks, gps] = await Promise.all([
    paymentsOf(tx, userId, date),
    collectionsOf(tx, userId, date),
    expensesOf(tx, userId, date),
    depositOf(tx, userId, date),
    openInvoicesFor(tx, customerIds),
    openExplanationTasks(tx, truckIds, date),
    activeTemplates(tx, ctx.tenantId),
    params.get(tx, "company.identity", date, { tenantId: ctx.tenantId }),
    customerFacingBankAccounts(tx, ctx.tenantId),
    phoneTrackingActive(tx, truckId),
  ]);
  const changeLogs = tripIds.length
    ? await tx
        .select()
        .from(scheduleChangeLogs)
        .where(and(inArray(scheduleChangeLogs.tripId, tripIds), eq(scheduleChangeLogs.afterPublish, true)))
        .orderBy(desc(scheduleChangeLogs.changedAt))
    : [];
  const withdrawnRows = truckIds.length
    ? await tx
        .select({ tripId: trips.id, number: trips.number, customerName: customers.name, at: trips.withdrawnAt })
        .from(trips)
        .innerJoin(customers, eq(customers.id, trips.customerId))
        .where(and(inArray(trips.truckId, truckIds), eq(trips.scheduledDate, date), isNotNull(trips.withdrawnAt), isNotNull(trips.publishedAt)))
    : [];
  // US-M3-01 KP-4 / US-M2-03 KP-5: rit terbit yang DIKELUARKAN dari truk ini (ditarik ke daftar belum dijadwalkan,
  // dijadwal ulang, atau dipindah ke truk lain) tampil sebagai "ditarik" beserta ringkasan perubahannya.
  const leftLogs = truckIds.length
    ? await tx
        .select({ log: scheduleChangeLogs, number: trips.number, customerName: customers.name })
        .from(scheduleChangeLogs)
        .innerJoin(trips, eq(trips.id, scheduleChangeLogs.tripId))
        .innerJoin(customers, eq(customers.id, trips.customerId))
        .where(
          and(
            eq(scheduleChangeLogs.afterPublish, true),
            inArray(scheduleChangeLogs.changeType, ["withdrawn", "truck_changed", "moved"]),
            inArray(sql<string>`${scheduleChangeLogs.before}->>'truckId'`, truckIds),
            gte(scheduleChangeLogs.changedAt, wibToUtc(date, "00:00")),
            ...(tripIds.length ? [notInArray(scheduleChangeLogs.tripId, tripIds)] : []),
          ),
        )
        .orderBy(desc(scheduleChangeLogs.changedAt))
    : [];
  const withdrawnList: M3Today["withdrawn"] = withdrawnRows.map((w) => ({ tripId: w.tripId, number: w.number, customerName: w.customerName, at: w.at!.toISOString(), summary: "Rit ditarik dari jadwal (pesanan dibatalkan)" }));
  for (const l of leftLogs) {
    if (withdrawnList.some((w) => w.tripId === l.log.tripId)) continue;
    const before = (l.log.before ?? {}) as Record<string, unknown>;
    if (typeof before.scheduledDate === "string" && before.scheduledDate !== date) continue;
    withdrawnList.push({ tripId: l.log.tripId, number: l.number, customerName: l.customerName, at: l.log.changedAt.toISOString(), summary: changeSummary(l.log) });
  }
  // US-M3-07 KP-5: setoran hari sebelumnya yang belum sempat diajukan (mis. lewat tengah malam) — dapat diajukan terlambat.
  const pendingDeposits = await Promise.all(
    (await staleRunningDeposits(tx, userId, date)).map(async (d) => ({ id: d.id, number: d.number, businessDate: d.businessDate, expectedNet: (await dayFigures(tx, userId, d.businessDate)).cashOnHand })),
  );
  const creditRequests = tripIds.length
    ? await tx
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.type, "field_payment_to_credit"), eq(approvalRequests.objectType, "trip"), inArray(approvalRequests.objectId, tripIds)))
        .orderBy(desc(approvalRequests.createdAt))
    : [];
  const receiptLogs = tripIds.length
    ? await tx
        .select({ objectId: waMessageLogs.objectId })
        .from(waMessageLogs)
        .where(and(eq(waMessageLogs.kind, "trip_receipt"), eq(waMessageLogs.objectType, "trip"), inArray(waMessageLogs.objectId, tripIds)))
    : [];
  const sent = new Set(receiptLogs.map((r) => r.objectId));

  const tripsOut: M3TripRef[] = tripRows.map((r) => {
    const t = r.t;
    const logs = changeLogs.filter((l) => l.tripId === t.id);
    const cr = creditRequests.find((a) => a.objectId === t.id);
    const fixed = r.fixedReceiveTime ? `Jam terima tetap ${r.fixedReceiveTime.slice(0, 5)}` : null;
    const customerNotes = [r.customerNotes, fixed].filter(Boolean).join(" · ") || null;
    return {
      id: t.id,
      number: t.number,
      orderId: t.orderId,
      orderNumber: r.orderNumber,
      truckId: t.truckId!,
      truckCode: r.truckCode,
      routeOrder: t.routeOrder,
      actualOrder: t.actualOrder,
      status: t.status,
      customerId: t.customerId,
      customerName: r.customerName,
      contactName: r.contactName,
      customerPhone: r.customerPhone,
      addressLabel: r.addressLabel,
      addressText: r.addressText,
      addressShort: shortAddress(r.addressText),
      // B-48: rit internal → titik depot tujuan (acuan jarak Selesai & navigasi sama dengan M12 US-M12-04 KP-5).
      ...(t.isInternal && r.outletLat !== null && r.outletLng !== null
        ? { lat: r.outletLat, lng: r.outletLng, coordinateLocked: true }
        : { lat: r.lat, lng: r.lng, coordinateLocked: r.coordinateStatus === "locked" }),
      requestedTime: r.requestedTime?.slice(0, 5) ?? null,
      customerNotes,
      addressNotes: r.addressNotes,
      orderNotes: r.orderNotes,
      hasSpecialNotes: !!(customerNotes || r.addressNotes || r.orderNotes),
      price: t.price,
      paymentMethod: t.paymentMethod,
      plannedVolumeL: t.plannedVolumeL,
      isInternal: t.isInternal,
      destinationOutletId: t.destinationOutletId,
      destinationOutletName: r.outletName,
      collectUnderpayment: r.collectUnderpayment,
      creditHold: !!t.creditHoldFlaggedAt && !t.creditHoldResolution,
      driverUserId: t.driverUserId,
      departedAt: t.departedAt?.toISOString() ?? null,
      arrivedAt: t.arrivedAt?.toISOString() ?? null,
      completedAt: t.completedAt?.toISOString() ?? null,
      failedAt: t.failedAt?.toISOString() ?? null,
      failReason: t.failReason,
      arrivalDistanceM: t.arrivalDistanceM,
      deliveredVolumeL: t.deliveredVolumeL,
      recipientName: t.recipientName,
      noLocation: t.noLocation,
      receiptStatus: sent.has(t.id) ? "sent" : t.receiptSkippedReason ? "skipped" : "none",
      // US-M3-01 KP-4: rit yang sudah Berangkat tidak berubah — penanda "diperbarui" hanya untuk rit belum berangkat.
      update: logs.length && t.status === "assigned" ? { at: logs[0]!.changedAt.toISOString(), summary: logs.map(changeSummary) } : null,
      creditRequest: cr
        ? {
            approvalId: cr.id,
            number: cr.number,
            status: cr.status,
            decisionReason: cr.decisionReason,
          }
        : null,
      syncConflict: t.syncConflict,
    };
  });

  const invoicesByCustomer: Record<string, M3InvoiceRef[]> = {};
  for (const inv of invoicesList) (invoicesByCustomer[inv.customerId] ??= []).push(inv);

  const finance = await tx
    .select({ name: employees.fullName, phone: employees.phone })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(and(eq(userRoles.role, "finance_admin"), eq(userRoles.status, "active"), eq(users.status, "active"), eq(employees.tenantId, ctx.tenantId)));
  const allowBank = ctx.employeeId ? ((await tx.select({ allow: employees.allowBankDeposit }).from(employees).where(eq(employees.id, ctx.employeeId)).limit(1))[0]?.allow ?? false) : false;
  const me = ctx.employeeId ? (await tx.select({ name: employees.fullName }).from(employees).where(eq(employees.id, ctx.employeeId)).limit(1))[0] : null;

  const noticeRows = await tx
    .select({ id: notifications.id, event: notifications.event, title: notifications.title, body: notifications.body, createdAt: notifications.createdAt })
    .from(notifications)
    .where(and(eq(notifications.recipientUserId, userId), inArray(notifications.event, NOTICE_EVENTS), gt(notifications.createdAt, new Date(now.getTime() - 24 * 3_600_000))))
    .orderBy(desc(notifications.createdAt))
    .limit(10);
  const paymentRefs: M3PaymentRef[] = payments;
  return {
    date,
    generatedAt: now.toISOString(),
    user: { id: userId, name: me?.name ?? "", employeeId: ctx.employeeId },
    truck,
    actingRole: acting.role,
    readOnlyReason: acting.reason,
    lock: lock ? { kind: lock.kind, message: lock.message, depositNumber: lock.depositNumber, depositDate: lock.depositDate } : null,
    trips: sortTripsForDriver(tripsOut),
    withdrawn: withdrawnList,
    pendingDeposits,
    invoicesByCustomer,
    payments: paymentRefs,
    collections,
    expenses: expenses.map((e) => ({
      id: e.id,
      tripId: e.tripId,
      kind: e.kind,
      amount: e.amount,
      fundingSource: e.fundingSource,
      status: e.status,
      recordedAt: (e.deviceTime ?? e.createdAt).toISOString(),
    })),
    deposit: deposit
      ? {
          id: deposit.id,
          number: deposit.number,
          status: deposit.status,
          businessDate: deposit.businessDate,
          submittedAt: deposit.submittedAt?.toISOString() ?? null,
          submittedLate: deposit.submittedLate,
          method: deposit.method,
          expectedCash: deposit.expectedCash,
          expectedNet: deposit.expectedNet,
          reopenReason: deposit.reopenReason,
        }
      : null,
    allowBankDeposit: allowBank,
    explanationTasks: tasks,
    gpsTracking: { enabled: gps, truckId, intervalS: rules.gpsIntervalS },
    receiptTemplates: templates,
    company: { name: identity.name, phone: identity.phone ?? null },
    bankAccounts: banks,
    financeContacts: finance.map((f) => ({ name: f.name, phone: f.phone })),
    notices: noticeRows.map((n) => ({ id: n.id, event: n.event, title: n.title, body: n.body, createdAt: n.createdAt.toISOString() })),
    settings: {
      standardVolumeL: rules.standardVolumeL,
      reasonRequiredGtM: rules.reasonRequiredGtM,
      ownerReviewGtM: rules.ownerReviewGtM,
      maxPhotoKb: rules.maxPhotoKb,
      maxDeliveryPhotos: rules.maxDeliveryPhotos,
      cashCloseTime: rules.cashCloseTime,
      gpsIntervalS: rules.gpsIntervalS,
      fieldCreditWaitMinutes: rules.fieldCreditWaitMinutes,
    },
  };
}

/** Riwayat setoran & selisih 90 hari (US-M3-07 KP-6) — HANYA milik pengguna sendiri. */
export async function buildDepositHistory(tx: Tx, ctx: ActorContext, since: Date | null): Promise<M3DepositHistory | undefined> {
  const userId = ctx.userId!;
  const date = ctxBusinessDate(ctx);
  if (since && toBusinessDate(since) === date) {
    const [d] = await tx.select({ m: max(deposits.updatedAt) }).from(deposits).where(and(eq(deposits.sourceType, "driver"), eq(deposits.depositorUserId, userId), gt(deposits.updatedAt, since)));
    const [x] = await tx.select({ m: max(discrepancies.updatedAt) }).from(discrepancies).where(and(eq(discrepancies.userId, userId), gt(discrepancies.updatedAt, since)));
    if (!d?.m && !x?.m) return undefined;
  }
  const rules = await m3Rules(tx, date, ctx.tenantId);
  return { days: rules.historyDays, rows: await depositHistory(tx, userId, date, rules.historyDays) };
}
