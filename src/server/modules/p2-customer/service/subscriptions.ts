/**
 * P2 — langganan mandiri & pengingat isi ulang (US-P2-05, S).
 *
 * - KP-1: pola langganan (hari/interval, jumlah tangki, slot PAR-73) = pesanan berulang M2 (US-M2-06) — dibuat/diubah/
 *   dijeda lewat `m2.createRecurringOrder`/`updateRecurringOrder`/`setRecurringStatus` atas nama Sistem SETELAH
 *   kepemilikan diperiksa; asal `customer_app`. Perubahan hanya berlaku untuk pesanan yang BELUM dibuat (M2); pesanan
 *   langganan tetap melalui kontrol kredit (job M2 `m2.recurring_generate`).
 * - KP-2: pengingat isi ulang dari rata-rata jarak antar pesanan selesai (FR-M2-08) — H-`refill_days_before` dari
 *   perkiraan tanggal pesan berikutnya; tombol pesan ulang satu ketukan (`reorder`); dapat dimatikan per akun.
 * - KP-3: pesanan langganan gagal dibuat (kredit ditahan, dsb.) → notifikasi pelanggan dengan tindakan yang disarankan.
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { customerAccounts, customerAddresses, orders, recurringOrderFailures, recurringOrders, refillReminderPrefs } from "@/db/schema";
import { enumValues, label, type EnumValue } from "@/lib/labels";
import { addDays, daysBetween, formatTanggal, isBusinessDate, toBusinessDate, type BusinessDate } from "@/lib/time";

import { getDb, runInTx, type Db, type Tx } from "@/server/core/db";
import { NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import * as m2 from "@/server/modules/m2-orders";

import { appRules, assertAppEnabled, customerBusinessDate, recordCustomerAudit, requireLinked, sysCtx, type CustomerContext } from "./common";
import { notifyCustomer } from "./messaging";
import { slotDefs, slotLabel } from "./slots";

type RecurringRow = typeof recurringOrders.$inferSelect;

export type SubscriptionView = {
  id: string;
  status: EnumValue<"recurring_status">;
  statusLabel: string;
  pattern: EnumValue<"recurring_pattern">;
  patternText: string;
  daysOfWeek: number[];
  intervalDays: number | null;
  tankCount: number;
  slot: string | null;
  slotText: string | null;
  paymentMethod: EnumValue<"payment_method">;
  paymentLabel: string;
  address: { id: string; label: string; addressText: string };
  startDate: string;
  endDate: string | null;
  nextDates: string[];
  fromApp: boolean;
  /** Kegagalan pembuatan pesanan yang belum ditindaklanjuti (KP-3). */
  failures: { id: string; targetDate: string; reason: string; message: string }[];
};

const DAY_NAMES = ["", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];

export function patternText(r: Pick<RecurringRow, "pattern" | "daysOfWeek" | "intervalDays">): string {
  if (r.pattern === "weekly") return `Setiap ${(r.daysOfWeek ?? []).map((d) => DAY_NAMES[d] ?? String(d)).join(", ")}`;
  return `Setiap ${r.intervalDays ?? "?"} hari`;
}

/** Langganan milik pelanggan (semua asal: kantor atau aplikasi). */
export async function listMySubscriptions(cctx: CustomerContext, opts: { tx?: Tx } = {}): Promise<SubscriptionView[]> {
  const customerId = requireLinked(cctx);
  const tx = opts.tx ?? getDb();
  const rows = await tx
    .select({ r: recurringOrders, label: customerAddresses.label, addressText: customerAddresses.addressText })
    .from(recurringOrders)
    .innerJoin(customerAddresses, eq(customerAddresses.id, recurringOrders.addressId))
    .where(eq(recurringOrders.customerId, customerId))
    .orderBy(asc(recurringOrders.status), desc(recurringOrders.createdAt));
  const failures = rows.length
    ? await tx
        .select()
        .from(recurringOrderFailures)
        .where(and(inArray(recurringOrderFailures.recurringOrderId, rows.map((r) => r.r.id)), isNull(recurringOrderFailures.resolvedAt)))
        .orderBy(desc(recurringOrderFailures.targetDate))
    : [];
  const today = customerBusinessDate(cctx);
  const out: SubscriptionView[] = [];
  for (const { r, label: addrLabel, addressText } of rows) {
    const slots = await slotDefs(tx, today);
    const slot = slots.find((s) => s.key === r.slot) ?? null;
    out.push({
      id: r.id,
      status: r.status,
      statusLabel: label("recurring_status", r.status),
      pattern: r.pattern,
      patternText: patternText(r),
      daysOfWeek: r.daysOfWeek ?? [],
      intervalDays: r.intervalDays,
      tankCount: r.tankCount,
      slot: r.slot,
      slotText: slot ? slotLabel(slot) : r.requestedTime ? `sekitar pukul ${r.requestedTime.slice(0, 5).replace(":", ".")}` : null,
      paymentMethod: r.paymentMethod,
      paymentLabel: label("customer_payment_choice", r.paymentMethod === "credit" ? "credit" : r.paymentMethod === "transfer" ? "transfer" : "cash"),
      address: { id: r.addressId, label: addrLabel, addressText },
      startDate: r.startDate,
      endDate: r.endDate,
      nextDates: r.status === "active" ? m2.nextOccurrences(r, today, 3) : [],
      fromApp: r.createdVia === "customer_app",
      failures: failures
        .filter((f) => f.recurringOrderId === r.id)
        .map((f) => ({ id: f.id, targetDate: f.targetDate, reason: f.reason, message: label("customer_recurring_failure", f.reason) })),
    });
  }
  return out;
}

