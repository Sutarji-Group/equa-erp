/**
 * M6 — paket standar multi-tenant (US-M6-07; NFR-30, Bab 4.3, PTB-56).
 *
 * - Admin sistem membuat tenant mitra + outlet depotnya; katalog standar EQUA (produk depot, harga standar berlaku,
 *   resep bahan) DISALIN sebagai bawaan — seketika, tanpa rilis aplikasi (KP-1).
 * - Pengaturan per outlet tanpa kode (KP-3): kas awal tetap, QRIS aktif, printer (kolom outlet) serta ambang void &
 *   kas & toleransi stok/neraca air (parameter lingkup outlet: PAR-02/03/04/57/58/59).
 * - Seluruh aturan kontrol POS berlaku sama untuk tenant mitra (KP-4) — tidak ada cabang khusus EQUA di layanan.
 */
import "server-only";

import { and, asc, count, eq, inArray, lte } from "drizzle-orm";
import { z } from "zod";

import { depotRecipes, outlets, productPrices, products, tenants } from "@/db/schema";
import { zRupiahNonNegative } from "@/lib/money";
import { isBusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, EQUA_TENANT_ID, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, parseInput, ValidationError } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { assertTenantScope, authorize, authorizeAny, runService } from "@/server/core/rbac";

import { loadOutletForOffice, type OutletRow, type TenantRow } from "./common";

// =====================================================================================================================
// Tenant mitra baru + salinan katalog standar (KP-1)
// =====================================================================================================================

const code = z
  .string()
  .trim()
  .min(2, { error: "Kode wajib diisi." })
  .max(10)
  .regex(/^[A-Za-z0-9]+$/, { error: "Kode hanya huruf dan angka." })
  .transform((v) => v.toUpperCase());

const createTenantSchema = z.object({
  code,
  name: z.string().trim().min(3, { error: "Nama tenant wajib diisi." }).max(120),
  outlets: z
    .array(
      z.object({
        code,
        name: z.string().trim().min(3, { error: "Nama outlet wajib diisi." }).max(120),
        address: z.string().trim().max(300).nullable().optional(),
        storageCapacityL: z.number().int().min(0).max(1_000_000).nullable().optional(),
      }),
    )
    .min(1, { error: "Tenant mitra minimal punya satu outlet depot." })
    .max(20),
  /** Salin katalog standar EQUA (produk depot + harga + resep) — bawaan ya (Bab 4.3). */
  copyStandardCatalog: z.boolean().default(true),
  reason: z.string().trim().min(5, { error: "Alasan/dasar perjanjian wajib diisi (minimal 5 karakter)." }).max(500),
});
export type CreatePartnerTenantInput = z.input<typeof createTenantSchema>;

export type CreatePartnerTenantResult = {
  tenant: TenantRow;
  outlets: OutletRow[];
  copied: { products: number; prices: number; recipes: number };
};

/** Tenant sumber katalog standar (tenant pemilik EQUA). */
async function standardTenantId(tx: Tx): Promise<string> {
  const [owner] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.kind, "owner")).orderBy(asc(tenants.createdAt)).limit(1);
  return owner?.id ?? EQUA_TENANT_ID;
}

