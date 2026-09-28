import { FileDown, MessageCircle } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { M5ActionForm } from "@/components/m5-receivables/action-form";
import { M5ActionButton, M5ReasonButton } from "@/components/m5-receivables/action-buttons";
import { AdvanceBadge, FormInput, FormTextarea, InvoiceStatusBadge } from "@/components/m5-receivables/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { KeyValueList } from "@/components/shared/key-value-list";
import { OfficeBreadcrumbLabel } from "@/components/shared/office-shell";
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
import { can } from "@/server/core/rbac";
import * as m5 from "@/server/modules/m5-receivables";

import { reallocatePaymentAction, reversePaymentAction, sendReceiptAction } from "../../actions";

export const metadata: Metadata = { title: "Rincian pelunasan" };

async function load(ctx: Parameters<typeof m5.getPaymentDetail>[0], id: string) {
  if (!isUuid(id)) return null;
  try {
    return await m5.getPaymentDetail(ctx, id);
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}

/**
 * Rincian pelunasan (US-M5-02 KP-1/KP-4/KP-5; 7.5.6): alokasi per faktur, bukti pelunasan PDF/WA, realokasi & pembalik
 * beralasan (> PAR-21 persetujuan pemilik). Faktur Lunas terkunci — pembatalan hanya lewat pembalik.
 */
export default async function PaymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requirePermission("m5.customer_payment.read");
  const { id } = await params;
  const d = await load(ctx, id);
  if (!d) notFound();
  const p = d.payment;
  const canSend = can(ctx, "m5.invoice.send");
  const canReverse = can(ctx, "m5.customer_payment.reverse");
  const canReallocate = can(ctx, "m5.customer_payment.reallocate");
  const pending = d.pendingApprovals.some((a) => a.status === "submitted");
  const active = !p.reversalOfId && !d.reversal;
  const allocated = d.allocations.reduce((s, a) => s + a.amount, 0);
  const reallocTargets = [
    ...d.allocations.map((a) => ({ id: a.invoiceId, number: a.number, current: a.amount, outstanding: a.outstanding })),
    ...d.openInvoices.filter((i) => !d.allocations.some((a) => a.invoiceId === i.id)).map((i) => ({ id: i.id, number: i.number, current: 0, outstanding: i.outstanding })),
  ];
  const title = `Pelunasan ${formatTanggal(p.businessDate, { weekday: false })}`;

  return (
    <div className="grid gap-6">
      <OfficeBreadcrumbLabel label={title} />
      <PageHeader
        title={`${title} — ${d.customer.name}`}
        backHref="/piutang/pelunasan"
        backLabel="Daftar pelunasan"
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <ToneBadge tone="neutral">{label("payment_channel", p.channel)}</ToneBadge>
            <ToneBadge tone="neutral">{label("payment_method", p.method)}</ToneBadge>
            {p.reversalOfId ? <ToneBadge tone="muted">Baris pembalik</ToneBadge> : d.reversal ? <ToneBadge tone="muted">Sudah dibalik</ToneBadge> : <ToneBadge tone="success">Berlaku</ToneBadge>}
            {pending ? <ToneBadge tone="warning">Koreksi menunggu persetujuan pemilik</ToneBadge> : null}
          </div>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={`/piutang/pelunasan/${p.id}/bukti`} download data-testid="unduh-bukti-pelunasan">
                <FileDown aria-hidden />
                Bukti PDF
              </a>
            </Button>
            {canSend && active ? <M5ActionButton label="Kirim bukti WA" icon={MessageCircle} action={sendReceiptAction.bind(null, p.id)} testId="kirim-bukti-wa" /> : null}
          </div>
        }
      />

      <SectionCard>
        <KeyValueList
          columns={3}
          items={[
            {
              label: "Pelanggan",
              value: (
                <Link href={`/piutang/pelanggan/${d.customer.id}`} className="text-primary hover:underline">
                  {d.customer.name}
                </Link>
              ),
              hint: <StatusBadge enumName="credit_status" value={d.customer.creditStatus} />,
            },
            { label: "Tanggal", value: formatTanggal(p.businessDate, { weekday: false }) },
            { label: "Jumlah", value: <span data-testid="jumlah-pelunasan">{formatRupiah(p.amount)}</span> },
            { label: "Teralokasi ke faktur", value: formatRupiah(allocated) },
            { label: "Uang muka (kelebihan bayar)", value: p.advanceAmount ? formatRupiah(p.advanceAmount) : null },
            { label: "Rit (lewat sopir)", value: d.tripNumber },
            { label: "Bukti transfer", value: p.proofAttachmentId ? <a href={`/api/attachments/${p.proofAttachmentId}`} target="_blank" rel="noopener" className="text-primary hover:underline">Lihat bukti</a> : null },
            { label: "Dicatat", value: formatTanggalJam(p.createdAt), hint: p.recordedByOffice ? "Dicatat kantor" : p.channel === "driver" ? "Dari aplikasi sopir" : undefined },
            ...(p.notes ? [{ label: "Catatan", value: p.notes, full: true }] : []),
            ...(p.reversalReason ? [{ label: "Alasan pembalik", value: p.reversalReason, full: true }] : []),
          ]}
        />
        {d.reversal ? (
          <p className="mt-4 text-sm">
            Dibalik oleh{" "}
            <Link href={`/piutang/pelunasan/${d.reversal.id}`} className="text-primary hover:underline">
              baris pembalik {formatTanggal(d.reversal.businessDate, { weekday: false })}
            </Link>
            .
          </p>
        ) : null}
        {d.reversalOf ? (
          <p className="mt-4 text-sm">
            Membalik{" "}
            <Link href={`/piutang/pelunasan/${d.reversalOf.id}`} className="text-primary hover:underline">
              pelunasan {formatTanggal(d.reversalOf.businessDate, { weekday: false })} ({formatRupiah(d.reversalOf.amount)})
            </Link>
            .
          </p>
        ) : null}
      </SectionCard>

      <SectionCard title="Alokasi ke faktur" flush>
        {d.allocations.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="alokasi-pelunasan">
              <TableHeader>
                <TableRow>
                  <TableHead>Faktur</TableHead>
                  <TableHead className="text-right">Dialokasikan</TableHead>
                  <TableHead className="text-right">Sisa faktur</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.allocations.map((a) => (
                  <TableRow key={a.invoiceId}>
                    <TableCell>
                      <Link href={`/piutang/faktur/${a.invoiceId}`} className="font-medium text-primary hover:underline">
                        {a.number}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right">{formatRupiah(a.amount)}</TableCell>
                    <TableCell className="text-right">{formatRupiah(a.outstanding)}</TableCell>
                    <TableCell>
                      <InvoiceStatusBadge status={a.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Tidak ada alokasi aktif" description={p.reversalOfId || d.reversal ? "Alokasi sudah dibalik." : "Seluruh pelunasan menjadi uang muka."} compact />
        )}
        {d.allocationRows.some((r) => r.amount < 0) ? (
          <details className="px-6 pb-4 text-sm">
            <summary className="cursor-pointer text-muted-foreground">Riwayat baris alokasi (termasuk pembalik)</summary>
            <ul className="mt-2 grid gap-1">
              {d.allocationRows.map((r) => (
                <li key={r.id} className={r.amount < 0 ? "text-destructive" : ""}>
                  {formatTanggalJam(r.allocatedAt)} · {r.number} · {formatRupiah(r.amount)}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </SectionCard>

      {d.advances.length ? (
        <SectionCard title="Uang muka dari pelunasan ini" flush>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dibuat</TableHead>
                  <TableHead className="text-right">Jumlah</TableHead>
                  <TableHead className="text-right">Sisa</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.advances.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>{formatTanggalJam(a.createdAt)}</TableCell>
                    <TableCell className="text-right">{formatRupiah(a.amount)}</TableCell>
                    <TableCell className="text-right">{formatRupiah(a.remainingAmount)}</TableCell>
                    <TableCell>
                      <AdvanceBadge status={a.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      ) : null}

      {active && !pending && (canReverse || canReallocate) ? (
        <div className="grid gap-6 lg:grid-cols-2">
          {canReallocate && reallocTargets.length ? (
            <SectionCard
              title="Ubah alokasi"
              description={`Jumlah teralokasi tetap ${formatRupiah(allocated)} (kelebihan bayar tetap uang muka). Isi jumlah baru per faktur; di atas batas koreksi (PAR-21) menunggu persetujuan pemilik.`}
            >
              <M5ActionForm action={reallocatePaymentAction.bind(null, p.id)} submitLabel="Simpan alokasi" testId="form-realokasi">
                <div className="grid gap-2 sm:grid-cols-2">
                  {reallocTargets.map((t) => (
                    <FormInput key={t.id} label={`${t.number} — sekarang ${formatRupiah(t.current)}, sisa ${formatRupiah(t.outstanding)}`} name={`alloc_${t.id}`} inputMode="numeric" defaultValue={t.current || ""} />
                  ))}
                </div>
                <FormTextarea label="Alasan (mis. konfirmasi pelanggan)" name="reason" required />
              </M5ActionForm>
            </SectionCard>
          ) : null}
          {canReverse ? (
            <SectionCard title="Balik pelunasan" description="Pembatalan hanya lewat pembalik beralasan (BR-38): faktur terkait kembali terbuka dan uang muka dari pelunasan ini dibatalkan.">
              <M5ReasonButton label="Balik pelunasan" title="Balik pelunasan ini?" description={`Jumlah ${formatRupiah(p.amount)}. Di atas batas koreksi (PAR-21) perlu persetujuan pemilik.`} action={reversePaymentAction.bind(null, p.id)} destructive testId="balik-pelunasan" />
            </SectionCard>
          ) : null}
        </div>
      ) : null}

      {d.pendingApprovals.length ? (
        <SectionCard title="Persetujuan koreksi" flush>
          <ul className="divide-y text-sm">
            {d.pendingApprovals.map((a) => (
              <li key={a.id} className="px-6 py-2">
                {a.number} — <StatusBadge enumName="approval_status" value={a.status} /> {a.amount ? formatRupiah(a.amount) : ""}
                <span className="block text-xs text-muted-foreground">{a.reason}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}
