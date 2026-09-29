"use server";

/**
 * Server Action layar Piutang (/piutang/*, M5). Tipis: sesi kantor → layanan M5 (authorize → validasi Zod → aturan &
 * pemisahan tugas → transaksi → audit → event) → revalidasi. Galat tampil sebagai pesan tindakan berbahasa Indonesia.
 */
import { revalidatePath } from "next/cache";

import type { M5ActionState } from "@/components/m5-receivables/action-state";
import { formatRupiah } from "@/lib/money";
import { requireOfficeSession } from "@/server/core/auth/office";
import { withTx } from "@/server/core/db";
import { toUserMessage } from "@/server/core/errors";
import { put } from "@/server/core/storage";
import * as m5 from "@/server/modules/m5-receivables";

// =====================================================================================================================
// Pembantu formulir
// =====================================================================================================================

function str(fd: FormData, name: string): string | null {
  const v = fd.get(name);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** Bilangan bulat rupiah (titik ribuan & awalan Rp dibuang). `null` bila kosong, NaN bila tidak valid. */
function int(fd: FormData, name: string): number | null {
  const s = str(fd, name);
  if (s === null) return null;
  const n = Number(s.replace(/[.\s]/g, "").replace(/^Rp/i, "").replace(",", "."));
  return Number.isFinite(n) ? n : Number.NaN;
}

/** Isian berawalan `prefix` (mis. `alloc_<invoiceId>`) → pasangan id–jumlah > 0. */
function allocationsFrom(fd: FormData, prefix = "alloc_"): { invoiceId: string; amount: number }[] {
  const out: { invoiceId: string; amount: number }[] = [];
  for (const [key] of fd.entries()) {
    if (!key.startsWith(prefix)) continue;
    const v = int(fd, key);
    if (v !== null && !Number.isNaN(v) && v > 0) out.push({ invoiceId: key.slice(prefix.length), amount: v });
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

const ALL_PATHS = ["/piutang", "/piutang/faktur", "/piutang/pelunasan", "/piutang/umur", "/piutang/pengingat", "/piutang/faktur-bulanan", "/piutang/saldo-awal", "/piutang/status-kredit"];

async function attempt(fn: () => Promise<string | { message?: string; link?: string | null } | void>, message: string, paths: string[] = []): Promise<M5ActionState> {
  try {
    const res = await fn();
    for (const p of [...ALL_PATHS, ...paths]) revalidatePath(p);
    if (typeof res === "string") return { ok: true, message: res };
    return { ok: true, message: res?.message ?? message, link: res?.link ?? null };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}

// =====================================================================================================================
// Faktur (US-M5-01, 7.5.6)
// =====================================================================================================================

/** Kirim faktur lewat WA (tautan) atau draf e-mail — pengiriman tercatat (US-M5-01 KP-5, US-M5-06 KP-4). */
export async function sendInvoiceAction(invoiceId: string, via: "wa" | "email"): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const r = await m5.sendInvoice(ctx, { invoiceId, via });
      return { link: r.link, message: via === "wa" ? "WhatsApp dibuka — pengiriman faktur tercatat." : "Draf e-mail dibuka — lampirkan PDF faktur; pengiriman tercatat." };
    },
    "Pengiriman tercatat.",
    [`/piutang/faktur/${invoiceId}`],
  );
}

/** Tandai faktur bersengketa (7.5.6). */
export async function disputeInvoiceAction(invoiceId: string, _prev: M5ActionState, fd: FormData): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const inv = await m5.disputeInvoice(ctx, { invoiceId, note: str(fd, "note") ?? "" });
      return `Faktur ${inv.number} ditandai bersengketa — pengingat & penahanan ditunda sampai diputuskan pemilik.`;
    },
    "Faktur ditandai bersengketa.",
    [`/piutang/faktur/${invoiceId}`],
  );
}

/** Keputusan sengketa oleh pemilik: nota kredit atau sengketa ditolak (7.5.6). */
export async function decideDisputeAction(invoiceId: string, _prev: M5ActionState, fd: FormData): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  const decision = str(fd, "decision") === "credit_note" ? "credit_note" : "reject";
  return attempt(
    async () => {
      const input =
        decision === "credit_note"
          ? { invoiceId, decision, amount: int(fd, "amount") ?? Number.NaN, reason: str(fd, "reason") ?? "" }
          : { invoiceId, decision, reason: str(fd, "reason") ?? "" };
      await m5.decideDispute(ctx, input);
      return decision === "credit_note" ? "Sengketa diputuskan: nota kredit terbit." : "Sengketa ditolak — faktur kembali ditagih.";
    },
    "Sengketa diputuskan.",
    [`/piutang/faktur/${invoiceId}`],
  );
}

