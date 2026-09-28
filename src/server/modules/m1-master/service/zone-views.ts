/**
 * M1 — tampilan zona tarif: ringkasan tabel & tarif, usulan menunggu, simulasi harga zona baru vs harga berlaku per
 * pelanggan (US-M1-05 KP-5, K23, R14) dan daftar alamat yang berpindah zona (KP-4). Dapat diekspor (katalog 7.9.4).
 */
import "server-only";

import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";

import {
  approvalRequests,
  customerAddresses,
  customerLegacyPrices,
  customers,
  fuelComponents,
  tariffZoneBoundaries,
  tariffZones,
  zoneTariffs,
} from "@/db/schema";
import { enumValues, type CustomerSegment } from "@/lib/labels";
import { addDays, type BusinessDate } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { getDb } from "@/server/core/db";
import { authorize } from "@/server/core/rbac";

import { getActiveSpecialPrice, getFuelComponent, getZoneTariff } from "./pricing";
import { truckWaterProduct } from "./common";
import { diffZoneTables, proposedZoneTable, zoneForMeters, zoneTableAt, type MovedAddress, type ZoneTableEntry } from "./zones";

export type ZoneOverview = {
  date: string;
  table: (ZoneTableEntry & { tariffs: { segment: CustomerSegment | null; pricePerTrip: number; effectiveFrom: string }[]; addressCount: number })[];
  fuel: { amountPerTrip: number; effectiveFrom: string } | null;
  pendingTables: { approvalId: string; number: string; effectiveFrom: string; reason: string; zones: { code: string; minDistanceM: number; maxDistanceM: number | null }[] }[];
  pendingTariffs: { id: string; zoneCode: string; segment: CustomerSegment | null; pricePerTrip: number; effectiveFrom: string; reason: string | null; approvalNumber: string | null }[];
  upcomingTables: { effectiveFrom: string; zones: { code: string; minDistanceM: number; maxDistanceM: number | null }[] }[];
  zonesForSelect: { value: string; label: string }[];
};

