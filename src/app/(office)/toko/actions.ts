"use server";

import { revalidatePath } from "next/cache";

import type { OutletActionState } from "@/components/m6-pos/office-action-state";
import { requireOfficeSession } from "@/server/core/auth/office";
import { withTx } from "@/server/core/db";
import { toUserMessage } from "@/server/core/errors";
import { put } from "@/server/core/storage";
import * as m7 from "@/server/modules/m7-store";

/**
 * Server Action layar kantor toko (/toko/*). Semua mutasi lewat layanan M7 (authorize → validasi → aturan → transaksi
 * → audit → event); galat tampil sebagai pesan tindakan berbahasa Indonesia.
 */

function str(fd: FormData, name: string): string | null {
  const v = fd.get(name);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** Bilangan bulat rupiah/jumlah (titik ribuan & awalan Rp dibuang). `null` bila kosong, NaN bila tidak valid. */
function int(fd: FormData, name: string): number | null {
  const s = str(fd, name);
  if (s === null) return null;
  const n = Number(s.replace(/[.\s]/g, "").replace(/^Rp/i, "").replace(",", "."));
  return Number.isFinite(n) ? n : Number.NaN;
}

/** Isian berawalan `prefix` (mis. `qty_<productId>`) → pasangan id–angka > 0. */
function linesFrom(fd: FormData, prefix: string): { id: string; value: number }[] {
  const out: { id: string; value: number }[] = [];
  for (const [key] of fd.entries()) {
    if (!key.startsWith(prefix)) continue;
    const v = int(fd, key);
    if (v !== null && !Number.isNaN(v) && v > 0) out.push({ id: key.slice(prefix.length), value: v });
  }
  return out;
}

async function uploadFile(fd: FormData, name: string, kind: string): Promise<string | null> {
  const file = fd.get(name);
  if (!(file instanceof File) || file.size === 0) return null;
  const { ctx } = await requireOfficeSession();
  const buf = Buffer.from(await file.arrayBuffer());
  const att = await withTx((tx) => put(tx, ctx, { blob: buf, contentType: file.type, kind, originalName: file.name }));
  return att.id;
}

async function attempt(fn: () => Promise<string | void>, message: string, paths: string[]): Promise<OutletActionState> {
  try {
    const custom = await fn();
    for (const p of paths) revalidatePath(p);
    return { ok: true, message: custom || message };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}

// --- Nota pembelian ----------------------------------------------------------------------------------------------------

/** Admin Keuangan menerima nota pengganti sebagai nota (7.7.6; penerima barang ≠ penerima nota). */
export async function acceptSubstituteAction(receiptId: string, _prev: OutletActionState, fd: FormData): Promise<OutletActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      await m7.acceptSubstituteNote(ctx, { receiptId, supplierNoteNumber: str(fd, "supplierNoteNumber"), note: str(fd, "note") });
    },
    "Nota pengganti diterima — stok & utang pemasok tercatat.",
    [`/toko/pembelian/${receiptId}`, "/toko/pembelian", "/toko/utang"],
  );
}

/** Retur sebagian ke pemasok / pembalik penuh nota (US-M7-02 KP-6; > PAR-21 → persetujuan pemilik). */
export async function correctReceiptAction(receiptId: string, _prev: OutletActionState, fd: FormData): Promise<OutletActionState> {
  const { ctx } = await requireOfficeSession();
  const kind = str(fd, "kind") === "reversal" ? "reversal" : "return";
  return attempt(
    async () => {
      const lines = kind === "return" ? linesFrom(fd, "qty_").map((l) => ({ productId: l.id, quantity: l.value })) : undefined;
      const res = await m7.correctPurchaseReceipt(ctx, { receiptId, kind, lines, reason: str(fd, "reason") ?? "" });
      if (res.status === "pending_approval") return "Koreksi di atas batas — menunggu persetujuan pemilik.";
    },
    kind === "reversal" ? "Nota dibalik." : "Retur ke pemasok tercatat.",
    [`/toko/pembelian/${receiptId}`, "/toko/pembelian", "/toko/utang", "/toko/barang"],
  );
}

/** Saldo awal utang pemasok saat cut-over (US-M7-08 KP-3). */
export async function openingPayableAction(_prev: OutletActionState, fd: FormData): Promise<OutletActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const attachmentId = await uploadFile(fd, "photo", "receipt_note");
      await m7.recordOpeningPayable(ctx, {
        outletId: str(fd, "outletId"),
        supplierId: str(fd, "supplierId") ?? "",
        supplierNoteNumber: str(fd, "supplierNoteNumber") ?? "",
        supplierNoteDate: str(fd, "supplierNoteDate") ?? "",
        dueDate: str(fd, "dueDate"),
        amount: int(fd, "amount") ?? Number.NaN,
        attachmentId,
        notes: str(fd, "notes"),
      });
    },
    "Saldo awal utang tercatat.",
    ["/toko/pembelian", "/toko/utang", "/toko/pemasok"],
  );
}

// --- Utang & pembayaran pemasok ---------------------------------------------------------------------------------------

