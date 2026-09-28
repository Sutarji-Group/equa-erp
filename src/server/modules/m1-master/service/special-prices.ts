/**
 * M1 — harga khusus per pelanggan per produk (US-M1-01 KP-5; BR-16; PAR-24; 6.2a `special_price`).
 *
 * Dispatcher mengajukan (alasan, tanggal mulai); tanggal tinjauan otomatis = mulai + PAR-24 bulan; berlaku hanya
 * setelah persetujuan pemilik (lewat tenggat: tidak ada — harga master berlaku sampai diputuskan). Harga khusus yang
 * lewat tanggal tinjauan TETAP berlaku tetapi tampil di daftar tinjauan pemilik (job bulanan memberi tahu).
 */
import "server-only";

import { and, asc, eq, isNull, lte, or, gte } from "drizzle-orm";
import { z } from "zod";

import { customers, products, specialPrices } from "@/db/schema";
import { newId } from "@/lib/ids";
import { formatRupiah, zRupiahPositive } from "@/lib/money";
import { isBusinessDate, toBusinessDate, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { getDb } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";

import { addMonths, loadCustomer, loadProduct } from "./common";

const requestSchema = z.object({
  customerId: z.uuid({ error: "Pilih pelanggan." }),
  productId: z.uuid({ error: "Pilih produk." }),
  price: zRupiahPositive,
  validFrom: z.string().refine(isBusinessDate, { error: "Tanggal mulai wajib (YYYY-MM-DD)." }),
  reason: z.string().trim().min(3, { error: "Alasan harga khusus wajib diisi (minimal 3 karakter)." }),
});
export type RequestSpecialPriceInput = z.input<typeof requestSchema>;

/** Ajukan harga khusus (BR-16): status Menunggu persetujuan; tanggal tinjauan = mulai + PAR-24 bulan. */
export async function requestSpecialPrice(ctx: ActorContext, input: RequestSpecialPriceInput, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m1.special_price.request", { tx: opts.tx, objectType: "customer", objectId: input?.customerId });
  const data = parseInput(requestSchema, input, { price: "Harga khusus", validFrom: "Tanggal mulai", reason: "Alasan" });
  const today = ctxBusinessDate(ctx);
  if (data.validFrom < today) throw ValidationError.field("validFrom", "Tanggal mulai tidak boleh mundur. Pilih hari ini atau sesudahnya.");
  return runService(ctx, opts, async (tx) => {
    const customer = await loadCustomer(tx, ctx, data.customerId);
    if (!customer.isActive) throw new DomainError("CUSTOMER_INACTIVE", "Pelanggan nonaktif.");
    const product = await loadProduct(tx, ctx, data.productId);
    if (product.tenantId !== customer.tenantId) throw ValidationError.field("productId", "Produk tidak dikenal untuk pelanggan ini.");
    if (product.status !== "active") throw new DomainError("PRODUCT_INACTIVE", "Produk nonaktif.");
    if (product.isInternalTransfer) throw ValidationError.field("productId", "Harga transfer internal tidak dapat diberi harga khusus.");
    const par24 = await params.get(tx, "PAR-24", today);
    const id = newId();
    const reviewDate = addMonths(data.validFrom, par24.months);
    const request = await approvals.submit(
      ctx,
      {
        type: "special_price",
        objectType: "special_price",
        objectId: id,
        amount: data.price,
        reason: data.reason,
        payload: { customerName: customer.name, productName: product.name, price: data.price, validFrom: data.validFrom, reviewDate, link: `/master/pelanggan/${customer.id}#harga-khusus` },
      },
      { tx },
    );
    const [row] = await tx
      .insert(specialPrices)
      .values({
        id,
        customerId: customer.id,
        productId: product.id,
        price: data.price,
        reason: data.reason,
        validFrom: data.validFrom,
        reviewDate,
        status: "pending",
        approvalRequestId: request.id,
        createdBy: ctx.userId,
      })
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "special_price",
      objectId: id,
      action: "submit",
      after: { customer: customer.name, product: product.name, price: data.price, validFrom: data.validFrom, reviewDate },
      reason: data.reason,
      rule: "BR-16",
    });
    return { specialPrice: row!, approval: request };
  });
}

