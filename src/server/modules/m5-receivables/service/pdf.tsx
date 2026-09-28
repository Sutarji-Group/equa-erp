/**
 * M5 — dokumen PDF untuk pelanggan: faktur (per rit / toko / kurang bayar / bulanan / saldo awal) dan bukti pelunasan
 * (US-M5-01 KP-5, US-M5-02 KP-5, US-M5-06 KP-2). Identitas usaha dari parameter `company.identity` (Bab 2.3; bawaan
 * "EQUA", diganti identitas PT setelah berdiri). Tanpa PPN dan bukan faktur pajak (BR-29).
 */
import "server-only";

import { Document, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";

import { employees, users } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb } from "@/server/core/db";
import * as params from "@/server/core/params";

import { eq } from "drizzle-orm";

import { invoiceDocument } from "./invoices";
import { customerBankAccount, paymentReceipt } from "./payments";

const s = StyleSheet.create({
  page: { paddingTop: 32, paddingBottom: 40, paddingHorizontal: 32, fontSize: 9, fontFamily: "Helvetica", color: "#111827" },
  company: { fontSize: 14, fontFamily: "Helvetica-Bold" },
  sub: { fontSize: 8, color: "#4B5563", marginTop: 2 },
  title: { fontSize: 16, fontFamily: "Helvetica-Bold", marginTop: 14 },
  row: { flexDirection: "row" },
  block: { marginTop: 10, flexDirection: "row", justifyContent: "space-between" },
  col: { width: "48%" },
  label: { fontSize: 8, color: "#6B7280" },
  strong: { fontFamily: "Helvetica-Bold" },
  table: { marginTop: 12, borderTopWidth: 1, borderColor: "#9CA3AF" },
  th: { flexDirection: "row", backgroundColor: "#E8EEF5", borderBottomWidth: 1, borderColor: "#9CA3AF" },
  tr: { flexDirection: "row", borderBottomWidth: 0.5, borderColor: "#E5E7EB" },
  cell: { paddingVertical: 3, paddingHorizontal: 3 },
  right: { textAlign: "right" },
  totals: { marginTop: 10, alignSelf: "flex-end", width: "50%" },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  grand: { borderTopWidth: 1, borderColor: "#111827", marginTop: 2, paddingTop: 3 },
  note: { marginTop: 4, fontSize: 8, color: "#374151" },
  badge: { marginTop: 4, fontSize: 9, fontFamily: "Helvetica-Bold", color: "#B91C1C" },
  footer: { position: "absolute", bottom: 18, left: 32, right: 32, fontSize: 7, color: "#6B7280", flexDirection: "row", justifyContent: "space-between" },
});

type Company = { name: string; legal_name: string | null; address: string | null; phone: string | null; npwp: string | null };

function Header({ company }: { company: Company }) {
  const sub = [company.address, company.phone ? `Telp ${company.phone}` : null, company.npwp ? `NPWP ${company.npwp}` : null].filter(Boolean).join(" · ");
  return (
    <View fixed>
      <Text style={s.company}>{company.legal_name || company.name}</Text>
      {sub ? <Text style={s.sub}>{sub}</Text> : null}
    </View>
  );
}

async function actorName(ctx: ActorContext): Promise<string> {
  if (!ctx.userId) return "Sistem";
  const db = getDb();
  const rows = await db.select({ name: employees.fullName }).from(users).leftJoin(employees, eq(employees.id, users.employeeId)).where(eq(users.id, ctx.userId)).limit(1);
  return rows[0]?.name ?? "Pengguna";
}

