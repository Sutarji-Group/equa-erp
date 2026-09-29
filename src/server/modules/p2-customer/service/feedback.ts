/**
 * P2 — penilaian layanan & keluhan (US-P2-06, S).
 *
 * - KP-1: nilai 1–5 + komentar sekali per pengiriman Selesai (dapat dilewati), terkait rit, truk, sopir; agregat untuk
 *   kinerja M9 (US-M9-05, `ratingAggregates`); komentar mentah hanya untuk pemilik & Dispatcher (`p2.rating.read`).
 * - KP-2: keluhan (jenis, teks, foto, terkait pesanan/rit/faktur) → kotak Dispatcher (operasional) atau Admin Keuangan
 *   (tagihan); tanggapan pertama ≤ PAR-75 jam layanan (lewat → notifikasi, job); status tampil ke pelanggan; keluhan
 *   volume/tagihan dapat memicu sengketa faktur M5 (7.5.6) oleh Admin Keuangan.
 * - KP-3: keluhan tidak dapat dihapus (DB menolak DELETE); ditutup dengan penyelesaian tercatat; laporan bulanan per
 *   jenis dan per truk.
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { complaintActions, complaints, customers, employees, invoices, orders, tripRatings, trips, trucks, users } from "@/db/schema";
import { enumValues, label, type EnumValue } from "@/lib/labels";
import { addDays, formatTanggalJam, lastDayOfMonth, monthOf, toBusinessDate, wibToUtc, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { hasRole, type ActorContext } from "@/server/core/context";
import { getDb, runInTx, type Db, type Tx } from "@/server/core/db";
import { ConflictError, DomainError, ForbiddenError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";
import { put as putAttachment } from "@/server/core/storage";
import * as m5 from "@/server/modules/m5-receivables";

import { addServiceHours, assertAppEnabled, customerAuditCtx, loadOwnInvoices, loadOwnOrder, loadOwnTrip, recordCustomerAudit, requireLinked, type CustomerContext } from "./common";
import { notifyCustomer } from "./messaging";

export type ComplaintRow = typeof complaints.$inferSelect;
export type ComplaintBox = "dispatcher" | "finance_admin";

// =====================================================================================================================
// Penilaian (KP-1)
// =====================================================================================================================

const ratingSchema = z.object({
  rating: z.coerce.number({ error: "Pilih nilai 1–5." }).int().min(1, { error: "Pilih nilai 1–5." }).max(5, { error: "Pilih nilai 1–5." }),
  comment: z.string().trim().max(500, { error: "Komentar maksimal 500 karakter." }).nullable().optional(),
});

/** Nilai pengiriman Selesai (sekali per rit). */
export async function rateDelivery(cctx: CustomerContext, tripId: string, input: z.input<typeof ratingSchema>, opts: { tx?: Tx } = {}) {
  const customerId = requireLinked(cctx);
  const data = parseInput(ratingSchema, input, { rating: "Nilai", comment: "Komentar" });
  return runInTx(opts.tx, async (tx) => {
    await assertAppEnabled(tx, cctx.tenantId);
    const trip = await loadOwnTrip(tx, cctx, tripId);
    if (trip.status !== "completed") throw new DomainError("DELIVERY_NOT_DONE", "Penilaian dapat diberikan setelah air diterima (pengiriman Selesai).");
    const [exists] = await tx.select({ id: tripRatings.id }).from(tripRatings).where(eq(tripRatings.tripId, trip.id)).limit(1);
    if (exists) throw new ConflictError("ALREADY_RATED", "Pengiriman ini sudah Anda nilai. Terima kasih!");
    const [row] = await tx
      .insert(tripRatings)
      .values({ tenantId: trip.tenantId, tripId: trip.id, customerAccountId: cctx.accountId, customerId, truckId: trip.truckId, driverEmployeeId: trip.driverEmployeeId, rating: data.rating, comment: data.comment || null, createdAt: cctx.now, updatedAt: cctx.now })
      .returning();
    await recordCustomerAudit(tx, cctx, { objectType: "trip_rating", objectId: row!.id, action: "create", after: { tripId: trip.id, rating: data.rating, hasComment: !!data.comment }, rule: "US-P2-06 KP-1" });
    return row!;
  });
}

export type RatingAggregate = { key: string; label: string; count: number; average: number; lowCount: number };

/**
 * Agregat penilaian per truk & per sopir pada rentang tanggal WIB (untuk kinerja M9, US-M9-05) — TANPA komentar.
 */