/** Penerapan keputusan `special_price` (ctx = pemilik). */
export async function applySpecialPriceDecision(tx: Tx, ctx: ActorContext, request: approvals.ApprovalRow, decision: "approved" | "rejected", reason: string | null) {
  const rows = await tx.select().from(specialPrices).where(eq(specialPrices.id, request.objectId)).limit(1);
  const sp = rows[0];
  if (!sp || sp.status !== "pending") return { applied: false };
  if (decision === "approved") {
    // Satu harga khusus aktif per (pelanggan, produk, tanggal mulai): yang lama bertanggal sama digantikan.
    const same = await tx
      .select()
      .from(specialPrices)
      .where(and(eq(specialPrices.customerId, sp.customerId), eq(specialPrices.productId, sp.productId), eq(specialPrices.validFrom, sp.validFrom), eq(specialPrices.status, "active")));
    for (const s of same) await tx.update(specialPrices).set({ status: "cancelled" }).where(eq(specialPrices.id, s.id));
    await tx.update(specialPrices).set({ status: "active", approvedBy: ctx.userId, approvedAt: ctx.now }).where(eq(specialPrices.id, sp.id));
  } else {
    await tx.update(specialPrices).set({ status: "rejected" }).where(eq(specialPrices.id, sp.id));
  }
  await auditRecord(tx, {
    ctx,
    objectType: "special_price",
    objectId: sp.id,
    action: decision === "approved" ? "approve" : "reject",
    before: { status: "pending" },
    after: { status: decision === "approved" ? "active" : "rejected" },
    reason,
    rule: "6.2a",
  });
  return { applied: decision === "approved", price: sp.price };
}

export type SpecialPriceReviewRow = {
  id: string;
  customerId: string;
  customerName: string;
  productName: string;
  price: number;
  validFrom: string;
  reviewDate: string;
  lastReviewedAt: Date | null;
  daysOverdue: number;
};

/** Daftar tinjauan pemilik: harga khusus aktif yang tanggal tinjauannya sudah lewat (tetap berlaku). */
export async function specialPricesDueForReview(tx: Tx, tenantId: string, date: BusinessDate): Promise<SpecialPriceReviewRow[]> {
  const rows = await tx
    .select({ s: specialPrices, customerName: customers.name, productName: products.name })
    .from(specialPrices)
    .innerJoin(customers, eq(customers.id, specialPrices.customerId))
    .innerJoin(products, eq(products.id, specialPrices.productId))
    .where(
      and(
        eq(customers.tenantId, tenantId),
        eq(specialPrices.status, "active"),
        lte(specialPrices.reviewDate, date),
        or(isNull(specialPrices.validUntil), gte(specialPrices.validUntil, date)),
      ),
    )
    .orderBy(asc(specialPrices.reviewDate));
  return rows.map((r) => ({
    id: r.s.id,
    customerId: r.s.customerId,
    customerName: r.customerName,
    productName: r.productName,
    price: r.s.price,
    validFrom: r.s.validFrom,
    reviewDate: r.s.reviewDate,
    lastReviewedAt: r.s.lastReviewedAt,
    daysOverdue: Math.max(0, Math.round((Date.parse(date) - Date.parse(r.s.reviewDate)) / 86_400_000)),
  }));
}

