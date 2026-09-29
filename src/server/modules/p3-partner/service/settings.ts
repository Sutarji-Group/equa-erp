/**
 * P3 — pengaturan POS oleh mitra dalam batas EQUA (Tahap 3 US-P3-02 KP-1, PTB-56; flag `phase3.partner_portal`).
 *
 * - Harga jual ditetapkan mitra per outlet (`product_prices` tenant mitra, lingkup outlet, berlaku besok) dengan harga
 *   anjuran EQUA tampil (harga standar EQUA produk sumber); batas `price_min/max_percent_of_recommended`.
 * - Kas awal tetap (≤ `opening_cash_max`) dan ambang void PAR-04 lingkup outlet (antara `void_threshold_min/max`).
 * - Semua perubahan berjejak (audit) dan tidak berlaku surut. POS M6 tidak berubah (US-P3-02 KP-1).
 * - Tenant mode baca-saja (US-P3-02 KP-4) tidak dapat mengubah pengaturan.
 */
import "server-only";

import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import { z } from "zod";

import { outlets, productPrices, products } from "@/db/schema";
import { formatRupiah, zRupiahNonNegative } from "@/lib/money";
import { addDays } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import * as params from "@/server/core/params";
import { runService } from "@/server/core/rbac";

import { assertPartnerActor, authorizePortalAction, denyCrossTenant, ownerTenantId, partnerRules } from "./common";

async function latestPrice(tx: Tx, productId: string, date: string, outletId: string | null) {
  const rows = await tx
    .select()
    .from(productPrices)
    .where(and(eq(productPrices.productId, productId), eq(productPrices.kind, "standard"), eq(productPrices.status, "active"), lte(productPrices.effectiveFrom, date)))
    .orderBy(desc(productPrices.effectiveFrom), desc(productPrices.createdAt));
  return (outletId ? rows.find((r) => r.outletId === outletId) : undefined) ?? rows.find((r) => r.outletId === null) ?? null;
}

export type PartnerPriceRow = { productId: string; code: string; name: string; price: number | null; recommendedPrice: number | null; min: number | null; max: number | null; pendingPrice: number | null; pendingFrom: string | null };

/** Harga jual outlet mitra + harga anjuran EQUA + batas (portal; tenant sendiri). */
export async function partnerPriceList(tx: Tx, tenantId: string, outletId: string, date: string): Promise<PartnerPriceRow[]> {
  const rules = await partnerRules(tx, date);
  const equa = await ownerTenantId(tx);
  const items = await tx
    .select()
    .from(products)
    .where(and(eq(products.tenantId, tenantId), eq(products.status, "active"), eq(products.posVisible, true), eq(products.isConsumable, false)))
    .orderBy(asc(products.sortOrder), asc(products.name));
  const out: PartnerPriceRow[] = [];
  for (const p of items) {
    const current = await latestPrice(tx, p.id, date, outletId);
    const tomorrow = addDays(date, 1);
    const next = await latestPrice(tx, p.id, tomorrow, outletId);
    let recommended = current?.recommendedPrice ?? null;
    if (p.sourceProductId) {
      const [src] = await tx.select({ tenantId: products.tenantId }).from(products).where(eq(products.id, p.sourceProductId)).limit(1);
      if (src?.tenantId === equa) recommended = (await latestPrice(tx, p.sourceProductId, date, null))?.price ?? recommended;
    }
    out.push({
      productId: p.id,
      code: p.code,
      name: p.name,
      price: current?.price ?? null,
      recommendedPrice: recommended,
      min: recommended !== null ? Math.round((recommended * rules.price_min_percent_of_recommended) / 100) : null,
      max: recommended !== null ? Math.round((recommended * rules.price_max_percent_of_recommended) / 100) : null,
      pendingPrice: next && next.id !== current?.id ? next.price : null,
      pendingFrom: next && next.id !== current?.id ? next.effectiveFrom : null,
    });
  }
  return out;
}

