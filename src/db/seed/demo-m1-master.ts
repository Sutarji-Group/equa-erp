/**
 * Seed demo Data master (M1) — idempoten (ID deterministik + ON CONFLICT DO NOTHING) dan TIDAK mengganggu data inti:
 * tidak membuat pelanggan/alamat/truk baru, tidak membuat permintaan persetujuan, tidak mengubah status apa pun.
 *
 * Isi:
 * - Harga air truk "saat ini" (sebelum sistem) untuk 14 pelanggan demo → simulasi zona baru vs harga berlaku
 *   (US-M1-05 KP-5) langsung berisi di layar Zona tarif.
 * - Satu batch impor pelanggan MODE UJI berstatus "Ada kesalahan" (1 baris valid, 1 duplikat dengan usulan gabung ke
 *   PLG-0001, 1 baris salah: WA & Tempo migrasi rumah tangga) → laporan validasi per baris (US-M1-06 KP-2).
 * - Draf ringkasan data awal kelompok "Armada, kru, karyawan, peran, perangkat" → layar tanda tangan pemilik (KP-4).
 */
import { label } from "@/lib/labels";

import type { DbOrTx } from "../client";
import { customerLegacyPrices, dataSignoffs, importBatchRows, importBatches } from "../schema";
import { customerId } from "./customers";
import { seedId } from "./ids";
import { EQUA_TENANT_ID, EMPLOYEE_SEEDS, TRUCK_SEEDS, userIdByUsername } from "./org";

/** Harga per rit yang berlaku sebelum sistem (hasil wawancara pemilik, data demo). */
export const DEMO_LEGACY_PRICES: { code: string; price: number; notes?: string }[] = [
  { code: "PLG-0001", price: 230_000, notes: "Harga langganan depot sejak 2024" },
  { code: "PLG-0002", price: 210_000 },
  { code: "PLG-0003", price: 300_000 },
  { code: "PLG-0004", price: 280_000 },
  { code: "PLG-0005", price: 260_000 },
  { code: "PLG-0019", price: 220_000 },
  { code: "PLG-0020", price: 215_000 },
  { code: "PLG-0021", price: 290_000 },
  { code: "PLG-0025", price: 240_000, notes: "Kesepakatan lisan pemilik lama" },
  { code: "PLG-0027", price: 320_000 },
  { code: "PLG-0029", price: 250_000 },
  { code: "PLG-0033", price: 330_000 },
  { code: "PLG-0036", price: 200_000 },
  { code: "PLG-0037", price: 210_000 },
];

export const DEMO_IMPORT_BATCH_ID = seedId("m1:demo_import_batch:customers");
export const DEMO_SIGNOFF_ID = seedId("m1:demo_signoff:fleet_people");

const EMPTY_CUSTOMER_ROW = {
  nama_kontak: null,
  catatan: null,
  jam_terima: null,
  zona_manual: null,
  alasan_zona: null,
  batas_kredit: null,
  tempo_hari: null,
};

