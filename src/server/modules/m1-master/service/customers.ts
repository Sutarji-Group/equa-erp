/**
 * M1 — pelanggan & alamat kirim (US-M1-01; FR-M1-01, FR-M2-08, BR-01, BR-02, BR-04, BR-18).
 *
 * - Bidang wajib: nama, segmen, nomor WA (format Indonesia), ≥ 1 alamat kirim. Status kredit baru = Tunai (BR-01),
 *   batas dari segmen (PAR-10; rumah tangga tunai saja, BR-04), tempo standar PAR-08 — Dispatcher tidak dapat mengubah
 *   status/batas/tempo (lewat persetujuan pemilik, ./credit.ts).
 * - Duplikat (WA sama / nama + alamat mirip) → kandidat + konfirmasi; TIDAK memblokir (KP-7).
 * - Alamat: koordinat dari peta (Dikunci) atau kosong (Belum dikunci); usulan dari lokasi Selesai rit pertama
 *   dikonfirmasi Dispatcher; zona Otomatis dari koordinat, Zona manual beralasan (KP-2, US-M1-05 KP-3).
 * - Tidak ada hapus: nonaktif beralasan; ditolak bila ada piutang terbuka atau pesanan aktif (KP-8).
 * - Semua perubahan berjejak audit (KP-10).
 */
import "server-only";

import { and, asc, count, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, ne, or, sql, sum } from "drizzle-orm";
import { z } from "zod";

import {
  customerAddresses,
  customerCreditHistory,
  customers,
  invoices,
  orders,
  products,
  specialPrices,
  tariffZones,
  trips,
  trucks,
  waterSources,
} from "@/db/schema";
import type { LatLng } from "@/lib/geo";
import { isValidLatLng } from "@/lib/geo";
import { enumValues, label, type CustomerSegment } from "@/lib/labels";
import { addDays, daysBetween, toBusinessDate, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { getDb } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, can, runService } from "@/server/core/rbac";
import { normalizeWaNumber } from "@/server/core/wa";
import { computeExposure, getReceivableBalance } from "@/server/modules/m5-receivables";

import { ACTIVE_ORDER_STATUSES, loadAddress, loadCustomer, masterRules, normalizeText, textSimilarity, type AddressRow, type CustomerRow } from "./common";
import { getActiveSpecialPrice } from "./pricing";
import { autoZoneColumns, loadZone, mapAddressToZone } from "./zones";

// =====================================================================================================================
// Skema masukan
// =====================================================================================================================

const segmentSchema = z.enum(enumValues("customer_segment"), { error: "Segmen tidak dikenal. Pilih salah satu segmen." });
const waSchema = z
  .string({ error: "Nomor WA wajib diisi." })
  .trim()
  .min(1, { error: "Nomor WA wajib diisi." })
  .transform((v, c) => {
    const n = normalizeWaNumber(v);
    if (!n) {
      c.addIssue({ code: "custom", message: "Nomor WA tidak valid. Contoh yang benar: 0812-3456-7890." });
      return z.NEVER;
    }
    return n;
  });
const timeSchema = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: "Jam terima harus berformat HH:mm (mis. 07:00)." });
const latSchema = z.number().min(-90).max(90);
const lngSchema = z.number().min(-180).max(180);

export const addressInputSchema = z.object({
  label: z.string().trim().min(1, { error: "Label alamat wajib diisi (mis. Utama, Gudang 2)." }).max(60),
  addressText: z.string().trim().min(5, { error: "Teks alamat wajib diisi (minimal 5 karakter)." }).max(500),
  lat: latSchema.nullable().optional(),
  lng: lngSchema.nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  /** Zona manual (tanpa koordinat, atau alamat di batas zona) — wajib alasan. */
  manualZoneId: z.uuid().nullable().optional(),
  manualZoneReason: z.string().trim().max(300).nullable().optional(),
});
export type AddressInput = z.input<typeof addressInputSchema>;

const customerFields = {
  name: z.string().trim().min(2, { error: "Nama pelanggan wajib diisi (minimal 2 karakter)." }).max(150),
  segment: segmentSchema,
  waPhone: waSchema,
  contactName: z.string().trim().max(100).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  fixedReceiveTime: timeSchema.nullable().optional(),
  code: z.string().trim().max(30).nullable().optional(),
};

const createCustomerSchema = z.object({
  ...customerFields,
  addresses: z.array(addressInputSchema).min(1, { error: "Minimal satu alamat kirim wajib diisi." }),
  /** KP-7: kandidat duplikat sudah ditampilkan dan pengguna mengonfirmasi tetap menyimpan. */
  confirmDuplicate: z.boolean().optional(),
  duplicateNote: z.string().trim().max(300).nullable().optional(),
});
export type CreateCustomerInput = z.input<typeof createCustomerSchema>;

const LABELS = {
  name: "Nama",
  segment: "Segmen",
  waPhone: "Nomor WA",
  addresses: "Alamat kirim",
  addressText: "Alamat",
  fixedReceiveTime: "Jam terima tetap",
};

// =====================================================================================================================
// Duplikat (KP-7)
// =====================================================================================================================

export type DuplicateCandidate = {
  customerId: string;
  code: string | null;
  name: string;
  waPhone: string;
  segment: CustomerSegment;
  isActive: boolean;
  reason: "wa" | "name_address";
  reasonText: string;
  similarity: number;
  matchedAddress: string | null;
};

/**
 * Kandidat duplikat: nomor WA sama, atau nama DAN salah satu alamat mirip (≥ ambang `m1.master_rules`). Tidak
 * memblokir — pemanggil menampilkan kandidat & meminta konfirmasi (US-M1-01 KP-7, US-M1-06 KP-2).
 */
export async function findDuplicateCandidates(
  tx: Tx,
  tenantId: string,
  input: { name: string; waPhone: string | null; addressTexts: string[]; excludeCustomerId?: string | null },
  date: BusinessDate,
): Promise<DuplicateCandidate[]> {
  const rules = await masterRules(tx, date);
  const min = rules.duplicate_name_min_similarity_pct / 100;
  const wa = input.waPhone ? normalizeWaNumber(input.waPhone) : null;
  const all = await tx
    .select({ id: customers.id, code: customers.code, name: customers.name, waPhone: customers.waPhone, segment: customers.segment, isActive: customers.isActive })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), isNull(customers.internalOutletId), isNull(customers.anonymizedAt)));
  const out = new Map<string, DuplicateCandidate>();
  for (const c of all) {
    if (input.excludeCustomerId && c.id === input.excludeCustomerId) continue;
    if (wa && c.waPhone === wa) {
      out.set(c.id, { customerId: c.id, code: c.code, name: c.name, waPhone: c.waPhone, segment: c.segment, isActive: c.isActive, reason: "wa", reasonText: "Nomor WA sama", similarity: 1, matchedAddress: null });
    }
  }
  const nameCandidates = all.filter((c) => !out.has(c.id) && c.id !== input.excludeCustomerId && textSimilarity(c.name, input.name) >= min);
  if (nameCandidates.length && input.addressTexts.length) {
    const addrs = await tx
      .select({ customerId: customerAddresses.customerId, addressText: customerAddresses.addressText })
      .from(customerAddresses)
      .where(inArray(customerAddresses.customerId, nameCandidates.map((c) => c.id)));
    for (const c of nameCandidates) {
      const nameSim = textSimilarity(c.name, input.name);
      let best: { sim: number; text: string } | null = null;
      for (const a of addrs.filter((x) => x.customerId === c.id)) {
        for (const t of input.addressTexts) {
          const s = textSimilarity(a.addressText, t);
          if (s >= min && (!best || s > best.sim)) best = { sim: s, text: a.addressText };
        }
      }
      if (best) {
        out.set(c.id, {
          customerId: c.id,
          code: c.code,
          name: c.name,
          waPhone: c.waPhone,
          segment: c.segment,
          isActive: c.isActive,
          reason: "name_address",
          reasonText: `Nama (${Math.round(nameSim * 100)}%) dan alamat (${Math.round(best.sim * 100)}%) mirip`,
          similarity: Math.min(nameSim, best.sim),
          matchedAddress: best.text,
        });
      }
    }
  }
  return [...out.values()].sort((a, b) => (a.reason === b.reason ? b.similarity - a.similarity : a.reason === "wa" ? -1 : 1));
}

