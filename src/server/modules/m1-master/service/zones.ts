/**
 * M1 — zona tarif & pemetaan alamat (US-M1-05; BR-19, K23, A13, PTB-02).
 *
 * - Batas zona berversi per tanggal berlaku (`tariff_zone_boundaries`); tabel zona pada tanggal D = batas aktif terbaru
 *   (effective_from ≤ D) per zona. Tidak tumpang tindih & tanpa celah (validasi `validateZoneTable`).
 * - Perubahan tabel zona: jalur baku Admin Keuangan → persetujuan pemilik (`price_change`, tenggat = sebelum tanggal
 *   berlaku, lewat tenggat → batas lama tetap); pemilik sendiri = keputusan langsung 6.2b (berjejak + notifikasi
 *   Admin Keuangan & Dispatcher). Saat berlaku: salinan batas di `tariff_zones` diperbarui dan alamat berzona
 *   Otomatis dipetakan ulang (daftar "alamat berpindah zona" untuk ditinjau pemilik, KP-4). Harga pesanan yang sudah
 *   dibuat tidak berubah (harga terkunci di pesanan, US-M1-02 KP-4).
 * - Jarak dari sumber air acuan (bawaan terdekat; dapat diubah Dispatcher beralasan) lewat `RoutingProvider` dengan
 *   cadangan garis lurus × 1,3 (KP-2, NFR-24).
 */
import "server-only";

