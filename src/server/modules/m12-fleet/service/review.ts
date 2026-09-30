/**
 * M12 — kejadian armada: daftar, rincian, tinjauan pemilik, permintaan keterangan, ringkasan H+0 (US-M12-04 KP-3,
 * US-M12-05 KP-3/KP-4, US-M12-06 KP-4, US-M12-08 KP-2; BR-25; BR-38).
 *
 * Alur: Terdeteksi → Keterangan sopir (M3, `m3.travel_explanation.create`) → Ditinjau pemilik (terima / tindak lanjut di
 * luar sistem) → Selesai. "Minta keterangan" (pemilik/Dispatcher) memberi tugas keterangan di aplikasi sopir
 * (`requires_explanation`) + pemberitahuan ke sopir. Semua keputusan berjejak audit; kejadian tidak pernah dihapus.
 * Tanpa keterangan saat tutup kas → ditandai & masuk kotak masuk pemilik + ringkasan H+0 (`fleetDaySummary` untuk M9).
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, notInArray, sql } from "drizzle-orm";

import { customerAddresses, customers, employees, fleetEvents, trips, trucks, users } from "@/db/schema";
import { label, type EnumValue, type FleetEventKind } from "@/lib/labels";
import { addDays, type BusinessDate } from "@/lib/time";

import { query as auditQuery, record as auditRecord, type AuditRow } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";

import { closeEventSchema, eventFilterSchema, reviewSchema } from "../schemas";
import { m12Rules, type M12Rules } from "./common";
import { notifyDriver } from "./detection";
import { deviceOutageMinutesForRange, deviceOutageMinutesOn } from "./devices";
import { EVENT_GROUPS, notifyOnce, REVIEW_KINDS, type FleetEventRow } from "./fleet-events";

export type FleetEventView = {
  id: string;
  kind: FleetEventKind;
  kindLabel: string;
  group: EnumValue<"fleet_event_group">;
  status: EnumValue<"fleet_event_status">;
  statusLabel: string;
  truckId: string | null;
  truckCode: string | null;
  tripId: string | null;
  tripNumber: string | null;
  orderId: string | null;
  customerName: string | null;
  businessDate: string;
  startedAt: Date;
  endedAt: Date | null;
  durationS: number | null;
  distanceM: number | null;
  lat: number | null;
  lng: number | null;
  requiresExplanation: boolean;
  explanation: string | null;
  explainedAt: Date | null;
  explanationLate: boolean;
  explainedByName: string | null;
  userName: string | null;
  reviewDecision: string | null;
  reviewNote: string | null;
  reviewedAt: Date | null;
  reviewedByName: string | null;
  doneAt: Date | null;
  details: Record<string, unknown>;
  /** Masih menunggu tinjauan pemilik (daftar tinjauan). */
  needsReview: boolean;
  /** Keterangan sopir diminta dan belum diisi. */
  awaitingExplanation: boolean;
};

export function groupOf(kind: FleetEventKind): EnumValue<"fleet_event_group"> {
  for (const [g, kinds] of Object.entries(EVENT_GROUPS)) if ((kinds as readonly string[]).includes(kind)) return g as EnumValue<"fleet_event_group">;
  return "travel";
}

function needsReview(e: Pick<FleetEventRow, "kind" | "status">): boolean {
  return REVIEW_KINDS.includes(e.kind) && (e.status === "detected" || e.status === "explained");
}