const subscriptionSchema = z
  .object({
    addressId: z.uuid({ error: "Pilih alamat kirim." }),
    pattern: z.enum(enumValues("recurring_pattern"), { error: "Pilih pola langganan." }),
    daysOfWeek: z.array(z.coerce.number().int().min(1).max(7)).nullable().optional(),
    intervalDays: z.coerce.number().int().min(1, { error: "Interval minimal 1 hari." }).max(90, { error: "Interval maksimal 90 hari." }).nullable().optional(),
    tankCount: z.coerce.number({ error: "Isi jumlah tangki." }).int().min(1, { error: "Jumlah tangki minimal 1." }).max(20, { error: "Maksimal 20 tangki; hubungi kantor untuk langganan lebih besar." }),
    slot: z.string({ error: "Pilih slot pengiriman." }).min(1, { error: "Pilih slot pengiriman." }),
    paymentMethod: z.enum(["cash", "transfer", "credit"], { error: "Pilih cara bayar." }),
    startDate: z.string({ error: "Pilih tanggal mulai." }).refine(isBusinessDate, { error: "Pilih tanggal mulai." }),
    endDate: z.string().refine(isBusinessDate, { error: "Tanggal berakhir tidak valid." }).nullable().optional(),
  })
  .superRefine((v, c) => {
    if (v.pattern === "weekly" && !(v.daysOfWeek && v.daysOfWeek.length)) c.addIssue({ code: "custom", path: ["daysOfWeek"], message: "Pilih minimal satu hari." });
    if (v.pattern === "interval" && !v.intervalDays) c.addIssue({ code: "custom", path: ["intervalDays"], message: "Isi setiap berapa hari." });
  });
export type SubscriptionInput = z.input<typeof subscriptionSchema>;

const SUB_LABELS = { addressId: "Alamat", pattern: "Pola", daysOfWeek: "Hari", intervalDays: "Interval", tankCount: "Jumlah tangki", slot: "Slot", paymentMethod: "Cara bayar", startDate: "Tanggal mulai", endDate: "Tanggal berakhir" };

async function ownSubscription(tx: Tx, customerId: string, id: string): Promise<RecurringRow> {
  const [row] = await tx.select().from(recurringOrders).where(and(eq(recurringOrders.id, id), eq(recurringOrders.customerId, customerId))).limit(1);
  if (!row) throw new NotFoundError("Langganan tidak ditemukan.");
  return row;
}

async function ownAddress(tx: Tx, customerId: string, addressId: string) {
  const [a] = await tx.select().from(customerAddresses).where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, customerId), eq(customerAddresses.isActive, true))).limit(1);
  if (!a) throw ValidationError.field("addressId", "Alamat tidak ditemukan.");
  return a;
}

/**
 * Buat (tanpa `id`) atau ubah (dengan `id`) langganan (US-P2-05 KP-1). Tempo hanya untuk pelanggan Tempo (aturan M2);
 * perubahan berlaku untuk pesanan yang belum dibuat.
 */