import { and, asc, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";

import {
  customerAddresses,
  customers,
  tariffZoneBoundaries,
  tariffZones,
  waterSources,
} from "@/db/schema";
import { newId } from "@/lib/ids";
import type { LatLng } from "@/lib/geo";
import { isValidLatLng } from "@/lib/geo";
import { addDays, isBusinessDate, toBusinessDate, wibToUtc, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, EQUA_TENANT_ID, systemContext, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { routeDistance, validateZoneTable, zoneForDistance, type RoutingProvider } from "@/server/core/maps";
import { notify } from "@/server/core/notifications";
import { authorizeAny, can, runService } from "@/server/core/rbac";

import { assertEffectiveFrom } from "./common";

export type ZoneTableEntry = {
  zoneId: string;
  code: string;
  name: string;
  sortOrder: number;
  boundaryId: string;
  minDistanceM: number;
  maxDistanceM: number | null;
  effectiveFrom: string;
};

/** Tabel zona yang berlaku pada tanggal `date` (satu batas aktif terbaru per zona aktif). */
export async function zoneTableAt(tx: Tx, tenantId: string, date: BusinessDate): Promise<ZoneTableEntry[]> {
  const rows = await tx
    .select({
      zoneId: tariffZones.id,
      code: tariffZones.code,
      name: tariffZones.name,
      sortOrder: tariffZones.sortOrder,
      boundaryId: tariffZoneBoundaries.id,
      minDistanceM: tariffZoneBoundaries.minDistanceM,
      maxDistanceM: tariffZoneBoundaries.maxDistanceM,
      effectiveFrom: tariffZoneBoundaries.effectiveFrom,
    })
    .from(tariffZoneBoundaries)
    .innerJoin(tariffZones, eq(tariffZones.id, tariffZoneBoundaries.tariffZoneId))
    .where(
      and(
        eq(tariffZones.tenantId, tenantId),
        eq(tariffZones.isActive, true),
        eq(tariffZoneBoundaries.status, "active"),
        lte(tariffZoneBoundaries.effectiveFrom, date),
      ),
    )
    .orderBy(asc(tariffZones.id), desc(tariffZoneBoundaries.effectiveFrom), desc(tariffZoneBoundaries.createdAt));
  const latest = new Map<string, ZoneTableEntry>();
  for (const r of rows) if (!latest.has(r.zoneId)) latest.set(r.zoneId, r);
  return [...latest.values()].sort((a, b) => a.minDistanceM - b.minDistanceM);
}

/** Zona untuk jarak (meter) menurut tabel zona. */
export function zoneForMeters(table: readonly ZoneTableEntry[], distanceM: number): ZoneTableEntry | null {
  const bands = table.map((z) => ({ ...z, id: z.zoneId }));
  return zoneForDistance(bands, distanceM / 1000);
}

export type ZoneMapping = {
  referenceWaterSourceId: string;
  referenceWaterSourceName: string;
  distanceM: number;
  distanceMethod: "route" | "straight_line_x1_3";
  /** Benar bila jarak memakai cadangan garis lurus karena layanan peta tidak tersedia (7.1.6: hitung ulang). */
  estimated: boolean;
  zoneId: string | null;
  zoneCode: string | null;
  zoneBoundaryId: string | null;
};

let providerOverride: RoutingProvider | null = null;
/** Ganti penyedia rute (uji). `null` = penyedia bawaan dari env. */
export function setRoutingProviderForTests(provider: RoutingProvider | null): void {
  providerOverride = provider;
}

/**
 * Petakan koordinat ke zona tarif (US-M1-05 KP-2/KP-3): sumber air acuan = terdekat (atau `referenceWaterSourceId`
 * yang ditetapkan Dispatcher), jarak lewat `RoutingProvider` dengan cadangan garis lurus × 1,3 (PTB-02).
 */
export async function mapAddressToZone(
  tx: Tx,
  input: LatLng & { tenantId?: string; date?: BusinessDate; referenceWaterSourceId?: string | null; provider?: RoutingProvider },
): Promise<ZoneMapping> {
  const point = { lat: input.lat, lng: input.lng };
  if (!isValidLatLng(point)) throw ValidationError.field("lat", "Koordinat tidak valid. Pilih titik di peta.");
  const tenantId = input.tenantId ?? EQUA_TENANT_ID;
  const date = input.date ?? toBusinessDate(new Date());
  const conds = [eq(waterSources.tenantId, tenantId), eq(waterSources.isActive, true)];
  if (input.referenceWaterSourceId) conds.push(eq(waterSources.id, input.referenceWaterSourceId));
  const sources = await tx.select().from(waterSources).where(and(...conds));
  if (sources.length === 0) {
    throw new DomainError(
      "NO_WATER_SOURCE",
      input.referenceWaterSourceId
        ? "Sumber air acuan tidak ditemukan atau nonaktif. Pilih sumber air lain."
        : "Belum ada sumber air aktif untuk menghitung jarak. Lengkapi Data master > Sumber air.",
    );
  }
  const provider = input.provider ?? providerOverride ?? undefined;
  let best: { source: (typeof sources)[number]; meters: number; method: "route" | "straight_line_x1_3"; estimated: boolean } | null = null;
  for (const source of sources) {
    const d = await routeDistance(point, { lat: source.lat, lng: source.lng }, provider);
    if (!best || d.meters < best.meters) best = { source, meters: d.meters, method: d.method, estimated: d.estimated };
  }
  const table = await zoneTableAt(tx, tenantId, date);
  const zone = zoneForMeters(table, best!.meters);
  return {
    referenceWaterSourceId: best!.source.id,
    referenceWaterSourceName: best!.source.name,
    distanceM: best!.meters,
    distanceMethod: best!.method,
    estimated: best!.estimated,
    zoneId: zone?.zoneId ?? null,
    zoneCode: zone?.code ?? null,
    zoneBoundaryId: zone?.boundaryId ?? null,
  };
}

/** Kolom alamat hasil pemetaan otomatis (zona Otomatis). */
export function autoZoneColumns(mapping: ZoneMapping, now: Date, manualSource: boolean, sourceReason: string | null) {
  return {
    referenceWaterSourceId: mapping.referenceWaterSourceId,
    referenceSourceManual: manualSource,
    referenceSourceReason: manualSource ? sourceReason : null,
    distanceM: mapping.distanceM,
    distanceMethod: mapping.distanceMethod,
    distanceNeedsRecalc: mapping.estimated || mapping.distanceMethod === "straight_line_x1_3",
    tariffZoneId: mapping.zoneId,
    zoneBoundaryId: mapping.zoneBoundaryId,
    zoneAssignment: "auto" as const,
    zoneManualReason: null,
    zoneAssignedAt: now,
  };
}

// =====================================================================================================================
// Usulan tabel zona (batas jarak berversi)
// =====================================================================================================================

const zoneTableSchema = z.object({
  effectiveFrom: z.string().refine(isBusinessDate, { error: "Tanggal berlaku wajib (YYYY-MM-DD)." }),
  reason: z.string().trim().min(3, { error: "Alasan wajib diisi (minimal 3 karakter)." }),
  zones: z
    .array(
      z.object({
        zoneId: z.uuid().optional(),
        code: z.string().trim().min(1).max(10).optional(),
        name: z.string().trim().min(2).max(80).optional(),
        minKm: z.number().min(0, { error: "Batas bawah tidak boleh negatif." }),
        maxKm: z.number().positive({ error: "Batas atas harus lebih dari 0." }).nullable(),
      }),
    )
    .min(1, { error: "Tabel zona minimal satu zona." }),
});

export type ProposeZoneTableInput = z.input<typeof zoneTableSchema>;

const toMeters = (km: number) => Math.round(km * 1000);

export type ProposeResult = { status: "pending" | "active"; approvalId: string | null; ids: string[] };

/**
 * Usulkan tabel zona baru (batas jarak) berlaku per tanggal (US-M1-05 KP-1). Admin Keuangan → persetujuan pemilik;
 * pemilik → keputusan langsung (6.2b). Tabel wajib memuat semua zona aktif, mulai 0 km, tanpa celah/tumpang tindih.
 */
export async function proposeZoneTable(ctx: ActorContext, input: ProposeZoneTableInput, opts: { tx?: Tx } = {}): Promise<ProposeResult> {
  await authorizeAny(ctx, ["m1.price.request", "m1.price.set", "m1.tariff_zone.update"], { tx: opts.tx });
  const data = parseInput(zoneTableSchema, input, { effectiveFrom: "Tanggal berlaku", reason: "Alasan", zones: "Zona" });
  const ownerDirect = can(ctx, "m1.price.set") || can(ctx, "m1.tariff_zone.update");
  const today = ctxBusinessDate(ctx);
  assertEffectiveFrom(data.effectiveFrom, today, ownerDirect);

  return runService(ctx, opts, async (tx) => {
    const current = await tx.select().from(tariffZones).where(and(eq(tariffZones.tenantId, ctx.tenantId), eq(tariffZones.isActive, true)));
    const byId = new Map(current.map((z) => [z.id, z]));
    for (const z of data.zones) {
      if (z.zoneId && !byId.has(z.zoneId)) throw ValidationError.field("zones", "Ada zona yang tidak dikenal. Muat ulang halaman.");
      if (!z.zoneId && (!z.code || !z.name)) throw ValidationError.field("zones", "Zona baru wajib diberi kode dan nama.");
    }
    const listed = new Set(data.zones.filter((z) => z.zoneId).map((z) => z.zoneId!));
    const missing = current.filter((z) => !listed.has(z.id));
    if (missing.length) {
      throw ValidationError.field("zones", `Tabel zona harus memuat semua zona aktif (${missing.map((z) => z.code).join(", ")} belum ada).`);
    }
    const codes = new Set(current.map((z) => z.code.toUpperCase()));
    for (const z of data.zones.filter((x) => !x.zoneId)) {
      if (codes.has(z.code!.toUpperCase())) throw ValidationError.field("zones", `Kode zona ${z.code} sudah dipakai.`);
      codes.add(z.code!.toUpperCase());
    }
    const bands = data.zones.map((z, i) => ({
      id: z.zoneId ?? `baru-${i}`,
      code: z.zoneId ? byId.get(z.zoneId)!.code : z.code!,
      minDistanceM: toMeters(z.minKm),
      maxDistanceM: z.maxKm === null ? null : toMeters(z.maxKm),
    }));
    const errors = validateZoneTable(bands);
    if (errors.length) throw new DomainError("ZONE_TABLE_INVALID", `Tabel zona tidak valid: ${errors.join(" ")}`);

    // Zona baru dibuat (salinan batas = usulan; aktif, tetapi tidak berlaku sebelum batasnya aktif).
    const zoneIds: string[] = [];
    for (let i = 0; i < data.zones.length; i++) {
      const z = data.zones[i]!;
      if (z.zoneId) {
        zoneIds.push(z.zoneId);
        continue;
      }
      const [created] = await tx
        .insert(tariffZones)
        .values({
          tenantId: ctx.tenantId,
          code: z.code!.toUpperCase(),
          name: z.name!,
          sortOrder: current.length + i + 1,
          minDistanceM: bands[i]!.minDistanceM,
          maxDistanceM: bands[i]!.maxDistanceM,
          createdBy: ctx.userId,
        })
        .returning();
      await auditRecord(tx, { ctx, objectType: "tariff_zone", objectId: created!.id, action: "create", after: created, reason: data.reason });
      zoneIds.push(created!.id);
    }

    const setId = newId();
    let approvalId: string | null = null;
    if (!ownerDirect) {
      const request = await approvals.submit(
        ctx,
        {
          type: "price_change",
          objectType: "tariff_zone_table",
          objectId: setId,
          reason: data.reason,
          deadlineAt: wibToUtc(data.effectiveFrom, "00:00"),
          payload: {
            kind: "zone_table",
            effectiveFrom: data.effectiveFrom,
            zones: bands.map((b, i) => ({ zoneId: zoneIds[i], code: b.code, minDistanceM: b.minDistanceM, maxDistanceM: b.maxDistanceM })),
            link: "/master/zona",
          },
        },
        { tx },
      );
      approvalId = request.id;
    }

    const ids: string[] = [];
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i]!;
      if (ownerDirect) await cancelSameDateActiveBoundary(tx, ctx, zoneIds[i]!, data.effectiveFrom);
      const [row] = await tx
        .insert(tariffZoneBoundaries)
        .values({
          tariffZoneId: zoneIds[i]!,
          minDistanceM: b.minDistanceM,
          maxDistanceM: b.maxDistanceM,
          effectiveFrom: data.effectiveFrom,
          status: ownerDirect ? "active" : "pending",
          approvalRequestId: approvalId,
          isOwnerDirect: ownerDirect,
          reason: data.reason,
          approvedBy: ownerDirect ? ctx.userId : null,
          approvedAt: ownerDirect ? ctx.now : null,
          createdBy: ctx.userId,
        })
        .returning();
      ids.push(row!.id);
      await auditRecord(tx, {
        ctx,
        objectType: "tariff_zone_boundary",
        objectId: row!.id,
        action: ownerDirect ? "set" : "submit",
        after: { zone: b.code, minDistanceM: b.minDistanceM, maxDistanceM: b.maxDistanceM, effectiveFrom: data.effectiveFrom, status: row!.status },
        reason: data.reason,
        rule: ownerDirect ? "6.2b" : "6.2a",
      });
    }

    if (ownerDirect) {
      await notifyOwnerDirectPriceChange(tx, ctx, "Tabel zona tarif", `Batas zona baru berlaku ${data.effectiveFrom}. Alasan: ${data.reason}`, "/master/zona");
      if (data.effectiveFrom <= today) await applyZoneTableIfEffective(tx, ctx, ctx.tenantId, today);
    }
    return { status: ownerDirect ? "active" : "pending", approvalId, ids };
  });
}

