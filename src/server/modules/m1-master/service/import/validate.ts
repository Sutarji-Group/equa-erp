/**
 * M1 — validasi baris impor data awal (US-M1-06 KP-2): wajib kosong, format WA salah, segmen tidak dikenal, format
 * angka/koordinat/tanggal, duplikat (WA sama / nama + alamat mirip — dalam berkas & terhadap data yang sudah ada) dengan
 * usulan penggabungan. Murni terhadap DB (hanya baca).
 */
import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { customerAddresses, customers, employees, outlets, poolLocations, tariffZones, trucks, waterMeters, waterSources } from "@/db/schema";
import { isValidLatLng } from "@/lib/geo";
import { LABELS, ROLE_CODES, type CustomerSegment, type RoleCode } from "@/lib/labels";
import { isBusinessDate, type BusinessDate } from "@/lib/time";

import type { Tx } from "@/server/core/db";
import { normalizeWaNumber } from "@/server/core/wa";

import { normalizeText } from "../common";
import { findDuplicateCandidates, type DuplicateCandidate } from "../customers";
import { IMPORT_DEFS, type ImportKindM1 } from "./definitions";
import type { ParsedImportRow } from "./workbook";

export type RowValidation = {
  rowNumber: number;
  status: "valid" | "error" | "duplicate";
  errors: string[];
  duplicateCandidates: Record<string, unknown>[];
  mergeProposal: Record<string, unknown> | null;
};

type Raw = Record<string, string | number | null>;

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  const cleaned = String(v).replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : Number.NaN;
}

function coord(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : Number.NaN;
}

function lookupLabel<T extends string>(enumName: keyof typeof LABELS, value: string | null): T | null {
  if (!value) return null;
  const map = LABELS[enumName] as Record<string, string>;
  const v = normalizeText(value);
  for (const [code, text] of Object.entries(map)) {
    if (normalizeText(code) === v || normalizeText(text) === v) return code as T;
  }
  return null;
}

export function parseSegment(value: string | null): CustomerSegment | null {
  return lookupLabel<CustomerSegment>("customer_segment", value);
}

export function parseRoles(value: string | null): { roles: RoleCode[]; unknown: string[] } {
  if (!value) return { roles: [], unknown: [] };
  const roles: RoleCode[] = [];
  const unknown: string[] = [];
  for (const part of value.split(/[,;/]/).map((p) => p.trim()).filter(Boolean)) {
    const r = lookupLabel<RoleCode>("role", part);
    if (r && ROLE_CODES.includes(r)) roles.push(r);
    else unknown.push(part);
  }
  return { roles: [...new Set(roles)], unknown };
}

export function parseCreditStatus(value: string | null): "cash" | "credit_migrated" | "invalid" {
  if (!value) return "cash";
  const v = normalizeText(value);
  if (v === "tunai" || v === "cash") return "cash";
  if (v === "tempo migrasi" || v === "credit migrated") return "credit_migrated";
  return "invalid";
}

function required(def: (typeof IMPORT_DEFS)[ImportKindM1], data: Raw, errors: string[]) {
  for (const c of def.columns) if (c.required && str(data[c.key]) === null) errors.push(`${c.header} wajib diisi.`);
}

function checkCoords(data: Raw, errors: string[], latKey = "lat", lngKey = "lng", requiredCoords = false) {
  const la = coord(data[latKey]);
  const ln = coord(data[lngKey]);
  if (la === null && ln === null) {
    if (requiredCoords) errors.push("Koordinat wajib diisi.");
    return;
  }
  if (la === null || ln === null) errors.push("Isi lintang dan bujur sekaligus, atau kosongkan keduanya.");
  else if (Number.isNaN(la) || Number.isNaN(ln) || !isValidLatLng({ lat: la, lng: ln })) errors.push("Koordinat tidak valid (lintang −90..90, bujur −180..180).");
}

