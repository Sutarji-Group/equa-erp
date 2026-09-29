/**
 * P2 — alamat kirim pelanggan (US-P2-01 KP-3). Alamat = data M1 (8.4): dibuat lewat `m1.addAddress`, lalu titik peta
 * pelanggan diterapkan dengan status "Belum dikunci" (US-M1-01 KP-2: dikunci Dispatcher / pengiriman pertama) dan
 * zona tarif dihitung otomatis (US-M1-05, `m1.mapAddressToZone`). Titik yang sudah Dikunci kantor tidak dapat
 * dipindah pelanggan.
 */
import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { customerAddresses, tariffZones } from "@/db/schema";
import { formatRupiah } from "@/lib/money";

import type { Tx } from "@/server/core/db";
import { runInTx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import * as m1 from "@/server/modules/m1-master";

import { assertAppEnabled, customerBusinessDate, recordCustomerAudit, requireLinked, sysCtx, type CustomerContext } from "./common";

export type AddressRow = typeof customerAddresses.$inferSelect;

export const pinSchema = z.object({
  lat: z.coerce.number({ error: "Tandai titik alamat di peta." }).min(-90).max(90),
  lng: z.coerce.number({ error: "Tandai titik alamat di peta." }).min(-180).max(180),
});

export const addressInputSchema = z.object({
  label: z.string().trim().min(1, { error: "Beri nama alamat (mis. Rumah, Gudang)." }).max(60),
  addressText: z.string().trim().min(5, { error: "Tulis alamat lengkap (minimal 5 karakter)." }).max(500),
  notes: z.string().trim().max(500).nullable().optional(),
  lat: pinSchema.shape.lat,
  lng: pinSchema.shape.lng,
});
export type CustomerAddressInput = z.input<typeof addressInputSchema>;

const LABELS = { label: "Nama alamat", addressText: "Alamat lengkap", notes: "Catatan akses", lat: "Titik peta", lng: "Titik peta" };

/**
 * Terapkan titik peta pelanggan pada alamat M1: koordinat + zona otomatis, status tetap "Belum dikunci" (sumber
 * `customer_app`). Menulis kolom alamat M1 secara langsung karena M1 belum menyediakan fungsi publik untuk titik
 * "belum dikunci" (dilaporkan di hand-off P2) — jejak audit `customer_address` tetap dicatat.
 */
export async function applyCustomerPin(tx: Tx, input: { addressId: string; tenantId: string; lat: number; lng: number; now: Date; accountId: string }): Promise<AddressRow> {
  const [address] = await tx.select().from(customerAddresses).where(eq(customerAddresses.id, input.addressId)).limit(1).for("update");
  if (!address) throw new NotFoundError("Alamat tidak ditemukan.");
  if (address.coordinateStatus === "locked") {
    throw new DomainError("ADDRESS_LOCKED", "Titik alamat ini sudah dikunci kantor EQUA. Hubungi kantor bila titiknya perlu dipindah.");
  }
  const date = customerBusinessDate({ now: input.now });
  const mapping = await m1.mapAddressToZone(tx, { lat: input.lat, lng: input.lng, tenantId: input.tenantId, date });
  const [after] = await tx
    .update(customerAddresses)
    .set({
      lat: input.lat,
      lng: input.lng,
      coordinateStatus: "unlocked",
      coordinateSource: "customer_app",
      referenceWaterSourceId: mapping.referenceWaterSourceId,
      referenceSourceManual: false,
      referenceSourceReason: null,
      distanceM: mapping.distanceM,
      distanceMethod: mapping.distanceMethod,
      distanceNeedsRecalc: mapping.estimated || mapping.distanceMethod === "straight_line_x1_3",
      tariffZoneId: mapping.zoneId,
      zoneBoundaryId: mapping.zoneBoundaryId,
      zoneAssignment: "auto",
      zoneManualReason: null,
      zoneAssignedAt: input.now,
    })
    .where(eq(customerAddresses.id, input.addressId))
    .returning();
  await recordCustomerAudit(tx, { tenantId: input.tenantId, now: input.now, accountId: input.accountId }, {
    objectType: "customer_address",
    objectId: input.addressId,
    action: "update",
    before: { lat: address.lat, lng: address.lng, tariffZoneId: address.tariffZoneId, coordinateStatus: address.coordinateStatus },
    after: { lat: input.lat, lng: input.lng, tariffZoneId: mapping.zoneId, zoneCode: mapping.zoneCode, coordinateStatus: "unlocked", coordinateSource: "customer_app" },
    rule: "US-P2-01 KP-3",
  });
  return after!;
}

export type CustomerAddressView = {
  id: string;
  label: string;
  addressText: string;
  notes: string | null;
  lat: number | null;
  lng: number | null;
  locked: boolean;
  zoneCode: string | null;
  zoneName: string | null;
  /** Harga per tangki hari ini (zona + BBM atau harga khusus). Null bila alamat di luar jangkauan zona. */
  pricePerTank: number | null;
  priceText: string;
  orderable: boolean;
};

/** Alamat kirim aktif milik pelanggan + zona & harga hari ini. */
export async function listMyAddresses(cctx: CustomerContext, opts: { tx?: Tx } = {}): Promise<CustomerAddressView[]> {
  const customerId = requireLinked(cctx);
  return runInTx(opts.tx, async (tx) => {
    const rows = await tx
      .select()
      .from(customerAddresses)
      .where(and(eq(customerAddresses.customerId, customerId), eq(customerAddresses.isActive, true)))
      .orderBy(asc(customerAddresses.createdAt));
    const zoneIds = [...new Set(rows.map((r) => r.tariffZoneId).filter((x): x is string => !!x))];
    const zones = zoneIds.length ? await tx.select({ id: tariffZones.id, code: tariffZones.code, name: tariffZones.name }).from(tariffZones).where(inArray(tariffZones.id, zoneIds)) : [];
    const date = customerBusinessDate(cctx);
    const out: CustomerAddressView[] = [];
    for (const r of rows) {
      const zone = zones.find((z) => z.id === r.tariffZoneId) ?? null;
      let pricePerTank: number | null = null;
      let orderable = false;
      let priceText = "Alamat di luar jangkauan zona tarif — hubungi kantor EQUA.";
      if (r.tariffZoneId) {
        try {
          const p = await m1.resolveTruckWaterPrice(tx, { customerId, addressId: r.id, date });
          if (!p.tempPrice) {
            pricePerTank = p.unitPrice;
            orderable = true;
            priceText = `${formatRupiah(p.unitPrice)} per tangki 5.000 L${p.source === "special" ? " (harga khusus)" : ""}`;
          }
        } catch (error) {
          priceText = error instanceof Error ? error.message : "Harga belum tersedia.";
        }
      }
      out.push({
        id: r.id,
        label: r.label,
        addressText: r.addressText,
        notes: r.notes,
        lat: r.lat,
        lng: r.lng,
        locked: r.coordinateStatus === "locked",
        zoneCode: zone?.code ?? null,
        zoneName: zone?.name ?? null,
        pricePerTank,
        priceText,
        orderable,
      });
    }
    return out;
  });
}

/** Tambah alamat kirim dari aplikasi: titik peta + catatan akses; status "Belum dikunci"; zona & harga otomatis. */
export async function addMyAddress(cctx: CustomerContext, input: CustomerAddressInput, opts: { tx?: Tx } = {}): Promise<AddressRow> {
  const customerId = requireLinked(cctx);
  const data = parseInput(addressInputSchema, input, LABELS);
  return runInTx(opts.tx, async (tx) => {
    await assertAppEnabled(tx, cctx.tenantId);
    const created = await m1.addAddress(sysCtx(cctx.tenantId, cctx.now), customerId, { label: data.label, addressText: data.addressText, notes: data.notes ?? null }, { tx });
    return applyCustomerPin(tx, { addressId: created.id, tenantId: cctx.tenantId, lat: data.lat, lng: data.lng, now: cctx.now, accountId: cctx.accountId });
  });
}

const updateSchema = z.object({
  label: addressInputSchema.shape.label.optional(),
  addressText: addressInputSchema.shape.addressText.optional(),
  notes: addressInputSchema.shape.notes,
  lat: pinSchema.shape.lat.optional(),
  lng: pinSchema.shape.lng.optional(),
});

async function ownAddress(tx: Tx, customerId: string, addressId: string): Promise<AddressRow> {
  const rows = await tx.select().from(customerAddresses).where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, customerId))).limit(1);
  if (!rows[0]) throw new NotFoundError("Alamat tidak ditemukan.");
  return rows[0];
}