async function viewRows(tx: Tx, where: ReturnType<typeof and>, limit = 500): Promise<FleetEventView[]> {
  const explainer = sql`(select ${employees.fullName} from ${users} join ${employees} on ${employees.id} = ${users.employeeId} where ${users.id} = ${fleetEvents.explainedBy})`;
  const reviewer = sql`(select ${employees.fullName} from ${users} join ${employees} on ${employees.id} = ${users.employeeId} where ${users.id} = ${fleetEvents.reviewedBy})`;
  const actor = sql`(select ${employees.fullName} from ${users} join ${employees} on ${employees.id} = ${users.employeeId} where ${users.id} = ${fleetEvents.userId})`;
  const rows = await tx
    .select({
      e: fleetEvents,
      truckCode: trucks.code,
      tripNumber: trips.number,
      orderId: trips.orderId,
      customerName: customers.name,
      explainedByName: sql<string | null>`${explainer}`,
      reviewedByName: sql<string | null>`${reviewer}`,
      userName: sql<string | null>`${actor}`,
    })
    .from(fleetEvents)
    .leftJoin(trucks, eq(trucks.id, fleetEvents.truckId))
    .leftJoin(trips, eq(trips.id, fleetEvents.tripId))
    .leftJoin(customers, eq(customers.id, trips.customerId))
    .where(where)
    .orderBy(desc(fleetEvents.startedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.e.id,
    kind: r.e.kind,
    kindLabel: label("fleet_event_kind", r.e.kind),
    group: groupOf(r.e.kind),
    status: r.e.status,
    statusLabel: label("fleet_event_status", r.e.status),
    truckId: r.e.truckId,
    truckCode: r.truckCode,
    tripId: r.e.tripId,
    tripNumber: r.tripNumber,
    orderId: r.orderId,
    customerName: r.customerName,
    businessDate: r.e.businessDate,
    startedAt: r.e.startedAt,
    endedAt: r.e.endedAt,
    durationS: r.e.durationS,
    distanceM: r.e.distanceM,
    lat: r.e.lat,
    lng: r.e.lng,
    requiresExplanation: r.e.requiresExplanation,
    explanation: r.e.explanation,
    explainedAt: r.e.explainedAt,
    explanationLate: r.e.explanationLate,
    explainedByName: r.explainedByName,
    userName: r.userName,
    reviewDecision: r.e.reviewDecision,
    reviewNote: r.e.reviewNote,
    reviewedAt: r.e.reviewedAt,
    reviewedByName: r.reviewedByName,
    doneAt: r.e.doneAt,
    details: r.e.details ?? {},
    needsReview: needsReview(r.e),
    awaitingExplanation: r.e.requiresExplanation && !r.e.explanation && r.e.status !== "done",
  }));
}

export type FleetEventFilter = {
  from?: BusinessDate;
  to?: BusinessDate;
  kind?: FleetEventKind;
  status?: EnumValue<"fleet_event_status">;
  group?: EnumValue<"fleet_event_group">;
  truckId?: string;
  view?: "review" | "open" | "all";
  limit?: number;
};

/** Daftar kejadian armada (bawaan 7 hari; masuk/keluar geofence hanya bila diminta kelompok geofence/jenisnya). */
export async function listFleetEvents(ctx: ActorContext, input: FleetEventFilter = {}, opts: { tx?: Tx } = {}): Promise<FleetEventView[]> {
  await authorize(ctx, "m12.fleet_event.read", { tx: opts.tx });
  const f = parseInput(eventFilterSchema, input, { from: "Dari", to: "Sampai", kind: "Jenis", status: "Status" });
  const tx = opts.tx ?? getDb();
  const to = f.to ?? ctxBusinessDate(ctx);
  const from = f.from ?? addDays(to, f.view === "review" ? -30 : -6);
  const conds = [eq(fleetEvents.tenantId, ctx.tenantId), gte(fleetEvents.businessDate, from), lte(fleetEvents.businessDate, to)];
  if (f.kind) conds.push(eq(fleetEvents.kind, f.kind));
  else if (f.group) conds.push(inArray(fleetEvents.kind, [...EVENT_GROUPS[f.group]]));
  else conds.push(notInArray(fleetEvents.kind, ["geofence_enter", "geofence_exit"]));
  if (f.status) conds.push(eq(fleetEvents.status, f.status));
  if (f.truckId) conds.push(eq(fleetEvents.truckId, f.truckId));
  if (f.view === "review") {
    conds.push(inArray(fleetEvents.kind, [...REVIEW_KINDS]));
    conds.push(inArray(fleetEvents.status, ["detected", "explained"]));
  } else if (f.view === "open") {
    conds.push(ne(fleetEvents.status, "done"));
  }
  return viewRows(tx, and(...conds), f.limit ?? 500);
}

export type FleetEventDetail = FleetEventView & {
  addressText: string | null;
  target: { lat: number; lng: number } | null;
  trail: { at: Date; action: string; actorName: string; reason: string | null }[];
};