// =====================================================================================================================
// Batas kredit bawaan (BR-04, PAR-10) & tempo (BR-02, PAR-08)
// =====================================================================================================================

export async function defaultCreditTerms(tx: Tx, segment: CustomerSegment, date: BusinessDate): Promise<{ creditLimit: number; paymentTermDays: number; cashOnly: boolean }> {
  const par10 = await params.get(tx, "PAR-10", date);
  const par08 = await params.get(tx, "PAR-08", date);
  const cashOnly = par10.cash_only_segments.includes(segment);
  return { creditLimit: cashOnly ? 0 : (par10.limits[segment] ?? 0), paymentTermDays: par08.days, cashOnly };
}

// =====================================================================================================================
// Buat pelanggan
// =====================================================================================================================

export type CreateCustomerResult =
  | { status: "created"; customer: CustomerRow; addresses: AddressRow[] }
  | { status: "duplicates"; candidates: DuplicateCandidate[] };

/** Kolom alamat baru dari masukan (koordinat → Dikunci + zona otomatis; tanpa koordinat → Belum dikunci/zona manual). */
async function buildAddressValues(tx: Tx, ctx: ActorContext, tenantId: string, customerId: string, a: z.output<typeof addressInputSchema>) {
  const hasPoint = a.lat != null && a.lng != null;
  if ((a.lat == null) !== (a.lng == null)) throw ValidationError.field("addresses", "Isi lintang dan bujur sekaligus, atau kosongkan keduanya.");
  const base = {
    customerId,
    label: a.label,
    addressText: a.addressText,
    notes: a.notes ?? null,
    createdBy: ctx.userId,
  };
  if (a.manualZoneId) {
    if (!a.manualZoneReason || a.manualZoneReason.trim().length < 3) {
      throw ValidationError.field("manualZoneReason", "Alasan zona manual wajib diisi (minimal 3 karakter).");
    }
    const zone = await loadZone(tx, ctx, a.manualZoneId);
    if (zone.tenantId !== tenantId) throw ValidationError.field("manualZoneId", "Zona tidak dikenal.");
  }
  if (hasPoint) {
    const mapping = await mapAddressToZone(tx, { lat: a.lat!, lng: a.lng!, tenantId, date: ctxBusinessDate(ctx) });
    const auto = autoZoneColumns(mapping, ctx.now, false, null);
    return {
      ...base,
      lat: a.lat!,
      lng: a.lng!,
      coordinateStatus: "locked" as const,
      coordinateSource: "map" as const,
      coordinateLockedAt: ctx.now,
      coordinateLockedBy: ctx.userId,
      ...auto,
      ...(a.manualZoneId ? { tariffZoneId: a.manualZoneId, zoneBoundaryId: null, zoneAssignment: "manual" as const, zoneManualReason: a.manualZoneReason! } : {}),
    };
  }
  return {
    ...base,
    coordinateStatus: "unlocked" as const,
    tariffZoneId: a.manualZoneId ?? null,
    zoneAssignment: a.manualZoneId ? ("manual" as const) : ("auto" as const),
    zoneManualReason: a.manualZoneId ? a.manualZoneReason! : null,
    zoneAssignedAt: a.manualZoneId ? ctx.now : null,
  };
}

/**
 * Buat pelanggan (US-M1-01 KP-1..KP-4, KP-7): status kredit Tunai, batas dari segmen, tempo standar. Bila ada kandidat
 * duplikat dan belum dikonfirmasi → `{ status: "duplicates", candidates }` tanpa menyimpan.
 */
export async function createCustomer(ctx: ActorContext, input: CreateCustomerInput, opts: { tx?: Tx; skipAuthorize?: boolean } = {}): Promise<CreateCustomerResult> {
  if (!opts.skipAuthorize) await authorize(ctx, "m1.customer.create", { tx: opts.tx });
  const data = parseInput(createCustomerSchema, input, LABELS);
  return runService(ctx, opts, async (tx) => {
    const today = ctxBusinessDate(ctx);
    if (!data.confirmDuplicate) {
      const candidates = await findDuplicateCandidates(tx, ctx.tenantId, { name: data.name, waPhone: data.waPhone, addressTexts: data.addresses.map((a) => a.addressText) }, today);
      if (candidates.length) return { status: "duplicates", candidates };
    }
    const terms = await defaultCreditTerms(tx, data.segment, today);
    const [customer] = await tx
      .insert(customers)
      .values({
        tenantId: ctx.tenantId,
        code: data.code || null,
        name: data.name,
        segment: data.segment,
        waPhone: data.waPhone,
        contactName: data.contactName ?? null,
        notes: data.notes ?? null,
        fixedReceiveTime: data.fixedReceiveTime ?? null,
        creditStatus: "cash",
        creditLimit: terms.creditLimit,
        paymentTermDays: terms.paymentTermDays,
        createdBy: ctx.userId,
      })
      .returning();
    const addresses: AddressRow[] = [];
    for (const a of data.addresses) {
      const values = await buildAddressValues(tx, ctx, ctx.tenantId, customer!.id, a);
      const [row] = await tx.insert(customerAddresses).values(values).returning();
      addresses.push(row!);
      await auditRecord(tx, { ctx, objectType: "customer_address", objectId: row!.id, action: "create", after: row });
    }
    await tx.insert(customerCreditHistory).values({
      customerId: customer!.id,
      fromStatus: null,
      toStatus: "cash",
      creditLimitAfter: terms.creditLimit,
      termDaysAfter: terms.paymentTermDays,
      reason: "Pelanggan baru — status Tunai (BR-01).",
      changedBy: ctx.userId,
      rule: "BR-01",
      changedAt: ctx.now,
    });
    await auditRecord(tx, {
      ctx,
      objectType: "customer",
      objectId: customer!.id,
      action: "create",
      after: customer,
      reason: data.confirmDuplicate ? `Kandidat duplikat dikonfirmasi bukan duplikat${data.duplicateNote ? `: ${data.duplicateNote}` : ""}` : null,
      rule: data.confirmDuplicate ? "US-M1-01 KP-7" : null,
    });
    return { status: "created", customer: customer!, addresses };
  });
}

const quickCreateSchema = z.object({
  name: customerFields.name,
  waPhone: waSchema,
  segment: segmentSchema,
  addressText: z.string().trim().min(5, { error: "Alamat wajib diisi (minimal 5 karakter)." }).max(500),
  addressLabel: z.string().trim().max(60).optional(),
  lat: latSchema.nullable().optional(),
  lng: lngSchema.nullable().optional(),
  manualZoneId: z.uuid().nullable().optional(),
  manualZoneReason: z.string().trim().max(300).nullable().optional(),
  confirmDuplicate: z.boolean().optional(),
  duplicateNote: z.string().trim().max(300).nullable().optional(),
});
export type QuickCreateCustomerInput = z.input<typeof quickCreateSchema>;

/**
 * Pelanggan baru dari layar pesanan M2 (US-M2-01 KP-3): nama, WA, alamat, segmen; otomatis Tunai (BR-01).
 * Kelengkapan lain dilengkapi kemudian di Data master > Pelanggan.
 */
export async function quickCreateCustomer(ctx: ActorContext, input: QuickCreateCustomerInput, opts: { tx?: Tx } = {}): Promise<CreateCustomerResult> {
  await authorize(ctx, "m1.customer.create", { tx: opts.tx });
  const data = parseInput(quickCreateSchema, input, LABELS);
  return createCustomer(
    ctx,
    {
      name: data.name,
      waPhone: data.waPhone,
      segment: data.segment,
      addresses: [
        {
          label: data.addressLabel || "Utama",
          addressText: data.addressText,
          lat: data.lat ?? null,
          lng: data.lng ?? null,
          manualZoneId: data.manualZoneId ?? null,
          manualZoneReason: data.manualZoneReason ?? null,
        },
      ],
      confirmDuplicate: data.confirmDuplicate,
      duplicateNote: data.duplicateNote,
    },
    { ...opts, skipAuthorize: true },
  );
}