/** Salin katalog standar (produk depot aktif, harga standar berlaku, resep aktif) ke tenant baru. */
export async function copyStandardCatalog(tx: Tx, input: { fromTenantId: string; toTenantId: string; date: string; userId: string | null }) {
  const src = await tx
    .select()
    .from(products)
    .where(and(eq(products.tenantId, input.fromTenantId), eq(products.line, "depot"), eq(products.status, "active")));
  const idMap = new Map<string, string>();
  for (const p of src) {
    const [row] = await tx
      .insert(products)
      .values({
        tenantId: input.toTenantId,
        code: p.code,
        name: p.name,
        line: p.line,
        category: p.category,
        unit: p.unit,
        isInternalTransfer: false,
        isConsumable: p.isConsumable,
        gallonSizeL: p.gallonSizeL,
        minStock: p.minStock,
        barcode: p.barcode,
        posVisible: p.posVisible,
        sortOrder: p.sortOrder,
        sourceProductId: p.id,
        status: "active",
        createdBy: input.userId,
      })
      .returning({ id: products.id });
    idMap.set(p.id, row!.id);
  }
  let prices = 0;
  if (idMap.size) {
    const priceRows = await tx
      .select()
      .from(productPrices)
      .where(
        and(
          inArray(productPrices.productId, [...idMap.keys()]),
          eq(productPrices.kind, "standard"),
          eq(productPrices.status, "active"),
          lte(productPrices.effectiveFrom, input.date),
        ),
      );
    const latest = new Map<string, (typeof priceRows)[number]>();
    for (const r of priceRows) {
      if (r.outletId) continue;
      const cur = latest.get(r.productId);
      if (!cur || r.effectiveFrom > cur.effectiveFrom) latest.set(r.productId, r);
    }
    for (const [pid, r] of latest) {
      await tx.insert(productPrices).values({
        tenantId: input.toTenantId,
        productId: idMap.get(pid)!,
        kind: "standard",
        price: r.price,
        // PTB-56: harga jual mitra ditetapkan mitra; harga anjuran EQUA tetap tampil.
        recommendedPrice: r.price,
        effectiveFrom: input.date,
        status: "active",
        isOwnerDirect: true,
        reason: "Salinan katalog standar EQUA (US-M6-07 KP-1).",
        approvedBy: input.userId,
        approvedAt: new Date(),
        createdBy: input.userId,
      });
      prices++;
    }
  }
  let recipes = 0;
  if (idMap.size) {
    const recipeRows = await tx
      .select()
      .from(depotRecipes)
      .where(and(eq(depotRecipes.tenantId, input.fromTenantId), eq(depotRecipes.isActive, true), lte(depotRecipes.effectiveFrom, input.date)));
    const latest = new Map<string, (typeof recipeRows)[number]>();
    for (const r of recipeRows) {
      const key = `${r.productId}:${r.materialProductId}`;
      const cur = latest.get(key);
      if (!cur || r.effectiveFrom > cur.effectiveFrom) latest.set(key, r);
    }
    for (const r of latest.values()) {
      const productId = idMap.get(r.productId);
      const materialId = idMap.get(r.materialProductId);
      if (!productId || !materialId || r.quantity <= 0) continue;
      await tx.insert(depotRecipes).values({
        tenantId: input.toTenantId,
        productId,
        materialProductId: materialId,
        quantity: r.quantity,
        effectiveFrom: input.date,
        createdBy: input.userId,
      });
      recipes++;
    }
  }
  return { products: idMap.size, prices, recipes };
}

export async function createPartnerTenant(ctx: ActorContext, input: CreatePartnerTenantInput, opts: { tx?: Tx } = {}): Promise<CreatePartnerTenantResult> {
  await authorize(ctx, "m10.tenant.create", { tx: opts.tx });
  const data = parseInput(createTenantSchema, input, { code: "Kode", name: "Nama", reason: "Alasan" });
  const outletCodes = data.outlets.map((o) => o.code);
  if (new Set(outletCodes).size !== outletCodes.length) throw ValidationError.field("outlets", "Kode outlet tidak boleh kembar.");
  return runService(ctx, opts, async (tx) => {
    const dup = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, data.code)).limit(1);
    if (dup[0]) throw new DomainError("TENANT_DUPLICATE", `Kode tenant ${data.code} sudah dipakai.`);
    const date = ctxBusinessDate(ctx);
    const [tenant] = await tx
      .insert(tenants)
      .values({ code: data.code, name: data.name, kind: "partner", settings: { createdFromStandardCatalog: data.copyStandardCatalog } })
      .returning();
    const createdOutlets: OutletRow[] = [];
    for (const o of data.outlets) {
      const [row] = await tx
        .insert(outlets)
        .values({
          tenantId: tenant!.id,
          code: o.code,
          name: o.name,
          kind: "depot",
          address: o.address ?? null,
          storageCapacityL: o.storageCapacityL ?? null,
          qrisEnabled: true,
          activatedOn: date,
        })
        .returning();
      createdOutlets.push(row!);
    }
    const copied = data.copyStandardCatalog
      ? await copyStandardCatalog(tx, { fromTenantId: await standardTenantId(tx), toTenantId: tenant!.id, date, userId: ctx.userId })
      : { products: 0, prices: 0, recipes: 0 };
    await auditRecord(tx, {
      ctx,
      objectType: "tenant",
      objectId: tenant!.id,
      action: "create",
      after: { code: data.code, name: data.name, kind: "partner", outlets: createdOutlets.map((o) => o.code), copied },
      reason: data.reason,
      rule: "US-M6-07 KP-1",
    });
    await notify(tx, {
      event: "tenant.created",
      tenantId: ctx.tenantId,
      title: `Tenant mitra ${data.name} dibuat`,
      body: `${createdOutlets.length} outlet; katalog standar disalin: ${copied.products} produk, ${copied.prices} harga, ${copied.recipes} resep.`,
      objectType: "tenant",
      objectId: tenant!.id,
      link: "/outlet/tenant",
      now: ctx.now,
    });
    return { tenant: tenant!, outlets: createdOutlets, copied };
  });
}