const settingsSchema = z.object({
  outletId: z.uuid({ error: "Pilih outlet." }),
  prices: z.array(z.object({ productId: z.uuid(), price: zRupiahNonNegative })).max(50).default([]),
  fixedOpeningCash: zRupiahNonNegative.nullable().optional(),
  voidThreshold: zRupiahNonNegative.nullable().optional(),
  reason: z.string().trim().min(5, { error: "Tulis alasan perubahan (minimal 5 karakter)." }).max(300),
});
export type PartnerSettingsInput = z.input<typeof settingsSchema>;

/** Mitra mengubah harga jual / kas awal tetap / ambang void outletnya (berlaku besok; dalam batas EQUA). */
export async function updatePartnerPosSettings(ctx: ActorContext, input: PartnerSettingsInput, opts: { tx?: Tx } = {}) {
  await authorizePortalAction(ctx, "p3.portal_settings.update", { tx: opts.tx });
  const data = parseInput(settingsSchema, input, { outletId: "Outlet", prices: "Harga", fixedOpeningCash: "Kas awal tetap", voidThreshold: "Ambang void", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const tenant = await assertPartnerActor(tx, ctx);
    if (tenant.readOnly) throw new DomainError("TENANT_READ_ONLY", "Pengaturan tidak dapat diubah selama mode baca-saja. Lunasi tunggakan tagihan EQUA terlebih dahulu.");
    const [o] = await tx.select().from(outlets).where(eq(outlets.id, data.outletId)).for("update").limit(1);
    if (!o) throw new NotFoundError("Outlet tidak ditemukan.");
    if (o.tenantId !== tenant.id) await denyCrossTenant(ctx, "outlet", "outlet", data.outletId, tx);
    const today = ctxBusinessDate(ctx);
    const effectiveFrom = addDays(today, 1);
    const rules = await partnerRules(tx, today);
    const changes: Record<string, unknown> = {};
    if (data.prices.length) {
      const list = new Map((await partnerPriceList(tx, tenant.id, o.id, today)).map((r) => [r.productId, r]));
      const ids = data.prices.map((p) => p.productId);
      const own = await tx.select({ id: products.id }).from(products).where(and(inArray(products.id, ids), eq(products.tenantId, tenant.id)));
      if (own.length !== new Set(ids).size) throw ValidationError.field("prices", "Produk tidak ditemukan di katalog outlet Anda.");
      const priced: { productId: string; from: number | null; to: number }[] = [];
      for (const p of data.prices) {
        const row = list.get(p.productId);
        if (!row) throw ValidationError.field("prices", "Produk ini tidak dijual di POS.");
        if (row.min !== null && row.max !== null && (p.price < row.min || p.price > row.max)) {
          throw ValidationError.field("prices", `Harga ${row.name} harus ${formatRupiah(row.min)}–${formatRupiah(row.max)} (${rules.price_min_percent_of_recommended}–${rules.price_max_percent_of_recommended}% harga anjuran EQUA ${formatRupiah(row.recommendedPrice ?? 0)}).`);
        }
        if (row.price === p.price && !row.pendingPrice) continue;
        const [same] = await tx
          .select({ id: productPrices.id })
          .from(productPrices)
          .where(and(eq(productPrices.productId, p.productId), eq(productPrices.kind, "standard"), eq(productPrices.outletId, o.id), eq(productPrices.effectiveFrom, effectiveFrom), eq(productPrices.status, "active")))
          .limit(1);
        if (same) await tx.update(productPrices).set({ status: "cancelled", updatedAt: ctx.now }).where(eq(productPrices.id, same.id));
        await tx.insert(productPrices).values({
          tenantId: tenant.id,
          productId: p.productId,
          kind: "standard",
          outletId: o.id,
          price: p.price,
          recommendedPrice: row.recommendedPrice,
          effectiveFrom,
          status: "active",
          isOwnerDirect: true,
          reason: `Harga jual mitra (PTB-56): ${data.reason}`,
          approvedBy: ctx.userId,
          approvedAt: ctx.now,
          createdBy: ctx.userId,
        });
        priced.push({ productId: p.productId, from: row.price, to: p.price });
      }
      if (priced.length) changes.prices = priced;
    }
    if (data.fixedOpeningCash !== undefined && data.fixedOpeningCash !== null && data.fixedOpeningCash !== o.fixedOpeningCash) {
      if (data.fixedOpeningCash > rules.opening_cash_max) throw ValidationError.field("fixedOpeningCash", `Kas awal tetap maksimal ${formatRupiah(rules.opening_cash_max)} (batas EQUA).`);
      await tx.update(outlets).set({ fixedOpeningCash: data.fixedOpeningCash, updatedAt: ctx.now }).where(eq(outlets.id, o.id));
      changes.fixedOpeningCash = { from: o.fixedOpeningCash, to: data.fixedOpeningCash };
    }
    if (data.voidThreshold !== undefined && data.voidThreshold !== null) {
      if (data.voidThreshold < rules.void_threshold_min || data.voidThreshold > rules.void_threshold_max) {
        throw ValidationError.field("voidThreshold", `Ambang void harus ${formatRupiah(rules.void_threshold_min)}–${formatRupiah(rules.void_threshold_max)} (batas EQUA).`);
      }
      const current = await params.get(tx, "PAR-04", effectiveFrom, { tenantId: tenant.id, outletId: o.id });
      if (current.amount_gt !== data.voidThreshold) {
        await params.set(systemContext({ tenantId: tenant.id, now: ctx.now, businessDate: today }), "PAR-04", { amount_gt: data.voidThreshold }, effectiveFrom, `Pengaturan mitra (US-P3-02 KP-1): ${data.reason}`, { outletId: o.id, tx });
        changes.voidThreshold = { from: current.amount_gt, to: data.voidThreshold };
      }
    }
    if (!Object.keys(changes).length) throw new DomainError("NO_CHANGES", "Tidak ada perubahan yang disimpan.");
    await auditRecord(tx, { ctx, objectType: "outlet", objectId: o.id, action: "partner_settings", after: { ...changes, effectiveFrom }, reason: data.reason, rule: "US-P3-02 KP-1, PTB-56" });
    return { effectiveFrom, changes };
  });
}

