/**
 * M1 — produk tiga lini (US-M1-02 KP-1, KP-6): air truk (harga = tarif zona + BBM), produk depot (harga tunggal per
 * tenant), barang toko (harga umum & mitra; barang baru dari kasir lewat M7). Dinonaktifkan, bukan dihapus; produk
 * nonaktif tidak muncul di POS/pesanan tetapi tetap tampil di riwayat.
 */
import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { productPrices, products } from "@/db/schema";
import { enumValues, type PriceKind, type ProductLine } from "@/lib/labels";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { getDb } from "@/server/core/db";
import { DomainError, parseInput, ValidationError } from "@/server/core/errors";
import { authorize, authorizeAny, runService } from "@/server/core/rbac";

import { loadProduct, type ProductRow } from "./common";
import { getFuelComponent, resolveProductPrice } from "./pricing";

const productSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, { error: "Kode produk wajib diisi." })
    .max(30)
    .regex(/^[A-Za-z0-9-]+$/, { error: "Kode produk hanya huruf, angka, dan tanda minus." })
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().min(2, { error: "Nama produk wajib diisi." }).max(120),
  line: z.enum(enumValues("product_line")),
  unit: z.string().trim().min(1, { error: "Satuan wajib diisi (mis. galon, pcs, rit)." }).max(20),
  category: z.string().trim().max(40).nullable().optional(),
  isInternalTransfer: z.boolean().optional(),
  isConsumable: z.boolean().optional(),
  gallonSizeL: z.number().int().min(1).max(100).nullable().optional(),
  minStock: z.number().int().min(0).nullable().optional(),
  barcode: z.string().trim().max(40).nullable().optional(),
  posVisible: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});
export type ProductInput = z.input<typeof productSchema>;

const LABELS = { code: "Kode", name: "Nama", line: "Lini", unit: "Satuan" };

/** Buat produk depot / air truk (Admin Keuangan). Barang toko baru dari kasir lewat M7 (persetujuan Admin Keuangan). */
export async function createProduct(ctx: ActorContext, input: ProductInput, opts: { tx?: Tx } = {}): Promise<ProductRow> {
  await authorize(ctx, "m1.product.create", { tx: opts.tx });
  const data = parseInput(productSchema, input, LABELS);
  if (data.line === "store") {
    throw new DomainError("STORE_PRODUCT_VIA_M7", "Barang toko baru diusulkan kasir di POS toko dan disetujui Admin Keuangan (M7).");
  }
  if (data.line !== "truck_water" && data.isInternalTransfer) throw ValidationError.field("isInternalTransfer", "Transfer internal hanya untuk produk air truk.");
  return runService(ctx, opts, async (tx) => {
    const dup = await tx.select({ id: products.id }).from(products).where(and(eq(products.tenantId, ctx.tenantId), eq(products.code, data.code))).limit(1);
    if (dup[0]) throw new DomainError("PRODUCT_DUPLICATE", `Kode produk ${data.code} sudah dipakai.`);
    const [row] = await tx
      .insert(products)
      .values({
        tenantId: ctx.tenantId,
        code: data.code,
        name: data.name,
        line: data.line,
        unit: data.unit,
        category: data.category ?? null,
        isInternalTransfer: data.isInternalTransfer ?? false,
        isConsumable: data.isConsumable ?? false,
        gallonSizeL: data.gallonSizeL ?? null,
        minStock: data.minStock ?? null,
        barcode: data.barcode ?? null,
        posVisible: data.line === "truck_water" ? false : (data.posVisible ?? true),
        sortOrder: data.sortOrder ?? 0,
        status: "active",
        createdBy: ctx.userId,
      })
      .returning();
    await auditRecord(tx, { ctx, objectType: "product", objectId: row!.id, action: "create", after: row });
    return row!;
  });
}