// =====================================================================================================================
// Ubah pelanggan
// =====================================================================================================================

const updateCustomerSchema = z.object({
  name: customerFields.name.optional(),
  segment: segmentSchema.optional(),
  waPhone: waSchema.optional(),
  contactName: customerFields.contactName,
  notes: customerFields.notes,
  fixedReceiveTime: customerFields.fixedReceiveTime,
  confirmDuplicate: z.boolean().optional(),
  /** US-M1-06 KP-3: data awal hanya dapat diubah lewat koreksi berjejak (alasan wajib). */
  correctionReason: z.string().trim().max(300).nullable().optional(),
});
export type UpdateCustomerInput = z.input<typeof updateCustomerSchema>;

export type UpdateCustomerResult = { status: "updated"; customer: CustomerRow } | { status: "duplicates"; candidates: DuplicateCandidate[] };

/** Ubah data pelanggan (bukan status kredit/batas/tempo — itu lewat persetujuan pemilik). */
export async function updateCustomer(ctx: ActorContext, customerId: string, input: UpdateCustomerInput, opts: { tx?: Tx } = {}): Promise<UpdateCustomerResult> {
  await authorize(ctx, "m1.customer.update", { tx: opts.tx, objectType: "customer", objectId: customerId });
  const data = parseInput(updateCustomerSchema, input, LABELS);
  return runService(ctx, opts, async (tx) => {
    const before = await loadCustomer(tx, ctx, customerId, { forUpdate: true });
    if (before.anonymizedAt) throw new DomainError("CUSTOMER_ANONYMIZED", "Pelanggan sudah dianonimkan; data tidak dapat diubah.");
    if (before.isInitialData && (!data.correctionReason || data.correctionReason.length < 3)) {
      throw new DomainError(
        "INITIAL_DATA_CORRECTION",
        "Pelanggan ini berasal dari impor data awal; perubahan hanya lewat koreksi berjejak. Isi alasan koreksi (minimal 3 karakter).",
      );
    }
    const today = ctxBusinessDate(ctx);
    if (data.waPhone && data.waPhone !== before.waPhone && !data.confirmDuplicate) {
      const candidates = (await findDuplicateCandidates(tx, before.tenantId, { name: data.name ?? before.name, waPhone: data.waPhone, addressTexts: [], excludeCustomerId: before.id }, today)).filter(
        (c) => c.reason === "wa",
      );
      if (candidates.length) return { status: "duplicates", candidates };
    }
    const patch: Partial<typeof customers.$inferInsert> = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.waPhone !== undefined) patch.waPhone = data.waPhone;
    if (data.contactName !== undefined) patch.contactName = data.contactName;
    if (data.notes !== undefined) patch.notes = data.notes;
    if (data.fixedReceiveTime !== undefined) patch.fixedReceiveTime = data.fixedReceiveTime;
    if (data.segment !== undefined && data.segment !== before.segment) {
      const terms = await defaultCreditTerms(tx, data.segment, today);
      if (terms.cashOnly && before.creditStatus !== "cash") {
        throw new DomainError("HOUSEHOLD_CASH_ONLY", `Segmen ${label("customer_segment", data.segment)} hanya tunai (BR-04); status kredit pelanggan ini ${label("credit_status", before.creditStatus)}.`);
      }
      if (terms.cashOnly && before.monthlyBilling) {
        throw new DomainError("HOUSEHOLD_CASH_ONLY", "Segmen rumah tangga tidak dapat memakai tagihan bulanan (BR-04).");
      }
      patch.segment = data.segment;
      if (!before.creditLimitOverridden || terms.cashOnly) patch.creditLimit = terms.creditLimit;
    }
    if (Object.keys(patch).length === 0) return { status: "updated", customer: before };
    const [after] = await tx.update(customers).set(patch).where(eq(customers.id, customerId)).returning();
    await auditRecord(tx, {
      ctx,
      objectType: "customer",
      objectId: customerId,
      action: before.isInitialData ? "correct" : "update",
      before: pick(before, Object.keys(patch)),
      after: pick(after!, Object.keys(patch)),
      reason: data.correctionReason ?? null,
      rule: before.isInitialData ? "US-M1-06 KP-3" : null,
    });
    return { status: "updated", customer: after! };
  });
}

function pick<T extends Record<string, unknown>>(row: T, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, row[k]]));
}

/** Nonaktifkan pelanggan beralasan (KP-8): ditolak bila ada piutang terbuka atau pesanan aktif. */
export async function deactivateCustomer(ctx: ActorContext, customerId: string, reason: string, opts: { tx?: Tx } = {}): Promise<CustomerRow> {
  await authorize(ctx, "m1.customer.deactivate", { tx: opts.tx, objectType: "customer", objectId: customerId });
  const cleanReason = parseInput(z.string().trim().min(3, { error: "Alasan menonaktifkan wajib diisi (minimal 3 karakter)." }), reason);
  return runService(ctx, opts, async (tx) => {
    const before = await loadCustomer(tx, ctx, customerId, { forUpdate: true });
    if (!before.isActive) throw new DomainError("ALREADY_INACTIVE", "Pelanggan sudah nonaktif.");
    const open = await openReceivable(tx, customerId);
    if (open > 0) {
      throw new DomainError("OPEN_RECEIVABLE", `Pelanggan tidak dapat dinonaktifkan: masih ada piutang terbuka Rp ${open.toLocaleString("id-ID")}. Lunasi atau selesaikan dulu di Piutang.`);
    }
    const [{ n }] = (await tx
      .select({ n: count() })
      .from(orders)
      .where(and(eq(orders.customerId, customerId), inArray(orders.status, [...ACTIVE_ORDER_STATUSES])))) as [{ n: number }];
    if (Number(n) > 0) {
      throw new DomainError("ACTIVE_ORDERS", `Pelanggan tidak dapat dinonaktifkan: masih ada ${n} pesanan aktif. Selesaikan atau batalkan pesanan itu dulu.`);
    }
    const [after] = await tx
      .update(customers)
      .set({ isActive: false, deactivatedAt: ctx.now, deactivatedBy: ctx.userId, deactivationReason: cleanReason })
      .where(eq(customers.id, customerId))
      .returning();
    await auditRecord(tx, { ctx, objectType: "customer", objectId: customerId, action: "deactivate", before: { isActive: true }, after: { isActive: false }, reason: cleanReason });
    return after!;
  });
}

/** Aktifkan kembali pelanggan nonaktif (beralasan, berjejak). */
export async function reactivateCustomer(ctx: ActorContext, customerId: string, reason: string, opts: { tx?: Tx } = {}): Promise<CustomerRow> {
  await authorize(ctx, "m1.customer.deactivate", { tx: opts.tx, objectType: "customer", objectId: customerId });
  const cleanReason = parseInput(z.string().trim().min(3, { error: "Alasan wajib diisi (minimal 3 karakter)." }), reason);
  return runService(ctx, opts, async (tx) => {
    const before = await loadCustomer(tx, ctx, customerId, { forUpdate: true });
    if (before.isActive) throw new DomainError("ALREADY_ACTIVE", "Pelanggan sudah aktif.");
    if (before.anonymizedAt) throw new DomainError("CUSTOMER_ANONYMIZED", "Pelanggan sudah dianonimkan dan tidak dapat diaktifkan.");
    const [after] = await tx
      .update(customers)
      .set({ isActive: true, deactivatedAt: null, deactivatedBy: null, deactivationReason: null })
      .where(eq(customers.id, customerId))
      .returning();
    await auditRecord(tx, { ctx, objectType: "customer", objectId: customerId, action: "activate", before: { isActive: false }, after: { isActive: true }, reason: cleanReason });
    return after!;
  });
}