async function cancelSameDateActiveBoundary(tx: Tx, ctx: ActorContext, zoneId: string, effectiveFrom: string): Promise<void> {
  const same = await tx
    .select()
    .from(tariffZoneBoundaries)
    .where(and(eq(tariffZoneBoundaries.tariffZoneId, zoneId), eq(tariffZoneBoundaries.effectiveFrom, effectiveFrom), eq(tariffZoneBoundaries.status, "active")));
  for (const row of same) {
    await tx.update(tariffZoneBoundaries).set({ status: "cancelled" }).where(eq(tariffZoneBoundaries.id, row.id));
    await auditRecord(tx, {
      ctx,
      objectType: "tariff_zone_boundary",
      objectId: row.id,
      action: "cancel",
      before: { status: "active" },
      after: { status: "cancelled" },
      reason: "Digantikan batas baru dengan tanggal berlaku yang sama.",
    });
  }
}

/** Notifikasi keputusan langsung pemilik atas harga/zona/BBM ke Admin Keuangan & Dispatcher (6.2b). */
export async function notifyOwnerDirectPriceChange(tx: Tx, ctx: ActorContext, what: string, body: string, link: string): Promise<void> {
  await notify(tx, {
    event: "price.changed_by_owner",
    tenantId: ctx.tenantId,
    recipients: { roles: ["finance_admin", "dispatcher"] },
    excludeUserIds: ctx.userId ? [ctx.userId] : [],
    title: `${what} diubah langsung oleh pemilik`,
    body,
    link,
    now: ctx.now,
  });
}

