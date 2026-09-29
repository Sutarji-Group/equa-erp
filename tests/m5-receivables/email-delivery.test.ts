/**
 * B-36 (D-10 butir 2) — faktur & pernyataan piutang dikirim lewat e-mail dari server (Resend) dengan PDF terlampir;
 * tanpa `RESEND_API_KEY` sistem membuka draf e-mail (`mailto:` berpenerima) dan mencatatnya "dibuka", bukan "terkirim".
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { auditLogs, exportLogs } from "@/db/schema";
import { resetServerEnvCache } from "@/lib/env";
import { DomainError, ValidationError } from "@/server/core/errors";
import { isEmailDeliveryConfigured } from "@/server/core/notifications";
import * as m5 from "@/server/modules/m5-receivables";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { creditCustomer, dispatcher, finance, invoiceFor, invoiceRow, today } from "./helpers";

type SentPayload = { to: string[]; subject: string; text: string; attachments?: { filename: string; content: Buffer; contentType?: string }[] };

const resendSend = vi.hoisted(() => vi.fn<(payload: SentPayload) => Promise<{ data: { id: string } | null; error: { message: string } | null }>>());
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

function useResend(on: boolean) {
  if (on) process.env.RESEND_API_KEY = "re_uji_b36";
  else delete process.env.RESEND_API_KEY;
  resetServerEnvCache();
}

describe("B-36 e-mail faktur & pernyataan piutang dari server dengan PDF terlampir", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());
  afterEach(() => {
    useResend(false);
    resendSend.mockReset();
  });

  it("B-36 US-M5-01 KP-5 tanpa pengirim server: draf e-mail berpenerima dibuka dan dicatat 'draf e-mail', bukan 'terkirim'", async () => {
    useResend(false);
    expect(isEmailDeliveryConfigured()).toBe(false);
    const c = await creditCustomer(t.db, { name: "Hotel Draf Surel" });
    const inv = await invoiceFor(t.db, c.id, { amount: 750_000, issueDate: today() });
    const r = await m5.emailInvoice(finance(), { invoiceId: inv.id, email: "keuangan@hotel.contoh" });
    expect(r.mode).toBe("mailto");
    expect(r.link).toMatch(/^mailto:keuangan%40hotel\.contoh\?subject=/);
    expect(decodeURIComponent(r.link!)).toContain(inv.number);
    expect(await invoiceRow(t.db, inv.id)).toMatchObject({ sentVia: "email_link" });
    expect(resendSend).not.toHaveBeenCalled();
    // Alamat boleh kosong untuk draf (diisi di aplikasi e-mail pengguna).
    const blank = await m5.emailInvoice(finance(), { invoiceId: inv.id, email: null });
    expect(blank.link).toMatch(/^mailto:\?subject=/);
  });

  it("B-36 US-M5-01 KP-5 US-M5-06 KP-4 Resend aktif: faktur terkirim dengan PDF terlampir, tercatat 'email' + audit penerima", async () => {
    useResend(true);
    resendSend.mockResolvedValue({ data: { id: "msg-b36-1" }, error: null });
    const c = await creditCustomer(t.db, { name: "Hotel Surel Server" });
    const inv = await invoiceFor(t.db, c.id, { amount: 1_250_000, issueDate: today() });
    const r = await m5.emailInvoice(finance(), { invoiceId: inv.id, email: "tagihan@hotel.contoh" });
    expect(r).toMatchObject({ mode: "email", link: null, to: "tagihan@hotel.contoh" });
    expect(resendSend).toHaveBeenCalledTimes(1);
    const sent = resendSend.mock.calls[0]![0];
    expect(sent.to).toEqual(["tagihan@hotel.contoh"]);
    expect(sent.subject).toContain(inv.number);
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments![0]!.filename).toBe(`faktur-${inv.number}.pdf`);
    expect(sent.attachments![0]!.contentType).toBe("application/pdf");
    expect(sent.attachments![0]!.content.subarray(0, 4).toString()).toBe("%PDF");
    expect(await invoiceRow(t.db, inv.id)).toMatchObject({ sentVia: "email" });
    const [audit] = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "invoice"), eq(auditLogs.objectId, inv.id), eq(auditLogs.action, "send")));
    expect(audit!.after).toMatchObject({ via: "email", to: "tagihan@hotel.contoh", attachment: `faktur-${inv.number}.pdf`, messageId: "msg-b36-1" });
    // Alamat wajib saat dikirim dari server; peran tanpa izin kirim ditolak.
    await expect(m5.emailInvoice(finance(), { invoiceId: inv.id, email: "" })).rejects.toBeInstanceOf(ValidationError);
    await expect(m5.emailInvoice(dispatcher(), { invoiceId: inv.id, email: "tagihan@hotel.contoh" })).rejects.toThrow();
  });

  it("B-36 US-M5-01 KP-5 kirim e-mail gagal → transaksi batal (tidak tercatat terkirim) dan pesan berisi tindakan", async () => {
    useResend(true);
    resendSend.mockResolvedValue({ data: null, error: { message: "Invalid `to` field" } });
    const c = await creditCustomer(t.db, { name: "Hotel Surel Gagal" });
    const inv = await invoiceFor(t.db, c.id, { amount: 500_000, issueDate: today() });
    const err = await m5.emailInvoice(finance(), { invoiceId: inv.id, email: "salah@alamat.contoh" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).message).toMatch(/gagal terkirim ke salah@alamat\.contoh.*coba lagi/);
    expect(await invoiceRow(t.db, inv.id)).toMatchObject({ sentAt: null, sentVia: null });
  });

  it("B-36 US-M5-04 KP-2 pernyataan piutang terkirim lewat e-mail dengan PDF kartu piutang (PDF internal, pengiriman tercatat di jejak audit — D-12 butir 2)", async () => {
    useResend(true);
    resendSend.mockResolvedValue({ data: { id: "msg-b36-2" }, error: null });
    const c = await creditCustomer(t.db, { name: "Restoran Pernyataan Surel" });
    await invoiceFor(t.db, c.id, { amount: 900_000, issueDate: today() });
    const r = await m5.emailStatement(finance(), { customerId: c.id, email: "owner@resto.contoh" });
    expect(r.mode).toBe("email");
    const sent = resendSend.mock.calls[0]![0];
    expect(sent.subject).toContain("Pernyataan piutang Restoran Pernyataan Surel");
    expect(sent.text).toContain("Restoran Pernyataan Surel");
    expect(sent.attachments![0]!.content.subarray(0, 4).toString()).toBe("%PDF");
    // D-12 butir 2 (B-77): PDF internal — bukan ekspor laporan; pengiriman (penerima + lampiran) tercatat di jejak audit.
    expect(await t.db.select().from(exportLogs).where(eq(exportLogs.reportKey, "m5.customer_card"))).toHaveLength(0);
    const [audit] = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "customer"), eq(auditLogs.objectId, c.id), eq(auditLogs.action, "statement_sent")));
    expect(audit!.after).toMatchObject({ via: "email", to: "owner@resto.contoh", attachment: sent.attachments![0]!.filename });

    useResend(false);
    const draft = await m5.emailStatement(finance(), { customerId: c.id, email: "owner@resto.contoh" });
    expect(draft.mode).toBe("mailto");
    expect(draft.link).toMatch(/^mailto:owner%40resto\.contoh\?subject=Pernyataan/);
  });
});