export async function ratingAggregates(tx: Tx | Db, input: { tenantId: string; from: BusinessDate; to: BusinessDate }): Promise<{ trucks: RatingAggregate[]; drivers: RatingAggregate[]; overall: { count: number; average: number } }> {
  const start = wibToUtc(input.from, "00:00");
  const end = wibToUtc(addDays(input.to, 1), "00:00");
  const rows = await tx
    .select({ r: tripRatings, plate: trucks.plateNumber, truckCode: trucks.code, driverName: employees.fullName })
    .from(tripRatings)
    .leftJoin(trucks, eq(trucks.id, tripRatings.truckId))
    .leftJoin(employees, eq(employees.id, tripRatings.driverEmployeeId))
    .where(and(eq(tripRatings.tenantId, input.tenantId), gte(tripRatings.createdAt, start), lt(tripRatings.createdAt, end)));
  const group = (keyOf: (r: (typeof rows)[number]) => [string, string] | null): RatingAggregate[] => {
    const map = new Map<string, { label: string; sum: number; count: number; low: number }>();
    for (const r of rows) {
      const k = keyOf(r);
      if (!k) continue;
      const g = map.get(k[0]) ?? { label: k[1], sum: 0, count: 0, low: 0 };
      g.sum += r.r.rating;
      g.count++;
      if (r.r.rating <= 2) g.low++;
      map.set(k[0], g);
    }
    return [...map.entries()].map(([key, g]) => ({ key, label: g.label, count: g.count, average: Math.round((g.sum / g.count) * 100) / 100, lowCount: g.low })).sort((a, b) => a.average - b.average || b.count - a.count);
  };
  const total = rows.reduce((s, r) => s + r.r.rating, 0);
  return {
    trucks: group((r) => (r.r.truckId ? [r.r.truckId, `${r.truckCode ?? ""} ${r.plate ?? ""}`.trim()] : null)),
    drivers: group((r) => (r.r.driverEmployeeId ? [r.r.driverEmployeeId, r.driverName ?? "—"] : null)),
    overall: { count: rows.length, average: rows.length ? Math.round((total / rows.length) * 100) / 100 : 0 },
  };
}

export type RatingCommentRow = { id: string; createdAt: Date; rating: number; comment: string | null; customerName: string; tripNumber: string; truck: string | null; driverName: string | null };

/** Layar penilaian kantor (pemilik & Dispatcher): agregat + komentar mentah. */
export async function ratingOverview(ctx: ActorContext, filter: { month?: string | null } = {}, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "p2.rating.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const month = filter.month && /^\d{4}-\d{2}$/.test(filter.month) ? filter.month : monthOf(toBusinessDate(ctx.now));
  const from = `${month}-01`;
  const to = lastDayOfMonth(from);
  const agg = await ratingAggregates(tx, { tenantId: ctx.tenantId, from, to });
  const rows = await tx
    .select({ r: tripRatings, customerName: customers.name, tripNumber: trips.number, plate: trucks.plateNumber, driverName: employees.fullName })
    .from(tripRatings)
    .innerJoin(customers, eq(customers.id, tripRatings.customerId))
    .innerJoin(trips, eq(trips.id, tripRatings.tripId))
    .leftJoin(trucks, eq(trucks.id, tripRatings.truckId))
    .leftJoin(employees, eq(employees.id, tripRatings.driverEmployeeId))
    .where(and(eq(tripRatings.tenantId, ctx.tenantId), gte(tripRatings.createdAt, wibToUtc(from, "00:00")), lt(tripRatings.createdAt, wibToUtc(addDays(to, 1), "00:00"))))
    .orderBy(desc(tripRatings.createdAt))
    .limit(500);
  const comments: RatingCommentRow[] = rows.map((x) => ({ id: x.r.id, createdAt: x.r.createdAt, rating: x.r.rating, comment: x.r.comment, customerName: x.customerName, tripNumber: x.tripNumber, truck: x.plate, driverName: x.driverName }));
  return { month, ...agg, comments };
}

// =====================================================================================================================
// Keluhan — pelanggan (KP-2)
// =====================================================================================================================

const complaintSchema = z.object({
  kind: z.enum(enumValues("complaint_kind"), { error: "Pilih jenis keluhan." }),
  description: z.string({ error: "Ceritakan keluhan Anda." }).trim().min(10, { error: "Ceritakan keluhan Anda (minimal 10 karakter)." }).max(2000),
  orderId: z.uuid().nullable().optional(),
  tripId: z.uuid().nullable().optional(),
  invoiceId: z.uuid().nullable().optional(),
});
export type ComplaintInput = z.input<typeof complaintSchema> & { photo?: { blob: Blob | Buffer | Uint8Array; contentType: string; name?: string | null } | null };

/** Kotak keluhan menurut jenis: tagihan → Admin Keuangan; lainnya → Dispatcher (operasional). */
export function complaintBoxFor(kind: EnumValue<"complaint_kind">): ComplaintBox {
  return kind === "billing" ? "finance_admin" : "dispatcher";
}

async function responseDeadline(tx: Tx, now: Date): Promise<Date> {
  const date = toBusinessDate(now);
  const p75 = await params.get(tx, "PAR-75", date);
  const window = await params.get(tx, "PAR-07", date);
  return addServiceHours(now, p75.complaint_response_hours, window, p75.service_hours_only);
}