function checkInt(data: Raw, key: string, label: string, errors: string[], opts: { min?: number; required?: boolean } = {}) {
  const n = num(data[key]);
  if (n === null) {
    if (opts.required) errors.push(`${label} wajib diisi.`);
    return;
  }
  if (Number.isNaN(n) || !Number.isInteger(n)) errors.push(`${label} harus angka bulat.`);
  else if (opts.min !== undefined && n < opts.min) errors.push(`${label} minimal ${opts.min}.`);
}

function checkDate(data: Raw, key: string, label: string, errors: string[]) {
  const v = str(data[key]);
  if (v && !isBusinessDate(v)) errors.push(`${label} harus berformat YYYY-MM-DD.`);
}

/** Validasi seluruh baris satu berkas. */
export async function validateImportRows(tx: Tx, tenantId: string, kind: ImportKindM1, rows: ParsedImportRow[], date: BusinessDate): Promise<RowValidation[]> {
  switch (kind) {
    case "customers":
      return validateCustomers(tx, tenantId, rows, date);
    case "customer_prices":
      return validateCustomerPrices(tx, tenantId, rows);
    case "trucks":
      return validateTrucks(tx, tenantId, rows);
    case "crew":
      return validateCrew(tx, tenantId, rows);
    case "employees":
      return validateEmployees(tx, tenantId, rows);
    case "outlets":
      return validateOutlets(tx, tenantId, rows);
    case "water_sources":
      return validateWaterSources(tx, tenantId, rows);
  }
}

function result(rowNumber: number, errors: string[], dup?: { candidates: Record<string, unknown>[]; proposal: Record<string, unknown> | null }): RowValidation {
  if (errors.length) return { rowNumber, status: "error", errors, duplicateCandidates: dup?.candidates ?? [], mergeProposal: null };
  if (dup && dup.candidates.length) return { rowNumber, status: "duplicate", errors: [], duplicateCandidates: dup.candidates, mergeProposal: dup.proposal };
  return { rowNumber, status: "valid", errors: [], duplicateCandidates: [], mergeProposal: null };
}

// ---------------------------------------------------------------------------------------------------------------------
// Pelanggan
// ---------------------------------------------------------------------------------------------------------------------