/** Aktifkan batas zona hasil persetujuan (handler `price_change` kind zone_table). */
export async function activateZoneTableRequest(tx: Tx, ctx: ActorContext, requestId: string): Promise<{ activated: number }> {
  const rows = await tx.select().from(tariffZoneBoundaries).where(and(eq(tariffZoneBoundaries.approvalRequestId, requestId), eq(tariffZoneBoundaries.status, "pending")));
  for (const row of rows) {
    await cancelSameDateActiveBoundary(tx, ctx, row.tariffZoneId, row.effectiveFrom);
    await tx.update(tariffZoneBoundaries).set({ status: "active", approvedBy: ctx.userId, approvedAt: ctx.now }).where(eq(tariffZoneBoundaries.id, row.id));
    await auditRecord(tx, {
      ctx,
      objectType: "tariff_zone_boundary",
      objectId: row.id,
      action: "approve",
      before: { status: "pending" },
      after: { status: "active" },
      rule: "6.2a",
    });
  }
  const zone = rows[0] ? await tx.select({ tenantId: tariffZones.tenantId }).from(tariffZones).where(eq(tariffZones.id, rows[0].tariffZoneId)).limit(1) : [];
  const today = ctxBusinessDate(ctx);
  if (rows[0] && rows[0].effectiveFrom <= today && zone[0]) await applyZoneTableIfEffective(tx, ctx, zone[0].tenantId, today);
  return { activated: rows.length };
}