/**
 * Saldo piutang pelanggan — SATU definisi M5 (`getReceivableBalance(tx, id).balance`: faktur terbuka semua lini +
 * rit belum ditagih pelanggan tagihan bulanan; US-M5-01 KP-3, B-32).
 */
export async function openReceivable(tx: Tx, customerId: string): Promise<number> {
  return (await getReceivableBalance(tx, customerId)).balance;
}

// =====================================================================================================================
// Mitra toko (BR-18, KP-6)
// =====================================================================================================================

/** Penanda mitra toko manual (mitra depot EQUA) — atau cabut penanda manual. */
export async function setStorePartner(ctx: ActorContext, customerId: string, input: { isStorePartner: boolean; reason: string }, opts: { tx?: Tx } = {}): Promise<CustomerRow> {
  await authorize(ctx, "m1.customer.update", { tx: opts.tx, objectType: "customer", objectId: customerId });
  const data = parseInput(z.object({ isStorePartner: z.boolean(), reason: z.string().trim().min(3, { error: "Alasan wajib diisi." }) }), input);
  return runService(ctx, opts, async (tx) => {
    const before = await loadCustomer(tx, ctx, customerId, { forUpdate: true });
    const [after] = await tx
      .update(customers)
      .set({ isStorePartner: data.isStorePartner, storePartnerSource: data.isStorePartner ? "manual" : null })
      .where(eq(customers.id, customerId))
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "customer",
      objectId: customerId,
      action: "update",
      before: { isStorePartner: before.isStorePartner, storePartnerSource: before.storePartnerSource },
      after: { isStorePartner: after!.isStorePartner, storePartnerSource: after!.storePartnerSource },
      reason: data.reason,
      rule: "BR-18",
    });
    return after!;
  });
}

/**
 * Job harian: penanda mitra toko otomatis untuk segmen depot pihak ketiga yang aktif (≥ 1 pesanan Selesai dalam
 * N hari, `m1.master_rules`), dicabut bila tidak aktif lagi. Penanda manual tidak disentuh (US-M1-01 KP-6).
 */
export async function refreshStorePartnerFlags(tx: Tx, now: Date): Promise<{ flagged: number; unflagged: number }> {
  const today = toBusinessDate(now);
  const rules = await masterRules(tx, today);
  const since = addDays(today, -rules.store_partner_active_days);
  const sinceUtc = new Date(`${since}T00:00:00+07:00`);
  const depots = await tx
    .select({ id: customers.id, tenantId: customers.tenantId, isStorePartner: customers.isStorePartner, source: customers.storePartnerSource })
    .from(customers)
    .where(and(eq(customers.segment, "third_party_depot"), eq(customers.isActive, true), isNull(customers.internalOutletId)));
  if (depots.length === 0) return { flagged: 0, unflagged: 0 };
  const activeRows = await tx
    .selectDistinct({ customerId: orders.customerId })
    .from(orders)
    .where(and(inArray(orders.customerId, depots.map((d) => d.id)), eq(orders.status, "completed"), gte(orders.completedAt, sinceUtc)));
  const active = new Set(activeRows.map((r) => r.customerId));
  let flagged = 0;
  let unflagged = 0;
  for (const d of depots) {
    const ctx = systemContext({ tenantId: d.tenantId, now });
    if (active.has(d.id) && !d.isStorePartner) {
      await tx.update(customers).set({ isStorePartner: true, storePartnerSource: "auto" }).where(eq(customers.id, d.id));
      await auditRecord(tx, { ctx, objectType: "customer", objectId: d.id, action: "update", before: { isStorePartner: false }, after: { isStorePartner: true, storePartnerSource: "auto" }, rule: "BR-18" });
      flagged++;
    } else if (!active.has(d.id) && d.isStorePartner && d.source === "auto") {
      await tx.update(customers).set({ isStorePartner: false, storePartnerSource: null }).where(eq(customers.id, d.id));
      await auditRecord(tx, {
        ctx,
        objectType: "customer",
        objectId: d.id,
        action: "update",
        before: { isStorePartner: true, storePartnerSource: "auto" },
        after: { isStorePartner: false },
        reason: `Tidak ada pesanan Selesai dalam ${rules.store_partner_active_days} hari terakhir.`,
        rule: "BR-18",
      });
      unflagged++;
    }
  }
  return { flagged, unflagged };
}

// =====================================================================================================================
// Alamat kirim (KP-2; US-M1-05 KP-2/KP-3)
// =====================================================================================================================

/** Tambah alamat kirim. */
export async function addAddress(ctx: ActorContext, customerId: string, input: AddressInput, opts: { tx?: Tx } = {}): Promise<AddressRow> {
  await authorize(ctx, "m1.customer.update", { tx: opts.tx, objectType: "customer", objectId: customerId });
  const data = parseInput(addressInputSchema, input, LABELS);
  return runService(ctx, opts, async (tx) => {
    const customer = await loadCustomer(tx, ctx, customerId);
    if (!customer.isActive) throw new DomainError("CUSTOMER_INACTIVE", "Pelanggan nonaktif; aktifkan dulu sebelum menambah alamat.");
    const values = await buildAddressValues(tx, ctx, customer.tenantId, customer.id, data);
    const [row] = await tx.insert(customerAddresses).values(values).returning();
    await auditRecord(tx, { ctx, objectType: "customer_address", objectId: row!.id, action: "create", after: row });
    return row!;
  });
}

const updateAddressSchema = z.object({
  label: addressInputSchema.shape.label.optional(),
  addressText: addressInputSchema.shape.addressText.optional(),
  notes: addressInputSchema.shape.notes,
});

/** Ubah label/teks/catatan alamat (koordinat & zona lewat fungsi khusus). */
export async function updateAddress(ctx: ActorContext, addressId: string, input: z.input<typeof updateAddressSchema>, opts: { tx?: Tx } = {}): Promise<AddressRow> {
  await authorize(ctx, "m1.customer.update", { tx: opts.tx, objectType: "customer_address", objectId: addressId });
  const data = parseInput(updateAddressSchema, input, LABELS);
  return runService(ctx, opts, async (tx) => {
    const { address } = await loadAddress(tx, ctx, addressId, { forUpdate: true });
    const patch: Partial<typeof customerAddresses.$inferInsert> = {};
    if (data.label !== undefined) patch.label = data.label;
    if (data.addressText !== undefined) patch.addressText = data.addressText;
    if (data.notes !== undefined) patch.notes = data.notes;
    if (Object.keys(patch).length === 0) return address;
    const [after] = await tx.update(customerAddresses).set(patch).where(eq(customerAddresses.id, addressId)).returning();
    await auditRecord(tx, { ctx, objectType: "customer_address", objectId: addressId, action: "update", before: pick(address, Object.keys(patch)), after: pick(after!, Object.keys(patch)) });
    return after!;
  });
}

/** Nonaktifkan alamat kirim (bukan alamat aktif terakhir). */
export async function deactivateAddress(ctx: ActorContext, addressId: string, reason: string, opts: { tx?: Tx } = {}): Promise<AddressRow> {
  await authorize(ctx, "m1.customer.update", { tx: opts.tx, objectType: "customer_address", objectId: addressId });
  const cleanReason = parseInput(z.string().trim().min(3, { error: "Alasan wajib diisi (minimal 3 karakter)." }), reason);
  return runService(ctx, opts, async (tx) => {
    const { address } = await loadAddress(tx, ctx, addressId, { forUpdate: true });
    if (!address.isActive) throw new DomainError("ALREADY_INACTIVE", "Alamat sudah nonaktif.");
    const [{ n }] = (await tx
      .select({ n: count() })
      .from(customerAddresses)
      .where(and(eq(customerAddresses.customerId, address.customerId), eq(customerAddresses.isActive, true)))) as [{ n: number }];
    if (Number(n) <= 1) throw new DomainError("LAST_ADDRESS", "Pelanggan wajib memiliki minimal satu alamat kirim aktif.");
    const [after] = await tx
      .update(customerAddresses)
      .set({ isActive: false, deactivatedAt: ctx.now, deactivatedBy: ctx.userId, deactivationReason: cleanReason })
      .where(eq(customerAddresses.id, addressId))
      .returning();
    await auditRecord(tx, { ctx, objectType: "customer_address", objectId: addressId, action: "deactivate", before: { isActive: true }, after: { isActive: false }, reason: cleanReason });
    return after!;
  });
}