async function validateCustomers(tx: Tx, tenantId: string, rows: ParsedImportRow[], date: BusinessDate): Promise<RowValidation[]> {
  const def = IMPORT_DEFS.customers;
  const zones = await tx.select({ id: tariffZones.id, code: tariffZones.code }).from(tariffZones).where(and(eq(tariffZones.tenantId, tenantId), eq(tariffZones.isActive, true)));
  const zoneByCode = new Map(zones.map((z) => [z.code.toUpperCase(), z.id]));
  const codes = [...new Set(rows.map((r) => str(r.data.kode_pelanggan)).filter((x): x is string => !!x))];
  const existingByCode = codes.length
    ? await tx.select({ id: customers.id, code: customers.code, name: customers.name, waPhone: customers.waPhone }).from(customers).where(and(eq(customers.tenantId, tenantId), inArray(customers.code, codes)))
    : [];
  const groups = new Map<string, ParsedImportRow[]>();
  for (const r of rows) {
    const code = str(r.data.kode_pelanggan);
    if (code) groups.set(code, [...(groups.get(code) ?? []), r]);
  }
  const waOwner = new Map<string, string>(); // WA → kode pertama di berkas
  for (const [code, group] of groups) {
    const wa = normalizeWaNumber(String(group[0]!.data.nomor_wa ?? ""));
    if (wa && !waOwner.has(wa)) waOwner.set(wa, code);
  }
  const groupDup = new Map<string, { candidates: Record<string, unknown>[]; proposal: Record<string, unknown> | null }>();
  async function groupDuplicates(code: string, first: ParsedImportRow, group: ParsedImportRow[]) {
    const candidates: Record<string, unknown>[] = [];
    let proposal: Record<string, unknown> | null = null;
    const existing = existingByCode.find((e) => e.code === code);
    if (existing) {
      candidates.push({ source: "db", customerId: existing.id, code: existing.code, name: existing.name, reason: "Kode pelanggan sudah ada di sistem" });
      return { candidates, proposal: { action: "merge", targetCustomerId: existing.id, targetName: existing.name, note: "Tambahkan alamat ke pelanggan yang sudah ada." } };
    }
    const wa = normalizeWaNumber(String(first.data.nomor_wa ?? ""));
    const owner = wa ? waOwner.get(wa) : undefined;
    if (owner && owner !== code) {
      candidates.push({ source: "file", code: owner, reason: `Nomor WA sama dengan kode ${owner} di berkas ini` });
      proposal = { action: "merge", targetCode: owner, note: `Gabungkan sebagai alamat pelanggan ${owner}.` };
    }
    const found: DuplicateCandidate[] = await findDuplicateCandidates(tx, tenantId, { name: String(first.data.nama), waPhone: wa, addressTexts: group.map((g) => String(g.data.alamat ?? "")) }, date);
    for (const c of found) {
      candidates.push({ source: "db", customerId: c.customerId, code: c.code, name: c.name, reason: c.reasonText });
      proposal ??= { action: "merge", targetCustomerId: c.customerId, targetName: c.name, note: "Gabungkan sebagai alamat pelanggan yang sudah ada (bila orang/usaha yang sama)." };
    }
    return { candidates, proposal };
  }
  const out: RowValidation[] = [];
  for (const r of rows) {
    const d = r.data;
    const errors: string[] = [];
    required(def, d, errors);
    const code = str(d.kode_pelanggan);
    const segment = parseSegment(str(d.segmen));
    if (str(d.segmen) && !segment) errors.push(`Segmen "${str(d.segmen)}" tidak dikenal. Pilih: Depot pihak ketiga, Rumah tangga, Perumahan, Industri, Proyek konstruksi, Hotel, Kolam renang.`);
    const wa = str(d.nomor_wa) ? normalizeWaNumber(String(d.nomor_wa)) : null;
    if (str(d.nomor_wa) && !wa) errors.push(`Format nomor WA salah ("${str(d.nomor_wa)}"). Contoh: 0812-3456-7890.`);
    checkCoords(d, errors);
    const time = str(d.jam_terima);
    if (time && !/^([01]?\d|2[0-3])[:.][0-5]\d$/.test(time)) errors.push("Jam terima harus berformat HH:mm (mis. 07:00).");
    const zm = str(d.zona_manual);
    if (zm && !zoneByCode.has(zm.toUpperCase())) errors.push(`Kode zona "${zm}" tidak dikenal.`);
    const credit = parseCreditStatus(str(d.status_kredit));
    if (credit === "invalid") {
      errors.push(`Status kredit "${str(d.status_kredit)}" tidak dikenal. Isi Tunai atau Tempo migrasi (status Tempo biasa hanya lewat persetujuan pemilik).`);
    } else if (credit === "credit_migrated") {
      if (segment === "household") errors.push("Rumah tangga hanya tunai; tidak dapat Tempo migrasi (BR-04).");
      checkInt(d, "batas_kredit", "Batas kredit", errors, { min: 1, required: true });
      checkInt(d, "tempo_hari", "Tempo (hari)", errors, { min: 1, required: true });
    } else {
      checkInt(d, "batas_kredit", "Batas kredit", errors, { min: 0 });
      checkInt(d, "tempo_hari", "Tempo (hari)", errors, { min: 1 });
    }
    // Konsistensi kelompok (kode sama = pelanggan sama).
    const group = code ? groups.get(code)! : [r];
    const first = group[0]!;
    if (first !== r) {
      for (const k of ["nama", "segmen", "nomor_wa", "status_kredit", "batas_kredit", "tempo_hari"]) {
        const a = str(first.data[k]);
        const b = str(d[k]);
        if (b !== null && a !== null && normalizeText(a) !== normalizeText(b) && !(k === "nomor_wa" && normalizeWaNumber(a) === normalizeWaNumber(b))) {
          errors.push(`Kolom ${def.columns.find((c) => c.key === k)!.header} berbeda dengan baris ${first.rowNumber} (kode pelanggan sama).`);
        }
      }
      const labels = group.slice(0, group.indexOf(r)).map((g) => normalizeText(str(g.data.label_alamat)));
      if (labels.includes(normalizeText(str(d.label_alamat)))) errors.push(`Label alamat "${str(d.label_alamat)}" dipakai dua kali untuk pelanggan ${code}.`);
    }
    if (errors.length) {
      out.push(result(r.rowNumber, errors));
      continue;
    }
    // Duplikat (tingkat kelompok/kode pelanggan — keputusan berlaku untuk semua baris kode itu): kode sudah ada, WA sama
    // dengan kode lain di berkas, atau WA / nama + alamat mirip pelanggan yang sudah ada (usulan penggabungan).
    if (!groupDup.has(code!)) groupDup.set(code!, await groupDuplicates(code!, first, group));
    const dup = groupDup.get(code!)!;
    out.push(result(r.rowNumber, [], dup));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Harga saat ini per pelanggan
// ---------------------------------------------------------------------------------------------------------------------

async function validateCustomerPrices(tx: Tx, tenantId: string, rows: ParsedImportRow[]): Promise<RowValidation[]> {
  const def = IMPORT_DEFS.customer_prices;
  const codes = [...new Set(rows.map((r) => str(r.data.kode_pelanggan)).filter((x): x is string => !!x))];
  const custs = codes.length ? await tx.select({ id: customers.id, code: customers.code }).from(customers).where(and(eq(customers.tenantId, tenantId), inArray(customers.code, codes))) : [];
  const addrs = custs.length ? await tx.select({ customerId: customerAddresses.customerId, label: customerAddresses.label }).from(customerAddresses).where(inArray(customerAddresses.customerId, custs.map((c) => c.id))) : [];
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const errors: string[] = [];
    required(def, r.data, errors);
    checkInt(r.data, "harga_per_rit", "Harga per rit", errors, { min: 1 });
    const code = str(r.data.kode_pelanggan);
    const cust = custs.find((c) => c.code === code);
    if (code && !cust) errors.push(`Pelanggan ${code} belum ada di sistem. Impor pelanggan lebih dulu.`);
    const lbl = str(r.data.label_alamat);
    if (cust && lbl && !addrs.some((a) => a.customerId === cust.id && normalizeText(a.label) === normalizeText(lbl))) errors.push(`Alamat berlabel "${lbl}" tidak ditemukan untuk pelanggan ${code}.`);
    const key = `${code}|${normalizeText(lbl)}`;
    if (!errors.length && seen.has(key)) errors.push(`Harga untuk pelanggan & alamat ini sudah ada di baris ${seen.get(key)}.`);
    if (!errors.length) seen.set(key, r.rowNumber);
    return result(r.rowNumber, errors);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Armada, kru, karyawan, outlet, sumber air
// ---------------------------------------------------------------------------------------------------------------------

async function validateTrucks(tx: Tx, tenantId: string, rows: ParsedImportRow[]): Promise<RowValidation[]> {
  const def = IMPORT_DEFS.trucks;
  const existing = await tx.select({ code: trucks.code, plate: trucks.plateNumber, tenantId: trucks.tenantId }).from(trucks);
  const pools = await tx.select({ code: poolLocations.code }).from(poolLocations).where(eq(poolLocations.tenantId, tenantId));
  const seenCode = new Map<string, number>();
  const seenPlate = new Map<string, number>();
  return rows.map((r) => {
    const errors: string[] = [];
    required(def, r.data, errors);
    checkInt(r.data, "kapasitas_l", "Kapasitas", errors, { min: 500 });
    checkInt(r.data, "kapasitas_rit", "Kapasitas rit/hari", errors, { min: 1 });
    const code = str(r.data.kode)?.toUpperCase() ?? null;
    const plate = str(r.data.nopol)?.toUpperCase().replace(/\s+/g, " ") ?? null;
    const pool = str(r.data.kode_pool)?.toUpperCase() ?? null;
    if (pool && !pools.some((p) => p.code.toUpperCase() === pool)) errors.push(`Kode pool ${pool} tidak dikenal.`);
    if (code && existing.some((e) => e.tenantId === tenantId && e.code === code)) errors.push(`Duplikat: truk berkode ${code} sudah ada. Kecualikan baris ini dengan alasan.`);
    if (plate && existing.some((e) => e.plate === plate)) errors.push(`Duplikat: nomor polisi ${plate} sudah terdaftar. Kecualikan baris ini dengan alasan.`);
    if (code && seenCode.has(code)) errors.push(`Kode truk ${code} dipakai dua kali (baris ${seenCode.get(code)}).`);
    if (plate && seenPlate.has(plate)) errors.push(`Nomor polisi ${plate} dipakai dua kali (baris ${seenPlate.get(plate)}).`);
    if (code) seenCode.set(code, r.rowNumber);
    if (plate) seenPlate.set(plate, r.rowNumber);
    return result(r.rowNumber, errors);
  });
}

async function validateCrew(tx: Tx, tenantId: string, rows: ParsedImportRow[]): Promise<RowValidation[]> {
  const def = IMPORT_DEFS.crew;
  const ts = await tx.select({ code: trucks.code }).from(trucks).where(eq(trucks.tenantId, tenantId));
  const emps = await tx.select({ no: employees.employeeNo, roles: employees.intendedRoles, isActive: employees.isActive }).from(employees).where(eq(employees.tenantId, tenantId));
  const used = new Map<string, number>();
  return rows.map((r) => {
    const errors: string[] = [];
    required(def, r.data, errors);
    const code = str(r.data.kode_truk)?.toUpperCase() ?? null;
    if (code && !ts.some((t) => t.code === code)) errors.push(`Truk ${code} belum ada. Impor armada lebih dulu.`);
    const d = str(r.data.no_sopir);
    const h = str(r.data.no_kernet);
    if (!d && !h) errors.push("Isi minimal nomor karyawan sopir atau kernet.");
    for (const [no, role, lbl] of [
      [d, "driver", "Sopir"],
      [h, "helper", "Kernet"],
    ] as const) {
      if (!no) continue;
      const e = emps.find((x) => x.no === no);
      if (!e) errors.push(`Karyawan ${no} tidak ditemukan.`);
      else if (!e.isActive) errors.push(`Karyawan ${no} tidak aktif.`);
      else if (!(e.roles ?? []).includes(role)) errors.push(`Karyawan ${no} bukan berperan ${lbl}.`);
      if (used.has(no)) errors.push(`Karyawan ${no} sudah menjadi kru default di baris ${used.get(no)} (satu karyawan satu truk default).`);
      used.set(no, r.rowNumber);
    }
    if (d && h && d === h) errors.push("Sopir dan kernet harus orang yang berbeda.");
    return result(r.rowNumber, errors);
  });
}

async function validateEmployees(tx: Tx, tenantId: string, rows: ParsedImportRow[]): Promise<RowValidation[]> {
  const def = IMPORT_DEFS.employees;
  const existing = await tx.select({ no: employees.employeeNo }).from(employees).where(eq(employees.tenantId, tenantId));
  const os = await tx.select({ code: outlets.code }).from(outlets).where(eq(outlets.tenantId, tenantId));
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const errors: string[] = [];
    required(def, r.data, errors);
    const no = str(r.data.no_karyawan);
    if (no && existing.some((e) => e.no === no)) errors.push(`Duplikat: nomor karyawan ${no} sudah ada. Kecualikan baris ini dengan alasan.`);
    if (no && seen.has(no)) errors.push(`Nomor karyawan ${no} dipakai dua kali (baris ${seen.get(no)}).`);
    if (no) seen.set(no, r.rowNumber);
    const phone = str(r.data.telepon);
    if (phone && !normalizeWaNumber(phone)) errors.push(`Format nomor telepon salah ("${phone}").`);
    const oc = str(r.data.kode_outlet)?.toUpperCase();
    if (oc && !os.some((o) => o.code === oc)) errors.push(`Kode outlet ${oc} tidak dikenal.`);
    const roles = parseRoles(str(r.data.peran));
    if (roles.unknown.length) errors.push(`Peran tidak dikenal: ${roles.unknown.join(", ")}.`);
    checkDate(r.data, "tanggal_masuk", "Tanggal masuk", errors);
    checkDate(r.data, "tanggal_keluar", "Tanggal keluar", errors);
    const hire = str(r.data.tanggal_masuk);
    const exit = str(r.data.tanggal_keluar);
    if (hire && exit && isBusinessDate(hire) && isBusinessDate(exit) && exit < hire) errors.push("Tanggal keluar sebelum tanggal masuk.");
    return result(r.rowNumber, errors);
  });
}

async function validateOutlets(tx: Tx, tenantId: string, rows: ParsedImportRow[]): Promise<RowValidation[]> {
  const def = IMPORT_DEFS.outlets;
  const existing = await tx.select({ code: outlets.code }).from(outlets).where(eq(outlets.tenantId, tenantId));
  const emps = await tx.select({ no: employees.employeeNo }).from(employees).where(eq(employees.tenantId, tenantId));
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const errors: string[] = [];
    required(def, r.data, errors);
    const code = str(r.data.kode)?.toUpperCase();
    if (code && !/^[A-Z0-9]+$/.test(code)) errors.push("Kode outlet hanya huruf dan angka.");
    if (code && existing.some((e) => e.code === code)) errors.push(`Duplikat: outlet ${code} sudah ada. Kecualikan baris ini dengan alasan.`);
    if (code && seen.has(code)) errors.push(`Kode outlet ${code} dipakai dua kali (baris ${seen.get(code)}).`);
    if (code) seen.set(code, r.rowNumber);
    const kind = lookupLabel<"depot" | "store">("outlet_kind", str(r.data.jenis));
    if (str(r.data.jenis) && !kind) errors.push(`Jenis "${str(r.data.jenis)}" tidak dikenal. Isi Depot atau Toko.`);
    checkCoords(r.data, errors);
    checkInt(r.data, "radius_geofence_m", "Radius geofence", errors, { min: 10 });
    checkInt(r.data, "kapasitas_simpan_l", "Kapasitas simpan", errors, { min: 0 });
    const op = str(r.data.no_operator);
    if (op && !emps.some((e) => e.no === op)) errors.push(`Karyawan ${op} tidak ditemukan.`);
    return result(r.rowNumber, errors);
  });
}