/** Pengaturan outlet sekarang (portal). */
export async function partnerSettingsView(ctx: ActorContext, input: { outletId: string }, opts: { tx?: Tx } = {}) {
  await authorizePortalAction(ctx, "p3.portal_settings.update", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const tenant = await assertPartnerActor(tx, ctx);
  const [o] = await tx.select().from(outlets).where(eq(outlets.id, input.outletId)).limit(1);
  if (!o) throw new NotFoundError("Outlet tidak ditemukan.");
  if (o.tenantId !== tenant.id) await denyCrossTenant(ctx, "outlet", "outlet", input.outletId);
  const today = ctxBusinessDate(ctx);
  const rules = await partnerRules(tx, today);
  const par04 = await params.get(tx, "PAR-04", today, { tenantId: tenant.id, outletId: o.id });
  const par57 = await params.get(tx, "PAR-57", today, { tenantId: tenant.id, outletId: o.id });
  return {
    outlet: { id: o.id, name: o.name, fixedOpeningCash: o.fixedOpeningCash ?? par57.amount },
    voidThreshold: par04.amount_gt,
    limits: { openingCashMax: rules.opening_cash_max, voidMin: rules.void_threshold_min, voidMax: rules.void_threshold_max, priceMinPct: rules.price_min_percent_of_recommended, priceMaxPct: rules.price_max_percent_of_recommended },
    prices: await partnerPriceList(tx, tenant.id, o.id, today),
    readOnly: tenant.readOnly,
  };
}