async function applyCoordinates(
  tx: Tx,
  ctx: ActorContext,
  address: AddressRow,
  tenantId: string,
  point: LatLng,
  source: "map" | "first_delivery" | "import" | "customer_app",
): Promise<AddressRow> {
  const mapping = await mapAddressToZone(tx, {
    lat: point.lat,
    lng: point.lng,
    tenantId,
    date: ctxBusinessDate(ctx),
    referenceWaterSourceId: address.referenceSourceManual ? address.referenceWaterSourceId : null,
  });
  const zoneCols =
    address.zoneAssignment === "manual" && address.coordinateStatus === "locked"
      ? { ...autoZoneColumns(mapping, ctx.now, address.referenceSourceManual, address.referenceSourceReason), tariffZoneId: address.tariffZoneId, zoneBoundaryId: address.zoneBoundaryId, zoneAssignment: "manual" as const, zoneManualReason: address.zoneManualReason, zoneAssignedAt: address.zoneAssignedAt }
      : autoZoneColumns(mapping, ctx.now, address.referenceSourceManual, address.referenceSourceReason);
  const [after] = await tx
    .update(customerAddresses)
    .set({
      lat: point.lat,
      lng: point.lng,
      coordinateStatus: "locked",
      coordinateSource: source,
      coordinateLockedAt: ctx.now,
      coordinateLockedBy: ctx.userId,
      proposedLat: null,
      proposedLng: null,
      proposedAt: null,
      ...zoneCols,
    })
    .where(eq(customerAddresses.id, address.id))
    .returning();
  return after!;
}

const pointSchema = z.object({ lat: latSchema, lng: lngSchema });

/** Isi/kunci koordinat alamat dari peta → zona Otomatis (US-M1-01 KP-2, US-M1-05 KP-3). */
export async function setAddressCoordinates(ctx: ActorContext, addressId: string, input: LatLng, opts: { tx?: Tx } = {}): Promise<AddressRow> {
  await authorize(ctx, "m1.customer.lock_coordinate", { tx: opts.tx, objectType: "customer_address", objectId: addressId });
  const point = parseInput(pointSchema, input, { lat: "Lintang", lng: "Bujur" });
  return runService(ctx, opts, async (tx) => {
    const { address, customer } = await loadAddress(tx, ctx, addressId, { forUpdate: true });
    const after = await applyCoordinates(tx, ctx, { ...address, zoneAssignment: address.coordinateStatus === "locked" ? address.zoneAssignment : "auto" }, customer.tenantId, point, "map");
    await auditRecord(tx, {
      ctx,
      objectType: "customer_address",
      objectId: addressId,
      action: "update",
      before: { lat: address.lat, lng: address.lng, coordinateStatus: address.coordinateStatus, tariffZoneId: address.tariffZoneId },
      after: { lat: after.lat, lng: after.lng, coordinateStatus: after.coordinateStatus, tariffZoneId: after.tariffZoneId, distanceM: after.distanceM },
      rule: "US-M1-01 KP-2",
    });
    return after;
  });
}

/** Tetapkan zona manual beralasan (alamat tanpa koordinat / di batas zona) — US-M1-05 KP-3. */
export async function setAddressManualZone(ctx: ActorContext, addressId: string, input: { zoneId: string; reason: string }, opts: { tx?: Tx } = {}): Promise<AddressRow> {
  await authorize(ctx, "m1.customer.update", { tx: opts.tx, objectType: "customer_address", objectId: addressId });
  const data = parseInput(z.object({ zoneId: z.uuid({ error: "Pilih zona." }), reason: z.string().trim().min(3, { error: "Alasan zona manual wajib diisi (minimal 3 karakter)." }) }), input);
  return runService(ctx, opts, async (tx) => {
    const { address, customer } = await loadAddress(tx, ctx, addressId, { forUpdate: true });
    const zone = await loadZone(tx, ctx, data.zoneId);
    if (zone.tenantId !== customer.tenantId) throw ValidationError.field("zoneId", "Zona tidak dikenal.");
    const [after] = await tx
      .update(customerAddresses)
      .set({ tariffZoneId: zone.id, zoneBoundaryId: null, zoneAssignment: "manual", zoneManualReason: data.reason, zoneAssignedAt: ctx.now })
      .where(eq(customerAddresses.id, addressId))
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "customer_address",
      objectId: addressId,
      action: "update",
      before: { tariffZoneId: address.tariffZoneId, zoneAssignment: address.zoneAssignment },
      after: { tariffZoneId: zone.id, zoneAssignment: "manual" },
      reason: data.reason,
      rule: "US-M1-05 KP-3",
    });
    return after!;
  });
}

/** Kembalikan zona ke Otomatis (butuh koordinat). */
export async function clearAddressManualZone(ctx: ActorContext, addressId: string, reason: string, opts: { tx?: Tx } = {}): Promise<AddressRow> {
  await authorize(ctx, "m1.customer.update", { tx: opts.tx, objectType: "customer_address", objectId: addressId });
  const cleanReason = parseInput(z.string().trim().min(3, { error: "Alasan wajib diisi." }), reason);
  return runService(ctx, opts, async (tx) => {
    const { address, customer } = await loadAddress(tx, ctx, addressId, { forUpdate: true });
    if (address.lat === null || address.lng === null) throw new DomainError("NO_COORDINATES", "Alamat belum berkoordinat; zona otomatis butuh koordinat. Kunci koordinat dulu.");
    const mapping = await mapAddressToZone(tx, { lat: address.lat, lng: address.lng, tenantId: customer.tenantId, date: ctxBusinessDate(ctx), referenceWaterSourceId: address.referenceSourceManual ? address.referenceWaterSourceId : null });
    const [after] = await tx
      .update(customerAddresses)
      .set(autoZoneColumns(mapping, ctx.now, address.referenceSourceManual, address.referenceSourceReason))
      .where(eq(customerAddresses.id, addressId))
      .returning();
    await auditRecord(tx, { ctx, objectType: "customer_address", objectId: addressId, action: "update", before: { tariffZoneId: address.tariffZoneId, zoneAssignment: address.zoneAssignment }, after: { tariffZoneId: after!.tariffZoneId, zoneAssignment: "auto" }, reason: cleanReason });
    return after!;
  });
}

