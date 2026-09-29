/**
 * Regresi temuan audit S5-B (M5): ambang PAR-21 tidak dapat dipecah (nota kredit & realokasi), teks dokumen pelanggan
 * tanpa kode enum/PRD, e-mail pernyataan piutang dengan PDF internal (D-12 butir 2), susulan faktur bulanan, dan batas
 * masa transisi PAR-41 dari tanggal go-live.
 */
import { readFileSync } from "node:fs";

import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { auditLogs, exportLogs, invoiceLines, invoices, notifications, unbilledCharges } from "@/db/schema";
import { resetServerEnvCache } from "@/lib/env";
import { formatUnderpaymentReason } from "@/lib/reasons";
import { addDays } from "@/lib/time";
import { runJobNow } from "@/server/core/jobs";
import * as params from "@/server/core/params";
import * as m5 from "@/server/modules/m5-receivables";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { completeCash, departArrive, driverWorld, expectApplied } from "../m3-driver/helpers";
import { attachment, creditCustomer, finance, invoiceFor, owner, system, today } from "./helpers";

type SentPayload = { to: string[]; subject: string; text: string; attachments?: { filename: string; content: Buffer; contentType?: string }[] };
const resendSend = vi.hoisted(() => vi.fn<(payload: SentPayload) => Promise<{ data: { id: string } | null; error: { message: string } | null }>>());
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));
// D-12 butir 2: e-mail pernyataan TIDAK boleh bergantung pada ekspor laporan (izin m5.aging.export).
vi.mock("@/server/core/export", async (orig) => ({
  ...(await orig<typeof import("@/server/core/export")>()),
  exportReport: vi.fn(async () => {
    throw new Error("exportReport tidak boleh dipakai untuk e-mail pernyataan");
  }),
}));

const CODE_PATTERN = /\b[a-z]+_[a-z_]+\b|\((BR|PTB|PAR|NFR)-\d+\)/;

describe("M5 — ambang koreksi PAR-21 tidak dapat dipecah (BR-38, US-M5-01 KP-6)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M5-01 KP-6 BR-38 nota kredit ≤ PAR-21 berulang pada faktur yang sama dijumlahkan: yang melewati ambang menunggu persetujuan pemilik", async () => {
    const c = await creditCustomer(t.db);
    const inv = await invoiceFor(t.db, c.id, { amount: 1_200_000, issueDate: addDays(today(), -3) });
    const a = await m5.requestCreditNote(finance(), { invoiceId: inv.id, amount: 450_000, reason: "Volume dikoreksi sebagian" });
    expect(a.status).toBe("issued");
    const b = await m5.requestCreditNote(finance(), { invoiceId: inv.id, amount: 450_000, reason: "Volume dikoreksi lagi" });
    expect(b.status).toBe("pending_approval");
    // Permintaan yang masih menunggu ikut dijumlahkan → nota kredit kecil berikutnya tidak lolos tanpa pemilik.
    await expect(m5.requestCreditNote(finance(), { invoiceId: inv.id, amount: 40_000, reason: "Pembulatan harga" })).rejects.toThrow(/menunggu keputusan/);
    const [row] = await t.db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row!.outstandingAmount).toBe(750_000);
  });

  it("US-M5-01 KP-6 BR-38 nota kredit koreksi per pelanggan per hari dijumlahkan lintas faktur", async () => {
    const c = await creditCustomer(t.db);
    const i1 = await invoiceFor(t.db, c.id, { amount: 400_000, issueDate: addDays(today(), -3) });
    const i2 = await invoiceFor(t.db, c.id, { amount: 400_000, issueDate: addDays(today(), -2) });
    expect((await m5.requestCreditNote(finance(), { invoiceId: i1.id, amount: 300_000, reason: "Harga salah ketik" })).status).toBe("issued");
    expect((await m5.requestCreditNote(finance(), { invoiceId: i2.id, amount: 300_000, reason: "Harga salah ketik juga" })).status).toBe("pending_approval");
  });

  it("US-M5-02 KP-1 BR-38 realokasi pelunasan berulang tanpa persetujuan dijumlahkan: melewati PAR-21 → persetujuan pemilik", async () => {
    const c = await creditCustomer(t.db);
    const d = today();
    const a = await invoiceFor(t.db, c.id, { amount: 400_000, issueDate: addDays(d, -20) });
    const b = await invoiceFor(t.db, c.id, { amount: 400_000, issueDate: addDays(d, -2) });
    const proof = await attachment(finance(), "transfer_proof");
    const pay = await m5.recordOfficePayment(finance(), { customerId: c.id, businessDate: d, amount: 400_000, method: "transfer", proofAttachmentId: proof.id });
    const r1 = await m5.reallocateCustomerPayment(finance(), { paymentId: pay.payment.id, allocations: [{ invoiceId: b.id, amount: 400_000 }], reason: "Konfirmasi pelanggan: untuk faktur terbaru" });
    expect(r1.status).toBe("reallocated");
    const r2 = await m5.reallocateCustomerPayment(finance(), { paymentId: pay.payment.id, allocations: [{ invoiceId: a.id, amount: 400_000 }], reason: "Pelanggan berubah pikiran" });
    expect(r2.status).toBe("pending_approval");
  });
});

