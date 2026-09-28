/**
 * M2 — pesanan berulang / langganan (US-M2-06 S; BR-21; PAR-34).
 *
 * Pola: pelanggan, alamat, hari dalam minggu atau interval hari, jumlah tangki, jam diminta, cara bayar, tanggal
 * mulai/berakhir; status Aktif/Jeda/Berakhir. Job harian membuat pesanan Baru bertanda "langganan" untuk tanggal kirim
 * sampai H-PAR-34 (idempoten: unik langganan+tanggal). Kontrol kredit US-M2-05 berlaku; yang gagal (Ditahan, melampaui
 * batas, kurang bayar kedua, pelanggan nonaktif) masuk daftar "gagal dibuat". Pola yang diubah tidak mengubah pesanan
 * yang sudah dibuat.
 */
import "server-only";

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { customerAddresses, customers, orders, recurringOrderFailures, recurringOrders } from "@/db/schema";
import { label, type EnumValue } from "@/lib/labels";
import { addDays, daysBetween, formatTanggal, toBusinessDate, weekdayOf, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Db, type Tx } from "@/server/core/db";
import { ConflictError, DomainError, NotFoundError, parseInput, toUserMessage, ValidationError } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import { authorize, runService, sod } from "@/server/core/rbac";

import { recurringSchema, type RecurringInput } from "../schemas";
import { loadCustomerAddress, orderRules, userNames } from "./common";
import { evaluateCreditOrder, underpaymentStatus } from "./credit";
import { findDuplicateOrders, reconfirmationNeededFor } from "./lifecycle";
import { insertOrder, resolveOrderPrice } from "./orders";

type RecurringRow = typeof recurringOrders.$inferSelect;

/** Hari ISO (1 = Senin … 7 = Minggu) dari tanggal bisnis. */
export function isoWeekday(date: BusinessDate): number {
  const d = weekdayOf(date);
  return d === 0 ? 7 : d;
}

/** Pola menghasilkan pesanan pada tanggal ini (dalam rentang mulai/berakhir). */
export function occursOn(r: Pick<RecurringRow, "pattern" | "daysOfWeek" | "intervalDays" | "startDate" | "endDate">, date: BusinessDate): boolean {
  if (date < r.startDate) return false;
  if (r.endDate && date > r.endDate) return false;
  if (r.pattern === "weekly") return (r.daysOfWeek ?? []).includes(isoWeekday(date));
  if (r.pattern === "interval" && r.intervalDays && r.intervalDays > 0) return daysBetween(r.startDate, date) % r.intervalDays === 0;
  return false;
}

/** N tanggal kirim berikutnya mulai `from` (untuk tampilan). */
export function nextOccurrences(r: Pick<RecurringRow, "pattern" | "daysOfWeek" | "intervalDays" | "startDate" | "endDate">, from: BusinessDate, count = 3, maxDays = 120): BusinessDate[] {
  const out: BusinessDate[] = [];
  for (let i = 0; i < maxDays && out.length < count; i++) {
    const d = addDays(from, i);
    if (occursOn(r, d)) out.push(d);
  }
  return out;
}

async function loadRecurring(tx: Tx, ctx: ActorContext, id: string, forUpdate = false): Promise<RecurringRow> {
  const q = tx.select().from(recurringOrders).where(eq(recurringOrders.id, id)).limit(1);
  const rows = forUpdate ? await q.for("update") : await q;
  if (!rows[0] || rows[0].tenantId !== ctx.tenantId) throw new NotFoundError("Pesanan berulang tidak ditemukan.");
  return rows[0];
}

const LABELS = { customerId: "Pelanggan", addressId: "Alamat kirim", pattern: "Pola", daysOfWeek: "Hari", intervalDays: "Interval", tankCount: "Jumlah tangki", startDate: "Tanggal mulai", endDate: "Tanggal berakhir", paymentMethod: "Cara bayar" };

