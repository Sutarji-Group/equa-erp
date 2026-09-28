/**
 * M1 — harga tiga lini & tarif (US-M1-02, US-M1-05 KP-1; BR-15, BR-16, BR-19, BR-33, K20, K23).
 *
 * - Harga air truk = tarif zona alamat kirim (per segmen bila ditetapkan) + komponen BBM, atau harga khusus aktif
 *   pelanggan (BR-16). Alamat tanpa zona → "harga sementara" (7.1.6).
 * - Produk depot: harga standar per tenant (opsional per outlet); barang toko: harga umum & mitra.
 * - Setiap harga/tarif berlaku per tanggal; jalur baku Admin Keuangan → persetujuan pemilik (`price_change`, tenggat =
 *   sebelum tanggal berlaku, lewat tenggat → harga lama tetap); pemilik = keputusan langsung 6.2b (alasan + tanggal
 *   berlaku wajib, notifikasi Admin Keuangan & Dispatcher). Riwayat tidak dapat dihapus.
 */
import "server-only";

import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";

import {
  customerAddresses,
  customers,
  fuelComponents,
  outlets,
  productPrices,
  products,
  specialPrices,
  tariffZones,
  zoneTariffs,
} from "@/db/schema";
import { enumValues, label, type CustomerSegment, type PriceKind } from "@/lib/labels";
import { newId } from "@/lib/ids";
import { formatRupiah, zRupiahPositive } from "@/lib/money";
import { isBusinessDate, wibToUtc, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { authorizeAny, can, runService } from "@/server/core/rbac";

import { assertEffectiveFrom, loadProduct, truckWaterProduct } from "./common";
import { loadZone, mapAddressToZone, notifyOwnerDirectPriceChange, zoneTableAt } from "./zones";

// =====================================================================================================================
// Pembacaan harga berlaku
// =====================================================================================================================

/** Tarif zona per rit yang berlaku pada tanggal (tarif segmen didahulukan bila ada). */
export async function getZoneTariff(
  tx: Tx,
  zoneId: string,
  segment: CustomerSegment | null,
  date: BusinessDate,
): Promise<{ id: string; pricePerTrip: number; segment: CustomerSegment | null; effectiveFrom: string } | null> {
  const rows = await tx
    .select()
    .from(zoneTariffs)
    .where(and(eq(zoneTariffs.tariffZoneId, zoneId), eq(zoneTariffs.status, "active"), lte(zoneTariffs.effectiveFrom, date)))
    .orderBy(desc(zoneTariffs.effectiveFrom), desc(zoneTariffs.createdAt));
  const bySegment = segment ? rows.find((r) => r.segment === segment) : undefined;
  const general = rows.find((r) => r.segment === null);
  const pick = bySegment ?? general;
  return pick ? { id: pick.id, pricePerTrip: pick.pricePerTrip, segment: pick.segment, effectiveFrom: pick.effectiveFrom } : null;
}

/** Komponen BBM per rit yang berlaku pada tanggal (PTB-03: satu nilai untuk seluruh zona). */
export async function getFuelComponent(tx: Tx, tenantId: string, date: BusinessDate): Promise<{ id: string; amountPerTrip: number; effectiveFrom: string } | null> {
  const rows = await tx
    .select()
    .from(fuelComponents)
    .where(and(eq(fuelComponents.tenantId, tenantId), eq(fuelComponents.status, "active"), lte(fuelComponents.effectiveFrom, date)))
    .orderBy(desc(fuelComponents.effectiveFrom), desc(fuelComponents.createdAt))
    .limit(1);
  const r = rows[0];
  return r ? { id: r.id, amountPerTrip: r.amountPerTrip, effectiveFrom: r.effectiveFrom } : null;
}

/** Harga khusus aktif pelanggan untuk produk pada tanggal (BR-16) — lewat tanggal tinjauan tetap berlaku. */
export async function getActiveSpecialPrice(tx: Tx, customerId: string, productId: string, date: BusinessDate) {
  const rows = await tx
    .select()
    .from(specialPrices)
    .where(
      and(
        eq(specialPrices.customerId, customerId),
        eq(specialPrices.productId, productId),
        eq(specialPrices.status, "active"),
        lte(specialPrices.validFrom, date),
        or(isNull(specialPrices.validUntil), gte(specialPrices.validUntil, date)),
      ),
    )
    .orderBy(desc(specialPrices.validFrom), desc(specialPrices.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export type TruckWaterPrice = {
  unitPrice: number;
  source: "zone" | "special";
  zoneId: string | null;
  zoneCode: string | null;
  zoneTariff: number;
  zoneTariffId: string | null;
  fuelComponent: number;
  fuelComponentId: string | null;
  specialPriceId?: string;
  /** Alamat tanpa zona (tanpa koordinat & tanpa zona manual): "harga sementara", tidak dapat diterbitkan (7.1.6). */
  tempPrice: boolean;
  productId: string;
};

/**
 * Harga air truk per rit untuk alamat kirim pada tanggal (BR-19): harga khusus aktif (BR-16) atau tarif zona alamat
 * (per segmen bila ada) + komponen BBM. Harga mengikuti alamat kirim, bukan pelanggan (7.1.6). Alamat tanpa zona →
 * `tempPrice: true` dengan tarif zona TERTINGGI yang berlaku (harga sementara konservatif; pesanan tidak dapat
 * diterbitkan sampai zona ditetapkan). Dipakai M2 untuk mengunci harga pesanan.
 */
export async function resolveTruckWaterPrice(
  tx: Tx,
  input: { customerId: string; addressId: string; date: BusinessDate; productId?: string },
): Promise<TruckWaterPrice> {
  if (!isBusinessDate(input.date)) throw ValidationError.field("date", "Tanggal harga tidak valid.");
  const rows = await tx
    .select({ address: customerAddresses, customer: customers })
    .from(customerAddresses)
    .innerJoin(customers, eq(customers.id, customerAddresses.customerId))
    .where(eq(customerAddresses.id, input.addressId))
    .limit(1);
  const row = rows[0];
  if (!row || row.customer.id !== input.customerId) throw new NotFoundError("Alamat kirim tidak ditemukan untuk pelanggan ini.");
  const { address, customer } = row;
  const product = input.productId ? await loadProduct(tx, null, input.productId) : await truckWaterProduct(tx, customer.tenantId);
  if (product.line !== "truck_water") throw new DomainError("NOT_TRUCK_WATER", "Produk bukan air truk.");

  const fuel = await getFuelComponent(tx, customer.tenantId, input.date);
  const special = await getActiveSpecialPrice(tx, customer.id, product.id, input.date);
  const zoneCode = address.tariffZoneId ? ((await tx.select({ code: tariffZones.code }).from(tariffZones).where(eq(tariffZones.id, address.tariffZoneId)).limit(1))[0]?.code ?? null) : null;

  if (special) {
    return {
      unitPrice: special.price,
      source: "special",
      zoneId: address.tariffZoneId,
      zoneCode,
      zoneTariff: 0,
      zoneTariffId: null,
      fuelComponent: 0,
      fuelComponentId: null,
      specialPriceId: special.id,
      tempPrice: false,
      productId: product.id,
    };
  }
  if (!fuel) throw new DomainError("NO_FUEL_COMPONENT", "Komponen BBM belum ditetapkan untuk tanggal ini. Minta pemilik menetapkannya di Data master > Produk.");

  if (!address.tariffZoneId) {
    const table = await zoneTableAt(tx, customer.tenantId, input.date);
    let highest: { id: string; pricePerTrip: number } | null = null;
    for (const z of table) {
      const t = await getZoneTariff(tx, z.zoneId, customer.segment, input.date);
      if (t && (!highest || t.pricePerTrip > highest.pricePerTrip)) highest = t;
    }
    if (!highest) throw new DomainError("NO_ZONE_TARIFF", "Tarif zona belum ditetapkan. Minta pemilik melengkapi Data master > Zona tarif.");
    return {
      unitPrice: highest.pricePerTrip + fuel.amountPerTrip,
      source: "zone",
      zoneId: null,
      zoneCode: null,
      zoneTariff: highest.pricePerTrip,
      zoneTariffId: highest.id,
      fuelComponent: fuel.amountPerTrip,
      fuelComponentId: fuel.id,
      tempPrice: true,
      productId: product.id,
    };
  }
  const tariff = await getZoneTariff(tx, address.tariffZoneId, customer.segment, input.date);
  if (!tariff) {
    throw new DomainError("NO_ZONE_TARIFF", `Tarif zona ${zoneCode ?? ""} belum ditetapkan untuk tanggal ini. Minta pemilik melengkapinya.`.replace("  ", " "));
  }
  return {
    unitPrice: tariff.pricePerTrip + fuel.amountPerTrip,
    source: "zone",
    zoneId: address.tariffZoneId,
    zoneCode,
    zoneTariff: tariff.pricePerTrip,
    zoneTariffId: tariff.id,
    fuelComponent: fuel.amountPerTrip,
    fuelComponentId: fuel.id,
    tempPrice: false,
    productId: product.id,
  };
}

/**
 * Deteksi perubahan harga sebelum tanggal kirim (US-M1-02 KP-4, PTB-13): bandingkan harga terkunci pesanan dengan
 * harga berlaku pada tanggal kirim. M2 menampilkan peringatan; memperbarui harga butuh konfirmasi pelanggan.
 */
export async function detectTruckPriceChange(
  tx: Tx,
  input: { customerId: string; addressId: string; lockedUnitPrice: number; deliveryDate: BusinessDate },
): Promise<{ changed: boolean; lockedUnitPrice: number; currentUnitPrice: number; difference: number; price: TruckWaterPrice }> {
  const price = await resolveTruckWaterPrice(tx, { customerId: input.customerId, addressId: input.addressId, date: input.deliveryDate });
  return {
    changed: price.unitPrice !== input.lockedUnitPrice,
    lockedUnitPrice: input.lockedUnitPrice,
    currentUnitPrice: price.unitPrice,
    difference: price.unitPrice - input.lockedUnitPrice,
    price,
  };
}

export type ProductPriceResult = {
  unitPrice: number;
  priceId: string;
  kind: PriceKind;
  outletSpecific: boolean;
  recommendedPrice: number | null;
  effectiveFrom: string;
};

/**
 * Harga produk berlaku (BR-15) untuk POS M6/M7: `standard` (depot), `general`/`partner` (toko). Harga khusus outlet
 * didahulukan. Produk nonaktif tidak dapat dijual (US-M1-02 KP-6).
 */
export async function resolveProductPrice(
  tx: Tx,
  input: { productId: string; kind: PriceKind; date: BusinessDate; tenantId: string; outletId?: string | null },
): Promise<ProductPriceResult> {
  const product = await loadProduct(tx, null, input.productId);
  if (product.tenantId !== input.tenantId) throw new NotFoundError("Produk tidak ditemukan untuk tenant ini.");
  if (product.status !== "active") throw new DomainError("PRODUCT_INACTIVE", `Produk ${product.name} nonaktif dan tidak dapat dijual.`);
  const rows = await tx
    .select()
    .from(productPrices)
    .where(
      and(
        eq(productPrices.productId, input.productId),
        eq(productPrices.kind, input.kind),
        eq(productPrices.status, "active"),
        lte(productPrices.effectiveFrom, input.date),
      ),
    )
    .orderBy(desc(productPrices.effectiveFrom), desc(productPrices.createdAt));
  const outletRow = input.outletId ? rows.find((r) => r.outletId === input.outletId) : undefined;
  const general = rows.find((r) => r.outletId === null);
  const pick = outletRow ?? general;
  if (!pick) {
    throw new DomainError("NO_PRODUCT_PRICE", `${label("price_kind", input.kind)} untuk ${product.name} belum ditetapkan pada tanggal ini.`);
  }
  return {
    unitPrice: pick.price,
    priceId: pick.id,
    kind: input.kind,
    outletSpecific: pick.outletId !== null,
    recommendedPrice: pick.recommendedPrice,
    effectiveFrom: pick.effectiveFrom,
  };
}

/**
 * Harga transfer internal air truk ke depot sendiri (BR-33, K20, US-M1-02 KP-5): tarif zona alamat depot pada segmen
 * depot pihak ketiga + komponen BBM — tanpa pembayaran (dasar jurnal M11, M8 pasokan depot).
 */
export async function resolveInternalTransferPrice(
  tx: Tx,
  input: { depotOutletId: string; date: BusinessDate },
): Promise<{ unitPrice: number; zoneId: string; zoneCode: string; zoneTariff: number; fuelComponent: number; customerId: string | null; addressId: string | null }> {
  const outletRows = await tx.select().from(outlets).where(eq(outlets.id, input.depotOutletId)).limit(1);
  const outlet = outletRows[0];
  if (!outlet || outlet.kind !== "depot") throw new NotFoundError("Depot tidak ditemukan.");
  const internal = await tx.select().from(customers).where(eq(customers.internalOutletId, outlet.id)).limit(1);
  let zoneId: string | null = null;
  let addressId: string | null = null;
  if (internal[0]) {
    const addr = await tx
      .select()
      .from(customerAddresses)
      .where(and(eq(customerAddresses.customerId, internal[0].id), eq(customerAddresses.isActive, true)))
      .orderBy(customerAddresses.createdAt)
      .limit(1);
    zoneId = addr[0]?.tariffZoneId ?? null;
    addressId = addr[0]?.id ?? null;
  }
  if (!zoneId && outlet.lat !== null && outlet.lng !== null) {
    const mapping = await mapAddressToZone(tx, { lat: outlet.lat, lng: outlet.lng, tenantId: outlet.tenantId, date: input.date });
    zoneId = mapping.zoneId;
  }
  if (!zoneId) throw new DomainError("DEPOT_NO_ZONE", `Zona alamat ${outlet.name} belum dapat ditentukan. Lengkapi koordinat depot.`);
  const zone = await loadZone(tx, null, zoneId);
  const tariff = await getZoneTariff(tx, zoneId, "third_party_depot", input.date);
  if (!tariff) throw new DomainError("NO_ZONE_TARIFF", `Tarif zona ${zone.code} belum ditetapkan.`);
  const fuel = await getFuelComponent(tx, outlet.tenantId, input.date);
  if (!fuel) throw new DomainError("NO_FUEL_COMPONENT", "Komponen BBM belum ditetapkan untuk tanggal ini.");
  return {
    unitPrice: tariff.pricePerTrip + fuel.amountPerTrip,
    zoneId,
    zoneCode: zone.code,
    zoneTariff: tariff.pricePerTrip,
    fuelComponent: fuel.amountPerTrip,
    customerId: internal[0]?.id ?? null,
    addressId,
  };
}

/**
 * Bandingkan jarak GPS aktual rit dengan zona alamat (US-M1-05 KP-6; dipakai FR-M12-07 bila tersedia). Hanya
 * penyimpangan untuk ditampilkan ke pemilik — TIDAK mengubah harga.
 */
export async function compareTripDistanceToZone(
  tx: Tx,
  input: { addressId: string; actualDistanceM: number; date: BusinessDate },
): Promise<{ addressZoneId: string | null; addressZoneCode: string | null; actualZoneId: string | null; actualZoneCode: string | null; deviates: boolean }> {
  const rows = await tx
    .select({ address: customerAddresses, tenantId: customers.tenantId })
    .from(customerAddresses)
    .innerJoin(customers, eq(customers.id, customerAddresses.customerId))
    .where(eq(customerAddresses.id, input.addressId))
    .limit(1);
  if (!rows[0]) throw new NotFoundError("Alamat kirim tidak ditemukan.");
  const table = await zoneTableAt(tx, rows[0].tenantId, input.date);
  const actual = table.find((z) => input.actualDistanceM >= z.minDistanceM && (z.maxDistanceM === null || input.actualDistanceM < z.maxDistanceM)) ?? null;
  const addrZone = table.find((z) => z.zoneId === rows[0]!.address.tariffZoneId) ?? null;
  return {
    addressZoneId: rows[0].address.tariffZoneId,
    addressZoneCode: addrZone?.code ?? null,
    actualZoneId: actual?.zoneId ?? null,
    actualZoneCode: actual?.code ?? null,
    deviates: (actual?.zoneId ?? null) !== rows[0].address.tariffZoneId,
  };
}

// =====================================================================================================================
// Usulan / penetapan harga (jalur baku 6.2a vs keputusan langsung pemilik 6.2b)
// =====================================================================================================================

type PriceMode = { ownerDirect: boolean };

async function priceMode(ctx: ActorContext, tx?: Tx): Promise<PriceMode> {
  await authorizeAny(ctx, ["m1.price.request", "m1.price.set"], { tx });
  return { ownerDirect: can(ctx, "m1.price.set") };
}

async function submitPriceChange(
  tx: Tx,
  ctx: ActorContext,
  input: { objectType: string; objectId: string; effectiveFrom: string; reason: string; amount: number | null; payload: Record<string, unknown> },
) {
  return approvals.submit(
    ctx,
    {
      type: "price_change",
      objectType: input.objectType,
      objectId: input.objectId,
      amount: input.amount,
      reason: input.reason,
      deadlineAt: wibToUtc(input.effectiveFrom, "00:00"),
      payload: { ...input.payload, effectiveFrom: input.effectiveFrom },
    },
    { tx },
  );
}

const zoneTariffSchema = z.object({
  zoneId: z.uuid({ error: "Pilih zona." }),
  segment: z.enum(enumValues("customer_segment")).nullable().optional(),
  pricePerTrip: zRupiahPositive,
  effectiveFrom: z.string().refine(isBusinessDate, { error: "Tanggal berlaku wajib (YYYY-MM-DD)." }),
  reason: z.string().trim().min(3, { error: "Alasan wajib diisi (minimal 3 karakter)." }),
});

export type PriceProposalResult = { id: string; status: "pending" | "active"; approvalId: string | null };

/** Tarif zona per rit baru (opsional per segmen) berlaku per tanggal (US-M1-05 KP-1, BR-19). */
export async function proposeZoneTariff(ctx: ActorContext, input: z.input<typeof zoneTariffSchema>, opts: { tx?: Tx } = {}): Promise<PriceProposalResult> {
  const mode = await priceMode(ctx, opts.tx);
  const data = parseInput(zoneTariffSchema, input, { pricePerTrip: "Tarif per rit", effectiveFrom: "Tanggal berlaku", reason: "Alasan" });
  assertEffectiveFrom(data.effectiveFrom, ctxBusinessDate(ctx), mode.ownerDirect);
  return runService(ctx, opts, async (tx) => {
    const zone = await loadZone(tx, ctx, data.zoneId);
    const segment = data.segment ?? null;
    const id = newId();
    let approvalId: string | null = null;
    if (mode.ownerDirect) {
      const same = await tx
        .select()
        .from(zoneTariffs)
        .where(and(eq(zoneTariffs.tariffZoneId, zone.id), eq(zoneTariffs.effectiveFrom, data.effectiveFrom), eq(zoneTariffs.status, "active")));
      for (const s of same.filter((r) => r.segment === segment)) {
        await tx.update(zoneTariffs).set({ status: "cancelled" }).where(eq(zoneTariffs.id, s.id));
        await auditRecord(tx, { ctx, objectType: "zone_tariff", objectId: s.id, action: "cancel", before: { status: "active" }, after: { status: "cancelled" }, reason: "Digantikan tarif baru pada tanggal berlaku yang sama." });
      }
    } else {
      const req = await submitPriceChange(tx, ctx, {
        objectType: "zone_tariff",
        objectId: id,
        effectiveFrom: data.effectiveFrom,
        reason: data.reason,
        amount: data.pricePerTrip,
        payload: { kind: "zone_tariff", zoneCode: zone.code, segment, pricePerTrip: data.pricePerTrip, link: "/master/zona" },
      });
      approvalId = req.id;
    }
    const [row] = await tx
      .insert(zoneTariffs)
      .values({
        id,
        tariffZoneId: zone.id,
        segment,
        pricePerTrip: data.pricePerTrip,
        effectiveFrom: data.effectiveFrom,
        status: mode.ownerDirect ? "active" : "pending",
        approvalRequestId: approvalId,
        isOwnerDirect: mode.ownerDirect,
        reason: data.reason,
        approvedBy: mode.ownerDirect ? ctx.userId : null,
        approvedAt: mode.ownerDirect ? ctx.now : null,
        createdBy: ctx.userId,
      })
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "zone_tariff",
      objectId: row!.id,
      action: mode.ownerDirect ? "set" : "submit",
      after: { zone: zone.code, segment, pricePerTrip: data.pricePerTrip, effectiveFrom: data.effectiveFrom, status: row!.status },
      reason: data.reason,
      rule: mode.ownerDirect ? "6.2b" : "6.2a",
    });
    if (mode.ownerDirect) {
      await notifyOwnerDirectPriceChange(
        tx,
        ctx,
        `Tarif ${zone.name}`,
        `${formatRupiah(data.pricePerTrip)}/rit${segment ? ` (segmen ${label("customer_segment", segment)})` : ""} berlaku ${data.effectiveFrom}. Alasan: ${data.reason}`,
        "/master/zona",
      );
    }
    return { id: row!.id, status: row!.status as "pending" | "active", approvalId };
  });
}

const fuelSchema = z.object({
  amountPerTrip: zRupiahPositive,
  effectiveFrom: z.string().refine(isBusinessDate, { error: "Tanggal berlaku wajib (YYYY-MM-DD)." }),
  reason: z.string().trim().min(3, { error: "Alasan wajib diisi (minimal 3 karakter)." }),
});

/** Komponen BBM per rit baru untuk seluruh zona (US-M1-02 KP-2, PTB-03). */
export async function proposeFuelComponent(ctx: ActorContext, input: z.input<typeof fuelSchema>, opts: { tx?: Tx } = {}): Promise<PriceProposalResult> {
  const mode = await priceMode(ctx, opts.tx);
  const data = parseInput(fuelSchema, input, { amountPerTrip: "Komponen BBM", effectiveFrom: "Tanggal berlaku", reason: "Alasan" });
  assertEffectiveFrom(data.effectiveFrom, ctxBusinessDate(ctx), mode.ownerDirect);
  return runService(ctx, opts, async (tx) => {
    const id = newId();
    let approvalId: string | null = null;
    if (mode.ownerDirect) {
      const same = await tx
        .select()
        .from(fuelComponents)
        .where(and(eq(fuelComponents.tenantId, ctx.tenantId), eq(fuelComponents.effectiveFrom, data.effectiveFrom), eq(fuelComponents.status, "active")));
      for (const s of same) {
        await tx.update(fuelComponents).set({ status: "cancelled" }).where(eq(fuelComponents.id, s.id));
        await auditRecord(tx, { ctx, objectType: "fuel_component", objectId: s.id, action: "cancel", before: { status: "active" }, after: { status: "cancelled" }, reason: "Digantikan komponen BBM baru pada tanggal berlaku yang sama." });
      }
    } else {
      const req = await submitPriceChange(tx, ctx, {
        objectType: "fuel_component",
        objectId: id,
        effectiveFrom: data.effectiveFrom,
        reason: data.reason,
        amount: data.amountPerTrip,
        payload: { kind: "fuel_component", amountPerTrip: data.amountPerTrip, link: "/master/produk#bbm" },
      });
      approvalId = req.id;
    }
    const [row] = await tx
      .insert(fuelComponents)
      .values({
        id,
        tenantId: ctx.tenantId,
        amountPerTrip: data.amountPerTrip,
        effectiveFrom: data.effectiveFrom,
        status: mode.ownerDirect ? "active" : "pending",
        approvalRequestId: approvalId,
        isOwnerDirect: mode.ownerDirect,
        reason: data.reason,
        approvedBy: mode.ownerDirect ? ctx.userId : null,
        approvedAt: mode.ownerDirect ? ctx.now : null,
        createdBy: ctx.userId,
      })
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "fuel_component",
      objectId: row!.id,
      action: mode.ownerDirect ? "set" : "submit",
      after: { amountPerTrip: data.amountPerTrip, effectiveFrom: data.effectiveFrom, status: row!.status },
      reason: data.reason,
      rule: mode.ownerDirect ? "6.2b" : "6.2a",
    });
    if (mode.ownerDirect) {
      await notifyOwnerDirectPriceChange(tx, ctx, "Komponen BBM", `${formatRupiah(data.amountPerTrip)}/rit berlaku ${data.effectiveFrom}. Alasan: ${data.reason}`, "/master/produk#bbm");
    }
    return { id: row!.id, status: row!.status as "pending" | "active", approvalId };
  });
}