describe("M5 — teks dokumen & pesan tanpa kode teknis (NFR-15, CLAUDE.md aturan 1)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("NFR-15 US-M5-01 KP-1 alasan kurang bayar pada baris faktur & notifikasi memakai label Indonesia, bukan kode enum", async () => {
    expect(formatUnderpaymentReason("customer_short")).toBe("Uang pelanggan kurang");
    expect(formatUnderpaymentReason("other: uang di rumah")).toBe("uang di rumah");
    expect(formatUnderpaymentReason("credit_not_approved: tanpa persetujuan Dispatcher (luring)")).toBe("Tempo tidak disetujui / tanpa sinyal — tanpa persetujuan Dispatcher (luring)");
    expect(formatUnderpaymentReason("prepaid_short: pembayaran di muka Rp 100.000 kurang")).toMatch(/^Pembayaran di muka kurang/);
    const w = await driverWorld(t.db);
    const trip = await w.addTrip();
    await departArrive(w, trip.id);
    expectApplied(await completeCash(w, trip.id, w.sopir, { payment: { method: "cash", cashReceived: 200_000, underpaymentReasonCode: "customer_short" } }));
    const [inv] = await t.db.select().from(invoices).where(and(eq(invoices.tripId, trip.id), eq(invoices.kind, "underpayment")));
    const lines = await t.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv!.id));
    expect(lines[0]!.description).toContain("Uang pelanggan kurang");
    expect(lines[0]!.description).not.toMatch(CODE_PATTERN);
    const notes = await t.db.select().from(notifications).where(and(eq(notifications.event, "trip.underpayment"), eq(notifications.objectId, trip.id)));
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) expect(n.body ?? "").not.toMatch(/\bcustomer_short\b/);
    // Pernyataan piutang pelanggan tanpa kode aturan PRD.
    const st = await m5.customerStatement(finance(), w.customer.id);
    for (const e of st.entries) expect(e.description).not.toMatch(/\((BR|PTB|PAR|NFR)-\d+\)/);
  });

  it("NFR-15 teks PDF faktur, pernyataan piutang & portal mitra tidak memuat kode aturan PRD", () => {
    for (const file of ["src/server/modules/m5-receivables/service/pdf.tsx", "src/server/modules/m5-receivables/service/aging.ts", "src/app/(portal)/mitra/(app)/layout.tsx"]) {
      const text = readFileSync(file, "utf8");
      const rendered = text
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .filter((l) => /<Text|description:|<p|>\s*[A-Z]/.test(l));
      for (const l of rendered) expect(l, `${file}: ${l.trim()}`).not.toMatch(/\((BR|PTB|PAR|NFR)-\d+\)/);
    }
  });
});