/** Buat pola langganan (US-M2-06 KP-1). */
export async function createRecurringOrder(ctx: ActorContext, input: RecurringInput, opts: { tx?: Tx } = {}): Promise<RecurringRow> {
  await authorize(ctx, "m2.recurring_order.create", { tx: opts.tx });
  const data = parseInput(recurringSchema, input, LABELS);
  return runService(ctx, opts, async (tx) => {
    sod.assertNotFinanceAdminOnOrders(ctx);
    const { customer, address } = await loadCustomerAddress(tx, ctx, data.customerId, data.addressId);
    if (!customer.isActive || !address.isActive) throw new DomainError("CUSTOMER_INACTIVE", "Pelanggan atau alamat kirim nonaktif.");
    if (data.paymentMethod === "credit" && customer.creditStatus === "cash") throw ValidationError.field("paymentMethod", "Tempo tidak tersedia: status kredit pelanggan Tunai.");
    if (data.startDate < ctxBusinessDate(ctx)) throw ValidationError.field("startDate", "Tanggal mulai tidak boleh sebelum hari ini.");
    const [row] = await tx
      .insert(recurringOrders)
      .values({
        tenantId: customer.tenantId,
        customerId: customer.id,
        addressId: address.id,
        pattern: data.pattern,
        daysOfWeek: data.pattern === "weekly" ? [...new Set(data.daysOfWeek ?? [])].sort() : null,
        intervalDays: data.pattern === "interval" ? data.intervalDays! : null,
        tankCount: data.tankCount,
        requestedTime: data.requestedTime ?? null,
        paymentMethod: customer.internalOutletId ? "internal" : data.paymentMethod,
        startDate: data.startDate,
        endDate: data.endDate ?? null,
        status: "active",
        createdVia: "office",
        notes: data.notes,
        createdBy: ctx.userId,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .returning();
    await auditRecord(tx, { ctx, objectType: "recurring_order", objectId: row!.id, action: "create", after: row, rule: "US-M2-06 KP-1" });
    return row!;
  });
}

/** Ubah pola (US-M2-06 KP-3: pesanan yang sudah dibuat dari pola tidak berubah). */
export async function updateRecurringOrder(ctx: ActorContext, id: string, input: RecurringInput, opts: { tx?: Tx } = {}): Promise<RecurringRow> {
  await authorize(ctx, "m2.recurring_order.update", { tx: opts.tx, objectType: "recurring_order", objectId: id });
  const data = parseInput(recurringSchema, input, LABELS);
  return runService(ctx, opts, async (tx) => {
    sod.assertNotFinanceAdminOnOrders(ctx);
    const before = await loadRecurring(tx, ctx, id, true);
    if (before.status === "ended") throw new ConflictError("RECURRING_ENDED", "Pesanan berulang sudah Berakhir; buat pola baru.");
    if (data.customerId !== before.customerId) throw ValidationError.field("customerId", "Pelanggan pola tidak dapat diganti; buat pola baru.");
    const { customer, address } = await loadCustomerAddress(tx, ctx, data.customerId, data.addressId);
    if (data.paymentMethod === "credit" && customer.creditStatus === "cash") throw ValidationError.field("paymentMethod", "Tempo tidak tersedia: status kredit pelanggan Tunai.");
    const [row] = await tx
      .update(recurringOrders)
      .set({
        addressId: address.id,
        pattern: data.pattern,
        daysOfWeek: data.pattern === "weekly" ? [...new Set(data.daysOfWeek ?? [])].sort() : null,
        intervalDays: data.pattern === "interval" ? data.intervalDays! : null,
        tankCount: data.tankCount,
        requestedTime: data.requestedTime ?? null,
        paymentMethod: customer.internalOutletId ? "internal" : data.paymentMethod,
        startDate: data.startDate,
        endDate: data.endDate ?? null,
        notes: data.notes,
        updatedAt: ctx.now,
      })
      .where(eq(recurringOrders.id, id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "recurring_order", objectId: id, action: "update", before, after: row, rule: "US-M2-06 KP-3" });
    return row!;
  });
}

/** Aktif / Jeda / Berakhir (US-M2-06 KP-1/KP-3: pola dijeda tidak menghasilkan pesanan). */
export async function setRecurringStatus(ctx: ActorContext, id: string, input: { status: EnumValue<"recurring_status">; reason: string }, opts: { tx?: Tx } = {}): Promise<RecurringRow> {
  await authorize(ctx, "m2.recurring_order.update", { tx: opts.tx, objectType: "recurring_order", objectId: id });
  const reason = (input.reason ?? "").trim();
  if (reason.length < 3) throw ValidationError.field("reason", "Alasan perubahan status wajib diisi (minimal 3 karakter).");
  return runService(ctx, opts, async (tx) => {
    sod.assertNotFinanceAdminOnOrders(ctx);
    const before = await loadRecurring(tx, ctx, id, true);
    if (before.status === "ended") throw new ConflictError("RECURRING_ENDED", "Pesanan berulang sudah Berakhir dan tidak dapat diaktifkan kembali; buat pola baru.");
    if (before.status === input.status) throw new DomainError("SAME_STATUS", `Status sudah ${label("recurring_status", input.status)}.`);
    const [row] = await tx.update(recurringOrders).set({ status: input.status, updatedAt: ctx.now }).where(eq(recurringOrders.id, id)).returning();
    await auditRecord(tx, { ctx, objectType: "recurring_order", objectId: id, action: "status", before: { status: before.status }, after: { status: input.status }, reason, rule: "US-M2-06" });
    return row!;
  });
}

export type RecurringListRow = RecurringRow & {
  customerName: string;
  customerCode: string | null;
  customerCreditStatus: EnumValue<"credit_status">;
  addressLabel: string;
  addressText: string;
  /** Alamat aktif pelanggan (untuk mengubah pola). */
  customerAddresses: { id: string; label: string; addressText: string }[];
  nextDates: BusinessDate[];
  generatedCount: number;
  createdByName: string | null;
};

/** Daftar pola langganan + tanggal kirim berikutnya. */
export async function listRecurringOrders(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<RecurringListRow[]> {
  await authorize(ctx, "m2.recurring_order.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx
    .select({ r: recurringOrders, customerName: customers.name, customerCode: customers.code, customerCreditStatus: customers.creditStatus, addressLabel: customerAddresses.label, addressText: customerAddresses.addressText })
    .from(recurringOrders)
    .innerJoin(customers, eq(customers.id, recurringOrders.customerId))
    .innerJoin(customerAddresses, eq(customerAddresses.id, recurringOrders.addressId))
    .where(eq(recurringOrders.tenantId, ctx.tenantId))
    .orderBy(asc(recurringOrders.status), asc(customers.name));
  const counts = rows.length
    ? await tx
        .select({ id: orders.recurringOrderId, n: sql<number>`count(*)::int` })
        .from(orders)
        .where(inArray(orders.recurringOrderId, rows.map((r) => r.r.id)))
        .groupBy(orders.recurringOrderId)
    : [];
  const names = await userNames(tx, rows.map((r) => r.r.createdBy));
  const addrs = rows.length
    ? await tx
        .select({ id: customerAddresses.id, customerId: customerAddresses.customerId, label: customerAddresses.label, addressText: customerAddresses.addressText })
        .from(customerAddresses)
        .where(and(inArray(customerAddresses.customerId, [...new Set(rows.map((r) => r.r.customerId))]), eq(customerAddresses.isActive, true)))
    : [];
  const today = ctxBusinessDate(ctx);
  return rows.map(({ r, customerName, customerCode, customerCreditStatus, addressLabel, addressText }) => ({
    ...r,
    customerName,
    customerCode,
    customerCreditStatus,
    addressLabel,
    addressText,
    customerAddresses: addrs.filter((a) => a.customerId === r.customerId).map((a) => ({ id: a.id, label: a.label, addressText: a.addressText })),
    nextDates: r.status === "active" ? nextOccurrences(r, today) : [],
    generatedCount: Number(counts.find((c) => c.id === r.id)?.n ?? 0),
    createdByName: r.createdBy ? (names.get(r.createdBy) ?? null) : null,
  }));
}

export type RecurringFailureRow = typeof recurringOrderFailures.$inferSelect & { customerName: string; resolvedByName: string | null };

/** Daftar pesanan langganan yang gagal dibuat (US-M2-06 KP-4). */
export async function listRecurringFailures(ctx: ActorContext, opts: { includeResolved?: boolean; tx?: Tx } = {}): Promise<RecurringFailureRow[]> {
  await authorize(ctx, "m2.recurring_order.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx
    .select({ f: recurringOrderFailures, customerName: customers.name })
    .from(recurringOrderFailures)
    .innerJoin(recurringOrders, eq(recurringOrders.id, recurringOrderFailures.recurringOrderId))
    .innerJoin(customers, eq(customers.id, recurringOrders.customerId))
    .where(and(eq(recurringOrders.tenantId, ctx.tenantId), opts.includeResolved ? sql`true` : isNull(recurringOrderFailures.resolvedAt)))
    .orderBy(desc(recurringOrderFailures.targetDate));
  const names = await userNames(tx, rows.map((r) => r.f.resolvedBy));
  return rows.map(({ f, customerName }) => ({ ...f, customerName, resolvedByName: f.resolvedBy ? (names.get(f.resolvedBy) ?? null) : null }));
}

/** Tandai kegagalan sudah ditindaklanjuti (mis. pesanan dibuat manual dengan persetujuan). */
export async function resolveRecurringFailure(ctx: ActorContext, failureId: string, input: { note: string }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m2.recurring_order.update", { tx: opts.tx, objectType: "recurring_order_failure", objectId: failureId });
  const note = (input.note ?? "").trim();
  if (note.length < 3) throw ValidationError.field("note", "Tindak lanjut wajib diisi (minimal 3 karakter).");
  return runService(ctx, opts, async (tx) => {
    const rows = await tx
      .select({ f: recurringOrderFailures, tenantId: recurringOrders.tenantId })
      .from(recurringOrderFailures)
      .innerJoin(recurringOrders, eq(recurringOrders.id, recurringOrderFailures.recurringOrderId))
      .where(eq(recurringOrderFailures.id, failureId))
      .limit(1);
    if (!rows[0] || rows[0].tenantId !== ctx.tenantId) throw new NotFoundError("Catatan kegagalan tidak ditemukan.");
    if (rows[0].f.resolvedAt) throw new ConflictError("ALREADY_RESOLVED", "Kegagalan ini sudah ditindaklanjuti.");
    const [after] = await tx
      .update(recurringOrderFailures)
      .set({ resolvedAt: ctx.now, resolvedBy: ctx.userId, message: `${rows[0].f.message ?? ""}${rows[0].f.message ? " — " : ""}Tindak lanjut: ${note}`, updatedAt: ctx.now })
      .where(eq(recurringOrderFailures.id, failureId))
      .returning();
    await auditRecord(tx, { ctx, objectType: "recurring_order_failure", objectId: failureId, action: "resolve", reason: note, rule: "US-M2-06 KP-4" });
    return after!;
  });
}

// =====================================================================================================================
// Job H-2
// =====================================================================================================================

export type GenerateResult = { created: number; failed: number; skipped: number; ended: number; errors: string[] };

async function recordFailure(tx: Tx, ctx: ActorContext, r: RecurringRow, date: BusinessDate, reason: EnumValue<"recurring_failure_reason">, message: string, customerName: string): Promise<boolean> {
  const [row] = await tx
    .insert(recurringOrderFailures)
    .values({ recurringOrderId: r.id, targetDate: date, reason, message, createdAt: ctx.now, updatedAt: ctx.now })
    .onConflictDoNothing()
    .returning({ id: recurringOrderFailures.id });
  if (!row) return false;
  await auditRecord(tx, { ctx, objectType: "recurring_order_failure", objectId: row.id, action: "create", after: { recurringOrderId: r.id, targetDate: date, reason }, reason: message, rule: "US-M2-06 KP-4" });
  await notify(tx, {
    event: "order.recurring_failed",
    tenantId: r.tenantId,
    title: `Pesanan langganan gagal dibuat: ${customerName}`,
    body: `Tanggal kirim ${formatTanggal(date)} — ${label("recurring_failure_reason", reason)}. ${message}`,
    objectType: "recurring_order",
    objectId: r.id,
    link: "/langganan#gagal",
    groupKey: `order.recurring_failed:${r.id}:${date}`,
    now: ctx.now,
  });
  return true;
}

/** Bangkitkan satu tanggal (di dalam transaksi pemanggil). */
async function generateOne(tx: Tx, r: RecurringRow, date: BusinessDate, now: Date): Promise<"created" | "failed" | "skipped"> {
  const ctx = systemContext({ tenantId: r.tenantId, now });
  const existing = await tx.select({ id: orders.id }).from(orders).where(and(eq(orders.recurringOrderId, r.id), eq(orders.requestedDate, date))).limit(1);
  if (existing[0]) return "skipped";
  const prior = await tx
    .select({ id: recurringOrderFailures.id })
    .from(recurringOrderFailures)
    .where(and(eq(recurringOrderFailures.recurringOrderId, r.id), eq(recurringOrderFailures.targetDate, date)))
    .limit(1);
  if (prior[0]) return "skipped";
  const { customer, address } = await loadCustomerAddress(tx, null, r.customerId, r.addressId);
  if (!customer.isActive || customer.anonymizedAt || !address.isActive) {
    return (await recordFailure(tx, ctx, r, date, "inactive_customer", "Pelanggan atau alamat kirim nonaktif.", customer.name)) ? "failed" : "skipped";
  }
  let price;
  try {
    price = await resolveOrderPrice(tx, customer, address.id, date, r.tankCount);
  } catch (error) {
    return (await recordFailure(tx, ctx, r, date, "other", toUserMessage(error), customer.name)) ? "failed" : "skipped";
  }
  const isInternal = !!customer.internalOutletId;
  const paymentMethod = isInternal ? "internal" : r.paymentMethod;
  if (paymentMethod === "credit") {
    const check = await evaluateCreditOrder(tx, customer.id, price.totalAmount);
    if (!check.ok) {
      const reason = check.reason === "on_hold" ? "credit_on_hold" : check.reason === "over_limit" ? "credit_limit" : "other";
      return (await recordFailure(tx, ctx, r, date, reason, check.message, customer.name)) ? "failed" : "skipped";
    }
  }
  const up = isInternal ? null : await underpaymentStatus(tx, customer.id);
  if (up?.secondUnpaid) {
    return (await recordFailure(tx, ctx, r, date, "underpayment", `Pelanggan punya ${up.openCount} faktur kurang bayar belum lunas (PTB-18): buat pesanan manual dengan persetujuan pemilik bila perlu.`, customer.name))
      ? "failed"
      : "skipped";
  }
  const dups = await findDuplicateOrders(tx, { customerId: customer.id, addressId: address.id, requestedDate: date });
  const { order } = await insertOrder(tx, ctx, {
    customer,
    addressId: address.id,
    requestedDate: date,
    requestedTime: r.requestedTime?.slice(0, 5) ?? customer.fixedReceiveTime?.slice(0, 5) ?? null,
    tankCount: r.tankCount,
    paymentMethod,
    price,
    notes: r.notes,
    source: "recurring",
    recurringOrderId: r.id,
    possibleDuplicate: dups.length > 0,
    duplicateOfOrderId: dups[0]?.id ?? null,
    duplicateReason: dups.length ? `Dibuat otomatis dari langganan; sudah ada ${dups.map((d) => d.number).join(", ")}` : null,
    collectUnderpayment: up?.collect ?? false,
    reconfirmationRequired: !isInternal && (await reconfirmationNeededFor(tx, customer.id, date)),
  });
  if (dups.length) {
    await notify(tx, {
      event: "order.duplicate",
      tenantId: r.tenantId,
      title: `Kemungkinan pesanan dobel (langganan): ${order.number}`,
      body: `${customer.name}, ${formatTanggal(date)} — sama dengan ${dups.map((d) => d.number).join(", ")}. Konfirmasi atau batalkan.`,
      objectType: "order",
      objectId: order.id,
      link: `/pesanan/${order.id}`,
      now,
    });
  }
  return "created";
}

/**
 * Job harian (US-M2-06 KP-2): untuk setiap pola Aktif, bangkitkan pesanan untuk tanggal kirim hari ini s.d. H+PAR-34
 * yang belum dibangkitkan. Idempoten (unik langganan+tanggal, catatan gagal unik). Pola lewat tanggal berakhir →
 * Berakhir.
 */
export async function generateRecurringOrders(now: Date, opts: { db?: Db; tenantId?: string } = {}): Promise<GenerateResult> {
  const db = opts.db ?? getDb();
  const today = toBusinessDate(now);
  const result: GenerateResult = { created: 0, failed: 0, skipped: 0, ended: 0, errors: [] };
  const list = await db
    .select()
    .from(recurringOrders)
    .where(and(eq(recurringOrders.status, "active"), opts.tenantId ? eq(recurringOrders.tenantId, opts.tenantId) : sql`true`))
    .orderBy(asc(recurringOrders.createdAt));
  for (const r of list) {
    try {
      await withTx(
        async (tx) => {
          const ctx = systemContext({ tenantId: r.tenantId, now });
          if (r.endDate && r.endDate < today) {
            await tx.update(recurringOrders).set({ status: "ended", updatedAt: now }).where(eq(recurringOrders.id, r.id));
            await auditRecord(tx, { ctx, objectType: "recurring_order", objectId: r.id, action: "status", before: { status: "active" }, after: { status: "ended" }, reason: "Lewat tanggal berakhir", rule: "US-M2-06" });
            result.ended++;
            return;
          }
          const rules = await orderRules(tx, today);
          const horizon = addDays(today, rules.recurringDaysBefore);
          let from = r.startDate > today ? r.startDate : today;
          if (r.lastGeneratedDate && addDays(r.lastGeneratedDate, 1) > from) from = addDays(r.lastGeneratedDate, 1);
          for (let d = from; d <= horizon; d = addDays(d, 1)) {
            if (!occursOn(r, d)) continue;
            const outcome = await generateOne(tx, r, d, now);
            result[outcome]++;
          }
          if (horizon >= from && (!r.lastGeneratedDate || horizon > r.lastGeneratedDate)) {
            await tx.update(recurringOrders).set({ lastGeneratedDate: horizon, updatedAt: now }).where(eq(recurringOrders.id, r.id));
          }
        },
        { db },
      );
    } catch (error) {
      result.errors.push(`${r.id}: ${toUserMessage(error)}`);
    }
  }
  return result;
}

/** PAR-34: berapa hari sebelum tanggal kirim pesanan langganan dibuat (untuk layar). */
export async function recurringDaysBefore(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<number> {
  await authorize(ctx, "m2.recurring_order.read", { tx: opts.tx });
  return (await orderRules(opts.tx ?? getDb(), ctxBusinessDate(ctx))).recurringDaysBefore;
}

/** Jalankan pembangkitan sekarang dari layar (Dispatcher) — sama dengan job, hanya tenant pelaku. */
export async function runRecurringGenerationNow(ctx: ActorContext): Promise<GenerateResult> {
  await authorize(ctx, "m2.recurring_order.update");
  return generateRecurringOrders(ctx.now, { tenantId: ctx.tenantId });
}