/** Nota kredit beralasan (BR-38; > PAR-21 → persetujuan pemilik). */
export async function creditNoteAction(invoiceId: string, _prev: M5ActionState, fd: FormData): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const r = await m5.requestCreditNote(ctx, { invoiceId, amount: int(fd, "amount") ?? Number.NaN, reason: str(fd, "reason") ?? "" });
      return r.status === "pending_approval" ? `Nota kredit di atas batas koreksi — menunggu persetujuan pemilik (${r.approvalNumber}).` : "Nota kredit terbit.";
    },
    "Nota kredit terbit.",
    [`/piutang/faktur/${invoiceId}`],
  );
}

/** Konversi kurang bayar → tempo setelah tempo lapangan disetujui Dispatcher (PTB-19, B-16). */
export async function convertUnderpaymentAction(invoiceId: string, reason: string): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const r = await m5.convertUnderpaymentToCredit(ctx, { invoiceId, reason });
      return `Kurang bayar ditutup; faktur kirim tempo ${r.invoice.number} terbit (jatuh tempo mengikuti tempo pelanggan).`;
    },
    "Kurang bayar dikonversi menjadi tempo.",
    [`/piutang/faktur/${invoiceId}`],
  );
}

/** Batalkan entri saldo awal yang salah sebelum ditandatangani (nota kredit penuh, berjejak). */
export async function cancelOpeningAction(invoiceId: string, reason: string): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      await m5.cancelOpeningInvoice(ctx, { invoiceId, reason });
    },
    "Entri saldo awal dibatalkan dengan nota kredit.",
    [`/piutang/faktur/${invoiceId}`],
  );
}

// =====================================================================================================================
// Pelunasan & uang muka (US-M5-02, 7.5.6)
// =====================================================================================================================

/** Pelunasan kantor: tunai kantor / transfer (bukti wajib); alokasi bawaan tertua dulu atau per faktur (KP-1). */
export async function recordPaymentAction(_prev: M5ActionState, fd: FormData): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const method = str(fd, "method") === "transfer" ? "transfer" : "cash";
    const proofAttachmentId = await uploadFile(fd, "proof", "transfer_proof");
    const allocations = allocationsFrom(fd);
    const r = await m5.recordOfficePayment(ctx, {
      customerId: str(fd, "customerId") ?? "",
      businessDate: str(fd, "businessDate") ?? "",
      amount: int(fd, "amount") ?? Number.NaN,
      method,
      proofAttachmentId,
      allocations: allocations.length ? allocations : null,
      notes: str(fd, "notes"),
    });
    const parts = [`Pelunasan ${formatRupiah(r.payment.amount)} tercatat — dialokasikan ke ${r.allocations.length} faktur.`];
    if (r.advanceAmount > 0) parts.push(`Kelebihan ${formatRupiah(r.advanceAmount)} menjadi uang muka pelanggan.`);
    return parts.join(" ");
  }, "Pelunasan tercatat.");
}

/** Pembalik pelunasan beralasan (KP-4; > PAR-21 persetujuan pemilik). */
export async function reversePaymentAction(paymentId: string, reason: string): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const r = await m5.reverseCustomerPayment(ctx, { paymentId, reason });
      return r.status === "pending_approval" ? `Pembalik di atas batas koreksi — menunggu persetujuan pemilik (${r.approvalNumber}).` : "Pelunasan dibalik; faktur kembali terbuka.";
    },
    "Pelunasan dibalik.",
    [`/piutang/pelunasan/${paymentId}`],
  );
}

/** Realokasi pelunasan (KP-1 "dapat diubah"; 7.5.6 transfer tanpa keterangan). */
export async function reallocatePaymentAction(paymentId: string, _prev: M5ActionState, fd: FormData): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const r = await m5.reallocateCustomerPayment(ctx, { paymentId, allocations: allocationsFrom(fd), reason: str(fd, "reason") ?? "" });
      return r.status === "pending_approval" ? `Realokasi di atas batas koreksi — menunggu persetujuan pemilik (${r.approvalNumber}).` : "Alokasi pelunasan diubah.";
    },
    "Alokasi diubah.",
    [`/piutang/pelunasan/${paymentId}`],
  );
}

/** 7.5.6: tunai rit yang sebenarnya pelunasan faktur lama → reklasifikasi (kas tidak berubah). */
export async function reclassifyTripCashAction(_prev: M5ActionState, fd: FormData): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const amount = int(fd, "amount");
    const r = await m5.reclassifyTripCash(ctx, { tripId: str(fd, "tripId") ?? "", amount: amount === null ? null : amount, reason: str(fd, "reason") ?? "" });
    return r.status === "pending_approval" ? `Reklasifikasi di atas batas koreksi — menunggu persetujuan pemilik (${r.approvalNumber}).` : "Tunai rit dialihkan menjadi pelunasan; rit menjadi faktur kirim. Kas tidak berubah.";
  }, "Reklasifikasi tercatat.");
}

