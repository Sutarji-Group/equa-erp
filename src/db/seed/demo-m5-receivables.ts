/**
 * Seed demo M5 — Piutang & Penagihan. Idempoten: seluruh data demo ditulis SEKALI (penanda: faktur demo pertama belum
 * ada); ID deterministik; nomor faktur/nota kredit memakai urutan resmi (`document_sequences`) dan dinaikkan hanya saat
 * baris benar-benar dibuat. Event domain TIDAK dipancarkan (seed menulis langsung, seperti seed demo modul lain).
 * Dilewati di Vitest (tanggal relatif hari ini) kecuali `force: true`.
 *
 * Isi (relatif terhadap `now`), dipilih agar setiap layar /piutang/* berisi dan konsisten dengan aturan malam hari:
 * - PLG-0024 PT Sinar Tekstil: faktur 2 rit lewat tempo 6 hari, dibayar sebagian lewat transfer (→ "akan Ditahan");
 *   faktur baru dengan nota kredit koreksi harga.
 * - PLG-0025 CV Tahu Cibuntu: faktur jatuh tempo H+3 (pengingat H-3) dan faktur lewat 1 hari (pengingat H+1, sudah
 *   Dibuka Admin Keuangan pagi ini).
 * - PLG-0026 PT Kerupuk Mekar Sari (status Ditahan dari seed pelanggan): faktur lewat tempo 26 hari + kurang bayar lama.
 * - PLG-0033 Hotel Puncak: faktur bersengketa (volume) + faktur belum jatuh tempo.
 * - PLG-0034 Hotel Bukit Indah (tagihan bulanan): faktur bulanan bulan lalu (terbit tanggal 1, jatuh tempo tanggal
 *   15 — siap kirim sebelum tanggal 15, lunas & terkirim sesudahnya) + rit bulan ini "belum ditagih".
 * - PLG-0001 Depot Air Tirta Sari (mitra toko): faktur toko lama lunas tunai kantor dengan kelebihan → uang muka, dan
 *   faktur untuk penjualan tempo toko demo M7 (backlog B-23) yang otomatis terpotong uang muka tersebut.
 * - PLG-0018 Perumahan Griya: faktur kurang bayar lapangan H+0 kemarin (PTB-18).
 * - PLG-0037 Kolam Renang Tirta Kencana: faktur lunas lewat transfer.
 * - PLG-0028 PT Pakan Ternak (Tempo migrasi): 2 faktur saldo awal cut-over + ringkasan menunggu tanda tangan pemilik.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { addDays, firstDayOfMonth, toBusinessDate, wibToUtc, type BusinessDate } from "@/lib/time";
import type { EnumValue, InvoiceKind } from "@/lib/labels";

import type { DbOrTx } from "../client";
import {
  attachments,
  creditNotes,
  customerAdvances,
  customerPayments,
  customers,
  dataSignoffs,
  documentSequences,
  invoiceLines,
  invoices,
  paymentAllocations,
  posSaleLines,
  posSales,
  products,
  receivableReminders,
  unbilledCharges,
} from "../schema";
import { CUSTOMER_SEEDS, customerId } from "./customers";
import { seedId } from "./ids";
import { EQUA_TENANT_ID, userIdByUsername } from "./org";

const TRIP_PRICE = 450_000;
const HOTEL_PRICE = 550_000;

type LineSpec = {
  description: string;
  amount: number;
  serviceDate: BusinessDate;
  volumeL?: number | null;
  component?: EnumValue<"invoice_line_component">;
  quantity?: number;
  unitPrice?: number;
  posSaleLineId?: string | null;
  productId?: string | null;
};

type InvoiceSpec = {
  key: string;
  customer: string;
  kind: InvoiceKind;
  issueDate: BusinessDate;
  dueDate: BusinessDate;
  lines: LineSpec[];
  description?: string;
  periodMonth?: BusinessDate | null;
  posSaleId?: string | null;
  opening?: { confirmationAttachmentId: string };
  dispute?: { note: string; at: Date; until: BusinessDate };
  sent?: { at: Date; via: "wa" | "email" };
};

type PaymentSpec = {
  key: string;
  customer: string;
  businessDate: BusinessDate;
  amount: number;
  method: "cash" | "transfer";
  allocations: { invoiceKey: string; amount: number }[];
  notes: string;
};

type CreditNoteSpec = { key: string; invoiceKey: string; amount: number; reason: string; issueDate: BusinessDate };

const yy = (d: BusinessDate) => d.slice(2, 4);

/** Nomor berikutnya (logika sama dengan core/numbering `nextNumber`, tanpa impor server-only). */
async function nextSeq(tx: DbOrTx, kind: "invoice" | "credit_note", scopeKey: string): Promise<number> {
  const rows = await tx
    .insert(documentSequences)
    .values({ id: seedId(`m5:demo:seq:${kind}:${scopeKey}:first`), tenantId: EQUA_TENANT_ID, kind, scopeKey, lastValue: 1 })
    .onConflictDoUpdate({
      target: [documentSequences.tenantId, documentSequences.kind, documentSequences.scopeKey],
      set: { lastValue: sql`${documentSequences.lastValue} + 1`, updatedAt: new Date() },
    })
    .returning({ lastValue: documentSequences.lastValue });
  return Number(rows[0]!.lastValue);
}