const productPriceSchema = z.object({
  productId: z.uuid({ error: "Pilih produk." }),
  kind: z.enum(enumValues("price_kind")),
  outletId: z.uuid().nullable().optional(),
  price: zRupiahPositive,
  recommendedPrice: zRupiahPositive.nullable().optional(),
  effectiveFrom: z.string().refine(isBusinessDate, { error: "Tanggal berlaku wajib (YYYY-MM-DD)." }),
  reason: z.string().trim().min(3, { error: "Alasan wajib diisi (minimal 3 karakter)." }),
});

/** Harga produk depot (standar) / toko (umum & mitra) berlaku per tanggal (US-M1-02 KP-1/KP-3, BR-15). */
export async function proposeProductPrice(ctx: ActorContext, input: z.input<typeof productPriceSchema>, opts: { tx?: Tx } = {}): Promise<PriceProposalResult> {
  const mode = await priceMode(ctx, opts.tx);
  const data = parseInput(productPriceSchema, input, { price: "Harga", effectiveFrom: "Tanggal berlaku", reason: "Alasan" });
  assertEffectiveFrom(data.effectiveFrom, ctxBusinessDate(ctx), mode.ownerDirect);
  return runService(ctx, opts, async (tx) => {
    const product = await loadProduct(tx, ctx, data.productId);
    if (product.line === "truck_water") {
      throw new DomainError("TRUCK_WATER_PRICE", "Harga air truk berasal dari tarif zona + komponen BBM (BR-19); ubah di Zona tarif / Komponen BBM.");
    }
    if (product.line === "depot" && data.kind !== "standard") throw ValidationError.field("kind", "Produk depot memakai harga standar.");
    if (product.line === "store" && data.kind === "standard") throw ValidationError.field("kind", "Barang toko memakai harga umum atau harga mitra.");
    if (product.status === "inactive") throw new DomainError("PRODUCT_INACTIVE", "Produk nonaktif — aktifkan dulu sebelum menetapkan harga.");
    const outletId = data.outletId ?? null;
    if (outletId) {
      const o = await tx.select({ tenantId: outlets.tenantId }).from(outlets).where(eq(outlets.id, outletId)).limit(1);
      if (!o[0] || o[0].tenantId !== product.tenantId) throw ValidationError.field("outletId", "Outlet tidak dikenal untuk tenant produk ini.");
    }
    const id = newId();
    let approvalId: string | null = null;
    if (mode.ownerDirect) {
      const same = await tx
        .select()
        .from(productPrices)
        .where(and(eq(productPrices.productId, product.id), eq(productPrices.kind, data.kind), eq(productPrices.effectiveFrom, data.effectiveFrom), eq(productPrices.status, "active")));
      for (const s of same.filter((r) => r.outletId === outletId)) {
        await tx.update(productPrices).set({ status: "cancelled" }).where(eq(productPrices.id, s.id));
        await auditRecord(tx, { ctx, objectType: "product_price", objectId: s.id, action: "cancel", before: { status: "active" }, after: { status: "cancelled" }, reason: "Digantikan harga baru pada tanggal berlaku yang sama." });
      }
    } else {
      const req = await submitPriceChange(tx, ctx, {
        objectType: "product_price",
        objectId: id,
        effectiveFrom: data.effectiveFrom,
        reason: data.reason,
        amount: data.price,
        payload: { kind: "product_price", productCode: product.code, productName: product.name, priceKind: data.kind, price: data.price, link: "/master/produk" },
      });
      approvalId = req.id;
    }
    const [row] = await tx
      .insert(productPrices)
      .values({
        id,
        tenantId: product.tenantId,
        productId: product.id,
        kind: data.kind,
        outletId,
        price: data.price,
        recommendedPrice: data.recommendedPrice ?? null,
        effectiveFrom: data.effectiveFrom,
        status: mode.ownerDirect ? "active" : "pending",
        approvalRequestId: approvalId,
        isOwnerDirect: mode.ownerDirect,
        reason: data.reason,
        approvedBy: mode.ownerDirect ? ctx.userId : null,
        approvedAt: mode.ownerDirect ? ctx.now : null,
        createdBy: ctx.userId,
      })
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "product_price",
      objectId: row!.id,
      action: mode.ownerDirect ? "set" : "submit",
      after: { product: product.code, kind: data.kind, outletId, price: data.price, effectiveFrom: data.effectiveFrom, status: row!.status },
      reason: data.reason,
      rule: mode.ownerDirect ? "6.2b" : "6.2a",
    });
    if (mode.ownerDirect) {
      await notifyOwnerDirectPriceChange(
        tx,
        ctx,
        `Harga ${product.name}`,
        `${label("price_kind", data.kind)} ${formatRupiah(data.price)} berlaku ${data.effectiveFrom}. Alasan: ${data.reason}`,
        "/master/produk",
      );
    }
    return { id: row!.id, status: row!.status as "pending" | "active", approvalId };
  });
}