/** Alokasikan uang muka ke faktur tertentu (KP-3). */
export async function applyAdvanceAction(advanceId: string, _prev: M5ActionState, fd: FormData): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const amount = int(fd, "amount");
    const n = await m5.applyAdvance(ctx, { advanceId, invoiceId: str(fd, "invoiceId") ?? "", amount: amount === null ? null : amount });
    return `Uang muka ${formatRupiah(n)} dialokasikan ke faktur.`;
  }, "Uang muka dialokasikan.");
}

/** Ajukan pengembalian uang muka ke pelanggan (persetujuan pemilik, KP-3). */
export async function requestRefundAction(advanceId: string, _prev: M5ActionState, fd: FormData): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const req = await m5.requestAdvanceRefund(ctx, {
      advanceId,
      amount: int(fd, "amount") ?? Number.NaN,
      method: str(fd, "method") === "transfer" ? "transfer" : "cash",
      reason: str(fd, "reason") ?? "",
    });
    return `Pengembalian uang muka diajukan ke pemilik (${req.number}).`;
  }, "Pengembalian diajukan.");
}

/** Bukti pelunasan lewat WA (KP-5). */
export async function sendReceiptAction(paymentId: string): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const r = await m5.sendPaymentReceipt(ctx, { paymentId });
      return { link: r.link, message: "WhatsApp dibuka — bukti pelunasan tercatat terkirim." };
    },
    "Bukti pelunasan dikirim.",
    [`/piutang/pelunasan/${paymentId}`],
  );
}

// =====================================================================================================================
// Status kredit & Ditahan (US-M5-03)
// =====================================================================================================================

/** Hitung ulang umur faktur & status Ditahan sekarang (KP-1). */
export async function evaluateHoldsAction(): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const r = await m5.runHoldEvaluationNow(ctx);
    return `Evaluasi selesai: ${r.evaluated} pelanggan dinilai, ${r.held.length} Ditahan, ${r.released.length} dilepas, ${r.deferred.length} dalam masa transisi.`;
  }, "Evaluasi selesai.");
}

/** Pemilik membuka Ditahan sebelum lunas (beralasan; berlaku sampai keterlambatan berikutnya). */
export async function releaseHoldAction(customerId: string, reason: string): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      await m5.releaseCreditHold(ctx, { customerId, reason });
    },
    "Ditahan dibuka — berlaku sampai keterlambatan berikutnya.",
    [`/piutang/pelanggan/${customerId}`],
  );
}

/** Dispatcher/Admin Keuangan mengajukan pembukaan Ditahan ke pemilik (6.2a). */
export async function requestHoldReleaseAction(customerId: string, reason: string): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const req = await m5.requestCreditHoldRelease(ctx, { customerId, reason });
      return `Pembukaan Ditahan diajukan ke pemilik (${req.number}).`;
    },
    "Diajukan ke pemilik.",
    [`/piutang/pelanggan/${customerId}`],
  );
}

/** Pemilik menunda penahanan otomatis (masa transisi, PAR-41; 6.2b). */
export async function deferHoldAction(customerId: string, _prev: M5ActionState, fd: FormData): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const r = await m5.deferCreditHold(ctx, { customerId, until: str(fd, "until") ?? "", reason: str(fd, "reason") ?? "" });
      return r.released ? "Masa transisi ditetapkan; status Ditahan dilepas selama masa transisi." : "Masa transisi ditetapkan.";
    },
    "Masa transisi ditetapkan.",
    [`/piutang/pelanggan/${customerId}`],
  );
}

/** Pemilik mengakhiri masa transisi lebih awal. */
export async function endDeferralAction(customerId: string, reason: string): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      await m5.endCreditHoldDeferral(ctx, { customerId, reason });
    },
    "Masa transisi diakhiri.",
    [`/piutang/pelanggan/${customerId}`],
  );
}

// =====================================================================================================================
// Kartu piutang & pengingat (US-M5-04, US-M5-05)
// =====================================================================================================================

/** Kirim kartu piutang sebagai pernyataan piutang lewat WA (US-M5-04 KP-2). */
export async function sendStatementAction(customerId: string): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const r = await m5.sendStatement(ctx, { customerId });
      return { link: r.link, message: "WhatsApp dibuka — pernyataan piutang tercatat terkirim." };
    },
    "Pernyataan piutang dikirim.",
    [`/piutang/pelanggan/${customerId}`],
  );
}

