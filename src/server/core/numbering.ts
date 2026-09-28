/**
 * Penomoran dokumen (docs/DECISIONS.md D-04, PTB-14 diperluas). Nomor unik, tidak dapat diubah, berurutan per
 * lingkup (tahun WIB, tahun-bulan, atau outlet+tanggal). YY = tahun 2 digit WIB dari tanggal dokumen.
 *
 * | Jenis                | Format                         | Lingkup urutan        |
 * |----------------------|--------------------------------|-----------------------|
 * | `order`              | `P-YY-NNNNNN`                  | tahun                 |
 * | rit                  | `P-YY-NNNNNN/n` (`tripNumber`) | turunan nomor pesanan |
 * | `invoice`            | `F-YY-NNNNNN`                  | tahun                 |
 * | `credit_note`        | `NK-YY-NNNNNN`                 | tahun                 |
 * | `pos_sale`           | `{kodeOutlet}-YYMMDD-NNNN`     | outlet + tanggal      |
 * | `deposit`            | `S-YY-NNNNNN`                  | tahun                 |
 * | `journal`            | `J-YYMM-NNNNN`                 | tahun-bulan           |
 * | `approval`           | `A-YY-NNNNNN`                  | tahun                 |
 * | `purchase_receipt`   | `NB-YY-NNNNNN` (nota internal) | tahun                 |
 * | `internal_transfer`  | `TI-YY-NNNNN`                  | tahun                 |
 *
 * Aman konkuren: satu pernyataan UPSERT (`INSERT … ON CONFLICT (tenant_id, kind, scope_key) DO UPDATE SET last_value =
 * last_value + 1 RETURNING`) mengunci baris urutan sampai transaksi pemanggil selesai (setara `SELECT … FOR UPDATE`),
 * sehingga dua transaksi paralel tidak pernah mendapat nomor sama. Nomor yang diambil transaksi yang kemudian
 * rollback ikut kembali (tidak ada lubang karena rollback).
 *
 * Urutan PER TENANT (NFR-30, D-04): `tenantId` WAJIB — kode outlet hanya unik per tenant, jadi outlet mitra berkode
 * sama (mis. `D01`) tidak berbagi penghitung dengan EQUA. Tanggal = TANGGAL BISNIS dokumen (`ctxBusinessDate(ctx)`,
 * atau tanggal bisnis perangkat untuk dokumen lapangan — `assignOfficialNumber`), bukan jam server: transaksi POS
 * 31 Des yang tersinkron 1 Jan tetap bernomor tahun/tanggal 31 Des.
 */
import "server-only";

import { sql } from "drizzle-orm";

import { documentSequences } from "@/db/schema";
import { newId } from "@/lib/ids";
import { isBusinessDate, toWibParts, type BusinessDate } from "@/lib/time";

import type { Tx } from "./db";
import { DomainError } from "./errors";

export type DocType =
  | "order"
  | "invoice"
  | "credit_note"
  | "pos_sale"
  | "deposit"
  | "journal"
  | "approval"
  | "purchase_receipt"
  | "internal_transfer";

type DocTypeDef = {
  label: string;
  prefix: string;
  digits: number;
  scope: "year" | "year_month" | "outlet_day";
};

/** Definisi setiap jenis nomor (BERKAS BERSAMA — hanya tambah jenis baru). */
export const DOC_TYPES: Record<DocType, DocTypeDef> = {
  order: { label: "Pesanan", prefix: "P", digits: 6, scope: "year" },
  invoice: { label: "Faktur", prefix: "F", digits: 6, scope: "year" },
  credit_note: { label: "Nota kredit", prefix: "NK", digits: 6, scope: "year" },
  pos_sale: { label: "Transaksi POS", prefix: "", digits: 4, scope: "outlet_day" },
  deposit: { label: "Setoran", prefix: "S", digits: 6, scope: "year" },
  journal: { label: "Jurnal", prefix: "J", digits: 5, scope: "year_month" },
  approval: { label: "Persetujuan", prefix: "A", digits: 6, scope: "year" },
  purchase_receipt: { label: "Nota pembelian internal", prefix: "NB", digits: 6, scope: "year" },
  internal_transfer: { label: "Transfer internal", prefix: "TI", digits: 5, scope: "year" },
};

export type NumberOptions = {
  /** Wajib untuk `pos_sale` (mis. `D01`, `TK1`). */
  outletCode?: string;
};

export type NextNumberOptions = NumberOptions & {
  /** WAJIB (NFR-30): urutan dipisah per tenant. */
  tenantId: string;
};

type WibYmd = { yy: string; mm: string; dd: string };

function wibYmd(date: Date | BusinessDate): WibYmd {
  if (typeof date === "string") {
    if (!isBusinessDate(date)) {
      throw new DomainError("INVALID_DATE", `Tanggal dokumen tidak valid: "${date}". Gunakan format YYYY-MM-DD.`);
    }
    return { yy: date.slice(2, 4), mm: date.slice(5, 7), dd: date.slice(8, 10) };
  }
  const p = toWibParts(date);
  return { yy: String(p.year).slice(-2), mm: String(p.month).padStart(2, "0"), dd: String(p.day).padStart(2, "0") };
}