// =====================================================================================================================
// Penerapan keputusan persetujuan `price_change`
// =====================================================================================================================

const PRICE_OBJECT_TYPES = new Set(["zone_tariff", "fuel_component", "product_price"]);

/** Aktifkan harga/tarif/BBM yang disetujui (menggantikan baris aktif bertanggal berlaku sama). */
export async function activatePriceRow(tx: Tx, ctx: ActorContext, objectType: string, id: string): Promise<boolean> {
  if (!PRICE_OBJECT_TYPES.has(objectType)) return false;
  if (objectType === "zone_tariff") {
    const [row] = await tx.select().from(zoneTariffs).where(eq(zoneTariffs.id, id));
    if (!row || row.status !== "pending") return false;
    const same = await tx
      .select()
      .from(zoneTariffs)
      .where(and(eq(zoneTariffs.tariffZoneId, row.tariffZoneId), eq(zoneTariffs.effectiveFrom, row.effectiveFrom), eq(zoneTariffs.status, "active")));
    for (const s of same.filter((r) => r.segment === row.segment)) await tx.update(zoneTariffs).set({ status: "cancelled" }).where(eq(zoneTariffs.id, s.id));
    await tx.update(zoneTariffs).set({ status: "active", approvedBy: ctx.userId, approvedAt: ctx.now }).where(eq(zoneTariffs.id, id));
  } else if (objectType === "fuel_component") {
    const [row] = await tx.select().from(fuelComponents).where(eq(fuelComponents.id, id));
    if (!row || row.status !== "pending") return false;
    const same = await tx
      .select()
      .from(fuelComponents)
      .where(and(eq(fuelComponents.tenantId, row.tenantId), eq(fuelComponents.effectiveFrom, row.effectiveFrom), eq(fuelComponents.status, "active")));
    for (const s of same) await tx.update(fuelComponents).set({ status: "cancelled" }).where(eq(fuelComponents.id, s.id));
    await tx.update(fuelComponents).set({ status: "active", approvedBy: ctx.userId, approvedAt: ctx.now }).where(eq(fuelComponents.id, id));
  } else {
    const [row] = await tx.select().from(productPrices).where(eq(productPrices.id, id));
    if (!row || row.status !== "pending") return false;
    const same = await tx
      .select()
      .from(productPrices)
      .where(and(eq(productPrices.productId, row.productId), eq(productPrices.kind, row.kind), eq(productPrices.effectiveFrom, row.effectiveFrom), eq(productPrices.status, "active")));
    for (const s of same.filter((r) => r.outletId === row.outletId)) await tx.update(productPrices).set({ status: "cancelled" }).where(eq(productPrices.id, s.id));
    await tx.update(productPrices).set({ status: "active", approvedBy: ctx.userId, approvedAt: ctx.now }).where(eq(productPrices.id, id));
  }
  await auditRecord(tx, { ctx, objectType, objectId: id, action: "approve", before: { status: "pending" }, after: { status: "active" }, rule: "6.2a" });
  return true;
}