/** Ajukan keluhan (KP-2). Foto opsional disimpan sebagai lampiran keluhan. */
export async function submitComplaint(cctx: CustomerContext, input: ComplaintInput, opts: { tx?: Tx } = {}): Promise<ComplaintRow> {
  const customerId = requireLinked(cctx);
  const data = parseInput(complaintSchema, input, { kind: "Jenis", description: "Keluhan", orderId: "Pesanan", tripId: "Pengiriman", invoiceId: "Tagihan" });
  return runInTx(opts.tx, async (tx) => {
    await assertAppEnabled(tx, cctx.tenantId);
    let orderId = data.orderId ?? null;
    if (orderId) await loadOwnOrder(tx, cctx, orderId);
    if (data.tripId) {
      const trip = await loadOwnTrip(tx, cctx, data.tripId);
      orderId ??= trip.orderId;
      if (trip.orderId !== orderId) throw ValidationError.field("tripId", "Pengiriman tidak sesuai dengan pesanan yang dipilih.");
    }
    if (data.invoiceId) await loadOwnInvoices(tx, cctx, [data.invoiceId]);
    const box = complaintBoxFor(data.kind);
    const dueAt = await responseDeadline(tx, cctx.now);
    const [row] = await tx
      .insert(complaints)
      .values({
        tenantId: cctx.tenantId,
        customerAccountId: cctx.accountId,
        customerId,
        orderId,
        tripId: data.tripId ?? null,
        invoiceId: data.invoiceId ?? null,
        kind: data.kind,
        description: data.description,
        status: "submitted",
        assignedRole: box,
        dueAt,
        createdAt: cctx.now,
        updatedAt: cctx.now,
      })
      .returning();
    let complaint = row!;
    if (input.photo) {
      const att = await putAttachment(tx, customerAuditCtx(cctx), { blob: input.photo.blob, contentType: input.photo.contentType, kind: "complaint_photo", objectRef: { type: "complaint", id: complaint.id }, originalName: input.photo.name ?? null, capturedAt: cctx.now });
      [complaint] = await tx.update(complaints).set({ photoAttachmentId: att.id }).where(eq(complaints.id, complaint.id)).returning() as [ComplaintRow];
    }
    await recordCustomerAudit(tx, cctx, { objectType: "complaint", objectId: complaint.id, action: "create", after: { kind: data.kind, box, orderId, tripId: data.tripId ?? null, invoiceId: data.invoiceId ?? null, hasPhoto: !!input.photo, dueAt }, rule: "US-P2-06 KP-2" });
    const [c] = await tx.select({ name: customers.name }).from(customers).where(eq(customers.id, customerId)).limit(1);
    await notify(tx, {
      event: "customer_app.complaint_submitted",
      tenantId: cctx.tenantId,
      recipients: { roles: [box] },
      title: `Keluhan ${label("complaint_kind", data.kind).toLowerCase()}: ${c?.name ?? "pelanggan"}`,
      body: `${data.description.slice(0, 160)}${data.description.length > 160 ? "…" : ""} — tanggapi sebelum ${formatTanggalJam(dueAt)}.`,
      objectType: "complaint",
      objectId: complaint.id,
      deadlineAt: dueAt,
      link: `/keluhan/${complaint.id}`,
      now: cctx.now,
    });
    return complaint;
  });
}

export type CustomerComplaintView = {
  id: string;
  kind: EnumValue<"complaint_kind">;
  kindLabel: string;
  description: string;
  status: EnumValue<"complaint_status">;
  statusLabel: string;
  createdAt: Date;
  orderNumber: string | null;
  hasPhoto: boolean;
  photoUrl: string | null;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  resolution: string | null;
  /** Tindak lanjut yang boleh dilihat pelanggan (tanggapan, penyelesaian). */
  updates: { at: Date; kind: string; note: string | null }[];
};

async function complaintViews(tx: Tx | Db, rows: ComplaintRow[]): Promise<CustomerComplaintView[]> {
  if (!rows.length) return [];
  const orderRows = await tx.select({ id: orders.id, number: orders.number }).from(orders).where(inArray(orders.id, rows.map((r) => r.orderId).filter((x): x is string => !!x).concat(["00000000-0000-0000-0000-000000000000"])));
  const actions = await tx
    .select()
    .from(complaintActions)
    .where(and(inArray(complaintActions.complaintId, rows.map((r) => r.id)), eq(complaintActions.visibleToCustomer, true)))
    .orderBy(asc(complaintActions.createdAt));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    kindLabel: label("complaint_kind", r.kind),
    description: r.description,
    status: r.status,
    statusLabel: label("complaint_status", r.status),
    createdAt: r.createdAt,
    orderNumber: orderRows.find((o) => o.id === r.orderId)?.number ?? null,
    hasPhoto: !!r.photoAttachmentId,
    photoUrl: r.photoAttachmentId ? `/api/customer/lampiran/${r.photoAttachmentId}` : null,
    firstResponseAt: r.firstResponseAt,
    resolvedAt: r.resolvedAt,
    resolution: r.resolution,
    updates: actions.filter((a) => a.complaintId === r.id).map((a) => ({ at: a.createdAt, kind: label("complaint_action", a.action), note: a.note })),
  }));
}