/** Ubah sumber air acuan alamat beralasan (PTB-02) — `null` kembali ke sumber terdekat. */
export async function setAddressReferenceSource(ctx: ActorContext, addressId: string, input: { waterSourceId: string | null; reason: string }, opts: { tx?: Tx } = {}): Promise<AddressRow> {
  await authorize(ctx, "m1.customer.update", { tx: opts.tx, objectType: "customer_address", objectId: addressId });
  const data = parseInput(z.object({ waterSourceId: z.uuid().nullable(), reason: z.string().trim().min(3, { error: "Alasan wajib diisi (minimal 3 karakter)." }) }), input);
  return runService(ctx, opts, async (tx) => {
    const { address, customer } = await loadAddress(tx, ctx, addressId, { forUpdate: true });
    if (address.lat === null || address.lng === null) throw new DomainError("NO_COORDINATES", "Alamat belum berkoordinat; kunci koordinat dulu sebelum mengubah sumber acuan.");
    if (data.waterSourceId) {
      const s = await tx.select({ tenantId: waterSources.tenantId, isActive: waterSources.isActive }).from(waterSources).where(eq(waterSources.id, data.waterSourceId)).limit(1);
      if (!s[0] || s[0].tenantId !== customer.tenantId || !s[0].isActive) throw ValidationError.field("waterSourceId", "Sumber air tidak dikenal atau nonaktif.");
    }
    const mapping = await mapAddressToZone(tx, { lat: address.lat, lng: address.lng, tenantId: customer.tenantId, date: ctxBusinessDate(ctx), referenceWaterSourceId: data.waterSourceId });
    const cols = autoZoneColumns(mapping, ctx.now, data.waterSourceId !== null, data.reason);
    const patch =
      address.zoneAssignment === "manual"
        ? { ...cols, tariffZoneId: address.tariffZoneId, zoneBoundaryId: address.zoneBoundaryId, zoneAssignment: "manual" as const, zoneManualReason: address.zoneManualReason, zoneAssignedAt: address.zoneAssignedAt }
        : cols;
    const [after] = await tx.update(customerAddresses).set(patch).where(eq(customerAddresses.id, addressId)).returning();
    await auditRecord(tx, {
      ctx,
      objectType: "customer_address",
      objectId: addressId,
      action: "update",
      before: { referenceWaterSourceId: address.referenceWaterSourceId, distanceM: address.distanceM, tariffZoneId: address.tariffZoneId },
      after: { referenceWaterSourceId: after!.referenceWaterSourceId, distanceM: after!.distanceM, tariffZoneId: after!.tariffZoneId },
      reason: data.reason,
      rule: "PTB-02",
    });
    return after!;
  });
}

/**
 * Usulan kunci koordinat dari lokasi Selesai rit (handler `trip.completed`, US-M1-01 KP-2, BRD 10.2): hanya untuk
 * alamat "Belum dikunci" tanpa usulan lain; Dispatcher diberi tahu untuk mengonfirmasi. Idempoten per rit.
 */
export async function proposeCoordinateFromTrip(tx: Tx, input: { tripId: string; tenantId: string; now: Date }): Promise<{ proposed: boolean; addressId?: string }> {
  const rows = await tx
    .select({ trip: trips, address: customerAddresses, customerName: customers.name, customerId: customers.id })
    .from(trips)
    .innerJoin(customerAddresses, eq(customerAddresses.id, trips.addressId))
    .innerJoin(customers, eq(customers.id, customerAddresses.customerId))
    .where(eq(trips.id, input.tripId))
    .limit(1);
  const row = rows[0];
  if (!row) return { proposed: false };
  const { trip, address } = row;
  if (trip.isInternal || address.coordinateStatus === "locked") return { proposed: false };
  if (trip.completedLat === null || trip.completedLng === null || !isValidLatLng({ lat: trip.completedLat, lng: trip.completedLng })) return { proposed: false };
  if (address.proposedFromTripId === trip.id || address.proposedLat !== null) return { proposed: false };
  const ctx = systemContext({ tenantId: input.tenantId, now: input.now });
  await tx
    .update(customerAddresses)
    .set({ proposedLat: trip.completedLat, proposedLng: trip.completedLng, proposedFromTripId: trip.id, proposedAt: input.now })
    .where(eq(customerAddresses.id, address.id));
  await auditRecord(tx, {
    ctx,
    objectType: "customer_address",
    objectId: address.id,
    action: "update",
    after: { proposedLat: trip.completedLat, proposedLng: trip.completedLng, proposedFromTripId: trip.id },
    reason: `Usulan koordinat dari lokasi Selesai rit ${trip.number}.`,
    rule: "US-M1-01 KP-2",
  });
  await notify(tx, {
    event: "address.coordinate_proposed",
    tenantId: input.tenantId,
    title: `Usulan koordinat: ${row.customerName}`,
    body: `Lokasi Selesai rit ${trip.number} diusulkan sebagai koordinat alamat "${address.label}". Konfirmasi atau tolak.`,
    objectType: "customer_address",
    objectId: address.id,
    link: `/master/pelanggan/${row.customerId}#alamat-${address.id}`,
    now: input.now,
  });
  return { proposed: true, addressId: address.id };
}

/** Dispatcher mengonfirmasi usulan koordinat → Dikunci (sumber "Lokasi Selesai rit pertama") + zona otomatis. */
export async function confirmCoordinateProposal(ctx: ActorContext, addressId: string, opts: { tx?: Tx } = {}): Promise<AddressRow> {
  await authorize(ctx, "m1.customer.lock_coordinate", { tx: opts.tx, objectType: "customer_address", objectId: addressId });
  return runService(ctx, opts, async (tx) => {
    const { address, customer } = await loadAddress(tx, ctx, addressId, { forUpdate: true });
    if (address.proposedLat === null || address.proposedLng === null) throw new DomainError("NO_PROPOSAL", "Tidak ada usulan koordinat untuk alamat ini.");
    const after = await applyCoordinates(tx, ctx, { ...address, zoneAssignment: "auto" }, customer.tenantId, { lat: address.proposedLat, lng: address.proposedLng }, "first_delivery");
    await auditRecord(tx, {
      ctx,
      objectType: "customer_address",
      objectId: addressId,
      action: "update",
      before: { coordinateStatus: address.coordinateStatus, tariffZoneId: address.tariffZoneId, zoneAssignment: address.zoneAssignment },
      after: { lat: after.lat, lng: after.lng, coordinateStatus: "locked", coordinateSource: "first_delivery", tariffZoneId: after.tariffZoneId, zoneAssignment: after.zoneAssignment },
      reason: "Konfirmasi usulan koordinat dari rit Selesai.",
      rule: "US-M1-01 KP-2",
    });
    return after;
  });
}

/** Dispatcher menolak usulan koordinat (beralasan); alamat tetap Belum dikunci. */
export async function rejectCoordinateProposal(ctx: ActorContext, addressId: string, reason: string, opts: { tx?: Tx } = {}): Promise<AddressRow> {
  await authorize(ctx, "m1.customer.lock_coordinate", { tx: opts.tx, objectType: "customer_address", objectId: addressId });
  const cleanReason = parseInput(z.string().trim().min(3, { error: "Alasan menolak wajib diisi." }), reason);
  return runService(ctx, opts, async (tx) => {
    const { address } = await loadAddress(tx, ctx, addressId, { forUpdate: true });
    if (address.proposedLat === null) throw new DomainError("NO_PROPOSAL", "Tidak ada usulan koordinat untuk alamat ini.");
    const [after] = await tx.update(customerAddresses).set({ proposedLat: null, proposedLng: null, proposedAt: null }).where(eq(customerAddresses.id, addressId)).returning();
    await auditRecord(tx, { ctx, objectType: "customer_address", objectId: addressId, action: "reject", before: { proposedLat: address.proposedLat, proposedLng: address.proposedLng }, after: { proposedLat: null }, reason: cleanReason, rule: "US-M1-01 KP-2" });
    return after!;
  });
}

// =====================================================================================================================
// Pencarian & ringkasan (KP-9; US-M2-01 KP-1, US-M2-08)
// =====================================================================================================================

export type CustomerSearchResult = {
  id: string;
  code: string | null;
  name: string;
  segment: CustomerSegment;
  waPhone: string | null;
  creditStatus: CustomerRow["creditStatus"];
  isActive: boolean;
  notes: string | null;
  fixedReceiveTime: string | null;
  addresses: { id: string; label: string; addressText: string; zoneId: string | null; zoneCode: string | null; coordinateStatus: AddressRow["coordinateStatus"] }[];
  /** Alamat terakhir dipakai pesanan (bawaan layar pesanan M2). */
  lastAddressId: string | null;
};

/**
 * Cari pelanggan (nama/WA/alamat) setelah ≥ 2 karakter (US-M2-01 KP-1: ≤ 1 detik). Nomor WA disamarkan bagi peran
 * tanpa izin data pribadi.
 */