/** Tandai batas zona usulan ditolak/lewat tenggat (batas lama tetap berlaku). */
export async function closeZoneTableRequest(tx: Tx, ctx: ActorContext, requestId: string, status: "rejected" | "cancelled", reason: string | null): Promise<{ closed: number }> {
  const rows = await tx.select().from(tariffZoneBoundaries).where(and(eq(tariffZoneBoundaries.approvalRequestId, requestId), eq(tariffZoneBoundaries.status, "pending")));
  for (const row of rows) {
    await tx.update(tariffZoneBoundaries).set({ status }).where(eq(tariffZoneBoundaries.id, row.id));
    await auditRecord(tx, {
      ctx,
      objectType: "tariff_zone_boundary",
      objectId: row.id,
      action: status === "rejected" ? "reject" : "expire",
      before: { status: "pending" },
      after: { status },
      reason: reason ?? (status === "cancelled" ? "Lewat tenggat — batas lama tetap berlaku." : null),
      rule: "6.2a",
    });
  }
  return { closed: rows.length };
}

export type MovedAddress = {
  addressId: string;
  customerId: string;
  customerCode: string | null;
  customerName: string;
  label: string;
  addressText: string;
  distanceM: number;
  fromZoneId: string | null;
  fromZoneCode: string | null;
  toZoneId: string | null;
  toZoneCode: string | null;
  manual: boolean;
};

type AddressForZoning = {
  addressId: string;
  customerId: string;
  customerCode: string | null;
  customerName: string;
  label: string;
  addressText: string;
  distanceM: number;
  tariffZoneId: string | null;
  zoneBoundaryId: string | null;
  zoneAssignment: "auto" | "manual";
};

async function addressesWithDistance(tx: Tx, tenantId: string): Promise<AddressForZoning[]> {
  const rows = await tx
    .select({
      addressId: customerAddresses.id,
      customerId: customers.id,
      customerCode: customers.code,
      customerName: customers.name,
      label: customerAddresses.label,
      addressText: customerAddresses.addressText,
      distanceM: customerAddresses.distanceM,
      tariffZoneId: customerAddresses.tariffZoneId,
      zoneBoundaryId: customerAddresses.zoneBoundaryId,
      zoneAssignment: customerAddresses.zoneAssignment,
    })
    .from(customerAddresses)
    .innerJoin(customers, eq(customers.id, customerAddresses.customerId))
    .where(and(eq(customers.tenantId, tenantId), eq(customerAddresses.isActive, true), isNotNull(customerAddresses.distanceM)));
  return rows.map((r) => ({ ...r, distanceM: r.distanceM! }));
}