/** Tutup usulan harga yang ditolak (`rejected`) atau lewat tenggat (`cancelled` — harga lama tetap berlaku). */
export async function closePriceRow(tx: Tx, ctx: ActorContext, objectType: string, id: string, status: "rejected" | "cancelled", reason: string | null): Promise<boolean> {
  let res: { id: string }[];
  if (objectType === "zone_tariff") {
    res = await tx.update(zoneTariffs).set({ status }).where(and(eq(zoneTariffs.id, id), eq(zoneTariffs.status, "pending"))).returning({ id: zoneTariffs.id });
  } else if (objectType === "fuel_component") {
    res = await tx.update(fuelComponents).set({ status }).where(and(eq(fuelComponents.id, id), eq(fuelComponents.status, "pending"))).returning({ id: fuelComponents.id });
  } else if (objectType === "product_price") {
    res = await tx.update(productPrices).set({ status }).where(and(eq(productPrices.id, id), eq(productPrices.status, "pending"))).returning({ id: productPrices.id });
  } else {
    return false;
  }
  if (res.length === 0) return false;
  await auditRecord(tx, {
    ctx,
    objectType,
    objectId: id,
    action: status === "rejected" ? "reject" : "expire",
    before: { status: "pending" },
    after: { status },
    reason: reason ?? (status === "cancelled" ? "Lewat tenggat sebelum tanggal berlaku — harga lama tetap berlaku." : null),
    rule: "6.2a",
  });
  return true;
}