/** Rincian kejadian: data, peta kecil (titik kejadian + tujuan/posisi perangkat), jejak keputusan. */
export async function getFleetEvent(ctx: ActorContext, id: string, opts: { tx?: Tx } = {}): Promise<FleetEventDetail> {
  await authorize(ctx, "m12.fleet_event.read", { tx: opts.tx, objectType: "fleet_event", objectId: id });
  const tx = opts.tx ?? getDb();
  const [view] = await viewRows(tx, and(eq(fleetEvents.id, id), eq(fleetEvents.tenantId, ctx.tenantId)), 1);
  if (!view) throw new NotFoundError("Kejadian armada tidak ditemukan.");
  let addressText: string | null = null;
  let target: { lat: number; lng: number } | null = (view.details.target as { lat: number; lng: number } | undefined) ?? null;
  if (view.tripId) {
    const [a] = await tx
      .select({ text: customerAddresses.addressText, lat: customerAddresses.lat, lng: customerAddresses.lng })
      .from(trips)
      .innerJoin(customerAddresses, eq(customerAddresses.id, trips.addressId))
      .where(eq(trips.id, view.tripId))
      .limit(1);
    addressText = a?.text ?? null;
    if (!target && a?.lat != null && a.lng != null) target = { lat: a.lat, lng: a.lng };
  }
  // Jejak keputusan objek ini (bagian tampilan kejadian; izin baca kejadian sudah diperiksa).
  const audit: AuditRow[] = await auditQuery(tx, { tenantId: ctx.tenantId, objectType: "fleet_event", objectId: id, limit: 50 });
  const actorIds = [...new Set(audit.map((a) => a.actorUserId).filter((x): x is string => !!x))];
  const names = actorIds.length
    ? await tx.select({ id: users.id, name: employees.fullName }).from(users).innerJoin(employees, eq(employees.id, users.employeeId)).where(inArray(users.id, actorIds))
    : [];
  return {
    ...view,
    addressText,
    target,
    trail: audit
      .sort((a, b) => a.serverTime.getTime() - b.serverTime.getTime())
      .map((a) => ({ at: a.serverTime, action: a.action, actorName: a.actorUserId ? (names.find((n) => n.id === a.actorUserId)?.name ?? "Pengguna") : "Sistem", reason: a.reason })),
  };
}

/**
 * Tinjauan kejadian (US-M12-04 KP-3, US-M12-05 KP-4): `accepted` (terima alasan → Selesai), `follow_up` (tindak lanjut di
 * luar sistem → Ditinjau), `request_explanation` (tugas keterangan ke sopir di M3). Berjejak.
 */
export async function reviewFleetEvent(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<FleetEventRow> {
  const data = parseInput(reviewSchema, input, { decision: "Keputusan", note: "Catatan" });
  await authorize(ctx, data.decision === "request_explanation" ? "m12.fleet_event.request_explanation" : "m12.fleet_event.review", {
    tx: opts.tx,
    objectType: "fleet_event",
    objectId: data.fleetEventId,
  });
  return runService(ctx, opts, async (tx) => {
    const [ev] = await tx.select().from(fleetEvents).where(eq(fleetEvents.id, data.fleetEventId)).for("update").limit(1);
    if (!ev || ev.tenantId !== ctx.tenantId) throw new NotFoundError("Kejadian armada tidak ditemukan.");
    if (ev.status === "done") throw new DomainError("FLEET_EVENT_DONE", "Kejadian ini sudah Selesai — keputusan tidak dapat diubah (BR-38).");
    const before = { status: ev.status, reviewDecision: ev.reviewDecision, requiresExplanation: ev.requiresExplanation };
    let patch: Partial<typeof fleetEvents.$inferInsert>;
    if (data.decision === "request_explanation") {
      if (!ev.truckId) throw new DomainError("NO_TRUCK", "Kejadian ini tidak terkait truk — keterangan sopir tidak dapat diminta.");
      if (ev.explanation) {
        throw new DomainError("EXPLANATION_EXISTS", "Sopir sudah memberi keterangan. Tinjau keterangannya lalu terima atau tandai tindak lanjut.");
      }
      patch = { requiresExplanation: true, status: "detected", reviewDecision: "request_explanation", reviewNote: data.note ?? null, reviewedBy: ctx.userId, reviewedAt: ctx.now };
    } else if (data.decision === "accepted") {
      patch = { status: "done", reviewDecision: "accepted", reviewNote: data.note ?? null, reviewedBy: ctx.userId, reviewedAt: ctx.now, doneAt: ctx.now };
    } else {
      patch = { status: "reviewed", reviewDecision: "follow_up", reviewNote: data.note ?? null, reviewedBy: ctx.userId, reviewedAt: ctx.now };
    }
    const [row] = await tx
      .update(fleetEvents)
      .set({ ...patch, updatedAt: ctx.now })
      .where(eq(fleetEvents.id, ev.id))
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "fleet_event",
      objectId: ev.id,
      action: data.decision === "request_explanation" ? "request_explanation" : "review",
      before,
      after: { status: row!.status, reviewDecision: row!.reviewDecision, requiresExplanation: row!.requiresExplanation },
      reason: data.note ?? label("fleet_review_decision", data.decision),
      rule: ev.kind.startsWith("location") ? "BR-23, US-M12-04 KP-3" : "BR-25, US-M12-05 KP-4",
      businessDate: ev.businessDate,
    });
    if (data.decision === "request_explanation") {
      const [truck] = await tx.select({ code: trucks.code }).from(trucks).where(eq(trucks.id, ev.truckId!)).limit(1);
      const driver = ev.userId ?? (ev.tripId ? ((await tx.select({ u: trips.driverUserId }).from(trips).where(eq(trips.id, ev.tripId)).limit(1))[0]?.u ?? null) : null);
      if (driver) {
        await notifyDriver(tx, { tenantId: ev.tenantId, userId: driver, eventId: ev.id, title: `Keterangan diminta: ${label("fleet_event_kind", ev.kind)} truk ${truck?.code ?? ""}`.trim(), now: ctx.now });
      }
    }
    return row!;
  });
}

