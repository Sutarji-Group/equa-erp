/**
 * P3 — kait event Tahap 3 (flag `phase3.partner_portal`; handler selalu terdaftar dan memeriksa flag/keadaan sendiri).
 *
 * - `order.created` (isolate: false): pesanan air mitra saat penghentian pasokan sementara berlaku → DITOLAK
 *   (transaksi M2 dibatalkan dengan pesan alasan & syarat pemulihan; US-P3-07 KP-1).
 * - `shift.opened` (isolate: false): tenant mitra mode baca-saja (US-P3-02 KP-4) tidak dapat membuka shift POS baru.
 * - `pos_sale.recorded`: konfirmasi pesanan spare part portal (US-P3-03 KP-3) — lihat portal-orders.ts.
 * - `credit_status.changed`: Ditahan pelanggan mitra → pemicu sanksi "tunggakan" (US-P3-03 KP-2, US-P3-04 KP-3).
 */
import "server-only";

import { eq } from "drizzle-orm";

import { outlets, tenants } from "@/db/schema";
import { formatTanggal, toBusinessDate } from "@/lib/time";

import type { Tx } from "@/server/core/db";
import type { DomainEvent } from "@/server/core/events";
import { DomainError } from "@/server/core/errors";

import { portalEnabled } from "./common";
import { activeSupplySuspension, partnerTenantOfCustomer, recordSanctionTrigger } from "./sanctions";

export { confirmSparePartOrderFromSale } from "./portal-orders";

/** Penghentian pasokan sementara: pesanan air mitra (dari kantor maupun portal) ditolak. */
export async function rejectOrderWhenSupplySuspended(tx: Tx, event: DomainEvent<"order.created">): Promise<void> {
  const p = event.payload;
  if (p.isInternal || p.status === "cancelled") return;
  const partnerTenantId = await partnerTenantOfCustomer(tx, p.customerId);
  if (!partnerTenantId || !(await portalEnabled(tx, partnerTenantId))) return;
  const date = event.businessDate ?? toBusinessDate(event.occurredAt);
  const suspension = await activeSupplySuspension(tx, partnerTenantId, date);
  if (!suspension) return;
  const d = (suspension.triggerDetail ?? {}) as { recoveryConditions?: string };
  throw new DomainError(
    "PARTNER_SUPPLY_SUSPENDED",
    `Pesanan air mitra ini diblokir: sanksi penghentian pasokan sementara berlaku sejak ${formatTanggal(suspension.effectiveFrom ?? date, { weekday: false })} (${suspension.decisionReason ?? "keputusan pemilik"}). Syarat pemulihan: ${d.recoveryConditions ?? "lihat halaman sanksi mitra"}. Pesanan baru dapat dibuat setelah pemilik mencabut sanksi.`,
  );
}

/** Tenant mitra mode baca-saja → shift POS baru ditolak (data lama tetap dapat dilihat). */
export async function rejectShiftWhenReadOnly(tx: Tx, event: DomainEvent<"shift.opened">): Promise<void> {
  const [row] = await tx
    .select({ kind: tenants.kind, readOnly: tenants.readOnly, name: tenants.name })
    .from(outlets)
    .innerJoin(tenants, eq(tenants.id, outlets.tenantId))
    .where(eq(outlets.id, event.payload.outletId))
    .limit(1);
  if (!row || row.kind !== "partner" || !row.readOnly) return;
  throw new DomainError(
    "TENANT_READ_ONLY",
    "POS mitra dalam mode baca-saja karena tunggakan tagihan setelah teguran. Lunasi tagihan EQUA lalu coba buka shift lagi; data lama tetap dapat dilihat.",
  );
}

/** Ditahan pelanggan mitra → pemicu sanksi (bukan blokir diam-diam; US-P3-03 KP-2). */
export async function triggerOnCreditHold(tx: Tx, event: DomainEvent<"credit_status.changed">): Promise<void> {
  const p = event.payload;
  if (p.to !== "on_hold") return;
  const partnerTenantId = await partnerTenantOfCustomer(tx, p.customerId);
  if (!partnerTenantId) return;
  await recordSanctionTrigger(tx, {
    partnerTenantId,
    trigger: "overdue",
    key: `credit_hold:${p.customerId}:${toBusinessDate(event.occurredAt)}`,
    summary: `Status kredit pelanggan mitra menjadi Ditahan: ${p.reason ?? "tagihan lewat tempo"}.`,
    detail: { customerId: p.customerId, from: p.from },
    now: event.occurredAt,
  });
}