async function validateWaterSources(tx: Tx, tenantId: string, rows: ParsedImportRow[]): Promise<RowValidation[]> {
  const def = IMPORT_DEFS.water_sources;
  const existing = await tx.select({ code: waterSources.code }).from(waterSources).where(eq(waterSources.tenantId, tenantId));
  const meters = await tx.select({ code: waterMeters.code }).from(waterMeters);
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const errors: string[] = [];
    required(def, r.data, errors);
    const code = str(r.data.kode)?.toUpperCase();
    if (code && existing.some((e) => e.code === code)) errors.push(`Duplikat: sumber air ${code} sudah ada. Kecualikan baris ini dengan alasan.`);
    if (code && seen.has(code)) errors.push(`Kode sumber ${code} dipakai dua kali (baris ${seen.get(code)}).`);
    if (code) seen.set(code, r.rowNumber);
    checkCoords(r.data, errors, "lat", "lng", true);
    checkInt(r.data, "kapasitas_harian_l", "Kapasitas harian", errors, { min: 1000 });
    checkInt(r.data, "radius_geofence_m", "Radius geofence", errors, { min: 10 });
    const mc = str(r.data.kode_meter);
    if (mc) {
      if (meters.some((m) => m.code === mc)) errors.push(`Pengenal meter ${mc} sudah dipakai.`);
      checkInt(r.data, "angka_awal_l", "Angka awal meter", errors, { min: 0, required: true });
      const unit = str(r.data.satuan_meter);
      if (unit && !lookupLabel("meter_unit", unit)) errors.push(`Satuan meter "${unit}" tidak dikenal. Isi Liter atau Meter kubik.`);
    }
    return result(r.rowNumber, errors);
  });
}

export const importValueParsers = { str, num, coord, lookupLabel };