/** Bandingkan pemetaan alamat antara dua tabel zona → alamat yang berpindah zona (US-M1-05 KP-4). */
export async function diffZoneTables(tx: Tx, tenantId: string, before: readonly ZoneTableEntry[], after: readonly ZoneTableEntry[]): Promise<MovedAddress[]> {
  const addresses = await addressesWithDistance(tx, tenantId);
  const out: MovedAddress[] = [];
  for (const a of addresses) {
    const from = a.zoneAssignment === "manual" ? null : zoneForMeters(before, a.distanceM);
    const fromZoneId = a.zoneAssignment === "manual" ? a.tariffZoneId : (from?.zoneId ?? null);
    const to = zoneForMeters(after, a.distanceM);
    if ((to?.zoneId ?? null) === fromZoneId) continue;
    const beforeCode = before.find((z) => z.zoneId === fromZoneId)?.code ?? after.find((z) => z.zoneId === fromZoneId)?.code ?? null;
    out.push({
      addressId: a.addressId,
      customerId: a.customerId,
      customerCode: a.customerCode,
      customerName: a.customerName,
      label: a.label,
      addressText: a.addressText,
      distanceM: a.distanceM,
      fromZoneId,
      fromZoneCode: beforeCode,
      toZoneId: to?.zoneId ?? null,
      toZoneCode: to?.code ?? null,
      manual: a.zoneAssignment === "manual",
    });
  }
  return out.sort((x, y) => x.customerName.localeCompare(y.customerName));
}

/** Tabel zona hasil usulan persetujuan tertentu (batas usulan menimpa tabel berlaku pada tanggal berlakunya). */
export async function proposedZoneTable(tx: Tx, tenantId: string, requestId: string): Promise<{ effectiveFrom: string; before: ZoneTableEntry[]; after: ZoneTableEntry[] } | null> {
  const pending = await tx
    .select({
      zoneId: tariffZones.id,
      code: tariffZones.code,
      name: tariffZones.name,
      sortOrder: tariffZones.sortOrder,
      boundaryId: tariffZoneBoundaries.id,
      minDistanceM: tariffZoneBoundaries.minDistanceM,
      maxDistanceM: tariffZoneBoundaries.maxDistanceM,
      effectiveFrom: tariffZoneBoundaries.effectiveFrom,
    })
    .from(tariffZoneBoundaries)
    .innerJoin(tariffZones, eq(tariffZones.id, tariffZoneBoundaries.tariffZoneId))
    .where(and(eq(tariffZoneBoundaries.approvalRequestId, requestId), eq(tariffZones.tenantId, tenantId)));
  if (pending.length === 0) return null;
  const effectiveFrom = pending[0]!.effectiveFrom;
  const before = await zoneTableAt(tx, tenantId, addDays(effectiveFrom, -1));
  const base = await zoneTableAt(tx, tenantId, effectiveFrom);
  const merged = new Map(base.map((z) => [z.zoneId, z]));
  for (const p of pending) merged.set(p.zoneId, p);
  return { effectiveFrom, before, after: [...merged.values()].sort((a, b) => a.minDistanceM - b.minDistanceM) };
}

/**
 * Terapkan tabel zona yang berlaku pada `date`: perbarui salinan batas di `tariff_zones` dan petakan ulang alamat
 * berzona Otomatis. Alamat Zona manual tidak diubah (tetap tampil pada daftar tinjauan). Pemilik diberi tahu bila ada
 * alamat yang berpindah zona (KP-4). Idempoten.
 */