export async function searchCustomers(ctx: ActorContext, q: string, opts: { limit?: number; includeInactive?: boolean; tx?: Tx } = {}): Promise<CustomerSearchResult[]> {
  await authorize(ctx, "m1.customer.read", { tx: opts.tx });
  const term = (q ?? "").trim();
  if (term.length < 2) return [];
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const tx = opts.tx ?? getDb();
  const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const digits = term.replace(/\D/g, "");
  const waDigits = digits.startsWith("0") ? digits.slice(1) : digits.startsWith("62") ? digits.slice(2) : digits;
  const matchers = [
    ilike(customers.name, like),
    ilike(customers.code, like),
    sql`exists (select 1 from ${customerAddresses} ca where ca.customer_id = ${customers.id} and ca.is_active and ca.address_text ilike ${like})`,
  ];
  if (waDigits.length >= 2) matchers.push(sql`${customers.waPhone} like ${`%${waDigits}%`}`);
  const conds = [eq(customers.tenantId, ctx.tenantId), isNull(customers.anonymizedAt), or(...matchers)];
  if (!opts.includeInactive) conds.push(eq(customers.isActive, true));
  const rows = await tx
    .select()
    .from(customers)
    .where(and(...conds))
    .orderBy(sql`case when lower(${customers.name}) like ${`${term.toLowerCase()}%`} then 0 else 1 end`, asc(customers.name))
    .limit(limit);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const addrs = await tx
    .select({ a: customerAddresses, zoneCode: tariffZones.code })
    .from(customerAddresses)
    .leftJoin(tariffZones, eq(tariffZones.id, customerAddresses.tariffZoneId))
    .where(and(inArray(customerAddresses.customerId, ids), eq(customerAddresses.isActive, true)))
    .orderBy(asc(customerAddresses.createdAt));
  const lastOrders = await tx
    .select({ customerId: orders.customerId, addressId: orders.addressId, createdAt: orders.createdAt })
    .from(orders)
    .where(inArray(orders.customerId, ids))
    .orderBy(desc(orders.createdAt));
  const lastByCustomer = new Map<string, string>();
  for (const o of lastOrders) if (!lastByCustomer.has(o.customerId)) lastByCustomer.set(o.customerId, o.addressId);
  const pii = can(ctx, "m1.customer_pii.read");
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    segment: r.segment,
    waPhone: pii ? r.waPhone : null,
    creditStatus: r.creditStatus,
    isActive: r.isActive,
    notes: r.notes,
    fixedReceiveTime: r.fixedReceiveTime,
    addresses: addrs
      .filter((a) => a.a.customerId === r.id)
      .map((a) => ({ id: a.a.id, label: a.a.label, addressText: pii ? a.a.addressText : redactAddressText(a.a.addressText), zoneId: a.a.tariffZoneId, zoneCode: a.zoneCode, coordinateStatus: a.a.coordinateStatus })),
    lastAddressId: lastByCustomer.get(r.id) ?? addrs.find((a) => a.a.customerId === r.id)?.a.id ?? null,
  }));
}

function redactAddressText(text: string): string {
  const parts = text.split(",");
  return parts.length > 1 ? `…, ${parts[parts.length - 1]!.trim()}` : "…";
}

export type CustomerSummary = {
  customerId: string;
  name: string;
  segment: CustomerSegment;
  creditStatus: CustomerRow["creditStatus"];
  creditLimit: number;
  paymentTermDays: number;
  /** Saldo piutang M5 (faktur terbuka + rit belum ditagih; US-M5-01 KP-3, B-32). */
  openReceivable: number;
  /** Nilai rit tempo pesanan berjalan (Baru/Menunggu persetujuan/Terjadwal/Dalam pengiriman) — BR-06. */
  openCreditOrders: number;
  /** Penjualan tempo toko belum difakturkan (bagian eksposur lintas lini, B-35). */
  uninvoicedStoreCredit: number;
  /** Batas tersisa = batas − eksposur M5 `computeExposure` (BR-06, PTB-25). */
  remainingLimit: number;
  lastOrders: { id: string; number: string; requestedDate: string; tankCount: number; status: string; trucks: string[]; totalAmount: number }[];
  /** Rata-rata jarak (hari) antar pesanan; null bila < 2 pesanan. */
  averageDaysBetweenOrders: number | null;
  notes: string | null;
  fixedReceiveTime: string | null;
  activeSpecialPrices: { id: string; productId: string; productName: string; price: number; validFrom: string; reviewDate: string; reviewOverdue: boolean }[];
  isStorePartner: boolean;
};

/**
 * Ringkasan pelanggan (US-M1-01 KP-9, US-M2-08 KP-1): piutang terbuka & batas tersisa (BR-06), 10 pesanan terakhir,
 * rata-rata jarak antar pesanan, catatan khusus, harga khusus aktif.
 */
export async function getCustomerSummary(ctx: ActorContext, customerId: string, opts: { tx?: Tx; date?: BusinessDate } = {}): Promise<CustomerSummary> {
  await authorize(ctx, "m1.customer.read", { tx: opts.tx, objectType: "customer", objectId: customerId });
  const tx = opts.tx ?? getDb();
  const customer = await loadCustomer(tx, ctx, customerId);
  const date = opts.date ?? ctxBusinessDate(ctx);
  // Saldo & eksposur dari M5 — satu definisi dengan kartu piutang, kontrol kredit M2 & tempo toko M7 (B-32, B-35).
  const exposure = await computeExposure(tx, customerId, { asOf: date });
  const last = await tx
    .select({ id: orders.id, number: orders.number, requestedDate: orders.requestedDate, tankCount: orders.tankCount, status: orders.status, totalAmount: orders.totalAmount })
    .from(orders)
    .where(eq(orders.customerId, customerId))
    .orderBy(desc(orders.requestedDate), desc(orders.createdAt))
    .limit(10);
  const truckRows = last.length
    ? await tx
        .selectDistinct({ orderId: trips.orderId, code: trucks.code })
        .from(trips)
        .innerJoin(trucks, eq(trucks.id, trips.truckId))
        .where(inArray(trips.orderId, last.map((o) => o.id)))
    : [];
  const history = await tx
    .select({ requestedDate: orders.requestedDate })
    .from(orders)
    .where(and(eq(orders.customerId, customerId), ne(orders.status, "cancelled")))
    .orderBy(asc(orders.requestedDate));
  const dates = [...new Set(history.map((h) => h.requestedDate))];
  let averageDaysBetweenOrders: number | null = null;
  if (dates.length >= 2) {
    let total = 0;
    for (let i = 1; i < dates.length; i++) total += daysBetween(dates[i - 1]!, dates[i]!);
    averageDaysBetweenOrders = Math.round((total / (dates.length - 1)) * 10) / 10;
  }
  const sp = await tx
    .select({ s: specialPrices, productName: products.name })
    .from(specialPrices)
    .innerJoin(products, eq(products.id, specialPrices.productId))
    .where(and(eq(specialPrices.customerId, customerId), eq(specialPrices.status, "active")))
    .orderBy(desc(specialPrices.validFrom));
  const activeSpecial: CustomerSummary["activeSpecialPrices"] = [];
  const seen = new Set<string>();
  for (const r of sp) {
    if (seen.has(r.s.productId)) continue;
    const current = await getActiveSpecialPrice(tx, customerId, r.s.productId, date);
    if (!current) continue;
    seen.add(r.s.productId);
    activeSpecial.push({ id: current.id, productId: current.productId, productName: r.productName, price: current.price, validFrom: current.validFrom, reviewDate: current.reviewDate, reviewOverdue: current.reviewDate <= date });
  }
  return {
    customerId,
    name: customer.name,
    segment: customer.segment,
    creditStatus: customer.creditStatus,
    creditLimit: customer.creditLimit,
    paymentTermDays: customer.paymentTermDays,
    openReceivable: exposure.balance,
    openCreditOrders: exposure.openCreditOrders,
    uninvoicedStoreCredit: exposure.uninvoicedStoreCredit,
    remainingLimit: exposure.remaining,
    lastOrders: last.map((o) => ({ ...o, trucks: truckRows.filter((t) => t.orderId === o.id).map((t) => t.code) })),
    averageDaysBetweenOrders,
    notes: customer.notes,
    fixedReceiveTime: customer.fixedReceiveTime,
    activeSpecialPrices: activeSpecial,
    isStorePartner: customer.isStorePartner,
  };
}