// =====================================================================================================================
// Riwayat harga (katalog 7.9.4 "Riwayat harga")
// =====================================================================================================================

export type PriceHistoryRow = {
  id: string;
  kind: "zone_tariff" | "fuel_component" | "product_price" | "special_price";
  kindLabel: string;
  subject: string;
  detail: string;
  price: number;
  effectiveFrom: string;
  status: string;
  ownerDirect: boolean;
  reason: string | null;
  createdAt: Date;
};

/** Riwayat seluruh harga (tarif zona, BBM, produk, harga khusus) — tidak dapat dihapus. */
export async function priceHistory(tx: Tx, tenantId: string, filter: { productId?: string; customerId?: string; limit?: number } = {}): Promise<PriceHistoryRow[]> {
  const out: PriceHistoryRow[] = [];
  if (!filter.productId && !filter.customerId) {
    const zt = await tx
      .select({ t: zoneTariffs, code: tariffZones.code, name: tariffZones.name })
      .from(zoneTariffs)
      .innerJoin(tariffZones, eq(tariffZones.id, zoneTariffs.tariffZoneId))
      .where(eq(tariffZones.tenantId, tenantId));
    for (const r of zt) {
      out.push({
        id: r.t.id,
        kind: "zone_tariff",
        kindLabel: "Tarif zona",
        subject: r.name,
        detail: r.t.segment ? `Segmen ${label("customer_segment", r.t.segment)}` : "Semua segmen",
        price: r.t.pricePerTrip,
        effectiveFrom: r.t.effectiveFrom,
        status: r.t.status,
        ownerDirect: r.t.isOwnerDirect,
        reason: r.t.reason,
        createdAt: r.t.createdAt,
      });
    }
    const fc = await tx.select().from(fuelComponents).where(eq(fuelComponents.tenantId, tenantId));
    for (const r of fc) {
      out.push({
        id: r.id,
        kind: "fuel_component",
        kindLabel: "Komponen BBM",
        subject: "Komponen BBM per rit",
        detail: "Seluruh zona",
        price: r.amountPerTrip,
        effectiveFrom: r.effectiveFrom,
        status: r.status,
        ownerDirect: r.isOwnerDirect,
        reason: r.reason,
        createdAt: r.createdAt,
      });
    }
  }
  if (!filter.customerId) {
    const conds = [eq(productPrices.tenantId, tenantId)];
    if (filter.productId) conds.push(eq(productPrices.productId, filter.productId));
    const pp = await tx
      .select({ p: productPrices, name: products.name, outletName: outlets.name })
      .from(productPrices)
      .innerJoin(products, eq(products.id, productPrices.productId))
      .leftJoin(outlets, eq(outlets.id, productPrices.outletId))
      .where(and(...conds));
    for (const r of pp) {
      out.push({
        id: r.p.id,
        kind: "product_price",
        kindLabel: label("price_kind", r.p.kind),
        subject: r.name,
        detail: r.outletName ? `Khusus ${r.outletName}` : "Semua outlet",
        price: r.p.price,
        effectiveFrom: r.p.effectiveFrom,
        status: r.p.status,
        ownerDirect: r.p.isOwnerDirect,
        reason: r.p.reason,
        createdAt: r.p.createdAt,
      });
    }
  }
  const spConds = [eq(customers.tenantId, tenantId)];
  if (filter.customerId) spConds.push(eq(specialPrices.customerId, filter.customerId));
  if (filter.productId) spConds.push(eq(specialPrices.productId, filter.productId));
  const sp = await tx
    .select({ s: specialPrices, customerName: customers.name, productName: products.name })
    .from(specialPrices)
    .innerJoin(customers, eq(customers.id, specialPrices.customerId))
    .innerJoin(products, eq(products.id, specialPrices.productId))
    .where(and(...spConds));
  for (const r of sp) {
    out.push({
      id: r.s.id,
      kind: "special_price",
      kindLabel: "Harga khusus",
      subject: r.customerName,
      detail: `${r.productName}; tinjauan ${r.s.reviewDate}${r.s.validUntil ? `; s.d. ${r.s.validUntil}` : ""}`,
      price: r.s.price,
      effectiveFrom: r.s.validFrom,
      status: r.s.status,
      ownerDirect: r.s.isOwnerDirect,
      reason: r.s.reason,
      createdAt: r.s.createdAt,
    });
  }
  out.sort((a, b) => (a.effectiveFrom === b.effectiveFrom ? b.createdAt.getTime() - a.createdAt.getTime() : b.effectiveFrom.localeCompare(a.effectiveFrom)));
  return filter.limit ? out.slice(0, filter.limit) : out;
}