function assertOutletCode(docType: DocType, opts: NumberOptions): string {
  const code = opts.outletCode?.trim();
  if (!code) {
    throw new DomainError("OUTLET_CODE_REQUIRED", `Kode outlet wajib untuk penomoran ${DOC_TYPES[docType].label}.`);
  }
  if (!/^[A-Z0-9]{2,10}$/.test(code)) {
    throw new DomainError("OUTLET_CODE_INVALID", `Kode outlet "${code}" tidak valid (huruf besar/angka, 2–10 karakter).`);
  }
  return code;
}

/** Kunci lingkup urutan, mis. `'27'`, `'2709'`, `'D01-270926'`. */
export function sequenceScopeKey(docType: DocType, date: Date | BusinessDate, opts: NumberOptions = {}): string {
  const def = DOC_TYPES[docType];
  const { yy, mm, dd } = wibYmd(date);
  switch (def.scope) {
    case "year":
      return yy;
    case "year_month":
      return `${yy}${mm}`;
    case "outlet_day":
      return `${assertOutletCode(docType, opts)}-${yy}${mm}${dd}`;
  }
}

/** Format nomor dari nilai urutan (murni; dipakai `nextNumber` dan uji). */
export function formatDocNumber(docType: DocType, seq: number, date: Date | BusinessDate, opts: NumberOptions = {}): string {
  const def = DOC_TYPES[docType];
  if (!Number.isSafeInteger(seq) || seq < 1) throw new DomainError("INVALID_SEQUENCE", "Nomor urut tidak valid.");
  const max = 10 ** def.digits - 1;
  if (seq > max) {
    throw new DomainError(
      "SEQUENCE_EXHAUSTED",
      `Nomor ${def.label} untuk periode ini sudah habis (maksimal ${max}). Hubungi admin sistem.`,
    );
  }
  const n = String(seq).padStart(def.digits, "0");
  const { yy, mm, dd } = wibYmd(date);
  switch (def.scope) {
    case "year":
      return `${def.prefix}-${yy}-${n}`;
    case "year_month":
      return `${def.prefix}-${yy}${mm}-${n}`;
    case "outlet_day":
      return `${assertOutletCode(docType, opts)}-${yy}${mm}${dd}-${n}`;
  }
}

/**
 * Ambil nomor berikutnya untuk jenis dokumen pada tanggal bisnis tertentu, di dalam transaksi pemanggil.
 * `await nextNumber(tx, "order", ctxBusinessDate(ctx), { tenantId: ctx.tenantId })` → `"P-26-000123"`.
 */
export async function nextNumber(tx: Tx, docType: DocType, date: Date | BusinessDate, opts: NextNumberOptions): Promise<string> {
  if (!(docType in DOC_TYPES)) {
    throw new DomainError("UNKNOWN_DOC_TYPE", `Jenis nomor dokumen tidak dikenal: ${docType}.`);
  }
  if (!opts?.tenantId) throw new Error(`nextNumber(${docType}): tenantId wajib diisi (NFR-30).`);
  const scopeKey = sequenceScopeKey(docType, date, opts);
  const rows = await tx
    .insert(documentSequences)
    .values({ id: newId(), tenantId: opts.tenantId, kind: docType, scopeKey, lastValue: 1 })
    .onConflictDoUpdate({
      target: [documentSequences.tenantId, documentSequences.kind, documentSequences.scopeKey],
      set: { lastValue: sql`${documentSequences.lastValue} + 1`, updatedAt: new Date() },
    })
    .returning({ lastValue: documentSequences.lastValue });
  const seq = Number(rows[0]?.lastValue);
  return formatDocNumber(docType, seq, date, opts);
}

/**
 * Nomor RESMI untuk dokumen yang terbit di perangkat (POS, nota pembelian, transfer internal) saat perintahnya
 * tersinkron: memakai TANGGAL BISNIS PERANGKAT (`meta.command.businessDate`) dan tenant perangkat, bukan tanggal
 * server. Nomor lokal perangkat tetap di `local_number` (`formatLocalNumber` di `@/lib/local-number`).
 * `await assignOfficialNumber(tx, "pos_sale", { tenantId: meta.device.tenantId, businessDate: meta.command.businessDate, outletCode })`.
 */
export async function assignOfficialNumber(
  tx: Tx,
  docType: DocType,
  input: { tenantId: string; businessDate: BusinessDate; outletCode?: string },
): Promise<string> {
  return nextNumber(tx, docType, input.businessDate, { tenantId: input.tenantId, outletCode: input.outletCode });
}

/** Nomor rit = nomor pesanan + urutan tangki: `tripNumber("P-27-000123", 2)` → `"P-27-000123/2"`. */
export function tripNumber(orderNumber: string, index: number): string {
  if (!/^P-\d{2}-\d{6}$/.test(orderNumber)) {
    throw new DomainError("INVALID_ORDER_NUMBER", `Nomor pesanan tidak valid: ${orderNumber}.`);
  }
  if (!Number.isInteger(index) || index < 1) throw new DomainError("INVALID_TRIP_INDEX", "Urutan tangki harus ≥ 1.");
  return `${orderNumber}/${index}`;
}