export async function listMyComplaints(cctx: CustomerContext, opts: { tx?: Tx } = {}): Promise<CustomerComplaintView[]> {
  const customerId = requireLinked(cctx);
  const tx = opts.tx ?? getDb();
  const rows = await tx.select().from(complaints).where(eq(complaints.customerId, customerId)).orderBy(desc(complaints.createdAt)).limit(200);
  return complaintViews(tx, rows);
}

export async function getMyComplaint(cctx: CustomerContext, id: string, opts: { tx?: Tx } = {}): Promise<CustomerComplaintView> {
  const customerId = requireLinked(cctx);
  const tx = opts.tx ?? getDb();
  const [row] = await tx.select().from(complaints).where(and(eq(complaints.id, id), eq(complaints.customerId, customerId))).limit(1);
  if (!row) throw new NotFoundError("Keluhan tidak ditemukan.");
  return (await complaintViews(tx, [row]))[0]!;
}

// =====================================================================================================================
// Keluhan — kantor (/keluhan)
// =====================================================================================================================

export type OfficeComplaintRow = {
  id: string;
  kind: EnumValue<"complaint_kind">;
  status: EnumValue<"complaint_status">;
  box: ComplaintBox;
  customerId: string;
  customerName: string;
  description: string;
  orderNumber: string | null;
  tripNumber: string | null;
  truck: string | null;
  createdAt: Date;
  dueAt: Date | null;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  overdue: boolean;
};

/** Kotak bawaan pelaku: pemilik = semua; Admin Keuangan = tagihan; Dispatcher = operasional. */
export function defaultBox(ctx: ActorContext): ComplaintBox | "all" {
  if (hasRole(ctx, "owner") || (hasRole(ctx, "dispatcher") && hasRole(ctx, "finance_admin"))) return "all";
  if (hasRole(ctx, "finance_admin")) return "finance_admin";
  return "dispatcher";
}