/** PDF faktur (izin baca faktur; dicetak ulang kapan saja — data tetap, faktur tidak berubah). */
export async function renderInvoicePdf(ctx: ActorContext, invoiceId: string): Promise<{ filename: string; body: Buffer }> {
  const d = await invoiceDocument(ctx, invoiceId);
  const printedBy = await actorName(ctx);
  const inv = d.invoice;
  const cols = [
    { h: "No", w: 5 },
    { h: "Uraian", w: 45 },
    { h: "Tanggal", w: 14 },
    { h: "Volume", w: 10, right: true },
    { h: "Harga", w: 13, right: true },
    { h: "Nilai", w: 13, right: true },
  ];
  const body = await renderToBuffer(
    <Document title={`Faktur ${inv.number}`} author={d.identity.name} creator="EQUA ERP" producer="EQUA ERP">
      <Page size="A4" style={s.page} wrap>
        <Header company={d.identity} />
        <Text style={s.title}>
          FAKTUR {inv.number}
          {inv.kind === "monthly" ? " (bulanan)" : ""}
        </Text>
        {inv.status === "paid" ? <Text style={s.badge}>LUNAS</Text> : null}
        {inv.pendingTransferId ? <Text style={s.badge}>Piutang sementara — transfer belum diterima</Text> : null}
        {inv.isOpeningBalance ? <Text style={s.badge}>Saldo awal (cut-over)</Text> : null}
        <View style={s.block}>
          <View style={s.col}>
            <Text style={s.label}>Kepada</Text>
            <Text style={s.strong}>{d.customer.name}</Text>
            {d.customer.code ? <Text>No. pelanggan {d.customer.code}</Text> : null}
            {d.address ? <Text>{d.address.addressText}</Text> : null}
          </View>
          <View style={s.col}>
            <Text style={s.label}>Jenis</Text>
            <Text>{label("invoice_kind", inv.kind)}</Text>
            <Text style={s.label}>Tanggal faktur</Text>
            <Text>{formatTanggal(inv.issueDate, { weekday: false })}</Text>
            <Text style={s.label}>Jatuh tempo</Text>
            <Text style={s.strong}>{formatTanggal(inv.dueDate, { weekday: false })}</Text>
            {d.trip ? (
              <>
                <Text style={s.label}>Nomor rit</Text>
                <Text>{d.trip.number}</Text>
              </>
            ) : null}
            {inv.periodMonth ? (
              <>
                <Text style={s.label}>Periode layanan</Text>
                <Text>{formatTanggal(inv.periodMonth, { weekday: false }).replace(/^\d+ /, "")}</Text>
              </>
            ) : null}
          </View>
        </View>
        <View style={s.table}>
          <View style={s.th} fixed>
            {cols.map((c) => (
              <Text key={c.h} style={[s.cell, s.strong, { width: `${c.w}%` }, c.right ? s.right : {}]}>
                {c.h}
              </Text>
            ))}
          </View>
          {d.lines.map((l) => (
            <View key={l.id} style={s.tr} wrap={false}>
              <Text style={[s.cell, { width: "5%" }]}>{l.lineNo}</Text>
              <Text style={[s.cell, { width: "45%" }]}>{l.description}</Text>
              <Text style={[s.cell, { width: "14%" }]}>{l.serviceDate ? formatTanggal(l.serviceDate, { weekday: false }) : "—"}</Text>
              <Text style={[s.cell, s.right, { width: "10%" }]}>{l.volumeL ? `${l.volumeL.toLocaleString("id-ID")} L` : l.quantity !== 1 ? String(l.quantity) : "—"}</Text>
              <Text style={[s.cell, s.right, { width: "13%" }]}>{formatRupiah(l.unitPrice)}</Text>
              <Text style={[s.cell, s.right, { width: "13%" }]}>{formatRupiah(l.amount)}</Text>
            </View>
          ))}
        </View>
        <View style={s.totals}>
          <View style={s.totalRow}>
            <Text>Total faktur</Text>
            <Text>{formatRupiah(inv.amount)}</Text>
          </View>
          {inv.creditedAmount ? (
            <View style={s.totalRow}>
              <Text>Nota kredit</Text>
              <Text>-{formatRupiah(inv.creditedAmount)}</Text>
            </View>
          ) : null}
          {d.paymentsReceived ? (
            <View style={s.totalRow}>
              <Text>Pelunasan & uang muka diterima</Text>
              <Text>-{formatRupiah(d.paymentsReceived)}</Text>
            </View>
          ) : null}
          {inv.writtenOffAmount ? (
            <View style={s.totalRow}>
              <Text>Dihapusbukukan</Text>
              <Text>-{formatRupiah(inv.writtenOffAmount)}</Text>
            </View>
          ) : null}
          <View style={[s.totalRow, s.grand]}>
            <Text style={s.strong}>Sisa tagihan faktur ini</Text>
            <Text style={s.strong}>{formatRupiah(inv.outstandingAmount)}</Text>
          </View>
          {inv.kind === "monthly" ? (
            <>
              <View style={s.totalRow}>
                <Text>Faktur lain belum lunas</Text>
                <Text>{formatRupiah(d.otherOutstanding)}</Text>
              </View>
              <View style={s.totalRow}>
                <Text>Uang muka tersisa</Text>
                <Text>{formatRupiah(d.openAdvance)}</Text>
              </View>
              <View style={[s.totalRow, s.grand]}>
                <Text style={s.strong}>Saldo terutang</Text>
                <Text style={s.strong}>{formatRupiah(inv.outstandingAmount + d.otherOutstanding)}</Text>
              </View>
            </>
          ) : null}
        </View>
        {d.notes.map((n) => (
          <Text key={n} style={s.note}>
            {n}
          </Text>
        ))}
        <View style={s.footer} fixed>
          <Text>
            {d.identity.name} · Faktur {inv.number} · dicetak {formatTanggalJam(ctx.now)} WIB oleh {printedBy}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Halaman ${pageNumber} dari ${totalPages}`} />
        </View>
      </Page>
    </Document>,
  );
  return { filename: `faktur-${inv.number}.pdf`, body };
}

/** PDF bukti pelunasan untuk pelanggan (US-M5-02 KP-5). */
export async function renderPaymentReceiptPdf(ctx: ActorContext, paymentId: string): Promise<{ filename: string; body: Buffer }> {
  const r = await paymentReceipt(ctx, paymentId);
  const db = getDb();
  const company = (await params.get(db, "company.identity", ctxBusinessDate(ctx), { tenantId: r.payment.tenantId })) as Company;
  const bank = await customerBankAccount(db, r.payment.tenantId);
  const printedBy = await actorName(ctx);
  const body = await renderToBuffer(
    <Document title="Bukti pelunasan" author={company.name} creator="EQUA ERP" producer="EQUA ERP">
      <Page size="A5" style={s.page}>
        <Header company={company} />
        <Text style={s.title}>BUKTI PELUNASAN</Text>
        {r.payment.reversalOfId ? <Text style={s.badge}>PEMBALIK — pelunasan dibatalkan</Text> : null}
        <View style={s.block}>
          <View style={s.col}>
            <Text style={s.label}>Diterima dari</Text>
            <Text style={s.strong}>{r.customer.name}</Text>
            {r.customer.code ? <Text>No. pelanggan {r.customer.code}</Text> : null}
          </View>
          <View style={s.col}>
            <Text style={s.label}>Tanggal</Text>
            <Text>{formatTanggal(r.payment.businessDate, { weekday: false })}</Text>
            <Text style={s.label}>Cara bayar</Text>
            <Text>
              {label("payment_method", r.payment.method)} · {label("payment_channel", r.payment.channel)}
            </Text>
          </View>
        </View>
        <View style={s.table}>
          <View style={s.th}>
            <Text style={[s.cell, s.strong, { width: "60%" }]}>Faktur</Text>
            <Text style={[s.cell, s.strong, s.right, { width: "40%" }]}>Dialokasikan</Text>
          </View>
          {r.allocations.map((a) => (
            <View key={a.invoiceId} style={s.tr}>
              <Text style={[s.cell, { width: "60%" }]}>{a.number}</Text>
              <Text style={[s.cell, s.right, { width: "40%" }]}>{formatRupiah(a.amount)}</Text>
            </View>
          ))}
          {r.advanceAmount ? (
            <View style={s.tr}>
              <Text style={[s.cell, { width: "60%" }]}>Uang muka (kelebihan bayar)</Text>
              <Text style={[s.cell, s.right, { width: "40%" }]}>{formatRupiah(r.advanceAmount)}</Text>
            </View>
          ) : null}
        </View>
        <View style={s.totals}>
          <View style={[s.totalRow, s.grand]}>
            <Text style={s.strong}>Jumlah dibayar</Text>
            <Text style={s.strong}>{formatRupiah(r.payment.amount)}</Text>
          </View>
          <View style={s.totalRow}>
            <Text>Sisa piutang setelah pelunasan</Text>
            <Text>{formatRupiah(r.balanceAfter)}</Text>
          </View>
        </View>
        <Text style={s.note}>Tanpa PPN; bukan faktur pajak (BR-29).</Text>
        {bank ? <Text style={s.note}>Rekening resmi: {bank.text} a.n. {bank.accountName}.</Text> : null}
        <View style={s.footer} fixed>
          <Text>
            {company.name} · dicetak {formatTanggalJam(ctx.now)} WIB oleh {printedBy}
          </Text>
        </View>
      </Page>
    </Document>,
  );
  return { filename: `bukti-pelunasan-${r.payment.businessDate}-${r.payment.id.slice(-6)}.pdf`, body };
}
