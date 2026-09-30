import "server-only";

import { getDb } from "@/server/core/db";
import * as p3 from "@/server/modules/p3-partner";

/**
 * Flag Tahap 3 `phase3.partner_portal` untuk halaman kantor Kemitraan. Tanpa `tenantId` = nilai GLOBAL (calon mitra &
 * pendaftaran publik). Dengan `tenantId` pelaku (tenant EQUA) = nilai untuk tenant itu (atau global) — tambahan S5-C:
 * uji coba Tahap 3 per mitra (flag dinyalakan untuk tenant mitra + tenant EQUA, global tetap mati) menampilkan layar
 * mutu/sanksi/dasbor/onboarding kantor, sama dengan menu (registri navigasi membaca flag tenant pelaku). Tindakan per
 * mitra tetap diperiksa layanan terhadap flag tenant mitra itu (docs/uat/gerbang-tahap.md).
 */
export async function phase3Enabled(tenantId?: string): Promise<boolean> {
  return p3.portalEnabled(getDb(), tenantId);
}

/** Istilah program: "Mitra Depot EQUA" kecuali flag `partner.franchise_terms` aktif. */
export async function terms(): Promise<p3.PartnerTerms> {
  return p3.partnerTerms(getDb());
}

/** Bulan 'YYYY-MM' dari query `?bulan=` (bila sah) atau bulan berjalan. */
export function monthParam(value: string | undefined, today: string): string {
  return value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : today.slice(0, 7);
}