/** Tandai kejadian yang ditindaklanjuti di luar sistem sebagai Selesai (catatan hasil wajib, berjejak). */
export async function closeFleetEvent(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<FleetEventRow> {
  const data = parseInput(closeEventSchema, input, { note: "Hasil tindak lanjut" });
  await authorize(ctx, "m12.fleet_event.review", { tx: opts.tx, objectType: "fleet_event", objectId: data.fleetEventId });
  return runService(ctx, opts, async (tx) => {
    const [ev] = await tx.select().from(fleetEvents).where(eq(fleetEvents.id, data.fleetEventId)).for("update").limit(1);
    if (!ev || ev.tenantId !== ctx.tenantId) throw new NotFoundError("Kejadian armada tidak ditemukan.");
    if (ev.status === "done") throw new DomainError("FLEET_EVENT_DONE", "Kejadian ini sudah Selesai.");
    const note = ev.reviewNote ? `${ev.reviewNote}\nHasil: ${data.note}` : `Hasil: ${data.note}`;
    const [row] = await tx
      .update(fleetEvents)
      .set({ status: "done", doneAt: ctx.now, reviewNote: note, reviewedBy: ev.reviewedBy ?? ctx.userId, reviewedAt: ev.reviewedAt ?? ctx.now, updatedAt: ctx.now })
      .where(eq(fleetEvents.id, ev.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "fleet_event", objectId: ev.id, action: "close", before: { status: ev.status }, after: { status: "done" }, reason: data.note, rule: "US-M12-05 KP-4", businessDate: ev.businessDate });
    return row!;
  });
}

export type PatternRow = { key: string; name: string; locationEvents: number; level2: number; inconsistent: number };

/** Pola penyimpangan lokasi berulang per sopir & per pelanggan (US-M12-04 KP-3 → masukan US-M9-05). */
export async function locationDeviationPatterns(ctx: ActorContext, input: { from: BusinessDate; to: BusinessDate }, opts: { tx?: Tx } = {}): Promise<{ byDriver: PatternRow[]; byCustomer: PatternRow[] }> {
  await authorize(ctx, "m12.fleet_event.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx
    .select({ kind: fleetEvents.kind, userId: fleetEvents.userId, driverName: employees.fullName, customerId: customers.id, customerName: customers.name })
    .from(fleetEvents)
    .leftJoin(trips, eq(trips.id, fleetEvents.tripId))
    .leftJoin(customers, eq(customers.id, trips.customerId))
    .leftJoin(users, eq(users.id, fleetEvents.userId))
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .where(
      and(
        eq(fleetEvents.tenantId, ctx.tenantId),
        inArray(fleetEvents.kind, ["location_deviation_l1", "location_deviation_l2", "location_source_inconsistent"]),
        gte(fleetEvents.businessDate, input.from),
        lte(fleetEvents.businessDate, input.to),
      ),
    );
  const tally = (keyOf: (r: (typeof rows)[number]) => string | null, nameOf: (r: (typeof rows)[number]) => string | null) => {
    const m = new Map<string, PatternRow>();
    for (const r of rows) {
      const key = keyOf(r);
      if (!key) continue;
      const cur = m.get(key) ?? { key, name: nameOf(r) ?? "—", locationEvents: 0, level2: 0, inconsistent: 0 };
      cur.locationEvents++;
      if (r.kind === "location_deviation_l2") cur.level2++;
      if (r.kind === "location_source_inconsistent") cur.inconsistent++;
      m.set(key, cur);
    }
    return [...m.values()].sort((a, b) => b.locationEvents - a.locationEvents || a.name.localeCompare(b.name));
  };
  return { byDriver: tally((r) => r.userId, (r) => r.driverName), byCustomer: tally((r) => r.customerId, (r) => r.customerName) };
}

export type FleetDaySummary = {
  date: BusinessDate;
  unexplained: { id: string; kind: string; kindLabel: string; truckCode: string | null; startedAt: Date }[];
  counts: { offSchedule: number; unknownStops: number; deviationsL2: number; inconsistent: number; geofenceFlags: number; awaitingReview: number };
  deviceOutages: { truckId: string; truckCode: string; minutes: number }[];
  deviceOutageThresholdMinutes: number;
};

/**
 * Ringkasan armada untuk H+0 (M9, US-M9-01): kejadian tanpa keterangan, penyimpangan tingkat 2, sumber lokasi tidak
 * konsisten, penanda geofence, dan perangkat GPS mati/dicabut > `device_dead_h0_minutes` dalam sehari (US-M12-08 KP-2).
 */
export async function fleetDaySummary(tx: Tx, tenantId: string, date: BusinessDate, now: Date): Promise<FleetDaySummary> {
  const rules = await m12Rules(tx, date, tenantId);
  const events = await tx
    .select({ e: fleetEvents, truckCode: trucks.code })
    .from(fleetEvents)
    .leftJoin(trucks, eq(trucks.id, fleetEvents.truckId))
    .where(and(eq(fleetEvents.tenantId, tenantId), eq(fleetEvents.businessDate, date)))
    .orderBy(asc(fleetEvents.startedAt), asc(fleetEvents.id));
  const truckRows = await tx.select({ id: trucks.id, code: trucks.code }).from(trucks).where(eq(trucks.tenantId, tenantId));
  const dead = await deviceOutageMinutesOn(tx, truckRows.map((t) => t.id), date, now);
  return summarizeFleetDay(date, rules, events, truckRows, dead);
}

/**
 * Versi RENTANG `fleetDaySummary` (v1.0.1, D-14 butir 4 / B-90 — H+0 rentang bulan): satu kueri kejadian, satu kueri
 * truk, satu kueri perangkat mati untuk seluruh rentang, dan aturan per tanggal lewat cache parameter (`params.cached`,
 * satu kueri per parameter) — sebelumnya ±16 kueri PER HARI (30 hari ≈ 480 kueri). Mengembalikan satu ringkasan per
 * tanggal `from..to` (urut naik) yang IDENTIK dengan `fleetDaySummary(tx, tenantId, d, now)` (diuji).
 */
export async function fleetRangeSummary(
  tx: Tx,
  tenantId: string,
  from: BusinessDate,
  to: BusinessDate,
  now: Date,
  opts: { cache?: params.ParamCache } = {},
): Promise<FleetDaySummary[]> {
  const dates: BusinessDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  if (dates.length === 0) return [];
  const cache = opts.cache ?? params.cached(tx);
  const rulesByDate = new Map<BusinessDate, M12Rules>();
  for (const d of dates) rulesByDate.set(d, await m12Rules(tx, d, tenantId, { cache }));
  const events = await tx
    .select({ e: fleetEvents, truckCode: trucks.code })
    .from(fleetEvents)
    .leftJoin(trucks, eq(trucks.id, fleetEvents.truckId))
    .where(and(eq(fleetEvents.tenantId, tenantId), gte(fleetEvents.businessDate, from), lte(fleetEvents.businessDate, to)))
    .orderBy(asc(fleetEvents.startedAt), asc(fleetEvents.id));
  const eventsByDate = new Map<string, typeof events>();
  for (const r of events) {
    const list = eventsByDate.get(r.e.businessDate);
    if (list) list.push(r);
    else eventsByDate.set(r.e.businessDate, [r]);
  }
  const truckRows = await tx.select({ id: trucks.id, code: trucks.code }).from(trucks).where(eq(trucks.tenantId, tenantId));
  const dead = await deviceOutageMinutesForRange(tx, truckRows.map((t) => t.id), dates, now);
  return dates.map((d) => summarizeFleetDay(d, rulesByDate.get(d)!, eventsByDate.get(d) ?? [], truckRows, dead.get(d) ?? new Map()));
}

/** Susun ringkasan H+0 satu tanggal (murni — dipakai `fleetDaySummary` & `fleetRangeSummary` agar keluarannya sama). */
function summarizeFleetDay(
  date: BusinessDate,
  rules: M12Rules,
  events: readonly { e: FleetEventRow; truckCode: string | null }[],
  truckRows: readonly { id: string; code: string }[],
  dead: Map<string, number>,
): FleetDaySummary {
  const unexplained = events.filter((r) => r.e.requiresExplanation && !r.e.explanation && r.e.status !== "done");
  return {
    date,
    unexplained: unexplained.map((r) => ({ id: r.e.id, kind: r.e.kind, kindLabel: label("fleet_event_kind", r.e.kind), truckCode: r.truckCode, startedAt: r.e.startedAt })),
    counts: {
      offSchedule: events.filter((r) => r.e.kind === "off_schedule_trip" || r.e.kind === "off_hours_trip").length,
      unknownStops: events.filter((r) => r.e.kind === "unknown_stop").length,
      deviationsL2: events.filter((r) => r.e.kind === "location_deviation_l2").length,
      inconsistent: events.filter((r) => r.e.kind === "location_source_inconsistent").length,
      geofenceFlags: events.filter((r) => ["fill_without_geofence", "geofence_without_fill", "supply_without_geofence"].includes(r.e.kind)).length,
      awaitingReview: events.filter((r) => needsReview(r.e)).length,
    },
    deviceOutages: truckRows
      .map((t) => ({ truckId: t.id, truckCode: t.code, minutes: dead.get(t.id) ?? 0 }))
      .filter((t) => t.minutes > rules.fleet.device_dead_h0_minutes)
      .sort((a, b) => b.minutes - a.minutes),
    deviceOutageThresholdMinutes: rules.fleet.device_dead_h0_minutes,
  };
}

/** Versi berizin `fleetDaySummary` untuk layar kantor (bagian H+0 di Kejadian armada). */
export async function getFleetDaySummary(ctx: ActorContext, date: BusinessDate, opts: { tx?: Tx } = {}): Promise<FleetDaySummary> {
  await authorize(ctx, "m12.fleet_event.read", { tx: opts.tx });
  return fleetDaySummary(opts.tx ?? getDb(), ctx.tenantId, date, ctx.now);
}

/**
 * Handler `cash_day.closed` (US-M12-05 KP-4, BR-25, 6.3): kejadian yang belum diberi keterangan sopir saat tutup kas
 * ditandai dan dikirim ke kotak masuk pemilik (`travel_explanation.missing`, kunci grup sama dengan job M3 PAR-06 —
 * tidak ganda).
 */
export async function markUnexplainedAtCashClose(tx: Tx, input: { tenantId: string; date: BusinessDate; closedAt: Date; now: Date }): Promise<number> {
  const rows = await tx
    .select({ e: fleetEvents, truckCode: trucks.code })
    .from(fleetEvents)
    .leftJoin(trucks, eq(trucks.id, fleetEvents.truckId))
    .where(and(eq(fleetEvents.tenantId, input.tenantId), eq(fleetEvents.businessDate, input.date), eq(fleetEvents.requiresExplanation, true), isNull(fleetEvents.explanation), ne(fleetEvents.status, "done")));
  if (rows.length === 0) return 0;
  const ctx = systemContext({ tenantId: input.tenantId, now: input.now });
  for (const r of rows) {
    if ((r.e.details as { unexplainedAtCashClose?: string } | null)?.unexplainedAtCashClose) continue;
    await tx
      .update(fleetEvents)
      .set({ details: { ...(r.e.details ?? {}), unexplainedAtCashClose: input.closedAt.toISOString() }, updatedAt: input.now })
      .where(eq(fleetEvents.id, r.e.id));
    await auditRecord(tx, { ctx, objectType: "fleet_event", objectId: r.e.id, action: "flag", after: { unexplainedAtCashClose: true }, rule: "BR-25, US-M12-05 KP-4", businessDate: input.date });
  }
  await notifyOnce(tx, {
    event: "travel_explanation.missing",
    tenantId: input.tenantId,
    title: `${rows.length} keterangan perjalanan belum diisi sopir (${input.date})`,
    body: `Truk: ${[...new Set(rows.map((r) => r.truckCode ?? "?"))].join(", ")}. Kas sudah ditutup; tinjau di Kejadian armada dan minta keterangan (BR-25).`,
    objectType: "fleet_event",
    objectId: rows[0]!.e.id,
    valueText: `${rows.length} kejadian`,
    link: `/armada/kejadian?tampil=h0&tanggal=${input.date}`,
    groupKey: `travel_explanation.missing:${input.date}`,
    now: input.now,
  });
  return rows.length;
}
