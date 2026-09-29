/**
 * Data awal KHUSUS uji E2E skenario lintas modul (docs/qa/skenario-uji.md) — dipanggil `pnpm e2e:prepare` saja, TIDAK
 * termasuk `runSeed` (dev/demo/uji Vitest tidak berubah). Idempoten (ID deterministik + ON CONFLICT DO NOTHING).
 *
 * P-05 (piutang) butuh pelanggan Tempo yang BERSIH (tanpa faktur/pesanan demo) agar alur rit tempo → faktur →
 * pengingat H-3/H+1 → pelunasan lewat sopir → lewat tempo > PAR-09 → Ditahan otomatis → pesanan tempo ditolak → lunas
 * → lepas dapat diperiksa angka demi angka. Status Tempo baru tidak dapat diberikan lewat UI tanpa riwayat pesanan
 * (PAR-11, US-M1-01 KP-4), jadi pelanggan disiapkan seperti hasil impor data awal yang sudah ditandatangani.
 */
import type { LatLng } from "@/lib/geo";

import type { DbOrTx } from "../client";
import { customerAddresses, customerCreditHistory, customers } from "../schema";
import { tariffZoneBoundaryId, tariffZoneId, zoneCodeForDistance } from "./catalog";
import { customerId, nearestSource } from "./customers";
import { seedId } from "./ids";
import { EQUA_TENANT_ID, waterSourceId } from "./org";

export type E2eScenarioCustomer = {
  code: string;
  name: string;
  address: string;
  point: LatLng;
  creditLimit: number;
  paymentTermDays: number;
  waPhone: string;
  contactName: string;
};

/** Pelanggan Tempo skenario P-05 (industri, tempo 14 hari = PAR-08, batas Rp 5.000.000). */
export const E2E_P05_CUSTOMER: E2eScenarioCustomer = {
  code: "PLG-0951",
  name: "CV Bata Merah Sukamanah",
  address: "Jl. Raya Sukamanah No. 17 (gudang bata), Karangtengah",
  point: { lat: -6.8215, lng: 107.1905 },
  creditLimit: 5_000_000,
  paymentTermDays: 14,
  waPhone: "6281399990951",
  contactName: "Pak Dudi (gudang)",
};

export async function seedE2eScenarioData(tx: DbOrTx): Promise<void> {
  const now = new Date();
  const c = E2E_P05_CUSTOMER;
  const id = customerId(c.code);
  await tx
    .insert(customers)
    .values({
      id,
      tenantId: EQUA_TENANT_ID,
      code: c.code,
      name: c.name,
      segment: "industry",
      waPhone: c.waPhone,
      contactName: c.contactName,
      notes: "Pelanggan data awal skenario E2E P-05 (piutang).",
      creditStatus: "credit",
      creditLimit: c.creditLimit,
      paymentTermDays: c.paymentTermDays,
      isInitialData: true,
    })
    .onConflictDoNothing();
  const src = nearestSource(c.point);
  await tx
    .insert(customerAddresses)
    .values({
      id: seedId(`address:${c.code}:utama`),
      customerId: id,
      label: "Utama",
      addressText: c.address,
      lat: c.point.lat,
      lng: c.point.lng,
      coordinateStatus: "locked",
      coordinateSource: "import",
      coordinateLockedAt: now,
      tariffZoneId: tariffZoneId(zoneCodeForDistance(src.distanceM)),
      zoneAssignment: "auto",
      zoneBoundaryId: tariffZoneBoundaryId(zoneCodeForDistance(src.distanceM)),
      zoneAssignedAt: now,
      referenceWaterSourceId: waterSourceId(src.code),
      distanceM: src.distanceM,
      distanceMethod: "straight_line_x1_3",
      distanceNeedsRecalc: true,
    })
    .onConflictDoNothing();
  await tx
    .insert(customerCreditHistory)
    .values({
      id: seedId(`credit_history:${c.code}:credit`),
      customerId: id,
      fromStatus: "cash",
      toStatus: "credit",
      creditLimitBefore: 0,
      creditLimitAfter: c.creditLimit,
      termDaysBefore: c.paymentTermDays,
      termDaysAfter: c.paymentTermDays,
      reason: "Status Tempo dari data awal (skenario E2E P-05) — disetujui pemilik.",
      rule: null,
      changedAt: now,
    })
    .onConflictDoNothing();
}