export async function saveMySubscription(cctx: CustomerContext, input: SubscriptionInput & { id?: string | null }, opts: { tx?: Tx } = {}): Promise<RecurringRow> {
  const customerId = requireLinked(cctx);
  const data = parseInput(subscriptionSchema, input, SUB_LABELS);
  return runInTx(opts.tx, async (tx) => {
    await assertAppEnabled(tx, cctx.tenantId);
    await ownAddress(tx, customerId, data.addressId);
    const slots = await slotDefs(tx, data.startDate);
    const slot = slots.find((s) => s.key === data.slot);
    if (!slot) throw ValidationError.field("slot", "Slot tidak dikenal. Pilih pagi, siang, atau sore.");
    const m2Input = {
      customerId,
      addressId: data.addressId,
      pattern: data.pattern,
      daysOfWeek: data.pattern === "weekly" ? data.daysOfWeek : null,
      intervalDays: data.pattern === "interval" ? data.intervalDays : null,
      tankCount: data.tankCount,
      requestedTime: slot.start,
      paymentMethod: data.paymentMethod,
      startDate: data.startDate,
      endDate: data.endDate ?? null,
      notes: "Diatur pelanggan lewat aplikasi",
    };
    const ctx = sysCtx(cctx.tenantId, cctx.now);
    let row: RecurringRow;
    let before: RecurringRow | null = null;
    if (input.id) {
      before = await ownSubscription(tx, customerId, input.id);
      row = await m2.updateRecurringOrder(ctx, before.id, m2Input, { tx });
    } else {
      row = await m2.createRecurringOrder(ctx, m2Input, { tx });
    }
    const [after] = await tx
      .update(recurringOrders)
      .set({ slot: data.slot as EnumValue<"delivery_slot">, ...(before ? {} : { createdVia: "customer_app" as const }), updatedAt: cctx.now })
      .where(eq(recurringOrders.id, row.id))
      .returning();
    await recordCustomerAudit(tx, cctx, {
      objectType: "recurring_order",
      objectId: row.id,
      action: before ? "update" : "create",
      before: before ? { pattern: before.pattern, daysOfWeek: before.daysOfWeek, intervalDays: before.intervalDays, tankCount: before.tankCount, slot: before.slot, paymentMethod: before.paymentMethod } : undefined,
      after: { pattern: after!.pattern, daysOfWeek: after!.daysOfWeek, intervalDays: after!.intervalDays, tankCount: after!.tankCount, slot: after!.slot, paymentMethod: after!.paymentMethod, source: "customer_app" },
      rule: "US-P2-05 KP-1",
    });
    return after!;
  });
}

/** Jeda / aktifkan / akhiri langganan (US-P2-05 KP-1). */
export async function setMySubscriptionStatus(cctx: CustomerContext, id: string, input: { status: "active" | "paused" | "ended"; reason?: string | null }, opts: { tx?: Tx } = {}): Promise<RecurringRow> {
  const customerId = requireLinked(cctx);
  const data = parseInput(z.object({ status: z.enum(["active", "paused", "ended"], { error: "Pilih status." }), reason: z.string().trim().max(300).nullable().optional() }), input, { status: "Status", reason: "Alasan" });
  return runInTx(opts.tx, async (tx) => {
    await assertAppEnabled(tx, cctx.tenantId);
    const before = await ownSubscription(tx, customerId, id);
    const reason = data.reason && data.reason.length >= 3 ? `Pelanggan (aplikasi): ${data.reason}` : `Diubah pelanggan lewat aplikasi (${label("recurring_status", data.status)})`;
    const after = await m2.setRecurringStatus(sysCtx(cctx.tenantId, cctx.now), id, { status: data.status, reason }, { tx });
    await recordCustomerAudit(tx, cctx, { objectType: "recurring_order", objectId: id, action: "status", before: { status: before.status }, after: { status: after.status }, reason, rule: "US-P2-05 KP-1" });
    return after;
  });
}

// =====================================================================================================================
// Pengingat isi ulang (KP-2)
// =====================================================================================================================

export type RefillEstimate = {
  /** Cukup data (≥ `refill_min_orders` pesanan selesai). */
  available: boolean;
  orderCount: number;
  avgIntervalDays: number | null;
  lastOrderId: string | null;
  lastOrderDate: string | null;
  expectedDate: string | null;
  reminderDate: string | null;
  /** Pesanan aktif/langganan aktif → pengingat tidak perlu. */
  suppressedReason: string | null;
};