/** Daftar tinjauan harga khusus (layar pemilik). */
export async function listSpecialPriceReviews(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<SpecialPriceReviewRow[]> {
  await authorize(ctx, "m1.special_price.read", { tx: opts.tx });
  return specialPricesDueForReview(opts.tx ?? getDb(), ctx.tenantId, ctxBusinessDate(ctx));
}

const reviewSchema = z.object({
  action: z.enum(["keep", "end"], { error: "Pilih keputusan tinjauan." }),
  note: z.string().trim().min(3, { error: "Catatan tinjauan wajib diisi (minimal 3 karakter)." }),
  /** Untuk "end": tanggal terakhir berlaku (≥ hari ini). */
  validUntil: z.string().refine(isBusinessDate, { error: "Tanggal akhir harus YYYY-MM-DD." }).optional(),
});

/**
 * Tinjauan pemilik (BR-16): `keep` → tetap berlaku, tanggal tinjauan berikutnya = hari ini + PAR-24 bulan;
 * `end` → berakhir pada `validUntil` (setelahnya harga master berlaku). Riwayat tetap tersimpan.
 */
export async function reviewSpecialPrice(ctx: ActorContext, id: string, input: z.input<typeof reviewSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m1.special_price.review", { tx: opts.tx, objectType: "special_price", objectId: id });
  const data = parseInput(reviewSchema, input, { note: "Catatan" });
  const today = ctxBusinessDate(ctx);
  return runService(ctx, opts, async (tx) => {
    const rows = await tx.select().from(specialPrices).where(eq(specialPrices.id, id)).limit(1);
    const sp = rows[0];
    if (!sp) throw new NotFoundError("Harga khusus tidak ditemukan.");
    await loadCustomer(tx, ctx, sp.customerId);
    if (sp.status !== "active") throw new DomainError("NOT_ACTIVE", "Hanya harga khusus yang berlaku yang dapat ditinjau.");
    const par24 = await params.get(tx, "PAR-24", today);
    let patch: Partial<typeof specialPrices.$inferInsert>;
    if (data.action === "keep") {
      patch = { lastReviewedAt: ctx.now, reviewDate: addMonths(today, par24.months) };
    } else {
      const until = data.validUntil ?? today;
      if (until < today) throw ValidationError.field("validUntil", "Tanggal akhir tidak boleh mundur.");
      if (until < sp.validFrom) throw ValidationError.field("validUntil", "Tanggal akhir sebelum tanggal mulai.");
      patch = { lastReviewedAt: ctx.now, validUntil: until };
    }
    const [after] = await tx.update(specialPrices).set(patch).where(eq(specialPrices.id, id)).returning();
    await auditRecord(tx, {
      ctx,
      objectType: "special_price",
      objectId: id,
      action: data.action === "keep" ? "review" : "update",
      before: { reviewDate: sp.reviewDate, validUntil: sp.validUntil },
      after: { reviewDate: after!.reviewDate, validUntil: after!.validUntil },
      reason: data.note,
      rule: "BR-16",
    });
    return after!;
  });
}

/** Job bulanan: beri tahu pemilik bila ada harga khusus lewat tanggal tinjauan (6.3 "Harga khusus lewat 6 bulan"). */
export async function notifySpecialPriceReviews(tx: Tx, now: Date): Promise<{ tenants: number; due: number }> {
  const date = toBusinessDate(now);
  const tenants = await tx.selectDistinct({ tenantId: customers.tenantId }).from(customers);
  let due = 0;
  let notified = 0;
  for (const t of tenants) {
    const rows = await specialPricesDueForReview(tx, t.tenantId, date);
    if (rows.length === 0) continue;
    due += rows.length;
    notified++;
    const ctx = systemContext({ tenantId: t.tenantId, now });
    await notify(tx, {
      event: "special_price.review_due",
      tenantId: t.tenantId,
      title: `${rows.length} harga khusus perlu ditinjau`,
      body: rows
        .slice(0, 5)
        .map((r) => `${r.customerName}: ${formatRupiah(r.price)} (tinjauan ${r.reviewDate})`)
        .join("; "),
      link: "/master/pelanggan?tab=tinjauan-harga",
      groupKey: `special_price_review:${t.tenantId}:${date.slice(0, 7)}`,
      now: ctx.now,
    });
  }
  return { tenants: notified, due };
}