/** Tombol "Buka WhatsApp" pengingat H-3/H+1 — status "dibuka" tercatat (US-M5-05 KP-1). */
export async function openReminderAction(customerId: string, kind: "before_due" | "after_due", date: string | null): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const r = await m5.openReminder(ctx, { customerId, kind, date });
    return { link: r.link, message: "WhatsApp dibuka — pengingat tercatat Dibuka." };
  }, "Pengingat dibuka.");
}

/** Pemilik mengubah template pesan piutang (versi baru; US-M5-05 KP-2). */
export async function updateTemplateAction(_prev: M5ActionState, fd: FormData): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const row = await m5.updateReceivableTemplate(ctx, { kind: str(fd, "kind") ?? "", body: str(fd, "body") ?? "", reason: str(fd, "reason") ?? "" });
    return `Template tersimpan sebagai versi ${row.version}.`;
  }, "Template tersimpan.");
}

// =====================================================================================================================
// Faktur bulanan (US-M5-06)
// =====================================================================================================================

/** Ajukan penanda tagihan bulanan (perjanjian tertulis wajib; persetujuan pemilik, BR-05). */
export async function requestMonthlyBillingAction(_prev: M5ActionState, fd: FormData): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const agreementAttachmentId = await uploadFile(fd, "agreement", "agreement");
    const req = await m5.requestMonthlyBilling(ctx, { customerId: str(fd, "customerId") ?? "", agreementAttachmentId: agreementAttachmentId ?? "", reason: str(fd, "reason") ?? "" });
    return `Penanda tagihan bulanan diajukan ke pemilik (${req.number}).`;
  }, "Diajukan ke pemilik.");
}

/** Terbitkan faktur bulanan periode lalu sekarang (bila job belum berjalan; idempoten). */
export async function runMonthlyAction(): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const r = await m5.runMonthlyInvoicingNow(ctx);
    return r.issued.length ? `${r.issued.length} faktur bulanan terbit.` : "Tidak ada faktur bulanan baru (sudah terbit atau tidak ada rit belum ditagih).";
  }, "Selesai.");
}

// =====================================================================================================================
// Saldo awal (US-M5-07)
// =====================================================================================================================

/** Input faktur saldo awal (bukti konfirmasi pelanggan wajib; KP-1). */
export async function createOpeningAction(_prev: M5ActionState, fd: FormData): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const confirmationAttachmentId = await uploadFile(fd, "confirmation", "customer_confirmation");
    const inv = await m5.createOpeningInvoice(ctx, {
      customerId: str(fd, "customerId") ?? "",
      line: str(fd, "line") ?? undefined,
      issueDate: str(fd, "issueDate") ?? "",
      dueDate: str(fd, "dueDate") ?? "",
      description: str(fd, "description") ?? "",
      amount: int(fd, "amount") ?? Number.NaN,
      confirmationAttachmentId: confirmationAttachmentId ?? "",
    });
    return `Faktur saldo awal ${inv.number} tercatat (${formatRupiah(inv.amount)}).`;
  }, "Saldo awal tercatat.");
}

/** Pemilik menandatangani total saldo awal piutang (KP-2, NFR-34). */
export async function signOpeningAction(_prev: M5ActionState, fd: FormData): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const expected = int(fd, "expectedTotal");
    await m5.signOpeningBalances(ctx, { note: str(fd, "note"), expectedTotal: expected === null || Number.isNaN(expected) ? null : expected });
  }, "Total saldo awal piutang ditandatangani — faktur saldo awal ikut umur, pengingat, dan penahanan.");
}

/** Koreksi saldo awal setelah ditandatangani (persetujuan pemilik; ≤ PAR-62 bulan setelah cut-over). */
export async function requestOpeningAdjustmentAction(_prev: M5ActionState, fd: FormData): Promise<M5ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const action = str(fd, "action") === "reduce" ? "reduce" : "add";
    let req;
    if (action === "add") {
      const confirmationAttachmentId = await uploadFile(fd, "confirmation", "customer_confirmation");
      req = await m5.requestOpeningAdjustment(ctx, {
        action,
        customerId: str(fd, "customerId") ?? "",
        line: str(fd, "line") ?? undefined,
        issueDate: str(fd, "issueDate") ?? "",
        dueDate: str(fd, "dueDate") ?? "",
        description: str(fd, "description") ?? "",
        amount: int(fd, "amount") ?? Number.NaN,
        confirmationAttachmentId: confirmationAttachmentId ?? "",
        reason: str(fd, "reason") ?? "",
      });
    } else {
      req = await m5.requestOpeningAdjustment(ctx, { action, invoiceId: str(fd, "invoiceId") ?? "", amount: int(fd, "amount") ?? Number.NaN, reason: str(fd, "reason") ?? "" });
    }
    return `Koreksi saldo awal diajukan ke pemilik (${req.number}).`;
  }, "Koreksi diajukan.");
}