/** Perkiraan tanggal pesan berikutnya dari rata-rata jarak antar pesanan selesai (FR-M2-08). */
export async function refillEstimate(tx: Tx | Db, input: { customerId: string; tenantId: string; today: BusinessDate }): Promise<RefillEstimate> {
  const rules = await appRules(tx, input.today, input.tenantId);
  const done = await tx
    .select({ id: orders.id, date: orders.requestedDate })
    .from(orders)
    .where(and(eq(orders.customerId, input.customerId), eq(orders.status, "completed"), gte(orders.requestedDate, addDays(input.today, -365))))
    .orderBy(asc(orders.requestedDate));
  const dates = [...new Set(done.map((d) => d.date))];
  const base: RefillEstimate = { available: false, orderCount: dates.length, avgIntervalDays: null, lastOrderId: done.at(-1)?.id ?? null, lastOrderDate: dates.at(-1) ?? null, expectedDate: null, reminderDate: null, suppressedReason: null };
  if (dates.length < rules.refill_min_orders) return base;
  let total = 0;
  for (let i = 1; i < dates.length; i++) total += daysBetween(dates[i - 1]!, dates[i]!);
  const avg = Math.max(1, Math.round(total / (dates.length - 1)));
  const expected = addDays(dates.at(-1)!, avg);
  const [active] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.customerId, input.customerId), inArray(orders.status, ["new", "awaiting_approval", "scheduled", "in_delivery"])))
    .limit(1);
  const [sub] = await tx.select({ id: recurringOrders.id }).from(recurringOrders).where(and(eq(recurringOrders.customerId, input.customerId), eq(recurringOrders.status, "active"))).limit(1);
  return {
    ...base,
    available: true,
    avgIntervalDays: avg,
    expectedDate: expected,
    reminderDate: addDays(expected, -rules.refill_days_before),
    suppressedReason: active ? "Masih ada pesanan berjalan." : sub ? "Langganan aktif sudah mengatur pengiriman." : null,
  };
}

export type RefillPrefView = { enabled: boolean; estimate: RefillEstimate };

async function prefRow(tx: Tx | Db, accountId: string) {
  return (await tx.select().from(refillReminderPrefs).where(eq(refillReminderPrefs.customerAccountId, accountId)).limit(1))[0] ?? null;
}

/** Status pengingat isi ulang akun (bawaan aktif). */
export async function myRefillReminder(cctx: CustomerContext, opts: { tx?: Tx } = {}): Promise<RefillPrefView> {
  const customerId = requireLinked(cctx);
  const tx = opts.tx ?? getDb();
  const pref = await prefRow(tx, cctx.accountId);
  return { enabled: pref?.enabled ?? true, estimate: await refillEstimate(tx, { customerId, tenantId: cctx.tenantId, today: customerBusinessDate(cctx) }) };
}

/** Nyalakan/matikan pengingat isi ulang (KP-2). */
export async function setRefillReminder(cctx: CustomerContext, input: { enabled: boolean }, opts: { tx?: Tx } = {}): Promise<{ enabled: boolean }> {
  requireLinked(cctx);
  const enabled = input.enabled === true;
  return runInTx(opts.tx, async (tx) => {
    const pref = await prefRow(tx, cctx.accountId);
    if (pref) await tx.update(refillReminderPrefs).set({ enabled, updatedAt: cctx.now }).where(eq(refillReminderPrefs.id, pref.id));
    else await tx.insert(refillReminderPrefs).values({ customerAccountId: cctx.accountId, enabled, createdAt: cctx.now, updatedAt: cctx.now });
    await recordCustomerAudit(tx, cctx, { objectType: "customer_account", objectId: cctx.accountId, action: "refill_reminder", before: { enabled: pref?.enabled ?? true }, after: { enabled }, rule: "US-P2-05 KP-2" });
    return { enabled };
  });
}

/**
 * Job harian: kirim pengingat isi ulang H-N (in-app + push + WA bila Cloud API aktif) dengan tautan pesan ulang satu
 * ketukan. Idempoten per akun + perkiraan tanggal. Mengembalikan jumlah pengingat terkirim.
 */
