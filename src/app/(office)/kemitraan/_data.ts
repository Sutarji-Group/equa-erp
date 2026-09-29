import "server-only";

import { getDb } from "@/server/core/db";
import * as p3 from "@/server/modules/p3-partner";

/** Flag Tahap 3 `phase3.partner_portal` (global) untuk halaman kantor Kemitraan. */
export async function phase3Enabled(): Promise<boolean> {
  return p3.portalEnabled(getDb());
}

/** Istilah program: "Mitra Depot EQUA" kecuali flag `partner.franchise_terms` aktif. */
export async function terms(): Promise<p3.PartnerTerms> {
  return p3.partnerTerms(getDb());
}

/** Bulan 'YYYY-MM' dari query `?bulan=` (bila sah) atau bulan berjalan. */
export function monthParam(value: string | undefined, today: string): string {
  return value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : today.slice(0, 7);
}