export type TenantListRow = TenantRow & { outletCount: number; productCount: number };

/** Daftar tenant (admin sistem & pemilik EQUA; hanya metadata — tanpa data transaksi lintas tenant). */
export async function listTenants(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<TenantListRow[]> {
  await authorize(ctx, "m10.tenant.read", { tx: opts.tx });
  const db = opts.tx ?? getDb();
  const rows = await db.select().from(tenants).orderBy(asc(tenants.createdAt));
  const oc = await db.select({ tenantId: outlets.tenantId, n: count() }).from(outlets).groupBy(outlets.tenantId);
  const pc = await db.select({ tenantId: products.tenantId, n: count() }).from(products).groupBy(products.tenantId);
  const om = new Map(oc.map((r) => [r.tenantId, Number(r.n)]));
  const pm = new Map(pc.map((r) => [r.tenantId, Number(r.n)]));
  return rows.map((t) => ({ ...t, outletCount: om.get(t.id) ?? 0, productCount: pm.get(t.id) ?? 0 }));
}

// =====================================================================================================================
// Pengaturan outlet tanpa kode (KP-3)
// =====================================================================================================================

const settingsSchema = z.object({
  outletId: z.uuid(),
  /** Kosong = ikut PAR-57. */
  fixedOpeningCash: zRupiahNonNegative.nullable(),
  qrisEnabled: z.boolean(),
  printerEnabled: z.boolean(),
  reason: z.string().trim().min(5, { error: "Alasan perubahan wajib diisi (minimal 5 karakter)." }).max(300),
});

export async function updateOutletPosSettings(ctx: ActorContext, input: z.input<typeof settingsSchema>, opts: { tx?: Tx } = {}): Promise<OutletRow> {
  await authorize(ctx, "m6.outlet_settings.update", { tx: opts.tx });
  const data = parseInput(settingsSchema, input, { fixedOpeningCash: "Kas awal tetap", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const outlet = await loadOutletForOffice(tx, ctx, data.outletId);
    const before = { fixedOpeningCash: outlet.fixedOpeningCash, qrisEnabled: outlet.qrisEnabled, printerEnabled: outlet.printerEnabled };
    const after = { fixedOpeningCash: data.fixedOpeningCash, qrisEnabled: data.qrisEnabled, printerEnabled: data.printerEnabled };
    const [row] = await tx.update(outlets).set({ ...after, updatedAt: new Date() }).where(eq(outlets.id, outlet.id)).returning();
    await auditRecord(tx, { ctx, objectType: "outlet", objectId: outlet.id, action: "update_pos_settings", before, after, reason: data.reason, rule: "6.2b" });
    return row!;
  });
}

/** Parameter POS yang dapat diatur per outlet (US-M6-07 KP-3; lingkup outlet di registri parameter). */
export const OUTLET_THRESHOLD_KEYS = ["PAR-02", "PAR-03", "PAR-04", "PAR-57", "PAR-58", "PAR-59"] as const;
export type OutletThresholdKey = (typeof OUTLET_THRESHOLD_KEYS)[number];

const thresholdSchema = z.object({
  outletId: z.uuid(),
  key: z.enum(OUTLET_THRESHOLD_KEYS),
  /** Nilai angka tunggal (rupiah/kejadian/buah/persen sesuai parameter). */
  value: z.number().min(0),
  effectiveFrom: z.string().refine(isBusinessDate, { error: "Tanggal berlaku tidak valid." }),
  reason: z.string().trim().min(5, { error: "Alasan perubahan wajib diisi (minimal 5 karakter)." }),
});

function thresholdValue(key: OutletThresholdKey, value: number) {
  switch (key) {
    case "PAR-02":
    case "PAR-57":
      return { amount: Math.round(value) };
    case "PAR-03":
      return { count: Math.round(value) };
    case "PAR-04":
      return { amount_gt: Math.round(value) };
    case "PAR-58":
      return { units_per_material: Math.round(value) };
    case "PAR-59":
      return { percent: value };
  }
}

/** Ambang per outlet (keputusan langsung pemilik 6.2b, berjejak, dengan tanggal berlaku). */
export async function setOutletThreshold(ctx: ActorContext, input: z.input<typeof thresholdSchema>, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["m6.outlet_settings.update"], { tx: opts.tx });
  const data = parseInput(thresholdSchema, input, { value: "Nilai", effectiveFrom: "Tanggal berlaku", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const outlet = await loadOutletForOffice(tx, ctx, data.outletId);
    assertTenantScope(ctx, outlet.tenantId);
    return params.set(ctx, data.key, thresholdValue(data.key, data.value) as never, data.effectiveFrom, data.reason, { outletId: outlet.id, tx });
  });
}