export async function sendRefillReminders(tx: Tx, now: Date, opts: { tenantId?: string } = {}): Promise<number> {
  const today = toBusinessDate(now);
  const accounts = await tx
    .select({ id: customerAccounts.id, customerId: customerAccounts.customerId, tenantId: customerAccounts.tenantId })
    .from(customerAccounts)
    .where(and(eq(customerAccounts.status, "linked"), isNull(customerAccounts.deactivatedAt), opts.tenantId ? eq(customerAccounts.tenantId, opts.tenantId) : sql`true`));
  let sent = 0;
  for (const acc of accounts) {
    if (!acc.customerId) continue;
    const pref = await prefRow(tx, acc.id);
    if (pref && !pref.enabled) continue;
    const est = await refillEstimate(tx, { customerId: acc.customerId, tenantId: acc.tenantId, today });
    if (!est.available || est.suppressedReason || !est.reminderDate || !est.expectedDate || est.reminderDate > today || est.expectedDate < today) {
      if (pref && est.avgIntervalDays !== pref.avgIntervalDays) await tx.update(refillReminderPrefs).set({ avgIntervalDays: est.avgIntervalDays, nextReminderDate: est.reminderDate, updatedAt: now }).where(eq(refillReminderPrefs.id, pref.id));
      continue;
    }
    const res = await notifyCustomer(tx, {
      tenantId: acc.tenantId,
      customerId: acc.customerId,
      accountId: acc.id,
      kind: "refill_reminder",
      title: "Waktunya isi ulang air?",
      body: `Biasanya Anda memesan sekitar ${formatTanggal(est.expectedDate)} (rata-rata setiap ${est.avgIntervalDays} hari). Ketuk untuk pesan ulang seperti pesanan terakhir.`,
      link: `/app/pesan/ulang?dari=${est.lastOrderId}`,
      objectType: "order",
      objectId: est.lastOrderId,
      dedupeKey: `refill:${acc.customerId}:${est.expectedDate}`,
      now,
      wa: {
        kind: "refill_reminder",
        text: `EQUA: biasanya Anda memesan air sekitar ${formatTanggal(est.expectedDate)}. Pesan ulang dari aplikasi EQUA dengan satu ketukan.`,
        variables: { tanggal: formatTanggal(est.expectedDate) },
      },
    });
    const values = { avgIntervalDays: est.avgIntervalDays, nextReminderDate: est.reminderDate, ...(res.inApp > 0 ? { lastRemindedAt: now } : {}), updatedAt: now };
    if (pref) await tx.update(refillReminderPrefs).set(values).where(eq(refillReminderPrefs.id, pref.id));
    else await tx.insert(refillReminderPrefs).values({ customerAccountId: acc.id, enabled: true, ...values, createdAt: now });
    if (res.inApp > 0) sent++;
  }
  return sent;
}

// =====================================================================================================================
// Pesanan langganan gagal dibuat (KP-3)
// =====================================================================================================================

/**
 * Beri tahu pelanggan atas kegagalan pembuatan pesanan langganan yang belum ditindaklanjuti (M2 `recurring_order_failures`)
 * dengan tindakan yang disarankan. Idempoten per kegagalan.
 */
export async function notifyRecurringFailures(tx: Tx, now: Date, opts: { tenantId?: string } = {}): Promise<number> {
  const since = addDays(toBusinessDate(now), -3);
  const rows = await tx
    .select({ f: recurringOrderFailures, r: recurringOrders })
    .from(recurringOrderFailures)
    .innerJoin(recurringOrders, eq(recurringOrders.id, recurringOrderFailures.recurringOrderId))
    .where(and(isNull(recurringOrderFailures.resolvedAt), gte(recurringOrderFailures.targetDate, since), opts.tenantId ? eq(recurringOrders.tenantId, opts.tenantId) : sql`true`));
  let n = 0;
  for (const { f, r } of rows) {
    const action = label("customer_recurring_failure", f.reason);
    const res = await notifyCustomer(tx, {
      tenantId: r.tenantId,
      customerId: r.customerId,
      kind: "recurring_failed",
      title: `Pesanan langganan ${formatTanggal(f.targetDate)} belum dapat dibuat`,
      body: action,
      link: f.reason === "credit_on_hold" || f.reason === "credit_limit" || f.reason === "underpayment" ? "/app/tagihan" : "/app/langganan",
      objectType: "recurring_order",
      objectId: r.id,
      dedupeKey: `recurring_failed:${f.id}`,
      now,
      wa: { kind: "customer_notice", text: `EQUA: pesanan langganan ${formatTanggal(f.targetDate)} belum dapat dibuat. ${action}`, variables: { pesan: action } },
      waEvenWithoutApp: true,
    });
    if (res.inApp > 0 || res.wa) n++;
  }
  return n;
}
