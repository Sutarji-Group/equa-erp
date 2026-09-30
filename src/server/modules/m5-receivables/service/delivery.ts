/**
 * M5 — kirim faktur & pernyataan piutang lewat e-mail dari SERVER (D-10 butir 2, backlog B-36; US-M5-01 KP-5,
 * US-M5-04 KP-2, US-M5-06 KP-4):
 *
 * - `RESEND_API_KEY` terisi → e-mail dikirim lewat Resend dengan PDF terlampir (faktur: `renderInvoicePdf`; pernyataan:
 *   `renderStatementPdf` internal — cukup izin `m5.invoice.send`, D-12 butir 2 — tercatat di jejak audit), status "terkirim".
 * - Tidak terisi → tautan `mailto:` berisi subjek & teks (PDF dilampirkan manual dari tombol unduh), dicatat "dibuka",
 *   bukan "terkirim".
 *
 * PDF dirender SEBELUM transaksi (renderer memakai koneksi DB sendiri); e-mail dikirim di dalam transaksi setelah semua
 * validasi — gagal kirim → transaksi batal (tidak ada catatan "terkirim" palsu), pesan tindakan untuk pengguna.
 */
import "server-only";

import { eq } from "drizzle-orm";
import { z } from "zod";

import { invoices } from "@/db/schema";

import { record as auditRecord } from "@/server/core/audit";
import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, parseInput, ValidationError } from "@/server/core/errors";
import { isEmailDeliveryConfigured, sendEmail } from "@/server/core/notifications";
import { authorize, runService } from "@/server/core/rbac";

import { renderStatementPdf, statementMessage } from "./aging";
import { loadInvoice } from "./common";
import { invoiceMessage, sendInvoice } from "./invoices";
import { renderInvoicePdf } from "./pdf";

export type EmailDeliveryResult = {
  /** `email` = terkirim dari server; `mailto` = draf e-mail dibuka di perangkat pengguna. */
  mode: "email" | "mailto";
  link: string | null;
  to: string | null;
  text: string;
};

const emailField = z.email({ error: "Alamat e-mail pelanggan tidak valid. Periksa penulisannya (mis. nama@contoh.com)." }).max(200);

const emailInvoiceSchema = z.object({ invoiceId: z.string().uuid(), email: emailField.nullable().optional() });
const emailStatementSchema = z.object({ customerId: z.string().uuid(), email: emailField.nullable().optional() });

function requireRecipient(email: string | null | undefined): string {
  if (!email) throw ValidationError.field("email", "Isi alamat e-mail pelanggan untuk mengirim dari server.");
  return email;
}

function deliveryFailed(what: string, to: string): DomainError {
  return new DomainError("EMAIL_NOT_SENT", `${what} gagal terkirim ke ${to}. Periksa alamat e-mail lalu coba lagi, atau kirim lewat WhatsApp.`);
}

/** Kirim faktur lewat e-mail (PDF terlampir) — atau draf `mailto:` bila pengirim server belum dikonfigurasi. */
export async function emailInvoice(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<EmailDeliveryResult> {
  await authorize(ctx, "m5.invoice.send", { tx: opts.tx });
  const data = parseInput(emailInvoiceSchema, input, { email: "Alamat e-mail" });
  if (!isEmailDeliveryConfigured()) {
    const r = await sendInvoice(ctx, { invoiceId: data.invoiceId, via: "email", email: data.email ?? null }, opts);
    return { mode: "mailto", link: r.link, to: data.email ?? null, text: r.text };
  }
  const to = requireRecipient(data.email);
  const pdf = await renderInvoicePdf(ctx, data.invoiceId);
  return runService(ctx, opts, async (tx) => {
    const inv = await loadInvoice(tx, data.invoiceId, { ctx, forUpdate: true });
    const msg = await invoiceMessage(tx, ctx, inv);
    const res = await sendEmail({ to: [to], subject: msg.subject, text: msg.text, attachments: [{ filename: pdf.filename, content: pdf.body, contentType: "application/pdf" }] });
    if (!res.ok) throw deliveryFailed(`E-mail faktur ${inv.number}`, to);
    await tx.update(invoices).set({ sentAt: ctx.now, sentVia: "email", updatedAt: ctx.now }).where(eq(invoices.id, inv.id));
    await auditRecord(tx, {
      ctx,
      objectType: "invoice",
      objectId: inv.id,
      action: "send",
      after: { via: "email", sentAt: ctx.now, to, attachment: pdf.filename, messageId: res.id ?? null, mode: res.mode },
      rule: "US-M5-01 KP-5, D-10 butir 2",
    });
    return { mode: "email" as const, link: null, to, text: msg.text };
  });
}

/** Kirim pernyataan piutang lewat e-mail (PDF kartu piutang terlampir) — atau draf `mailto:`. */
export async function emailStatement(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<EmailDeliveryResult> {
  await authorize(ctx, "m5.invoice.send", { tx: opts.tx });
  const data = parseInput(emailStatementSchema, input, { email: "Alamat e-mail" });
  const configured = isEmailDeliveryConfigured();
  const to = configured ? requireRecipient(data.email) : (data.email ?? null);
  // D-12 butir 2 (B-77): izin `m5.invoice.send` cukup — PDF pernyataan dibangkitkan INTERNAL (bukan lewat ekspor laporan
  // yang butuh `m5.aging.export`), dirender di luar transaksi; pengiriman tercatat di jejak audit (lampiran + penerima).
  const pdf = configured ? await renderStatementPdf(ctx, data.customerId, opts) : null;
  return runService(ctx, opts, async (tx) => {
    const msg = await statementMessage(tx, ctx, data.customerId);
    let link: string | null = null;
    if (pdf && to) {
      const res = await sendEmail({ to: [to], subject: msg.subject, text: msg.text, attachments: [{ filename: pdf.filename, content: pdf.body, contentType: "application/pdf" }] });
      if (!res.ok) throw deliveryFailed("E-mail pernyataan piutang", to);
    } else {
      link = `mailto:${to ? encodeURIComponent(to) : ""}?subject=${encodeURIComponent(msg.subject)}&body=${encodeURIComponent(msg.text)}`;
    }
    await auditRecord(tx, {
      ctx,
      objectType: "customer",
      objectId: msg.customer.id,
      action: "statement_sent",
      after: { via: pdf ? "email" : "email_link", to, balance: msg.statement.closingBalance, unbilled: msg.statement.unbilled, attachment: pdf?.filename ?? null },
      rule: "US-M5-04 KP-2, D-10 butir 2",
    });
    return { mode: pdf ? ("email" as const) : ("mailto" as const), link, to, text: msg.text };
  });
}