export async function listComplaints(ctx: ActorContext, filter: { box?: ComplaintBox | "all" | null; status?: string | null; month?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<OfficeComplaintRow[]> {
  await authorize(ctx, "p2.complaint.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const box = filter.box ?? defaultBox(ctx);
  const conds: SQL[] = [eq(complaints.tenantId, ctx.tenantId)];
  if (box !== "all") conds.push(eq(complaints.assignedRole, box));
  if (filter.status === "open") conds.push(inArray(complaints.status, ["submitted", "responded"]));
  else if (filter.status && (enumValues("complaint_status") as readonly string[]).includes(filter.status)) conds.push(sql`${complaints.status} = ${filter.status}`);
  if (filter.month && /^\d{4}-\d{2}$/.test(filter.month)) {
    const from = `${filter.month}-01`;
    conds.push(gte(complaints.createdAt, wibToUtc(from, "00:00")), lt(complaints.createdAt, wibToUtc(addDays(lastDayOfMonth(from), 1), "00:00")));
  }
  const rows = await tx
    .select({ c: complaints, customerName: customers.name, orderNumber: orders.number, tripNumber: trips.number, plate: trucks.plateNumber })
    .from(complaints)
    .innerJoin(customers, eq(customers.id, complaints.customerId))
    .leftJoin(orders, eq(orders.id, complaints.orderId))
    .leftJoin(trips, eq(trips.id, complaints.tripId))
    .leftJoin(trucks, eq(trucks.id, trips.truckId))
    .where(and(...conds))
    .orderBy(asc(complaints.status), asc(complaints.dueAt), desc(complaints.createdAt))
    .limit(500);
  return rows.map(({ c, customerName, orderNumber, tripNumber, plate }) => ({
    id: c.id,
    kind: c.kind,
    status: c.status,
    box: c.assignedRole as ComplaintBox,
    customerId: c.customerId,
    customerName,
    description: c.description,
    orderNumber,
    tripNumber,
    truck: plate,
    createdAt: c.createdAt,
    dueAt: c.dueAt,
    firstResponseAt: c.firstResponseAt,
    resolvedAt: c.resolvedAt,
    overdue: !c.firstResponseAt && !!c.dueAt && c.dueAt < ctx.now,
  }));
}

export type OfficeComplaintDetail = OfficeComplaintRow & {
  row: ComplaintRow;
  customerPhone: string | null;
  invoice: { id: string; number: string; outstanding: number; disputed: boolean } | null;
  /** Faktur pesanan/rit terkait yang dapat disengketakan (keluhan volume/tagihan, 7.5.6). */
  disputeCandidates: { id: string; number: string; outstanding: number; disputed: boolean }[];
  actions: { id: string; at: Date; action: string; actionLabel: string; note: string | null; actorName: string | null; visibleToCustomer: boolean }[];
  photoUrl: string | null;
  canRespond: boolean;
};

export async function getComplaint(ctx: ActorContext, id: string, opts: { tx?: Tx } = {}): Promise<OfficeComplaintDetail> {
  await authorize(ctx, "p2.complaint.read", { tx: opts.tx, objectType: "complaint", objectId: id });
  const tx = opts.tx ?? getDb();
  const [row] = await tx
    .select({ c: complaints, customerName: customers.name, customerPhone: customers.waPhone, orderNumber: orders.number, tripNumber: trips.number, plate: trucks.plateNumber })
    .from(complaints)
    .innerJoin(customers, eq(customers.id, complaints.customerId))
    .leftJoin(orders, eq(orders.id, complaints.orderId))
    .leftJoin(trips, eq(trips.id, complaints.tripId))
    .leftJoin(trucks, eq(trucks.id, trips.truckId))
    .where(and(eq(complaints.id, id), eq(complaints.tenantId, ctx.tenantId)))
    .limit(1);
  if (!row) throw new NotFoundError("Keluhan tidak ditemukan.");
  const c = row.c;
  const acts = await tx
    .select({ a: complaintActions, actorName: employees.fullName })
    .from(complaintActions)
    .leftJoin(users, eq(users.id, complaintActions.actorUserId))
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .where(eq(complaintActions.complaintId, c.id))
    .orderBy(asc(complaintActions.createdAt));
  const invoiceRows = c.invoiceId ? await tx.select().from(invoices).where(eq(invoices.id, c.invoiceId)).limit(1) : [];
  const tripIds = c.tripId ? [c.tripId] : c.orderId ? (await tx.select({ id: trips.id }).from(trips).where(eq(trips.orderId, c.orderId))).map((t) => t.id) : [];
  const candidates = tripIds.length ? await tx.select().from(invoices).where(and(inArray(invoices.tripId, tripIds), sql`${invoices.outstandingAmount} > 0`)) : [];
  const inv = invoiceRows[0] ?? null;
  const all = [...(inv && inv.outstandingAmount > 0 ? [inv] : []), ...candidates.filter((x) => x.id !== inv?.id)];
  return {
    id: c.id,
    kind: c.kind,
    status: c.status,
    box: c.assignedRole as ComplaintBox,
    customerId: c.customerId,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    description: c.description,
    orderNumber: row.orderNumber,
    tripNumber: row.tripNumber,
    truck: row.plate,
    createdAt: c.createdAt,
    dueAt: c.dueAt,
    firstResponseAt: c.firstResponseAt,
    resolvedAt: c.resolvedAt,
    overdue: !c.firstResponseAt && !!c.dueAt && c.dueAt < ctx.now,
    row: c,
    invoice: inv ? { id: inv.id, number: inv.number, outstanding: inv.outstandingAmount, disputed: inv.disputeStatus === "disputed" } : null,
    disputeCandidates: all.map((i) => ({ id: i.id, number: i.number, outstanding: i.outstandingAmount, disputed: i.disputeStatus === "disputed" })),
    actions: acts.map(({ a, actorName }) => ({ id: a.id, at: a.createdAt, action: a.action, actionLabel: label("complaint_action", a.action), note: a.note, actorName, visibleToCustomer: a.visibleToCustomer })),
    photoUrl: c.photoAttachmentId ? `/api/attachments/${c.photoAttachmentId}` : null,
    canRespond: c.status !== "done" && canHandleBox(ctx, c.assignedRole as ComplaintBox),
  };
}

function canHandleBox(ctx: ActorContext, box: ComplaintBox): boolean {
  return hasRole(ctx, box);
}

async function loadForUpdate(tx: Tx, ctx: ActorContext, id: string): Promise<ComplaintRow> {
  const [row] = await tx.select().from(complaints).where(and(eq(complaints.id, id), eq(complaints.tenantId, ctx.tenantId))).limit(1).for("update");
  if (!row) throw new NotFoundError("Keluhan tidak ditemukan.");
  return row;
}

function assertBox(ctx: ActorContext, c: ComplaintRow): void {
  if (!canHandleBox(ctx, c.assignedRole as ComplaintBox)) {
    throw new ForbiddenError(`Keluhan ini ada di kotak ${label("complaint_box", c.assignedRole)}. Minta petugas kotak itu menanggapi, atau pindahkan kotaknya.`, {
      permission: "p2.complaint.respond",
      rule: "US-P2-06 KP-2",
      objectType: "complaint",
      objectId: c.id,
    });
  }
}

async function customerUpdate(tx: Tx, c: ComplaintRow, now: Date, title: string, body: string, key: string): Promise<void> {
  await notifyCustomer(tx, {
    tenantId: c.tenantId,
    customerId: c.customerId,
    kind: "complaint_update",
    title,
    body,
    link: `/app/keluhan/${c.id}`,
    objectType: "complaint",
    objectId: c.id,
    dedupeKey: key,
    now,
    wa: { kind: "customer_notice", text: `EQUA: ${title}. ${body}`, variables: { pesan: `${title}. ${body}` } },
    waEvenWithoutApp: true,
  });
}

const noteSchema = (what: string, min = 5) => z.string({ error: `${what} wajib diisi.` }).trim().min(min, { error: `${what} wajib diisi (minimal ${min} karakter).` }).max(2000);

/** Tanggapan (pertama atau lanjutan) ke pelanggan (KP-2): tanggapan pertama menghentikan hitungan tenggat PAR-75. */
export async function respondComplaint(ctx: ActorContext, id: string, input: { response: string }, opts: { tx?: Tx } = {}): Promise<ComplaintRow> {
  await authorize(ctx, "p2.complaint.respond", { tx: opts.tx, objectType: "complaint", objectId: id });
  const response = parseInput(noteSchema("Tanggapan"), input.response, {});
  return runService(ctx, opts, async (tx) => {
    const c = await loadForUpdate(tx, ctx, id);
    assertBox(ctx, c);
    if (c.status === "done") throw new ConflictError("COMPLAINT_DONE", "Keluhan sudah selesai. Pelanggan dapat mengajukan keluhan baru bila perlu.");
    const first = !c.firstResponseAt;
    const [after] = await tx
      .update(complaints)
      .set({ status: "responded", response, ...(first ? { firstResponseAt: ctx.now, firstResponseBy: ctx.userId } : {}), updatedAt: ctx.now })
      .where(eq(complaints.id, c.id))
      .returning();
    await tx.insert(complaintActions).values({ complaintId: c.id, action: "respond", note: response, visibleToCustomer: true, actorUserId: ctx.userId, createdAt: ctx.now });
    await auditRecord(tx, { ctx, objectType: "complaint", objectId: c.id, action: "respond", before: { status: c.status }, after: { status: "responded", firstResponse: first, late: first && !!c.dueAt && c.dueAt < ctx.now }, reason: response, rule: "US-P2-06 KP-2, PAR-75" });
    await customerUpdate(tx, after!, ctx.now, "Keluhan Anda sudah ditanggapi", response, `complaint_respond:${c.id}:${ctx.now.getTime()}`);
    return after!;
  });
}

/** Tutup keluhan dengan penyelesaian tercatat (KP-3). */
export async function resolveComplaint(ctx: ActorContext, id: string, input: { resolution: string }, opts: { tx?: Tx } = {}): Promise<ComplaintRow> {
  await authorize(ctx, "p2.complaint.respond", { tx: opts.tx, objectType: "complaint", objectId: id });
  const resolution = parseInput(noteSchema("Penyelesaian"), input.resolution, {});
  return runService(ctx, opts, async (tx) => {
    const c = await loadForUpdate(tx, ctx, id);
    assertBox(ctx, c);
    if (c.status === "done") throw new ConflictError("COMPLAINT_DONE", "Keluhan sudah selesai.");
    const [after] = await tx
      .update(complaints)
      .set({ status: "done", resolution, resolvedAt: ctx.now, resolvedBy: ctx.userId, ...(c.firstResponseAt ? {} : { firstResponseAt: ctx.now, firstResponseBy: ctx.userId, response: resolution }), updatedAt: ctx.now })
      .where(eq(complaints.id, c.id))
      .returning();
    await tx.insert(complaintActions).values({ complaintId: c.id, action: "resolve", note: resolution, visibleToCustomer: true, actorUserId: ctx.userId, createdAt: ctx.now });
    await auditRecord(tx, { ctx, objectType: "complaint", objectId: c.id, action: "resolve", before: { status: c.status }, after: { status: "done" }, reason: resolution, rule: "US-P2-06 KP-3" });
    await customerUpdate(tx, after!, ctx.now, "Keluhan Anda selesai", resolution, `complaint_resolve:${c.id}`);
    return after!;
  });
}

/** Pindah kotak (mis. keluhan "lainnya" ternyata soal tagihan). */
export async function reassignComplaint(ctx: ActorContext, id: string, input: { box: ComplaintBox; note: string }, opts: { tx?: Tx } = {}): Promise<ComplaintRow> {
  await authorize(ctx, "p2.complaint.respond", { tx: opts.tx, objectType: "complaint", objectId: id });
  const data = parseInput(z.object({ box: z.enum(["dispatcher", "finance_admin"], { error: "Pilih kotak tujuan." }), note: noteSchema("Alasan pindah kotak", 3) }), input, { box: "Kotak", note: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const c = await loadForUpdate(tx, ctx, id);
    if (c.status === "done") throw new ConflictError("COMPLAINT_DONE", "Keluhan sudah selesai.");
    if (c.assignedRole === data.box) throw new DomainError("SAME_BOX", `Keluhan sudah ada di kotak ${label("complaint_box", data.box)}.`);
    const [after] = await tx.update(complaints).set({ assignedRole: data.box, updatedAt: ctx.now }).where(eq(complaints.id, c.id)).returning();
    await tx.insert(complaintActions).values({ complaintId: c.id, action: "reassign", note: `${label("complaint_box", c.assignedRole)} → ${label("complaint_box", data.box)}: ${data.note}`, visibleToCustomer: false, actorUserId: ctx.userId, createdAt: ctx.now });
    await auditRecord(tx, { ctx, objectType: "complaint", objectId: c.id, action: "reassign", before: { box: c.assignedRole }, after: { box: data.box }, reason: data.note, rule: "US-P2-06 KP-2" });
    await notify(tx, {
      event: "customer_app.complaint_submitted",
      tenantId: ctx.tenantId,
      recipients: { roles: [data.box] },
      title: `Keluhan dipindahkan ke kotak ${label("complaint_box", data.box)}`,
      body: data.note,
      objectType: "complaint",
      objectId: c.id,
      deadlineAt: c.firstResponseAt ? null : c.dueAt,
      link: `/keluhan/${c.id}`,
      now: ctx.now,
    });
    return after!;
  });
}

/**
 * Keluhan volume/tagihan memicu sengketa faktur (7.5.6) — lewat layanan M5 dengan izin pelaku (`m5.invoice.dispute`,
 * Admin Keuangan). Tindak lanjut dicatat di keluhan.
 */
export async function disputeInvoiceFromComplaint(ctx: ActorContext, id: string, input: { invoiceId: string; note: string }, opts: { tx?: Tx } = {}): Promise<ComplaintRow> {
  await authorize(ctx, "p2.complaint.respond", { tx: opts.tx, objectType: "complaint", objectId: id });
  const data = parseInput(z.object({ invoiceId: z.uuid({ error: "Pilih faktur." }), note: noteSchema("Catatan sengketa") }), input, { invoiceId: "Faktur", note: "Catatan" });
  return runService(ctx, opts, async (tx) => {
    const c = await loadForUpdate(tx, ctx, id);
    if (c.kind !== "volume" && c.kind !== "billing") throw new DomainError("DISPUTE_NOT_APPLICABLE", "Sengketa faktur hanya untuk keluhan volume atau tagihan.");
    const [inv] = await tx.select().from(invoices).where(and(eq(invoices.id, data.invoiceId), eq(invoices.customerId, c.customerId))).limit(1);
    if (!inv) throw ValidationError.field("invoiceId", "Faktur bukan milik pelanggan ini.");
    await m5.disputeInvoice(ctx, { invoiceId: inv.id, note: `Keluhan pelanggan (${label("complaint_kind", c.kind)}): ${data.note}` }, { tx });
    const [after] = await tx.update(complaints).set({ invoiceId: inv.id, updatedAt: ctx.now }).where(eq(complaints.id, c.id)).returning();
    await tx.insert(complaintActions).values({ complaintId: c.id, action: "invoice_dispute", note: `Faktur ${inv.number} ditandai bersengketa: ${data.note}`, visibleToCustomer: true, actorUserId: ctx.userId, createdAt: ctx.now });
    await auditRecord(tx, { ctx, objectType: "complaint", objectId: c.id, action: "invoice_dispute", after: { invoiceId: inv.id, invoiceNumber: inv.number }, reason: data.note, rule: "US-P2-06 KP-2, 7.5.6" });
    return after!;
  });
}

/** Keluhan belum ditanggapi melewati tenggat PAR-75 → notifikasi sekali (job). */
export async function notifyOverdueComplaints(tx: Tx, now: Date): Promise<number> {
  const rows = await tx
    .select({ c: complaints, customerName: customers.name })
    .from(complaints)
    .innerJoin(customers, eq(customers.id, complaints.customerId))
    .where(and(eq(complaints.status, "submitted"), isNull(complaints.firstResponseAt), lt(complaints.dueAt, now)));
  let n = 0;
  for (const { c, customerName } of rows) {
    const [already] = await tx.select({ id: complaintActions.id }).from(complaintActions).where(and(eq(complaintActions.complaintId, c.id), eq(complaintActions.action, "overdue_notified"))).limit(1);
    if (already) continue;
    await tx.insert(complaintActions).values({ complaintId: c.id, action: "overdue_notified", note: `Tenggat tanggapan ${formatTanggalJam(c.dueAt!)} terlewati.`, visibleToCustomer: false, createdAt: now });
    await notify(tx, {
      event: "customer_app.complaint_overdue",
      tenantId: c.tenantId,
      recipients: { roles: [c.assignedRole as ComplaintBox, "owner"] },
      title: `Keluhan ${customerName} belum ditanggapi`,
      body: `${label("complaint_kind", c.kind)} — diajukan ${formatTanggalJam(c.createdAt)}, tenggat ${formatTanggalJam(c.dueAt!)} (PAR-75).`,
      objectType: "complaint",
      objectId: c.id,
      link: `/keluhan/${c.id}`,
      now,
    });
    n++;
  }
  return n;
}

// =====================================================================================================================
// Laporan bulanan keluhan (KP-3)
// =====================================================================================================================

export type ComplaintMonthlyReport = {
  month: string;
  total: number;
  open: number;
  overdueFirstResponse: number;
  avgFirstResponseHours: number | null;
  byKind: { kind: EnumValue<"complaint_kind">; label: string; count: number; open: number }[];
  byTruck: { truckId: string | null; truck: string; count: number; kinds: Record<string, number> }[];
  rows: (OfficeComplaintRow & { firstResponseHours: number | null })[];
};

/** Laporan bulanan keluhan per jenis & per truk (dipakai layar kantor, ekspor, dan kinerja M9). */
export async function complaintMonthlyReport(tx: Tx | Db, input: { tenantId: string; month: string; now: Date }): Promise<ComplaintMonthlyReport> {
  const from = `${input.month}-01`;
  const to = lastDayOfMonth(from);
  const rows = await tx
    .select({ c: complaints, customerName: customers.name, orderNumber: orders.number, tripNumber: trips.number, plate: trucks.plateNumber, truckId: trips.truckId })
    .from(complaints)
    .innerJoin(customers, eq(customers.id, complaints.customerId))
    .leftJoin(orders, eq(orders.id, complaints.orderId))
    .leftJoin(trips, eq(trips.id, complaints.tripId))
    .leftJoin(trucks, eq(trucks.id, trips.truckId))
    .where(and(eq(complaints.tenantId, input.tenantId), gte(complaints.createdAt, wibToUtc(from, "00:00")), lt(complaints.createdAt, wibToUtc(addDays(to, 1), "00:00"))))
    .orderBy(asc(complaints.createdAt));
  // Keluhan tanpa rit tetapi berpesanan → truk rit pertama pesanan itu.
  const orderIds = rows.filter((r) => !r.c.tripId && r.c.orderId).map((r) => r.c.orderId!);
  const orderTrucks = orderIds.length
    ? await tx
        .select({ orderId: trips.orderId, truckId: trips.truckId, plate: trucks.plateNumber, seq: trips.sequenceInOrder })
        .from(trips)
        .leftJoin(trucks, eq(trucks.id, trips.truckId))
        .where(inArray(trips.orderId, orderIds))
        .orderBy(asc(trips.sequenceInOrder))
    : [];
  const detailed = rows.map(({ c, customerName, orderNumber, tripNumber, plate, truckId }) => {
    const fallback = !c.tripId && c.orderId ? orderTrucks.find((t) => t.orderId === c.orderId && t.truckId) : undefined;
    const tId = truckId ?? fallback?.truckId ?? null;
    const truck = plate ?? fallback?.plate ?? null;
    const hours = c.firstResponseAt ? Math.round(((c.firstResponseAt.getTime() - c.createdAt.getTime()) / 3_600_000) * 10) / 10 : null;
    return {
      id: c.id,
      kind: c.kind,
      status: c.status,
      box: c.assignedRole as ComplaintBox,
      customerId: c.customerId,
      customerName,
      description: c.description,
      orderNumber,
      tripNumber,
      truck,
      truckId: tId,
      createdAt: c.createdAt,
      dueAt: c.dueAt,
      firstResponseAt: c.firstResponseAt,
      resolvedAt: c.resolvedAt,
      overdue: !!c.dueAt && (c.firstResponseAt ? c.firstResponseAt > c.dueAt : c.dueAt < input.now),
      firstResponseHours: hours,
    };
  });
  const kinds = enumValues("complaint_kind");
  const byTruckMap = new Map<string, { truckId: string | null; truck: string; count: number; kinds: Record<string, number> }>();
  for (const r of detailed) {
    const key = r.truckId ?? "none";
    const g = byTruckMap.get(key) ?? { truckId: r.truckId, truck: r.truck ?? "Tanpa truk (belum dikirim / tagihan)", count: 0, kinds: {} };
    g.count++;
    g.kinds[r.kind] = (g.kinds[r.kind] ?? 0) + 1;
    byTruckMap.set(key, g);
  }
  const responded = detailed.filter((r) => r.firstResponseHours !== null);
  return {
    month: input.month,
    total: detailed.length,
    open: detailed.filter((r) => r.status !== "done").length,
    overdueFirstResponse: detailed.filter((r) => r.overdue).length,
    avgFirstResponseHours: responded.length ? Math.round((responded.reduce((s, r) => s + r.firstResponseHours!, 0) / responded.length) * 10) / 10 : null,
    byKind: kinds.map((k) => ({ kind: k, label: label("complaint_kind", k), count: detailed.filter((r) => r.kind === k).length, open: detailed.filter((r) => r.kind === k && r.status !== "done").length })),
    byTruck: [...byTruckMap.values()].sort((a, b) => b.count - a.count),
    rows: detailed.map(({ truckId: _t, ...rest }) => rest),
  };
}

export async function complaintReport(ctx: ActorContext, filter: { month?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<ComplaintMonthlyReport> {
  await authorize(ctx, "p2.adoption.read", { tx: opts.tx });
  const month = filter.month && /^\d{4}-\d{2}$/.test(filter.month) ? filter.month : monthOf(toBusinessDate(ctx.now));
  return complaintMonthlyReport(opts.tx ?? getDb(), { tenantId: ctx.tenantId, month, now: ctx.now });
}