export async function seedDemoM1Master(tx: DbOrTx): Promise<{ legacyPrices: number }> {
  const dispatcher = userIdByUsername("dispatcher1");

  const legacy = await tx
    .insert(customerLegacyPrices)
    .values(
      DEMO_LEGACY_PRICES.map((p) => ({
        id: seedId(`m1:legacy_price:${p.code}`),
        tenantId: EQUA_TENANT_ID,
        customerId: customerId(p.code),
        addressId: null,
        pricePerTrip: p.price,
        notes: p.notes ?? "Harga saat ini sebelum sistem (data demo).",
        isCurrent: true,
        createdBy: dispatcher,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: customerLegacyPrices.id });

  await tx
    .insert(importBatches)
    .values({
      id: DEMO_IMPORT_BATCH_ID,
      tenantId: EQUA_TENANT_ID,
      kind: "customers",
      originalFilename: "uji-pelanggan-baru.xlsx",
      status: "has_errors",
      isInitialData: false,
      rowCount: 3,
      errorCount: 1,
      duplicateCount: 1,
      excludedCount: 0,
      createdBy: dispatcher,
    })
    .onConflictDoNothing();

  await tx
    .insert(importBatchRows)
    .values([
      {
        id: seedId("m1:demo_import_row:2"),
        batchId: DEMO_IMPORT_BATCH_ID,
        rowNumber: 2,
        data: {
          ...EMPTY_CUSTOMER_ROW,
          kode_pelanggan: "PLG-0201",
          nama: "CV Roti Manis Cibeber",
          segmen: "Industri",
          nomor_wa: "0857-2000-0201",
          nama_kontak: "Pak Iwan",
          label_alamat: "Pabrik",
          alamat: "Jl. Raya Cibeber No. 40, Cibeber",
          lat: -6.9002,
          lng: 107.1288,
          status_kredit: "Tunai",
        },
        status: "valid",
      },
      {
        id: seedId("m1:demo_import_row:3"),
        batchId: DEMO_IMPORT_BATCH_ID,
        rowNumber: 3,
        data: {
          ...EMPTY_CUSTOMER_ROW,
          kode_pelanggan: "PLG-0202",
          nama: "Depot Tirta Sari Cibeber",
          segmen: "Depot pihak ketiga",
          nomor_wa: "0813-1000-0001",
          label_alamat: "Utama",
          alamat: "Jl. Raya Cibeber No. 12, Cibeber",
          lat: -6.9051,
          lng: 107.131,
          status_kredit: "Tunai",
        },
        status: "duplicate",
        duplicateCandidates: [{ source: "db", customerId: customerId("PLG-0001"), code: "PLG-0001", name: "Depot Air Tirta Sari", reason: "Nomor WA sama" }],
        mergeProposal: {
          action: "merge",
          targetCustomerId: customerId("PLG-0001"),
          targetName: "Depot Air Tirta Sari",
          note: "Gabungkan sebagai alamat pelanggan yang sudah ada (bila orang/usaha yang sama).",
        },
      },
      {
        id: seedId("m1:demo_import_row:4"),
        batchId: DEMO_IMPORT_BATCH_ID,
        rowNumber: 4,
        data: {
          ...EMPTY_CUSTOMER_ROW,
          kode_pelanggan: "PLG-0203",
          nama: "Ibu Enok Hasanah",
          segmen: "Rumah tangga",
          nomor_wa: "0812-34",
          label_alamat: "Utama",
          alamat: "Kp. Babakan RT 02/01, Cilaku",
          zona_manual: "Z2",
          status_kredit: "Tempo migrasi",
          batas_kredit: 1_000_000,
          tempo_hari: 7,
        },
        status: "error",
        errors: ['Format nomor WA salah ("0812-34"). Contoh: 0812-3456-7890.', "Rumah tangga hanya tunai; tidak dapat Tempo migrasi (BR-04)."],
      },
    ])
    .onConflictDoNothing();

  const byRole: Record<string, number> = {};
  for (const e of EMPLOYEE_SEEDS) {
    const key = label("role", e.role);
    byRole[key] = (byRole[key] ?? 0) + 1;
  }
  await tx
    .insert(dataSignoffs)
    .values({
      id: DEMO_SIGNOFF_ID,
      tenantId: EQUA_TENANT_ID,
      group: "fleet_people",
      title: "Ringkasan data awal — Armada, kru, karyawan, peran, perangkat",
      summary: {
        kinds: {
          trucks: { kind: "trucks", mode: "production", created: TRUCK_SEEDS.length, excluded: 0 },
          employees: { kind: "employees", mode: "production", created: EMPLOYEE_SEEDS.length, excluded: 0, byRole },
        },
        note: "Data demo (seed) — ringkasan armada & karyawan untuk ditandatangani pemilik.",
      },
      status: "draft",
      createdBy: userIdByUsername("admin1"),
    })
    .onConflictDoNothing();

  return { legacyPrices: legacy.length };
}