/** Ubah nama/teks/catatan akses alamat; pindah titik hanya bila belum dikunci. */
export async function updateMyAddress(cctx: CustomerContext, addressId: string, input: z.input<typeof updateSchema>, opts: { tx?: Tx } = {}): Promise<AddressRow> {
  const customerId = requireLinked(cctx);
  const data = parseInput(updateSchema, input, LABELS);
  return runInTx(opts.tx, async (tx) => {
    await assertAppEnabled(tx, cctx.tenantId);
    const address = await ownAddress(tx, customerId, addressId);
    if (!address.isActive) throw new DomainError("ADDRESS_INACTIVE", "Alamat ini sudah tidak dipakai.");
    let row = address;
    if (data.label !== undefined || data.addressText !== undefined || data.notes !== undefined) {
      row = await m1.updateAddress(sysCtx(cctx.tenantId, cctx.now), addressId, { label: data.label, addressText: data.addressText, notes: data.notes }, { tx });
    }
    if (data.lat !== undefined && data.lng !== undefined && (data.lat !== address.lat || data.lng !== address.lng)) {
      row = await applyCustomerPin(tx, { addressId, tenantId: cctx.tenantId, lat: data.lat, lng: data.lng, now: cctx.now, accountId: cctx.accountId });
    }
    return row;
  });
}

/** Hapus alamat dari daftar (nonaktif; tidak ada penghapusan data, Bab 6.1). */
export async function deactivateMyAddress(cctx: CustomerContext, addressId: string, opts: { tx?: Tx } = {}): Promise<AddressRow> {
  const customerId = requireLinked(cctx);
  return runInTx(opts.tx, async (tx) => {
    await ownAddress(tx, customerId, addressId);
    return m1.deactivateAddress(sysCtx(cctx.tenantId, cctx.now), addressId, "Dihapus pelanggan dari aplikasi", { tx });
  });
}
