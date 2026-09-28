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
 * Aman konkuren: satu pernyataan UPSERT (`INSERT … ON CONFLICT (kind, scope_key) DO UPDATE SET last_value =
 * last_value + 1 RETURNING`) mengunci baris urutan sampai transaksi pemanggil selesai (setara `SELECT … FOR UPDATE`),
 * sehingga dua transaksi paralel tidak pernah mendapat nomor sama. Nomor yang diambil transaksi yang kemudian
 * rollback ikut kembali (tidak ada lubang karena rollback).
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
 * Ambil nomor berikutnya untuk jenis dokumen pada tanggal (WIB) tertentu, di dalam transaksi pemanggil.
 * `await nextNumber(tx, "order", ctx.now)` → `"P-26-000123"`.
 */
export async function nextNumber(
  tx: Tx,
  docType: DocType,
  date: Date | BusinessDate,
  opts: NumberOptions = {},
): Promise<string> {
  if (!(docType in DOC_TYPES)) {
    throw new DomainError("UNKNOWN_DOC_TYPE", `Jenis nomor dokumen tidak dikenal: ${docType}.`);
  }
  const scopeKey = sequenceScopeKey(docType, date, opts);
  const rows = await tx
    .insert(documentSequences)
    .values({ id: newId(), kind: docType, scopeKey, lastValue: 1 })
    .onConflictDoUpdate({
      target: [documentSequences.kind, documentSequences.scopeKey],
      set: { lastValue: sql`${documentSequences.lastValue} + 1`, updatedAt: new Date() },
    })
    .returning({ lastValue: documentSequences.lastValue });
  const seq = Number(rows[0]?.lastValue);
  return formatDocNumber(docType, seq, date, opts);
}

/** Nomor rit = nomor pesanan + urutan tangki: `tripNumber("P-27-000123", 2)` → `"P-27-000123/2"`. */
export function tripNumber(orderNumber: string, index: number): string {
  if (!/^P-\d{2}-\d{6}$/.test(orderNumber)) {
    throw new DomainError("INVALID_ORDER_NUMBER", `Nomor pesanan tidak valid: ${orderNumber}.`);
  }
  if (!Number.isInteger(index) || index < 1) throw new DomainError("INVALID_TRIP_INDEX", "Urutan tangki harus ≥ 1.");
  return `${orderNumber}/${index}`;
}