// =====================================================================================================================
// Daftar & rincian untuk layar kantor
// =====================================================================================================================

export type CustomerListRow = {
  id: string;
  code: string | null;
  name: string;
  segment: CustomerSegment;
  waPhone: string | null;
  creditStatus: CustomerRow["creditStatus"];
  creditLimit: number;
  isStorePartner: boolean;
  isActive: boolean;
  isInitialData: boolean;
  addressCount: number;
  unlockedCount: number;
  zones: string;
};

/** Daftar pelanggan (tanpa pelanggan internal depot). */
export async function listCustomers(
  ctx: ActorContext,
  filter: { segment?: CustomerSegment; creditStatus?: CustomerRow["creditStatus"]; status?: "active" | "inactive" | "all"; q?: string } = {},
  opts: { tx?: Tx } = {},
): Promise<CustomerListRow[]> {
  await authorize(ctx, "m1.customer.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const conds = [eq(customers.tenantId, ctx.tenantId), isNull(customers.internalOutletId)];
  if (filter.segment) conds.push(eq(customers.segment, filter.segment));
  if (filter.creditStatus) conds.push(eq(customers.creditStatus, filter.creditStatus));
  if (filter.status !== "all") conds.push(eq(customers.isActive, filter.status !== "inactive"));
  const rows = await tx.select().from(customers).where(and(...conds)).orderBy(asc(customers.name));
  const ids = rows.map((r) => r.id);
  const addrs = ids.length
    ? await tx
        .select({ customerId: customerAddresses.customerId, status: customerAddresses.coordinateStatus, zone: tariffZones.code })
        .from(customerAddresses)
        .leftJoin(tariffZones, eq(tariffZones.id, customerAddresses.tariffZoneId))
        .where(and(inArray(customerAddresses.customerId, ids), eq(customerAddresses.isActive, true)))
    : [];
  const pii = can(ctx, "m1.customer_pii.read");
  return rows.map((r) => {
    const mine = addrs.filter((a) => a.customerId === r.id);
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      segment: r.segment,
      waPhone: pii ? r.waPhone : null,
      creditStatus: r.creditStatus,
      creditLimit: r.creditLimit,
      isStorePartner: r.isStorePartner,
      isActive: r.isActive,
      isInitialData: r.isInitialData,
      addressCount: mine.length,
      unlockedCount: mine.filter((a) => a.status === "unlocked").length,
      zones: [...new Set(mine.map((a) => a.zone ?? "—"))].join(", "),
    };
  });
}

/** Rincian pelanggan untuk layar /master/pelanggan/[id]. */
export async function getCustomerDetail(ctx: ActorContext, customerId: string, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m1.customer.read", { tx: opts.tx, objectType: "customer", objectId: customerId });
  const tx = opts.tx ?? getDb();
  const customer = await loadCustomer(tx, ctx, customerId);
  const addresses = await tx
    .select({ a: customerAddresses, zoneCode: tariffZones.code, zoneName: tariffZones.name, sourceName: waterSources.name })
    .from(customerAddresses)
    .leftJoin(tariffZones, eq(tariffZones.id, customerAddresses.tariffZoneId))
    .leftJoin(waterSources, eq(waterSources.id, customerAddresses.referenceWaterSourceId))
    .where(eq(customerAddresses.customerId, customerId))
    .orderBy(desc(customerAddresses.isActive), asc(customerAddresses.createdAt));
  const creditHistory = await tx.select().from(customerCreditHistory).where(eq(customerCreditHistory.customerId, customerId)).orderBy(desc(customerCreditHistory.changedAt));
  const special = await tx
    .select({ s: specialPrices, productName: products.name })
    .from(specialPrices)
    .innerJoin(products, eq(products.id, specialPrices.productId))
    .where(eq(specialPrices.customerId, customerId))
    .orderBy(desc(specialPrices.createdAt));
  const pii = can(ctx, "m1.customer_pii.read");
  return {
    customer: pii ? customer : { ...customer, waPhone: "" },
    addresses: addresses.map((r) => ({ ...r.a, addressText: pii ? r.a.addressText : redactAddressText(r.a.addressText), zoneCode: r.zoneCode, zoneName: r.zoneName, referenceSourceName: r.sourceName })),
    creditHistory,
    specialPrices: special.map((r) => ({ ...r.s, productName: r.productName })),
  };
}

/** Alamat dengan usulan koordinat yang menunggu konfirmasi Dispatcher. */
export async function listCoordinateProposals(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m1.customer.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  return tx
    .select({
      addressId: customerAddresses.id,
      customerId: customers.id,
      customerName: customers.name,
      label: customerAddresses.label,
      addressText: customerAddresses.addressText,
      proposedLat: customerAddresses.proposedLat,
      proposedLng: customerAddresses.proposedLng,
      proposedAt: customerAddresses.proposedAt,
      tripNumber: trips.number,
    })
    .from(customerAddresses)
    .innerJoin(customers, eq(customers.id, customerAddresses.customerId))
    .leftJoin(trips, eq(trips.id, customerAddresses.proposedFromTripId))
    .where(and(eq(customers.tenantId, ctx.tenantId), isNotNull(customerAddresses.proposedLat), eq(customerAddresses.coordinateStatus, "unlocked"), eq(customerAddresses.isActive, true)))
    .orderBy(asc(customerAddresses.proposedAt));
}

/**
 * Kemajuan kunci koordinat alamat (US-M1-06 KP-5): % alamat aktif pelanggan (bukan internal) yang Dikunci, plus hari
 * ke-N dari jendela pelengkapan (`m1.master_rules.coordinate_completion_days`, sejak go-live PAR-41 bila diisi).
 */
export async function coordinateLockProgress(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorizeAnyRead(ctx, opts.tx);
  const tx = opts.tx ?? getDb();
  const rows = await tx
    .select({ status: customerAddresses.coordinateStatus, n: count() })
    .from(customerAddresses)
    .innerJoin(customers, eq(customers.id, customerAddresses.customerId))
    .where(and(eq(customers.tenantId, ctx.tenantId), isNull(customers.internalOutletId), eq(customers.isActive, true), eq(customerAddresses.isActive, true)))
    .groupBy(customerAddresses.coordinateStatus);
  const locked = Number(rows.find((r) => r.status === "locked")?.n ?? 0);
  const unlocked = Number(rows.find((r) => r.status === "unlocked")?.n ?? 0);
  const total = locked + unlocked;
  const today = ctxBusinessDate(ctx);
  const rules = await masterRules(tx, today);
  const par41 = await params.get(tx, "PAR-41", today);
  const goLive = par41.go_live_date;
  const dayOfWindow = goLive ? daysBetween(goLive, today) + 1 : null;
  return {
    total,
    locked,
    unlocked,
    percentLocked: total === 0 ? 100 : Math.round((locked / total) * 1000) / 10,
    windowDays: rules.coordinate_completion_days,
    goLiveDate: goLive,
    dayOfWindow,
    windowEnded: dayOfWindow !== null && dayOfWindow > rules.coordinate_completion_days,
  };
}

async function authorizeAnyRead(ctx: ActorContext, tx?: Tx) {
  if (can(ctx, "m1.customer.read") || can(ctx, "m1.import.read") || can(ctx, "m1.data_signoff.read")) return;
  await authorize(ctx, "m1.customer.read", { tx });
}

/** Pelanggan (untuk tampilan) berdasarkan ID — tanpa otorisasi (internal modul). */
export async function customerNameMap(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.select({ id: customers.id, name: customers.name }).from(customers).where(inArray(customers.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export const _internal = { normalizeText };

/** NotFound pembantu (dipakai modul lain lewat index). */
export function assertCustomerFound(row: CustomerRow | undefined): asserts row is CustomerRow {
  if (!row) throw new NotFoundError("Pelanggan tidak ditemukan.");
}
