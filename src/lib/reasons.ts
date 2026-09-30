/**
 * Alasan berkode yang disimpan sebagai teks `kode` atau `kode: keterangan` (mis. alasan kurang bayar M3
 * `customer_short`, `other: uang di rumah`, `credit_not_approved: permintaan …`, `prepaid_short: …`) → kalimat
 * Indonesia untuk dokumen & pesan (CLAUDE.md aturan 1, NFR-15). Kode yang tidak dikenal dibiarkan apa adanya.
 */
import { label } from "./labels";

/** Kode alasan kurang bayar buatan M3 di luar enum `underpayment_reason`. */
const EXTRA_UNDERPAYMENT_REASONS: Record<string, string> = {
  prepaid_short: "Pembayaran di muka kurang dari harga rit",
};

const CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$|^[a-z]+$/;

/** "customer_short" → "Uang pelanggan kurang"; "other: uang di rumah" → "uang di rumah"; teks bebas tetap. */
export function formatUnderpaymentReason(raw: string | null | undefined): string {
  const text = raw?.trim() ?? "";
  if (!text) return "";
  const idx = text.indexOf(":");
  const head = (idx >= 0 ? text.slice(0, idx) : text).trim();
  const tail = idx >= 0 ? text.slice(idx + 1).trim() : "";
  if (!CODE.test(head)) return text;
  const known = EXTRA_UNDERPAYMENT_REASONS[head] ?? (label("underpayment_reason", head) !== head ? label("underpayment_reason", head) : null);
  if (!known) return text;
  if (head === "other") return tail || known;
  return tail ? `${known} — ${tail}` : known;
}