describe("M5 — e-mail pernyataan piutang dengan PDF internal (D-12 butir 2, B-77)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());
  afterEach(() => {
    delete process.env.RESEND_API_KEY;
    resetServerEnvCache();
    resendSend.mockReset();
  });

  it("B-77 D-12 butir 2 US-M5-04 KP-2 izin m5.invoice.send cukup: PDF pernyataan dibangkitkan internal (tanpa ekspor laporan), tetap diaudit", async () => {
    process.env.RESEND_API_KEY = "re_uji_b77";
    resetServerEnvCache();
    resendSend.mockResolvedValue({ data: { id: "msg-b77" }, error: null });
    const c = await creditCustomer(t.db, { name: "Kafe Pernyataan Internal" });
    await invoiceFor(t.db, c.id, { amount: 650_000, issueDate: today() });
    const r = await m5.emailStatement(finance(), { customerId: c.id, email: "kafe@contoh.id" });
    expect(r.mode).toBe("email");
    const sent = resendSend.mock.calls[0]![0];
    expect(sent.attachments![0]!.content.subarray(0, 4).toString()).toBe("%PDF");
    expect(sent.attachments![0]!.filename).toMatch(/^pernyataan-piutang-.*\.pdf$/);
    expect(await t.db.select().from(exportLogs).where(eq(exportLogs.reportKey, "m5.customer_card"))).toHaveLength(0);
    const [audit] = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "customer"), eq(auditLogs.objectId, c.id), eq(auditLogs.action, "statement_sent")));
    expect(audit!.after).toMatchObject({ via: "email", to: "kafe@contoh.id", attachment: sent.attachments![0]!.filename });
  });
});

describe("M5 — susulan faktur bulanan & batas masa transisi (US-M5-06 KP-2, US-M5-03 KP-5)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M5-06 KP-2 job faktur bulanan yang terlewat pada tanggal PAR-12 disusul otomatis hari berikutnya (tanggal faktur = tanggal jalan)", async () => {
    const c = await creditCustomer(t.db, { monthly: true });
    const d = today();
    const period = await m5.monthlyPeriod(t.db, d);
    const serviceDate = period.serviceMonth;
    await t.db.insert(unbilledCharges).values({ tenantId: system().tenantId, customerId: c.id, serviceDate, description: "Air truk rit susulan uji", amount: 300_000, volumeL: 5000, status: "unbilled" });
    const late = addDays(period.issueDate, 2) > d ? d : addDays(period.issueDate, 2);
    const res = await runJobNow("m5.monthly_invoices", new Date(`${late}T05:00:00.000Z`));
    expect(res.status).toBe("succeeded");
    expect(JSON.stringify(res)).not.toMatch(/tanggal terbit/);
    const [inv] = await t.db.select().from(invoices).where(and(eq(invoices.customerId, c.id), eq(invoices.kind, "monthly")));
    expect(inv).toMatchObject({ periodMonth: period.serviceMonth, issueDate: late < period.issueDate ? period.issueDate : late });
  });

  it("US-M5-03 KP-5 PAR-41 masa transisi tanpa tanggal go-live (dan tanpa cut-over) ditolak — batas tidak bergulir dari hari ini", async () => {
    const c = await creditCustomer(t.db);
    const d = today();
    await params.set(owner(d), "PAR-41", { max_months_since_go_live: 2, go_live_date: null }, d, "Go-live belum ditetapkan (uji)");
    const limit = await m5.holdDeferralLimit(owner(d));
    expect(limit.maxUntil).toBeNull();
    await expect(m5.deferCreditHold(owner(d), { customerId: c.id, until: addDays(d, 10), reason: "Masa transisi pelanggan lama" })).rejects.toThrow(/go-live belum ditetapkan/);
    await params.set(owner(d), "PAR-41", { max_months_since_go_live: 2, go_live_date: addDays(d, -10) }, d, "Go-live pilot");
    const ok = await m5.deferCreditHold(owner(d), { customerId: c.id, until: addDays(d, 10), reason: "Masa transisi pelanggan lama" });
    expect(ok).toBeTruthy();
  });
});