/** Pembayaran pemasok (US-M7-08 KP-2): transfer wajib bukti; alokasi manual per nota atau otomatis nota tertua. */
export async function supplierPaymentAction(_prev: OutletActionState, fd: FormData): Promise<OutletActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const method = str(fd, "method") === "transfer" ? "transfer" : "cash";
      const proofAttachmentId = await uploadFile(fd, "proof", "transfer_proof");
      const allocations = linesFrom(fd, "alloc_").map((a) => ({ purchaseReceiptId: a.id, amount: a.value }));
      const res = await m7.recordSupplierPayment(ctx, {
        supplierId: str(fd, "supplierId") ?? "",
        amount: int(fd, "amount") ?? Number.NaN,
        method,
        businessDate: str(fd, "businessDate"),
        proofAttachmentId,
        allocations: allocations.length ? allocations : undefined,
        notes: str(fd, "notes"),
      });
      return `Pembayaran tercatat — dialokasikan ke ${res.allocations.length} nota.`;
    },
    "Pembayaran tercatat.",
    ["/toko/utang", "/toko/pemasok", "/toko/pembelian"],
  );
}

/** Pembalik pembayaran keliru (≤ PAR-21 langsung; di atasnya persetujuan pemilik). */
export async function reversePaymentAction(paymentId: string, _prev: OutletActionState, fd: FormData): Promise<OutletActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const res = await m7.reverseSupplierPayment(ctx, { paymentId, reason: str(fd, "reason") ?? "" });
      if (res.status === "pending_approval") return "Pembalik di atas batas — menunggu persetujuan pemilik.";
    },
    "Pembayaran dibalik.",
    ["/toko/utang", "/toko/pemasok"],
  );
}

// --- Pemasok ----------------------------------------------------------------------------------------------------------

export async function updateSupplierAction(supplierId: string, _prev: OutletActionState, fd: FormData): Promise<OutletActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      await m7.updateSupplier(ctx, supplierId, {
        contactName: str(fd, "contactName"),
        phone: str(fd, "phone"),
        address: str(fd, "address"),
        paymentTermDays: int(fd, "paymentTermDays"),
        notes: str(fd, "notes"),
      });
    },
    "Data pemasok disimpan.",
    ["/toko/pemasok"],
  );
}

export async function setSupplierActiveAction(supplierId: string, active: boolean, _prev: OutletActionState, fd: FormData): Promise<OutletActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      await m7.setSupplierActive(ctx, supplierId, { active, reason: str(fd, "reason") ?? "" });
    },
    active ? "Pemasok diaktifkan kembali." : "Pemasok dinonaktifkan.",
    ["/toko/pemasok"],
  );
}

// --- Opname & stok awal -----------------------------------------------------------------------------------------------

/** Admin Keuangan (bersama kasir) mengajukan penyesuaian opname bulanan + alasan per selisih → persetujuan pemilik. */
export async function submitCountAction(stockCountId: string, _prev: OutletActionState, fd: FormData): Promise<OutletActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const reasons: { productId: string; reason: "damaged" | "lost" | "miscount" | "other"; reasonNote: string | null }[] = [];
      for (const [key, value] of fd.entries()) {
        if (!key.startsWith("reason_") || typeof value !== "string" || !value) continue;
        const productId = key.slice("reason_".length);
        reasons.push({ productId, reason: value as "damaged" | "lost" | "miscount" | "other", reasonNote: str(fd, `note_${productId}`) });
      }
      const res = await m7.submitStoreStockCount(ctx, { stockCountId, reasons, notes: str(fd, "notes") });
      if (res.differences === 0) return "Opname tanpa selisih — langsung selesai.";
    },
    "Penyesuaian opname diajukan ke pemilik.",
    [`/toko/opname/${stockCountId}`, "/toko/opname"],
  );
}

/** Stok awal cut-over (US-M7-02 KP-5): hasil opname fisik + harga beli terakhir → draf tanda tangan pemilik. */
export async function prepareOpeningStockAction(_prev: OutletActionState, fd: FormData): Promise<OutletActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const qty = linesFrom(fd, "qty_");
      const lines = qty.map((q) => ({ productId: q.id, quantity: q.value, unitCost: int(fd, `cost_${q.id}`) ?? Number.NaN }));
      await m7.prepareOpeningStock(ctx, { outletId: str(fd, "outletId"), lines, notes: str(fd, "notes") });
    },
    "Stok awal disiapkan — menunggu tanda tangan pemilik.",
    ["/toko/opname", "/master/tanda-tangan"],
  );
}

export async function signOpeningStockAction(stockCountId: string, _prev: OutletActionState, fd: FormData): Promise<OutletActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      await m7.signOpeningStock(ctx, { stockCountId, note: str(fd, "note") });
    },
    "Stok awal ditandatangani — kartu stok terisi.",
    [`/toko/opname/${stockCountId}`, "/toko/opname", "/toko/barang"],
  );
}

// --- Retur pelanggan ----------------------------------------------------------------------------------------------------

/** Retur barang setelah shift ditutup (US-M7-01 KP-5, PTB-46; > PAR-21 → persetujuan pemilik). */
export async function storeReturnAction(saleId: string, _prev: OutletActionState, fd: FormData): Promise<OutletActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const lines = linesFrom(fd, "ret_").map((l) => ({ productId: l.id, quantity: l.value }));
      const res = await m7.recordStoreReturn(ctx, { saleId, lines, reason: str(fd, "reason") ?? "" });
      if (res.status === "pending_approval") return "Retur di atas batas — menunggu persetujuan pemilik.";
    },
    "Retur tercatat — stok kembali; nota kredit/pengembalian dana diteruskan ke piutang.",
    ["/toko/laporan", "/toko/barang"],
  );
}