export async function applyZoneTableIfEffective(tx: Tx, ctx: ActorContext, tenantId: string, date: BusinessDate): Promise<{ moved: MovedAddress[] }> {
  const table = await zoneTableAt(tx, tenantId, date);
  if (table.length === 0) return { moved: [] };
  const zones = await tx.select().from(tariffZones).where(inArray(tariffZones.id, table.map((z) => z.zoneId)));
  for (const z of zones) {
    const t = table.find((x) => x.zoneId === z.id)!;
    if (z.minDistanceM !== t.minDistanceM || z.maxDistanceM !== t.maxDistanceM) {
      await tx.update(tariffZones).set({ minDistanceM: t.minDistanceM, maxDistanceM: t.maxDistanceM }).where(eq(tariffZones.id, z.id));
      await auditRecord(tx, {
        ctx,
        objectType: "tariff_zone",
        objectId: z.id,
        action: "update",
        before: { minDistanceM: z.minDistanceM, maxDistanceM: z.maxDistanceM },
        after: { minDistanceM: t.minDistanceM, maxDistanceM: t.maxDistanceM, effectiveFrom: t.effectiveFrom },
        rule: "US-M1-05 KP-1",
      });
    }
  }
  const addresses = await addressesWithDistance(tx, tenantId);
  const moved: MovedAddress[] = [];
  for (const a of addresses) {
    if (a.zoneAssignment !== "auto") continue;
    const zone = zoneForMeters(table, a.distanceM);
    if ((zone?.zoneId ?? null) === a.tariffZoneId && (zone?.boundaryId ?? null) === a.zoneBoundaryId) continue;
    await tx
      .update(customerAddresses)
      .set({ tariffZoneId: zone?.zoneId ?? null, zoneBoundaryId: zone?.boundaryId ?? null, zoneAssignedAt: ctx.now })
      .where(eq(customerAddresses.id, a.addressId));
    if ((zone?.zoneId ?? null) !== a.tariffZoneId) {
      const fromCode = zones.find((z) => z.id === a.tariffZoneId)?.code ?? null;
      moved.push({
        addressId: a.addressId,
        customerId: a.customerId,
        customerCode: a.customerCode,
        customerName: a.customerName,
        label: a.label,
        addressText: a.addressText,
        distanceM: a.distanceM,
        fromZoneId: a.tariffZoneId,
        fromZoneCode: fromCode,
        toZoneId: zone?.zoneId ?? null,
        toZoneCode: zone?.code ?? null,
        manual: false,
      });
      await auditRecord(tx, {
        ctx,
        objectType: "customer_address",
        objectId: a.addressId,
        action: "update",
        before: { tariffZoneId: a.tariffZoneId },
        after: { tariffZoneId: zone?.zoneId ?? null, zoneBoundaryId: zone?.boundaryId ?? null },
        reason: "Batas zona baru berlaku — pemetaan ulang otomatis.",
        rule: "US-M1-05 KP-4",
      });
    }
  }
  if (moved.length > 0) {
    await notify(tx, {
      event: "zone.addresses_moved",
      tenantId,
      title: `${moved.length} alamat berpindah zona`,
      body: `Batas zona yang berlaku ${date} memindahkan ${moved.length} alamat kirim. Harga pesanan yang sudah dibuat tidak berubah.`,
      link: "/master/zona#berpindah",
      groupKey: `zone_moved:${tenantId}:${date}`,
      now: ctx.now,
    });
  }
  return { moved };
}

/** Job harian: terapkan batas zona yang mulai berlaku hari ini untuk semua tenant. */
export async function applyEffectiveZoneTables(tx: Tx, now: Date, date: BusinessDate): Promise<{ tenants: number; moved: number }> {
  const tenants = await tx.selectDistinct({ tenantId: tariffZones.tenantId }).from(tariffZones);
  let moved = 0;
  for (const t of tenants) {
    const ctx = systemContext({ tenantId: t.tenantId, now });
    const res = await applyZoneTableIfEffective(tx, ctx, t.tenantId, date);
    moved += res.moved.length;
  }
  return { tenants: tenants.length, moved };
}

/** Pastikan zona milik tenant pelaku. */
export async function loadZone(tx: Tx, ctx: ActorContext | null, zoneId: string) {
  const rows = await tx.select().from(tariffZones).where(eq(tariffZones.id, zoneId)).limit(1);
  const zone = rows[0];
  if (!zone) throw new NotFoundError("Zona tarif tidak ditemukan.");
  if (ctx && zone.tenantId !== ctx.tenantId && !ctx.scope.tenantIds.includes(zone.tenantId)) throw new NotFoundError("Zona tarif tidak ditemukan.");
  return zone;
}
