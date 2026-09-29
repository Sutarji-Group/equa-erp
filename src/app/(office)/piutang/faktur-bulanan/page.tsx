import { FileDown, Mail, MessageCircle } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { M5ActionForm } from "@/components/m5-receivables/action-form";
import { M5ActionButton } from "@/components/m5-receivables/action-buttons";
import { FormInput, FormSelect, FormTextarea, InvoiceStatusBadge, hrefWith } from "@/components/m5-receivables/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m5 from "@/server/modules/m5-receivables";

import { requestMonthlyBillingAction, runMonthlyAction, sendInvoiceAction } from "../actions";

export const metadata: Metadata = { title: "Faktur bulanan" };

const monthName = (d: string) => formatTanggal(d, { weekday: false }).replace(/^\d+ /, "");

/**
 * Faktur bulanan pelanggan tagihan bulanan (US-M5-06): terbit otomatis tanggal PAR-12 untuk layanan bulan lalu
 * (rincian rit, pelunasan & uang muka, saldo), jatuh tempo tanggal PAR-12; daftar "siap kirim" + PDF + status kirim;
 * rit belum ditagih (ikut eksposur); penanda tagihan bulanan hanya dengan perjanjian terlampir & persetujuan pemilik.
 */
export default async function MonthlyInvoicesPage() {
  const { ctx } = await requirePermission("m5.monthly_invoice.read");
  const b = await m5.monthlyBoard(ctx);
  const canSend = can(ctx, "m5.invoice.send");
  const canIssue = can(ctx, "m5.monthly_invoice.issue");
  const canRequest = can(ctx, "m5.monthly_billing.request");
  const period = b.period;

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Faktur bulanan"
        description={`Layanan ${monthName(period.serviceMonth)} terbit ${formatTanggal(period.issueDate, { weekday: false })}, jatuh tempo ${formatTanggal(period.dueDate, { weekday: false })} (PAR-12). Rit yang tersinkron setelah faktur terbit masuk faktur bulan berikutnya dengan penanda.`}
        actions={
          <div className="flex flex-wrap gap-2">
            {canIssue && b.today >= period.issueDate ? <M5ActionButton label="Terbitkan faktur bulanan sekarang" action={runMonthlyAction} testId="terbitkan-bulanan" /> : null}
            <ExportButtons excelHref={hrefWith("/api/export/m5.monthly_invoices", { format: "xlsx" })} pdfHref={hrefWith("/api/export/m5.monthly_invoices", { format: "pdf" })} />
          </div>
        }
      />

      <SectionCard title="Siap kirim" description="Kirim PDF faktur bulanan ke pelanggan lewat WhatsApp atau e-mail; status pengiriman tercatat." flush>
        {b.ready.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="bulanan-siap-kirim">
              <TableHeader>
                <TableRow>
                  <TableHead>Faktur</TableHead>
                  <TableHead>Pelanggan</TableHead>
                  <TableHead>Layanan</TableHead>
                  <TableHead>Jatuh tempo</TableHead>
                  <TableHead className="text-right">Nilai</TableHead>
                  <TableHead className="text-right">Sisa</TableHead>
                  <TableHead>Kirim</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {b.ready.map((inv) => (
                  <TableRow key={inv.id} className="align-top">
                    <TableCell>
                      <Link href={`/piutang/faktur/${inv.id}`} className="font-medium text-primary hover:underline">
                        {inv.number}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm">{inv.customerName}</TableCell>
                    <TableCell>{inv.periodMonth ? monthName(inv.periodMonth) : "—"}</TableCell>
                    <TableCell>{formatTanggal(inv.dueDate, { weekday: false })}</TableCell>
                    <TableCell className="text-right">{formatRupiah(inv.amount)}</TableCell>
                    <TableCell className="text-right">{formatRupiah(inv.outstandingAmount)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <Button asChild variant="outline" size="sm">
                          <a href={`/piutang/faktur/${inv.id}/pdf`} download>
                            <FileDown aria-hidden />
                            PDF
                          </a>
                        </Button>
                        {canSend ? (
                          <>
                            <M5ActionButton label="WA" icon={<MessageCircle aria-hidden />} action={sendInvoiceAction.bind(null, inv.id, "wa")} testId={`kirim-wa-${inv.number}`} />
                            <M5ActionButton label="E-mail" icon={<Mail aria-hidden />} action={sendInvoiceAction.bind(null, inv.id, "email")} />
                          </>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Tidak ada faktur bulanan yang menunggu dikirim" compact />
        )}
      </SectionCard>

      <SectionCard
        title="Rit belum ditagih"
        description="Rit tempo pelanggan tagihan bulanan yang akan masuk faktur bulan berikutnya — dihitung dalam eksposur sehingga batas kredit tetap berlaku sepanjang bulan (US-M5-06 KP-5)."
        actions={<ExportButtons excelHref={hrefWith("/api/export/m5.unbilled", { format: "xlsx" })} pdfHref={hrefWith("/api/export/m5.unbilled", { format: "pdf" })} disabled={!b.unbilled.length} />}
        flush
      >
        {b.unbilled.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="belum-ditagih">
              <TableHeader>
                <TableRow>
                  <TableHead>Pelanggan</TableHead>
                  <TableHead className="text-right">Rit</TableHead>
                  <TableHead>Layanan pertama</TableHead>
                  <TableHead>Susulan</TableHead>
                  <TableHead className="text-right">Nilai</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {b.unbilled.map((u) => (
                  <TableRow key={u.customerId}>
                    <TableCell className="text-sm">{u.customerName}</TableCell>
                    <TableCell className="text-right">{u.n}</TableCell>
                    <TableCell>{formatTanggal(u.first, { weekday: false })}</TableCell>
                    <TableCell>{u.late ? <ToneBadge tone="warning">{u.late} rit susulan</ToneBadge> : "—"}</TableCell>
                    <TableCell className="text-right font-medium">{formatRupiah(u.total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Tidak ada rit belum ditagih" compact />
        )}
      </SectionCard>

      <SectionCard title="Sudah dikirim" flush>
        {b.sent.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="bulanan-terkirim">
              <TableHeader>
                <TableRow>
                  <TableHead>Faktur</TableHead>
                  <TableHead>Pelanggan</TableHead>
                  <TableHead>Layanan</TableHead>
                  <TableHead className="text-right">Nilai</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Dikirim</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {b.sent.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell>
                      <Link href={`/piutang/faktur/${inv.id}`} className="font-medium text-primary hover:underline">
                        {inv.number}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm">{inv.customerName}</TableCell>
                    <TableCell>{inv.periodMonth ? monthName(inv.periodMonth) : "—"}</TableCell>
                    <TableCell className="text-right">{formatRupiah(inv.amount)}</TableCell>
                    <TableCell>
                      <InvoiceStatusBadge status={inv.status} />
                    </TableCell>
                    <TableCell className="text-sm">{inv.sentAt ? `${formatTanggalJam(inv.sentAt)} · ${inv.sentVia === "email" ? "e-mail" : "WhatsApp"}` : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada faktur bulanan terkirim" compact />
        )}
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Pelanggan tagihan bulanan" description="Hanya dengan perjanjian tertulis terlampir dan disetujui pemilik (BR-05)." flush>
          {b.customers.length ? (
            <ul className="divide-y text-sm" data-testid="pelanggan-bulanan">
              {b.customers.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-6 py-2">
                  <span>
                    {c.name} {c.code ? <span className="text-xs text-muted-foreground">({c.code})</span> : null}
                  </span>
                  {c.agreementAttachmentId ? (
                    <a href={`/api/attachments/${c.agreementAttachmentId}`} target="_blank" rel="noopener" className="text-primary hover:underline">
                      Perjanjian
                    </a>
                  ) : (
                    <ToneBadge tone="warning">Perjanjian belum terlampir</ToneBadge>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Belum ada pelanggan tagihan bulanan" compact />
          )}
        </SectionCard>

        {canRequest ? (
          <SectionCard title="Ajukan penanda tagihan bulanan" description="Untuk pelanggan Tempo berperjanjian tertulis (hotel, industri). Diputuskan pemilik.">
            <M5ActionForm action={requestMonthlyBillingAction} submitLabel="Ajukan ke pemilik" testId="form-tagihan-bulanan">
              <FormSelect label="Pelanggan" name="customerId" required emptyLabel="— pilih pelanggan Tempo —" options={b.eligible.map((c) => ({ value: c.id, label: c.code ? `${c.name} (${c.code})` : c.name }))} />
              <FormInput label="Perjanjian tertulis (PDF/foto)" name="agreement" type="file" accept="application/pdf,image/jpeg,image/png" required hint="Wajib (BR-05), maks. 4 MB; foto dikompres otomatis." />
              <FormTextarea label="Alasan" name="reason" required />
            </M5ActionForm>
          </SectionCard>
        ) : null}
      </div>

      {b.requests.length ? (
        <SectionCard title="Pengajuan tagihan bulanan" flush>
          <ul className="divide-y text-sm">
            {b.requests.map((r) => (
              <li key={r.id} className="px-6 py-2">
                {r.number} · {(r.payload as { customerName?: string } | null)?.customerName ?? ""} — <StatusBadge enumName="approval_status" value={r.status} />
                <span className="block text-xs text-muted-foreground">{r.reason}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}
