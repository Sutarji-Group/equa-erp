/**
 * Nomor lokal dokumen yang terbit DI PERANGKAT (7.6.6, US-M6-01 KP-4/KP-5, US-M6-06 KP-2) — isomorfik.
 *
 * Format: `{awalan}-{YYMMDD}-{tagPerangkat}-{urut}`, mis. `D01-270926-POSD01-0007` (awalan = kode outlet untuk POS).
 * Urutan = `device_seq` per perangkat per lingkup (`nextDeviceSeq(scope)` di klien, TIDAK pernah direset — disemai
 * dari server saat aktivasi & pull sehingga hapus data + aktivasi ulang tidak mengulang nomor → tidak ada bentrok
 * unik `(device_id, local_number)` yang membuat penjualan ditolak final). Nomor RESMI diisi server saat sinkron
 * (`assignOfficialNumber` di src/server/core/numbering.ts, memakai tanggal bisnis perangkat).
 */

/** Lingkup urutan perangkat yang dikenal core (modul boleh menambah lingkup sendiri dengan nama `<modul>.<dok>`). */
export type DeviceSeqScope = "pos_sale" | "purchase_receipt" | "internal_transfer" | (string & {});

/** Tag perangkat dari kode perangkat (`POS-D01` → `POSD01`): huruf besar/angka saja. */
export function deviceTagFromCode(deviceCode: string): string {
  return deviceCode.toUpperCase().replace(/[^A-Z0-9]/g, "") || "DEV";
}

export function formatLocalNumber(input: { prefix: string; businessDate: string; deviceTag: string; seq: number }): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) throw new Error(`Tanggal bisnis tidak valid: ${input.businessDate}`);
  if (!Number.isSafeInteger(input.seq) || input.seq < 1) throw new Error("Nomor urut perangkat tidak valid.");
  const ymd = `${input.businessDate.slice(2, 4)}${input.businessDate.slice(5, 7)}${input.businessDate.slice(8, 10)}`;
  const prefix = input.prefix.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `${prefix}-${ymd}-${deviceTagFromCode(input.deviceTag)}-${String(input.seq).padStart(4, "0")}`;
}
