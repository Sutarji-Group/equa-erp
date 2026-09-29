import { FileDown, Mail, MessageCircle } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { M5ActionForm } from "@/components/m5-receivables/action-form";
import { M5ActionButton, M5ReasonButton } from "@/components/m5-receivables/action-buttons";
import { BucketBadge, DisputeBadge, FormInput, FormSelect, FormTextarea, InvoiceStatusBadge, ReminderBadge } from "@/components/m5-receivables/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { KeyValueList } from "@/components/shared/key-value-list";
import { OfficeBreadcrumbLabel } from "@/components/shared/office-shell";
import { JournalLink } from "@/components/shared/journal-link";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isUuid } from "@/lib/ids";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { NotFoundError } from "@/server/core/errors";
import { isEmailDeliveryConfigured } from "@/server/core/notifications";
import { can } from "@/server/core/rbac";
import * as m5 from "@/server/modules/m5-receivables";

import { cancelOpeningAction, convertUnderpaymentAction, creditNoteAction, decideDisputeAction, disputeInvoiceAction, emailInvoiceAction, sendInvoiceAction } from "../../actions";

export const metadata: Metadata = { title: "Rincian faktur" };

async function load(ctx: Parameters<typeof m5.getInvoiceDetail>[0], id: string) {
  if (!isUuid(id)) return null;
  try {
    return await m5.getInvoiceDetail(ctx, id);
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}

/**
 * Rincian faktur (US-M5-01 KP-1/KP-5/KP-6, US-M5-06, 7.5.6): rincian rit/barang, pelunasan & nota kredit, pengingat,
 * pengiriman; PDF (identitas usaha, tanpa PPN); kirim WA/e-mail tercatat; sengketa; nota kredit beralasan; konversi
 * kurang bayar → tempo. Tidak ada tombol hapus.
 */
export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requirePermission("m5.invoice.read");
  const { id } = await params;
  const d = await load(ctx, id);
  if (!d) notFound();
  const inv = d.invoice;
  const canSend = can(ctx, "m5.invoice.send");
  // B-36: e-mail dari server (Resend + PDF) bila dikonfigurasi; bila tidak, draf e-mail (mailto).
  const emailServer = isEmailDeliveryConfigured();
  const canDispute = can(ctx, "m5.invoice.dispute");
  const canDecide = can(ctx, "m5.dispute.decide");
  const canCredit = can(ctx, "m5.credit_note.create");
  const canOpening = can(ctx, "m5.opening_balance.create");
  const canCard = can(ctx, "m5.aging.read") || can(ctx, "m5.credit_exposure.read");
  const canPayments = can(ctx, "m5.customer_payment.read");
  const open = inv.outstandingAmount > 0;
  const disputed = inv.disputeStatus === "disputed";
  const convertible = inv.kind === "underpayment" && d.fieldCredit?.status === "approved" && open;

  return (
    <div className="grid gap-6">
      <OfficeBreadcrumbLabel label={inv.number} />
      <PageHeader
        title={`Faktur ${inv.number}`}
        backHref="/piutang/faktur"
        backLabel="Daftar faktur"
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <InvoiceStatusBadge status={inv.status} />
            <ToneBadge tone="neutral">{label("invoice_kind", inv.kind)}</ToneBadge>
            <DisputeBadge status={inv.disputeStatus} />
            {inv.isOpeningBalance ? <ToneBadge tone="muted">Saldo awal (cut-over)</ToneBadge> : null}
            {inv.pendingTransferId ? <ToneBadge tone="danger">Piutang sementara — transfer belum diterima</ToneBadge> : null}
          </div>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* B-55: jurnal peristiwa sumber faktur (rit / penjualan POS / tagihan langganan) — pendapatan diakui di sana (D-10). */}
            <JournalLink ctx={ctx} sourceType={inv.tripId ? "trip" : inv.posSaleId ? "pos_sale" : "invoice"} sourceId={inv.tripId ?? inv.posSaleId ?? (inv.kind === "partner_subscription" ? inv.id : null)} />
            <Button asChild variant="outline" size="sm">
              <a href={`/piutang/faktur/${inv.id}/pdf`} download data-testid="unduh-pdf-faktur">
                <FileDown aria-hidden />
                Unduh PDF
              </a>
            </Button>
            {canSend ? (
              <>
                <M5ActionButton label="Kirim WA" icon={<MessageCircle aria-hidden />} action={sendInvoiceAction.bind(null, inv.id, "wa")} testId="kirim-wa-faktur" />
                <details className="relative">
                  <summary className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-md border px-3 text-sm font-medium" data-testid="kirim-email-faktur">
                    <Mail className="size-4" aria-hidden />
                    Kirim e-mail
                  </summary>
                  <div className="absolute right-0 z-10 mt-2 w-80 rounded-md border bg-popover p-3 shadow-md">
                    <M5ActionForm action={emailInvoiceAction.bind(null, inv.id)} submitLabel={emailServer ? "Kirim dengan PDF" : "Buka draf e-mail"} testId="form-email-faktur">
                      <FormInput label="E-mail pelanggan" name="email" type="email" required={emailServer} hint={emailServer ? "PDF faktur terlampir otomatis." : "Pengirim e-mail server belum aktif: draf e-mail dibuka, lampirkan PDF dari tombol Unduh PDF."} />
                    </M5ActionForm>
                  </div>
                </details>
              </>
            ) : null}
          </div>
        }
      />

      <SectionCard>
        <KeyValueList
          columns={3}
          items={[
            {
              label: "Pelanggan",
              value: canCard ? (
                <Link href={`/piutang/pelanggan/${d.customer.id}`} className="text-primary hover:underline">
                  {d.customer.name}
                </Link>
              ) : (
                d.customer.name
              ),
              hint: (
                <span className="inline-flex items-center gap-1">
                  {d.customer.code ?? ""} <StatusBadge enumName="credit_status" value={d.customer.creditStatus} />
                </span>
              ),
            },
            { label: "Alamat", value: d.address?.addressText ?? null, hint: d.address?.label },
            { label: "Nomor rit", value: d.trip?.number ?? null },
            { label: "Tanggal faktur", value: formatTanggal(inv.issueDate, { weekday: false }) },
            { label: "Jatuh tempo", value: formatTanggal(inv.dueDate, { weekday: false }), hint: open ? <BucketBadge bucket={d.bucket} /> : null },
            { label: "Periode layanan", value: inv.periodMonth ? formatTanggal(inv.periodMonth, { weekday: false }).replace(/^\d+ /, "") : null },
            { label: "Nilai faktur", value: formatRupiah(inv.amount) },
            { label: "Dibayar (pelunasan & uang muka)", value: formatRupiah(inv.paidAmount) },
            { label: "Nota kredit", value: inv.creditedAmount ? formatRupiah(inv.creditedAmount) : null },
            { label: "Dihapusbukukan (PTB-28)", value: inv.writtenOffAmount ? formatRupiah(inv.writtenOffAmount) : null },
            { label: "Sisa", value: <span data-testid="sisa-faktur">{formatRupiah(inv.outstandingAmount)}</span> },
            { label: "Dikirim", value: inv.sentAt ? `${formatTanggalJam(inv.sentAt)} lewat ${m5.invoiceSentViaLabel(inv.sentVia).toLowerCase()}` : "Belum dikirim" },
            ...(disputed || inv.disputeStatus !== "none"
              ? [{ label: "Sengketa", value: inv.disputeNote ?? "", hint: inv.disputeUntil ? `Pengingat & penahanan ditunda sampai ${formatTanggal(inv.disputeUntil, { weekday: false })} (PAR-45)` : undefined, full: true }]
              : []),
            ...(inv.description ? [{ label: "Keterangan", value: inv.description, full: true }] : []),
          ]}
        />
      </SectionCard>

      <SectionCard title="Rincian" description="Harga tanpa PPN; dokumen ini bukan faktur pajak (BR-29)." flush>
        <div className="overflow-x-auto">
          <Table data-testid="baris-faktur">
            <TableHeader>
              <TableRow>
                <TableHead>No</TableHead>
                <TableHead>Uraian</TableHead>
                <TableHead>Tanggal</TableHead>
                <TableHead className="text-right">Volume</TableHead>
                <TableHead className="text-right">Harga</TableHead>
                <TableHead className="text-right">Nilai</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>{l.lineNo}</TableCell>
                  <TableCell className="min-w-64 text-sm">{l.description}</TableCell>
                  <TableCell className="whitespace-nowrap">{l.serviceDate ? formatTanggal(l.serviceDate, { weekday: false }) : "—"}</TableCell>
                  <TableCell className="text-right">{l.volumeL ? `${l.volumeL.toLocaleString("id-ID")} L` : l.quantity !== 1 ? l.quantity : "—"}</TableCell>
                  <TableCell className="text-right">{formatRupiah(l.unitPrice)}</TableCell>
                  <TableCell className="text-right">{formatRupiah(l.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Pelunasan & uang muka" flush>
          {d.allocations.length ? (
            <div className="overflow-x-auto">
              <Table data-testid="alokasi-faktur">
                <TableHeader>
                  <TableRow>
                    <TableHead>Tanggal</TableHead>
                    <TableHead>Sumber</TableHead>
                    <TableHead className="text-right">Jumlah</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.allocations.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="whitespace-nowrap">{formatTanggal(a.amount > 0 && a.paymentDate ? a.paymentDate : a.allocatedAt, { weekday: false })}</TableCell>
                      <TableCell className="text-sm">
                        {a.customerAdvanceId ? (
                          "Uang muka dialokasikan"
                        ) : a.customerPaymentId && canPayments ? (
                          <Link href={`/piutang/pelunasan/${a.customerPaymentId}`} className="text-primary hover:underline">
                            Pelunasan {a.channel ? label("payment_channel", a.channel).toLowerCase() : ""} {a.method ? `(${label("payment_method", a.method).toLowerCase()})` : ""}
                          </Link>
                        ) : (
                          `Pelunasan ${a.channel ? label("payment_channel", a.channel).toLowerCase() : ""}`
                        )}
                        {a.amount < 0 ? <span className="block text-xs text-muted-foreground">Pembalik (BR-38)</span> : null}
                      </TableCell>
                      <TableCell className={`text-right ${a.amount < 0 ? "text-destructive" : ""}`}>{formatRupiah(a.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState title="Belum ada pelunasan" compact />
          )}
        </SectionCard>

        <SectionCard title="Nota kredit" flush>
          {d.creditNotes.length ? (
            <div className="overflow-x-auto">
              <Table data-testid="nota-kredit-faktur">
                <TableHeader>
                  <TableRow>
                    <TableHead>Nomor</TableHead>
                    <TableHead>Tanggal</TableHead>
                    <TableHead>Alasan</TableHead>
                    <TableHead className="text-right">Jumlah</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.creditNotes.map((n) => (
                    <TableRow key={n.id}>
                      <TableCell className="font-medium">{n.number}</TableCell>
                      <TableCell className="whitespace-nowrap">{formatTanggal(n.issueDate, { weekday: false })}</TableCell>
                      <TableCell className="text-sm">{n.reason}</TableCell>
                      <TableCell className="text-right">{formatRupiah(n.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState title="Belum ada nota kredit" compact />
          )}
        </SectionCard>
      </div>

      {canSend || canDispute || canDecide || canCredit || canOpening ? (
        <div className="grid gap-6 lg:grid-cols-2">
          {canCredit && open && !inv.isOpeningBalance && !disputed ? (
            <SectionCard title="Nota kredit (koreksi beralasan)" description="Faktur tidak dapat dihapus (BR-38). Nota kredit di atas batas koreksi (PAR-21) menunggu persetujuan pemilik.">
              <M5ActionForm action={creditNoteAction.bind(null, inv.id)} submitLabel="Terbitkan nota kredit" testId="form-nota-kredit">
                <FormInput label="Nilai nota kredit (Rp)" name="amount" inputMode="numeric" required hint={`Paling besar sisa faktur ${formatRupiah(inv.outstandingAmount)}.`} />
                <FormTextarea label="Alasan" name="reason" required />
              </M5ActionForm>
            </SectionCard>
          ) : null}
          {canDispute && open && inv.disputeStatus !== "disputed" ? (
            <SectionCard title="Tandai bersengketa" description="Pelanggan menyengketakan volume/harga: pengingat & penahanan atas faktur ini ditunda maksimal PAR-45 hari sampai diputuskan pemilik (7.5.6).">
              <M5ActionForm action={disputeInvoiceAction.bind(null, inv.id)} submitLabel="Tandai bersengketa" variant="outline" testId="form-sengketa">
                <FormTextarea label="Catatan sengketa" name="note" required />
              </M5ActionForm>
            </SectionCard>
          ) : null}
          {canDecide && disputed ? (
            <SectionCard title="Putuskan sengketa" description="Koreksi lewat nota kredit, atau sengketa ditolak (faktur kembali ditagih).">
              <M5ActionForm action={decideDisputeAction.bind(null, inv.id)} submitLabel="Simpan keputusan" testId="form-putus-sengketa">
                <FormSelect
                  label="Keputusan"
                  name="decision"
                  defaultValue="credit_note"
                  options={[
                    { value: "credit_note", label: label("dispute_decision", "credit_note") },
                    { value: "reject", label: label("dispute_decision", "reject") },
                  ]}
                />
                <FormInput label="Nilai nota kredit (Rp) — bila koreksi" name="amount" inputMode="numeric" />
                <FormTextarea label="Alasan keputusan" name="reason" required />
              </M5ActionForm>
            </SectionCard>
          ) : null}
          {canCredit && convertible ? (
            <SectionCard
              title="Konversi kurang bayar → tempo"
              description={`Tempo lapangan rit ini disetujui Dispatcher (${d.fieldCredit?.number ?? ""}). Faktur kurang bayar ditutup nota kredit dan faktur kirim tempo terbit setelah pemeriksaan status & batas kredit.`}
            >
              <div>
                <M5ReasonButton label="Konversi ke tempo" title="Konversi kurang bayar menjadi tempo?" description="Faktur kurang bayar ditutup; faktur kirim tempo terbit dengan jatuh tempo mengikuti tempo pelanggan." action={convertUnderpaymentAction.bind(null, inv.id)} variant="default" testId="konversi-tempo" />
              </div>
            </SectionCard>
          ) : null}
          {canOpening && inv.isOpeningBalance && open ? (
            <SectionCard title="Saldo awal" description="Sebelum total saldo awal ditandatangani pemilik, entri yang salah dibatalkan dengan nota kredit berjejak; sesudahnya lewat penyesuaian saldo awal.">
              <div className="flex flex-wrap gap-2">
                <M5ReasonButton label="Batalkan entri saldo awal" title="Batalkan entri saldo awal?" action={cancelOpeningAction.bind(null, inv.id)} destructive testId="batal-saldo-awal" />
                <Button asChild variant="outline" size="sm">
                  <Link href="/piutang/saldo-awal">Penyesuaian saldo awal</Link>
                </Button>
              </div>
            </SectionCard>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Pengingat jatuh tempo" flush>
          {d.reminders.length ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tanggal</TableHead>
                    <TableHead>Jenis</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.reminders.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{formatTanggal(r.scheduledDate, { weekday: false })}</TableCell>
                      <TableCell>{label("reminder_kind", r.kind)}</TableCell>
                      <TableCell>
                        <ReminderBadge status={r.status} />
                        {r.openedAt ? <span className="block text-xs text-muted-foreground">{formatTanggalJam(r.openedAt)}</span> : null}
                        {r.skipReason ? <span className="block text-xs text-muted-foreground">{r.skipReason}</span> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState title="Belum ada pengingat" compact />
          )}
        </SectionCard>
        <SectionCard title="Pengiriman & persetujuan" flush>
          {d.sends.length || d.approvals.length ? (
            <ul className="divide-y text-sm">
              {d.sends.map((s) => (
                <li key={s.id} className="px-6 py-2">
                  {label("wa_message_kind", s.kind)} — {label("wa_message_status", s.status)} · {formatTanggalJam(s.createdAt)}
                </li>
              ))}
              {d.approvals.map((a) => (
                <li key={a.id} className="px-6 py-2">
                  Persetujuan {a.number} ({label("approval_type", a.type)}) — <StatusBadge enumName="approval_status" value={a.status} />
                  <span className="block text-xs text-muted-foreground">{a.reason}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Belum dikirim" compact />
          )}
        </SectionCard>
      </div>
    </div>
  );
}