/** Ubah atribut produk (bukan harga; harga lewat usulan berlaku per tanggal). */
export async function updateProduct(ctx: ActorContext, productId: string, input: Partial<ProductInput>, opts: { tx?: Tx } = {}): Promise<ProductRow> {
  await authorize(ctx, "m1.product.update", { tx: opts.tx, objectType: "product", objectId: productId });
  return runService(ctx, opts, async (tx) => {
    const before = await loadProduct(tx, ctx, productId);
    const data = parseInput(
      productSchema,
      {
        code: before.code,
        name: before.name,
        line: before.line,
        unit: before.unit,
        category: before.category,
        isInternalTransfer: before.isInternalTransfer,
        isConsumable: before.isConsumable,
        gallonSizeL: before.gallonSizeL,
        minStock: before.minStock,
        barcode: before.barcode,
        posVisible: before.posVisible,
        sortOrder: before.sortOrder,
        ...input,
      },
      LABELS,
    );
    if (data.code !== before.code) throw ValidationError.field("code", "Kode produk tidak dapat diubah.");
    if (data.line !== before.line) throw ValidationError.field("line", "Lini produk tidak dapat diubah.");
    const patch = {
      name: data.name,
      unit: data.unit,
      category: data.category ?? null,
      isConsumable: data.isConsumable ?? false,
      gallonSizeL: data.gallonSizeL ?? null,
      minStock: data.minStock ?? null,
      barcode: data.barcode ?? null,
      posVisible: before.line === "truck_water" ? false : (data.posVisible ?? true),
      sortOrder: data.sortOrder ?? 0,
    };
    const [after] = await tx.update(products).set(patch).where(eq(products.id, productId)).returning();
    const keys = Object.keys(patch).filter((k) => (before as Record<string, unknown>)[k] !== (after as Record<string, unknown>)[k]);
    if (keys.length) {
      await auditRecord(tx, {
        ctx,
        objectType: "product",
        objectId: productId,
        action: "update",
        before: Object.fromEntries(keys.map((k) => [k, (before as Record<string, unknown>)[k]])),
        after: Object.fromEntries(keys.map((k) => [k, (after as Record<string, unknown>)[k]])),
      });
    }
    return after!;
  });
}

/** Nonaktifkan / aktifkan kembali produk beralasan (US-M1-02 KP-6). */
export async function setProductActive(ctx: ActorContext, productId: string, input: { active: boolean; reason: string }, opts: { tx?: Tx } = {}): Promise<ProductRow> {
  await authorize(ctx, "m1.product.deactivate", { tx: opts.tx, objectType: "product", objectId: productId });
  const data = parseInput(z.object({ active: z.boolean(), reason: z.string().trim().min(3, { error: "Alasan wajib diisi (minimal 3 karakter)." }) }), input);
  return runService(ctx, opts, async (tx) => {
    const before = await loadProduct(tx, ctx, productId);
    const target = data.active ? "active" : "inactive";
    if (before.status === target) throw new DomainError("NO_CHANGE", `Produk sudah ${data.active ? "aktif" : "nonaktif"}.`);
    if (before.status === "pending_approval") throw new DomainError("PENDING_APPROVAL", "Produk masih menunggu persetujuan (M7).");
    const [after] = await tx
      .update(products)
      .set({ status: target, deactivatedAt: data.active ? null : ctx.now, deactivatedBy: data.active ? null : ctx.userId, deactivationReason: data.active ? null : data.reason })
      .where(eq(products.id, productId))
      .returning();
    await auditRecord(tx, { ctx, objectType: "product", objectId: productId, action: data.active ? "activate" : "deactivate", before: { status: before.status }, after: { status: target }, reason: data.reason });
    return after!;
  });
}

export type ProductListRow = ProductRow & {
  prices: { kind: PriceKind; price: number | null; effectiveFrom: string | null }[];
  pendingPrices: number;
};

/** Daftar produk per lini + harga berlaku hari ini (tanpa outlet). */
export async function listProducts(ctx: ActorContext, filter: { line?: ProductLine; includeInactive?: boolean } = {}, opts: { tx?: Tx } = {}): Promise<ProductListRow[]> {
  await authorizeAny(ctx, ["m1.product.read", "m1.price.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const conds = [eq(products.tenantId, ctx.tenantId)];
  if (filter.line) conds.push(eq(products.line, filter.line));
  if (!filter.includeInactive) conds.push(inArray(products.status, ["active", "pending_approval"]));
  const rows = await tx.select().from(products).where(and(...conds)).orderBy(asc(products.line), asc(products.sortOrder), asc(products.code));
  const pending = rows.length
    ? await tx.select({ productId: productPrices.productId }).from(productPrices).where(and(inArray(productPrices.productId, rows.map((r) => r.id)), eq(productPrices.status, "pending")))
    : [];
  const date = ctxBusinessDate(ctx);
  const out: ProductListRow[] = [];
  for (const r of rows) {
    const kinds: PriceKind[] = r.line === "depot" ? ["standard"] : r.line === "store" ? ["general", "partner"] : [];
    const prices: ProductListRow["prices"] = [];
    for (const kind of kinds) {
      try {
        const p = r.status === "active" ? await resolveProductPrice(tx, { productId: r.id, kind, date, tenantId: r.tenantId }) : null;
        prices.push({ kind, price: p?.unitPrice ?? null, effectiveFrom: p?.effectiveFrom ?? null });
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        prices.push({ kind, price: null, effectiveFrom: null });
      }
    }
    out.push({ ...r, prices, pendingPrices: pending.filter((p) => p.productId === r.id).length });
  }
  return out;
}

/** Komponen BBM berlaku hari ini + usulan menunggu. */
export async function currentFuelComponent(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["m1.price.read", "m1.tariff_zone.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  return getFuelComponent(tx, ctx.tenantId, ctxBusinessDate(ctx));
}