function addressOf(code: string): { id: string; text: string } {
  const c = CUSTOMER_SEEDS.find((x) => x.code === code);
  return { id: seedId(`address:${code}:utama`), text: c?.address ?? "" };
}

const invoiceIdOf = (key: string) => seedId(`m5:demo:invoice:${key}`);

export async function seedDemoM5Receivables(tx: DbOrTx, now: Date = new Date(), opts: { force?: boolean } = {}): Promise<{ invoices: number; created: boolean }> {
  if (!opts.force && (process.env.VITEST || process.env.NODE_ENV === "test")) return { invoices: 0, created: false };
  const [exists] = await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, invoiceIdOf("sinar-a"))).limit(1);
  if (exists) return { invoices: 0, created: false };

  const d = toBusinessDate(now);
  const ago = (n: number) => addDays(d, -n);
  /** Waktu WIB pada tanggal tertentu, tidak melewati `now` (data demo tidak boleh "dari masa depan"). */
  const at = (date: BusinessDate, time: string) => {
    const t = wibToUtc(date, time);
    return t > now ? now : t;
  };
  const finance = userIdByUsername("keuangan1");
  const monthStart = firstDayOfMonth(d);
  const prevMonthStart = firstDayOfMonth(addDays(monthStart, -1));
  const monthlyDue = `${d.slice(0, 7)}-15`;

  const tripLine = (code: string, date: BusinessDate, price = TRIP_PRICE): LineSpec => ({
    description: `Air truk 5.000 L — pengiriman ${date} (data demo), ${addressOf(code).text}`,
    amount: price,
    unitPrice: price,
    serviceDate: date,
    volumeL: 5_000,
    component: "trip",
  });

  // --- Lampiran demo (bukti transfer, konfirmasi saldo awal) --------------------------------------------------------
  const attachment = async (key: string, kind: string, name: string, objectType: string | null, objectId: string | null) => {
    const id = seedId(`m5:demo:attachment:${key}`);
    await tx
      .insert(attachments)
      .values({ id, tenantId: EQUA_TENANT_ID, storageKey: `seed/m5/${key}.pdf`, contentType: "application/pdf", sizeBytes: 0, kind, originalName: name, objectType, objectId, uploadedBy: finance })
      .onConflictDoNothing();
    return id;
  };

  // --- Faktur -----------------------------------------------------------------------------------------------------
  const specs: InvoiceSpec[] = [
    { key: "sinar-a", customer: "PLG-0024", kind: "delivery", issueDate: ago(20), dueDate: ago(6), lines: [tripLine("PLG-0024", ago(20)), tripLine("PLG-0024", ago(20))], description: "Faktur kirim 2 rit (data demo)" },
    { key: "sinar-b", customer: "PLG-0024", kind: "delivery", issueDate: ago(3), dueDate: addDays(d, 11), lines: [tripLine("PLG-0024", ago(3))], description: "Faktur kirim rit (data demo)" },
    { key: "tahu-a", customer: "PLG-0025", kind: "delivery", issueDate: ago(11), dueDate: addDays(d, 3), lines: [tripLine("PLG-0025", ago(11))], description: "Faktur kirim rit (data demo)" },
    { key: "tahu-b", customer: "PLG-0025", kind: "delivery", issueDate: ago(15), dueDate: ago(1), lines: [tripLine("PLG-0025", ago(15)), tripLine("PLG-0025", ago(15))], description: "Faktur kirim 2 rit (data demo)" },
    { key: "kerupuk-a", customer: "PLG-0026", kind: "delivery", issueDate: ago(40), dueDate: ago(26), lines: [tripLine("PLG-0026", ago(40)), tripLine("PLG-0026", ago(40)), tripLine("PLG-0026", ago(40))], description: "Faktur kirim 3 rit (data demo)" },
    {
      key: "kerupuk-b",
      customer: "PLG-0026",
      kind: "underpayment",
      issueDate: ago(41),
      dueDate: ago(41),
      lines: [{ description: "Kurang bayar rit: diterima Rp 300.000 dari Rp 450.000 — pelanggan membayar sebagian (data demo)", amount: 150_000, unitPrice: 150_000, serviceDate: ago(41), volumeL: 5_000, component: "underpayment" }],
      description: "Kurang bayar lapangan (data demo)",
    },
    {
      key: "puncak-a",
      customer: "PLG-0033",
      kind: "delivery",
      issueDate: ago(18),
      dueDate: ago(4),
      lines: [tripLine("PLG-0033", ago(18), HOTEL_PRICE)],
      description: "Faktur kirim rit (data demo)",
      dispute: { note: "Pelanggan: volume diterima hanya 4.500 L menurut meter tandon hotel (data demo).", at: at(ago(1), "10:00"), until: addDays(ago(1), 7) },
    },
    { key: "puncak-b", customer: "PLG-0033", kind: "delivery", issueDate: ago(2), dueDate: addDays(d, 12), lines: [tripLine("PLG-0033", ago(2), HOTEL_PRICE)], description: "Faktur kirim rit (data demo)" },
    {
      key: "bukit-monthly",
      customer: "PLG-0034",
      kind: "monthly",
      issueDate: monthStart,
      dueDate: monthlyDue,
      periodMonth: prevMonthStart,
      lines: [3, 10, 17, 24].map((day) => tripLine("PLG-0034", `${prevMonthStart.slice(0, 8)}${String(day).padStart(2, "0")}`, HOTEL_PRICE)),
      description: "Faktur bulanan layanan bulan lalu (data demo)",
      sent: d > monthlyDue ? { at: at(monthStart, "08:15"), via: "wa" } : undefined,
    },
    {
      key: "tirta-a",
      customer: "PLG-0001",
      kind: "store_sale",
      issueDate: ago(12),
      dueDate: addDays(ago(12), 14),
      lines: [{ description: "Galon kosong × 5 (data demo)", amount: 175_000, quantity: 5, unitPrice: 35_000, serviceDate: ago(12), component: "store_item" }],
      description: "Penjualan tempo toko (data demo)",
    },
    {
      key: "griya-under",
      customer: "PLG-0018",
      kind: "underpayment",
      issueDate: ago(1),
      dueDate: ago(1),
      lines: [{ description: "Kurang bayar rit: diterima Rp 300.000 dari Rp 450.000 (data demo)", amount: 150_000, unitPrice: 150_000, serviceDate: ago(1), volumeL: 5_000, component: "underpayment" }],
      description: "Kurang bayar lapangan H+0 (data demo)",
    },
    { key: "kencana-a", customer: "PLG-0037", kind: "delivery", issueDate: ago(30), dueDate: ago(16), lines: [tripLine("PLG-0037", ago(30))], description: "Faktur kirim rit (data demo)" },
  ];

  // Saldo awal cut-over (US-M5-07) — menunggu tanda tangan pemilik.
  const pakanProof1 = await attachment("pakan-open-1", "customer_confirmation", "Konfirmasi saldo PT Pakan Ternak — nota 0457 (demo).pdf", "invoice", invoiceIdOf("pakan-open-1"));
  const pakanProof2 = await attachment("pakan-open-2", "customer_confirmation", "Konfirmasi saldo PT Pakan Ternak — nota 0512 (demo).pdf", "invoice", invoiceIdOf("pakan-open-2"));
  specs.push(
    {
      key: "pakan-open-1",
      customer: "PLG-0028",
      kind: "opening_balance",
      issueDate: ago(70),
      dueDate: ago(40),
      lines: [{ description: "Saldo awal: nota kertas 0457 (data demo)", amount: 1_200_000, unitPrice: 1_200_000, serviceDate: ago(70), component: "opening_balance" }],
      description: "Nota kertas 0457 — dikonfirmasi pelanggan (data demo)",
      opening: { confirmationAttachmentId: pakanProof1 },
    },
    {
      key: "pakan-open-2",
      customer: "PLG-0028",
      kind: "opening_balance",
      issueDate: ago(45),
      dueDate: ago(15),
      lines: [{ description: "Saldo awal: nota kertas 0512 (data demo)", amount: 800_000, unitPrice: 800_000, serviceDate: ago(45), component: "opening_balance" }],
      description: "Nota kertas 0512 — dikonfirmasi pelanggan (data demo)",
      opening: { confirmationAttachmentId: pakanProof2 },
    },
  );

  // B-23: penjualan tempo toko demo M7 (PLG-0001) yang belum difakturkan → faktur per transaksi.
  const storeSales = await tx
    .select()
    .from(posSales)
    .where(and(eq(posSales.tenantId, EQUA_TENANT_ID), eq(posSales.paymentMethod, "credit"), eq(posSales.status, "valid"), eq(posSales.isReversal, false), isNull(posSales.invoiceId)))
    .orderBy(asc(posSales.soldAt));
  const [partner] = await tx.select({ term: customers.paymentTermDays }).from(customers).where(eq(customers.id, customerId("PLG-0001"))).limit(1);
  for (const sale of storeSales) {
    if (!sale.customerId) continue;
    const code = CUSTOMER_SEEDS.find((c) => customerId(c.code) === sale.customerId)?.code;
    if (!code) continue;
    const lines = await tx
      .select({ l: posSaleLines, name: products.name })
      .from(posSaleLines)
      .leftJoin(products, eq(products.id, posSaleLines.productId))
      .where(eq(posSaleLines.posSaleId, sale.id))
      .orderBy(asc(posSaleLines.lineNo));
    const invLines: LineSpec[] = lines.map(({ l, name }) => ({
      description: `${name ?? "Barang toko"} × ${l.quantity}`,
      amount: l.lineTotal,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      serviceDate: sale.businessDate,
      component: "store_item",
      posSaleLineId: l.id,
      productId: l.productId,
    }));
    const sum = invLines.reduce((s, l) => s + l.amount, 0);
    if (sum !== sale.total) invLines.push({ description: "Diskon kasir", amount: sale.total - sum, unitPrice: sale.total - sum, serviceDate: sale.businessDate, component: "other" });
    specs.push({
      key: `pos-${sale.id}`,
      customer: code,
      kind: "store_sale",
      issueDate: sale.businessDate,
      dueDate: addDays(sale.businessDate, partner?.term ?? 14),
      lines: invLines,
      posSaleId: sale.id,
      description: `Penjualan tempo toko ${sale.number ?? sale.localNumber}`,
    });
  }
  const firstStoreSaleKey = specs.find((s) => s.posSaleId)?.key ?? null;

  // --- Pelunasan, uang muka & nota kredit ---------------------------------------------------------------------------
  const payments: PaymentSpec[] = [
    { key: "sinar-tf", customer: "PLG-0024", businessDate: ago(5), amount: 400_000, method: "transfer", allocations: [{ invoiceKey: "sinar-a", amount: 400_000 }], notes: "Transfer sebagian — sisa dijanjikan minggu ini (data demo)" },
    { key: "tirta-cash", customer: "PLG-0001", businessDate: ago(8), amount: 225_000, method: "cash", allocations: [{ invoiceKey: "tirta-a", amount: 175_000 }], notes: "Bayar tunai di kantor; kelebihan menjadi uang muka (data demo)" },
    { key: "kencana-tf", customer: "PLG-0037", businessDate: ago(17), amount: TRIP_PRICE, method: "transfer", allocations: [{ invoiceKey: "kencana-a", amount: TRIP_PRICE }], notes: "Transfer lunas (data demo)" },
  ];
  const monthlyAmount = 4 * HOTEL_PRICE;
  if (d > monthlyDue) {
    payments.push({ key: "bukit-tf", customer: "PLG-0034", businessDate: `${d.slice(0, 7)}-12`, amount: monthlyAmount, method: "transfer", allocations: [{ invoiceKey: "bukit-monthly", amount: monthlyAmount }], notes: "Transfer faktur bulanan (data demo)" });
  }
  const advanceAmount = 225_000 - 175_000;
  const advanceApplied = firstStoreSaleKey ? Math.min(advanceAmount, specs.find((s) => s.key === firstStoreSaleKey)!.lines.reduce((s, l) => s + l.amount, 0)) : 0;
  const creditNoteSpecs: CreditNoteSpec[] = [{ key: "sinar-nk", invoiceKey: "sinar-b", amount: 25_000, reason: "Koreksi harga: tarif zona pelanggan berubah sejak awal bulan (data demo)", issueDate: ago(2) }];

  const paidOf = (key: string) =>
    payments.flatMap((p) => p.allocations).filter((a) => a.invoiceKey === key).reduce((s, a) => s + a.amount, 0) + (key === firstStoreSaleKey ? advanceApplied : 0);
  /** Waktu lunas = pelunasan terakhir yang dialokasikan ke faktur. */
  const paidAtOf = (key: string): Date => {
    const dates = payments.filter((p) => p.allocations.some((a) => a.invoiceKey === key)).map((p) => at(p.businessDate, "10:30"));
    if (key === firstStoreSaleKey && advanceApplied > 0) dates.push(now);
    return dates.reduce((m, x) => (x > m ? x : m), dates[0] ?? now);
  };
  const creditedOf = (key: string) => creditNoteSpecs.filter((c) => c.invoiceKey === key).reduce((s, c) => s + c.amount, 0);

  let created = 0;
  for (const s of specs) {
    const amount = s.lines.reduce((sum, l) => sum + l.amount, 0);
    const paid = paidOf(s.key);
    const credited = creditedOf(s.key);
    const outstanding = amount - paid - credited;
    const status = outstanding === 0 ? "paid" : paid > 0 || credited > 0 ? "partial" : "open";
    const id = invoiceIdOf(s.key);
    const number = `F-${yy(s.issueDate)}-${String(await nextSeq(tx, "invoice", yy(s.issueDate))).padStart(6, "0")}`;
    const address = s.kind === "store_sale" || s.kind === "opening_balance" ? null : addressOf(s.customer).id;
    await tx
      .insert(invoices)
      .values({
        id,
        tenantId: EQUA_TENANT_ID,
        number,
        kind: s.kind,
        customerId: customerId(s.customer),
        addressId: address,
        posSaleId: s.posSaleId ?? null,
        periodMonth: s.periodMonth ?? null,
        issueDate: s.issueDate,
        dueDate: s.dueDate,
        amount,
        paidAmount: paid,
        creditedAmount: credited,
        outstandingAmount: outstanding,
        status,
        description: s.description ?? null,
        isOpeningBalance: s.kind === "opening_balance",
        openingConfirmationAttachmentId: s.opening?.confirmationAttachmentId ?? null,
        disputeStatus: s.dispute ? "disputed" : "none",
        disputedAt: s.dispute?.at ?? null,
        disputeNote: s.dispute?.note ?? null,
        disputeUntil: s.dispute?.until ?? null,
        sentAt: s.sent?.at ?? null,
        sentVia: s.sent?.via ?? null,
        paidAt: status === "paid" ? paidAtOf(s.key) : null,
        createdBy: finance,
        createdAt: at(s.issueDate, "18:00"),
      })
      .onConflictDoNothing();
    let lineNo = 0;
    for (const l of s.lines) {
      lineNo++;
      await tx
        .insert(invoiceLines)
        .values({
          id: seedId(`m5:demo:invoice:${s.key}:line:${lineNo}`),
          invoiceId: id,
          lineNo,
          component: l.component ?? "trip",
          description: l.description,
          posSaleLineId: l.posSaleLineId ?? null,
          productId: l.productId ?? null,
          serviceDate: l.serviceDate,
          quantity: l.quantity ?? 1,
          unitPrice: l.unitPrice ?? l.amount,
          amount: l.amount,
          volumeL: l.volumeL ?? null,
        })
        .onConflictDoNothing();
    }
    if (s.posSaleId) await tx.update(posSales).set({ invoiceId: id }).where(eq(posSales.id, s.posSaleId));
    created++;
  }

  // Faktur bulanan: rincian rit bulan lalu sudah ditagih; rit bulan ini "belum ditagih" (US-M5-06 KP-5).
  const monthlySpec = specs.find((s) => s.key === "bukit-monthly")!;
  let chargeNo = 0;
  for (const l of monthlySpec.lines) {
    chargeNo++;
    await tx
      .insert(unbilledCharges)
      .values({ id: seedId(`m5:demo:unbilled:bukit:billed:${chargeNo}`), tenantId: EQUA_TENANT_ID, customerId: customerId("PLG-0034"), serviceDate: l.serviceDate, description: l.description, amount: l.amount, volumeL: 5_000, status: "billed", invoiceId: invoiceIdOf("bukit-monthly") })
      .onConflictDoNothing();
  }
  for (const k of [6, 3, 1]) {
    const day = ago(k);
    if (day < monthStart) continue;
    await tx
      .insert(unbilledCharges)
      .values({ id: seedId(`m5:demo:unbilled:bukit:${k}`), tenantId: EQUA_TENANT_ID, customerId: customerId("PLG-0034"), serviceDate: day, description: tripLine("PLG-0034", day, HOTEL_PRICE).description, amount: HOTEL_PRICE, volumeL: 5_000, status: "unbilled" })
      .onConflictDoNothing();
  }

  for (const p of payments) {
    const id = seedId(`m5:demo:payment:${p.key}`);
    const allocated = p.allocations.reduce((s, a) => s + a.amount, 0);
    const proof = p.method === "transfer" ? await attachment(`proof-${p.key}`, "transfer_proof", `Bukti transfer ${p.customer} (demo).pdf`, "customer_payment", id) : null;
    await tx
      .insert(customerPayments)
      .values({
        id,
        tenantId: EQUA_TENANT_ID,
        customerId: customerId(p.customer),
        channel: "office",
        method: p.method,
        amount: p.amount,
        businessDate: p.businessDate,
        proofAttachmentId: proof,
        advanceAmount: p.amount - allocated,
        notes: p.notes,
        createdBy: finance,
        createdAt: at(p.businessDate, "10:30"),
      })
      .onConflictDoNothing();
    let n = 0;
    for (const a of p.allocations) {
      n++;
      await tx
        .insert(paymentAllocations)
        .values({ id: seedId(`m5:demo:payment:${p.key}:alloc:${n}`), invoiceId: invoiceIdOf(a.invoiceKey), customerPaymentId: id, amount: a.amount, allocatedAt: at(p.businessDate, "10:30"), createdBy: finance })
        .onConflictDoNothing();
    }
  }

  // Uang muka dari kelebihan bayar PLG-0001 → otomatis terpotong ke faktur tempo toko berikutnya (US-M5-02 KP-3).
  const advanceId = seedId("m5:demo:advance:tirta-cash");
  await tx
    .insert(customerAdvances)
    .values({
      id: advanceId,
      tenantId: EQUA_TENANT_ID,
      customerId: customerId("PLG-0001"),
      sourcePaymentId: seedId("m5:demo:payment:tirta-cash"),
      amount: advanceAmount,
      remainingAmount: advanceAmount - advanceApplied,
      status: advanceAmount - advanceApplied === 0 ? "applied" : "open",
      notes: "Kelebihan pelunasan tunai kantor (data demo).",
      createdBy: finance,
      createdAt: at(ago(8), "10:31"),
    })
    .onConflictDoNothing();
  if (firstStoreSaleKey && advanceApplied > 0) {
    await tx
      .insert(paymentAllocations)
      .values({ id: seedId("m5:demo:advance:tirta-cash:alloc"), invoiceId: invoiceIdOf(firstStoreSaleKey), customerAdvanceId: advanceId, amount: advanceApplied, allocatedAt: now, createdBy: finance })
      .onConflictDoNothing();
  }

  for (const c of creditNoteSpecs) {
    const number = `NK-${yy(c.issueDate)}-${String(await nextSeq(tx, "credit_note", yy(c.issueDate))).padStart(6, "0")}`;
    const inv = specs.find((s) => s.key === c.invoiceKey)!;
    await tx
      .insert(creditNotes)
      .values({ id: seedId(`m5:demo:credit_note:${c.key}`), tenantId: EQUA_TENANT_ID, number, customerId: customerId(inv.customer), invoiceId: invoiceIdOf(c.invoiceKey), amount: c.amount, reason: c.reason, issueDate: c.issueDate, status: "issued", createdBy: finance })
      .onConflictDoNothing();
  }

  // Pengingat H+1 PLG-0025 sudah dibuka Admin Keuangan pagi ini (US-M5-05 KP-1).
  await tx
    .insert(receivableReminders)
    .values({ id: seedId("m5:demo:reminder:tahu-b"), tenantId: EQUA_TENANT_ID, customerId: customerId("PLG-0025"), invoiceId: invoiceIdOf("tahu-b"), kind: "after_due", scheduledDate: d, totalOutstanding: 2 * TRIP_PRICE, status: "opened", openedAt: at(d, "08:30"), openedBy: finance })
    .onConflictDoNothing();

  // Ringkasan saldo awal piutang menunggu tanda tangan pemilik (NFR-34).
  const openingSpecs = specs.filter((s) => s.kind === "opening_balance");
  const openingTotal = openingSpecs.reduce((s, x) => s + x.lines.reduce((a, l) => a + l.amount, 0), 0);
  await tx
    .insert(dataSignoffs)
    .values({
      id: seedId("m5:demo:signoff:opening_receivables"),
      tenantId: EQUA_TENANT_ID,
      group: "opening_receivables",
      title: "Ringkasan data awal — Piutang berjalan",
      summary: {
        total: openingTotal,
        count: openingSpecs.length,
        customers: [{ customerId: customerId("PLG-0028"), name: CUSTOMER_SEEDS.find((c) => c.code === "PLG-0028")?.name ?? "PLG-0028", code: "PLG-0028", total: openingTotal, count: openingSpecs.length }],
        updatedAt: now.toISOString(),
      },
      status: "draft",
      createdBy: finance,
    })
    .onConflictDoNothing();

  return { invoices: created, created: true };
}