/** Ringkasan tabel zona berlaku + tarif per segmen + usulan menunggu persetujuan. */
export async function getZoneOverview(ctx: ActorContext, opts: { tx?: Tx; date?: BusinessDate } = {}): Promise<ZoneOverview> {
  await authorize(ctx, "m1.tariff_zone.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const date = opts.date ?? ctxBusinessDate(ctx);
  const table = await zoneTableAt(tx, ctx.tenantId, date);
  const counts = await tx
    .select({ zoneId: customerAddresses.tariffZoneId, id: customerAddresses.id })
    .from(customerAddresses)
    .innerJoin(customers, eq(customers.id, customerAddresses.customerId))
    .where(and(eq(customers.tenantId, ctx.tenantId), eq(customerAddresses.isActive, true), eq(customers.isActive, true)));
  const withTariffs: ZoneOverview["table"] = [];
  for (const z of table) {
    const tariffs: ZoneOverview["table"][number]["tariffs"] = [];
    for (const seg of [null, ...enumValues("customer_segment")] as (CustomerSegment | null)[]) {
      const t = await getZoneTariff(tx, z.zoneId, seg, date);
      if (t && t.segment === seg) tariffs.push({ segment: seg, pricePerTrip: t.pricePerTrip, effectiveFrom: t.effectiveFrom });
    }
    withTariffs.push({ ...z, tariffs, addressCount: counts.filter((c) => c.zoneId === z.zoneId).length });
  }
  const fuel = await getFuelComponent(tx, ctx.tenantId, date);

  const pendingRows = await tx
    .select({ b: tariffZoneBoundaries, code: tariffZones.code, number: approvalRequests.number, reason: approvalRequests.reason })
    .from(tariffZoneBoundaries)
    .innerJoin(tariffZones, eq(tariffZones.id, tariffZoneBoundaries.tariffZoneId))
    .innerJoin(approvalRequests, eq(approvalRequests.id, tariffZoneBoundaries.approvalRequestId))
    .where(and(eq(tariffZones.tenantId, ctx.tenantId), eq(tariffZoneBoundaries.status, "pending")))
    .orderBy(asc(tariffZoneBoundaries.minDistanceM));
  const pendingTables = new Map<string, ZoneOverview["pendingTables"][number]>();
  for (const r of pendingRows) {
    const key = r.b.approvalRequestId!;
    const entry = pendingTables.get(key) ?? { approvalId: key, number: r.number, effectiveFrom: r.b.effectiveFrom, reason: r.reason, zones: [] };
    entry.zones.push({ code: r.code, minDistanceM: r.b.minDistanceM, maxDistanceM: r.b.maxDistanceM });
    pendingTables.set(key, entry);
  }
  const pendingTariffRows = await tx
    .select({ t: zoneTariffs, code: tariffZones.code, number: approvalRequests.number })
    .from(zoneTariffs)
    .innerJoin(tariffZones, eq(tariffZones.id, zoneTariffs.tariffZoneId))
    .leftJoin(approvalRequests, eq(approvalRequests.id, zoneTariffs.approvalRequestId))
    .where(and(eq(tariffZones.tenantId, ctx.tenantId), eq(zoneTariffs.status, "pending")))
    .orderBy(desc(zoneTariffs.createdAt));
  const futureRows = await tx
    .select({ b: tariffZoneBoundaries, code: tariffZones.code })
    .from(tariffZoneBoundaries)
    .innerJoin(tariffZones, eq(tariffZones.id, tariffZoneBoundaries.tariffZoneId))
    .where(and(eq(tariffZones.tenantId, ctx.tenantId), eq(tariffZoneBoundaries.status, "active")))
    .orderBy(asc(tariffZoneBoundaries.effectiveFrom), asc(tariffZoneBoundaries.minDistanceM));
  const upcoming = new Map<string, ZoneOverview["upcomingTables"][number]>();
  for (const r of futureRows.filter((x) => x.b.effectiveFrom > date)) {
    const e = upcoming.get(r.b.effectiveFrom) ?? { effectiveFrom: r.b.effectiveFrom, zones: [] };
    e.zones.push({ code: r.code, minDistanceM: r.b.minDistanceM, maxDistanceM: r.b.maxDistanceM });
    upcoming.set(r.b.effectiveFrom, e);
  }
  const allZones = await tx.select().from(tariffZones).where(and(eq(tariffZones.tenantId, ctx.tenantId), eq(tariffZones.isActive, true))).orderBy(asc(tariffZones.sortOrder));
  return {
    date,
    table: withTariffs,
    fuel: fuel ? { amountPerTrip: fuel.amountPerTrip, effectiveFrom: fuel.effectiveFrom } : null,
    pendingTables: [...pendingTables.values()],
    pendingTariffs: pendingTariffRows.map((r) => ({ id: r.t.id, zoneCode: r.code, segment: r.t.segment, pricePerTrip: r.t.pricePerTrip, effectiveFrom: r.t.effectiveFrom, reason: r.t.reason, approvalNumber: r.number })),
    upcomingTables: [...upcoming.values()],
    zonesForSelect: allZones.map((z) => ({ value: z.id, label: `${z.code} — ${z.name}` })),
  };
}

/**
 * Alamat yang berpindah zona akibat perubahan batas (US-M1-05 KP-4): untuk usulan persetujuan tertentu, untuk tabel
 * yang akan berlaku pada `effectiveFrom`, atau (bawaan) perubahan terakhir yang sudah berlaku.
 */
export async function listZoneMoves(ctx: ActorContext, input: { approvalId?: string; effectiveFrom?: string } = {}, opts: { tx?: Tx } = {}): Promise<{ effectiveFrom: string | null; moves: MovedAddress[] }> {
  await authorize(ctx, "m1.tariff_zone.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  if (input.approvalId) {
    const p = await proposedZoneTable(tx, ctx.tenantId, input.approvalId);
    if (!p) return { effectiveFrom: null, moves: [] };
    return { effectiveFrom: p.effectiveFrom, moves: await diffZoneTables(tx, ctx.tenantId, p.before, p.after) };
  }
  let effectiveFrom = input.effectiveFrom ?? null;
  if (!effectiveFrom) {
    const today = ctxBusinessDate(ctx);
    const rows = await tx
      .select({ effectiveFrom: tariffZoneBoundaries.effectiveFrom })
      .from(tariffZoneBoundaries)
      .innerJoin(tariffZones, eq(tariffZones.id, tariffZoneBoundaries.tariffZoneId))
      .where(and(eq(tariffZones.tenantId, ctx.tenantId), eq(tariffZoneBoundaries.status, "active")))
      .orderBy(desc(tariffZoneBoundaries.effectiveFrom));
    effectiveFrom = rows.find((r) => r.effectiveFrom <= today)?.effectiveFrom ?? null;
    const upcoming = rows.filter((r) => r.effectiveFrom > today).at(-1);
    if (upcoming) effectiveFrom = upcoming.effectiveFrom;
  }
  if (!effectiveFrom) return { effectiveFrom: null, moves: [] };
  const before = await zoneTableAt(tx, ctx.tenantId, addDays(effectiveFrom, -1));
  const after = await zoneTableAt(tx, ctx.tenantId, effectiveFrom);
  if (before.length === 0) return { effectiveFrom, moves: [] };
  return { effectiveFrom, moves: await diffZoneTables(tx, ctx.tenantId, before, after) };
}

export type ZoneSimulationRow = {
  customerId: string;
  customerCode: string | null;
  customerName: string;
  segment: CustomerSegment;
  addressId: string;
  addressLabel: string;
  distanceM: number | null;
  currentZoneCode: string | null;
  newZoneCode: string | null;
  /** Harga berlaku sebelum sistem (impor data awal, US-M1-06 KP-1) — null bila tidak diimpor. */
  legacyPrice: number | null;
  /** Harga master berlaku hari ini (tarif zona + BBM, atau harga khusus). */
  currentPrice: number | null;
  /** Harga menurut zona/tarif baru (usulan atau yang akan berlaku). */
  newPrice: number | null;
  /** newPrice − legacyPrice (atau − currentPrice bila tidak ada harga impor). */
  difference: number | null;
  differencePct: number | null;
  hasSpecialPrice: boolean;
};

/**
 * Simulasi harga zona baru vs harga yang berlaku per pelanggan (US-M1-05 KP-5): tabel zona & tarif pada tanggal
 * `date` (bawaan: usulan menunggu persetujuan `approvalId`, atau tanggal hari ini) dibandingkan dengan harga impor
 * data awal (K23 "diturunkan dari harga yang berlaku hari ini") dan harga master hari ini.
 */
export async function simulateZonePricing(ctx: ActorContext, input: { approvalId?: string; date?: BusinessDate; includePendingTariffs?: boolean } = {}, opts: { tx?: Tx } = {}): Promise<{ date: string; rows: ZoneSimulationRow[] }> {
  await authorize(ctx, "m1.tariff_zone.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  let newTable: ZoneTableEntry[];
  let date = input.date ?? today;
  if (input.approvalId) {
    const p = await proposedZoneTable(tx, ctx.tenantId, input.approvalId);
    newTable = p ? p.after : await zoneTableAt(tx, ctx.tenantId, date);
    if (p) date = p.effectiveFrom;
  } else {
    newTable = await zoneTableAt(tx, ctx.tenantId, date);
  }
  const currentTable = await zoneTableAt(tx, ctx.tenantId, today);
  const product = await truckWaterProduct(tx, ctx.tenantId);
  const fuelNow = await getFuelComponent(tx, ctx.tenantId, today);
  const fuelNew = await getFuelComponent(tx, ctx.tenantId, date);
  const pendingTariffs = input.includePendingTariffs !== false
    ? await tx
        .select({ t: zoneTariffs })
        .from(zoneTariffs)
        .innerJoin(tariffZones, eq(tariffZones.id, zoneTariffs.tariffZoneId))
        .where(and(eq(tariffZones.tenantId, ctx.tenantId), eq(zoneTariffs.status, "pending")))
    : [];
  const pendingFuel = input.includePendingTariffs !== false
    ? (await tx.select().from(fuelComponents).where(and(eq(fuelComponents.tenantId, ctx.tenantId), eq(fuelComponents.status, "pending"))).orderBy(desc(fuelComponents.createdAt)).limit(1))[0]
    : undefined;

  const rows = await tx
    .select({ a: customerAddresses, c: customers })
    .from(customerAddresses)
    .innerJoin(customers, eq(customers.id, customerAddresses.customerId))
    .where(and(eq(customers.tenantId, ctx.tenantId), eq(customers.isActive, true), isNull(customers.internalOutletId), eq(customerAddresses.isActive, true)))
    .orderBy(asc(customers.name), asc(customerAddresses.createdAt));
  const legacy = rows.length
    ? await tx
        .select()
        .from(customerLegacyPrices)
        .where(and(inArray(customerLegacyPrices.customerId, [...new Set(rows.map((r) => r.c.id))]), eq(customerLegacyPrices.isCurrent, true)))
    : [];

  const tariffCache = new Map<string, number | null>();
  async function tariffFor(zoneId: string | null, segment: CustomerSegment, onDate: string, usePending: boolean): Promise<number | null> {
    if (!zoneId) return null;
    const key = `${zoneId}|${segment}|${onDate}|${usePending}`;
    if (tariffCache.has(key)) return tariffCache.get(key)!;
    let price = (await getZoneTariff(tx, zoneId, segment, onDate))?.pricePerTrip ?? null;
    if (usePending) {
      const pend = pendingTariffs.map((p) => p.t).filter((t) => t.tariffZoneId === zoneId && (t.segment === segment || t.segment === null));
      const pick = pend.find((t) => t.segment === segment) ?? pend.find((t) => t.segment === null);
      if (pick) price = pick.pricePerTrip;
    }
    tariffCache.set(key, price);
    return price;
  }

  const out: ZoneSimulationRow[] = [];
  for (const { a, c } of rows) {
    const special = await getActiveSpecialPrice(tx, c.id, product.id, today);
    const currentZone = a.zoneAssignment === "manual" ? (currentTable.find((z) => z.zoneId === a.tariffZoneId) ?? null) : a.distanceM !== null ? zoneForMeters(currentTable, a.distanceM) : (currentTable.find((z) => z.zoneId === a.tariffZoneId) ?? null);
    const newZone = a.zoneAssignment === "manual" ? (newTable.find((z) => z.zoneId === a.tariffZoneId) ?? currentZone) : a.distanceM !== null ? zoneForMeters(newTable, a.distanceM) : currentZone;
    const currentTariff = await tariffFor(currentZone?.zoneId ?? null, c.segment, today, false);
    const newTariff = await tariffFor(newZone?.zoneId ?? null, c.segment, date, true);
    const fuelCurrent = fuelNow?.amountPerTrip ?? 0;
    const fuelFuture = pendingFuel?.amountPerTrip ?? fuelNew?.amountPerTrip ?? fuelCurrent;
    const currentPrice = special ? special.price : currentTariff !== null ? currentTariff + fuelCurrent : null;
    const newPrice = newTariff !== null ? newTariff + fuelFuture : null;
    const legacyRow = legacy.find((l) => l.customerId === c.id && l.addressId === a.id) ?? legacy.find((l) => l.customerId === c.id && l.addressId === null);
    const legacyPrice = legacyRow?.pricePerTrip ?? null;
    const base = legacyPrice ?? currentPrice;
    const difference = newPrice !== null && base !== null ? newPrice - base : null;
    out.push({
      customerId: c.id,
      customerCode: c.code,
      customerName: c.name,
      segment: c.segment,
      addressId: a.id,
      addressLabel: a.label,
      distanceM: a.distanceM,
      currentZoneCode: currentZone?.code ?? null,
      newZoneCode: newZone?.code ?? null,
      legacyPrice,
      currentPrice,
      newPrice,
      difference,
      differencePct: difference !== null && base ? Math.round((difference / base) * 1000) / 10 : null,
      hasSpecialPrice: Boolean(special),
    });
  }
  return { date, rows: out };
}
