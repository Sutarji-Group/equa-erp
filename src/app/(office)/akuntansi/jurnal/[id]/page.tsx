import type { Metadata } from "next";
import Link from "next/link";

import { M11ActionForm } from "@/components/m11-accounting/action-form";
import { M11ActionButton, M11ReasonButton } from "@/components/m11-accounting/action-buttons";
import { Amount, FormInput, JournalKindBadge, JournalLink, JournalStatusBadge, QueueStatusBadge } from "@/components/m11-accounting/ui";
import { KeyValueList } from "@/components/shared/key-value-list";
import { OfficeBreadcrumbLabel } from "@/components/shared/office-shell";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m11 from "@/server/modules/m11-accounting";

import { attachEvidenceAction, cancelJournalAction, reverseJournalAction, submitJournalAction } from "../../actions";

export const metadata: Metadata = { title: "Rincian jurnal" };

/**
 * Rincian jurnal (US-M11-02 KP-5, US-M11-04 KP-3): baris akun & pusat laba, tautan ke transaksi sumber (dan sumber →
 * jurnal), pembalik, persetujuan, lampiran. Jurnal otomatis tidak dapat diubah; jurnal manual terposting hanya dibalik.
 */
export default async function JournalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requirePermission("m11.journal.read");
  const { id } = await params;
  const d = await m11.getJournalDetail(ctx, id);
  const j = d.journal;
  const manual = j.kind === "manual" || j.kind === "accrual";
  const editable = manual && (j.status === "draft" || j.status === "rejected");
  const debit = d.lines.reduce((s, l) => s + l.debit, 0);
  const credit = d.lines.reduce((s, l) => s + l.credit, 0);

  return (
    <div className="grid gap-6">
      <OfficeBreadcrumbLabel label={j.number} />
      <PageHeader
        title={`Jurnal ${j.number}`}
        backHref="/akuntansi/jurnal"
        backLabel="Jurnal"
        meta={
          <span className="flex flex-wrap gap-1">
            <JournalKindBadge kind={j.kind} />
            <JournalStatusBadge status={j.status} />
            {d.reversedBy ? <ToneBadge tone="muted">Dibalik</ToneBadge> : null}
          </span>
        }
        description={j.description}
        actions={
          <div className="flex flex-wrap gap-2" data-testid="aksi-jurnal">
            {editable && can(ctx, "m11.journal.submit") ? <M11ActionButton label="Ajukan / posting" variant="default" action={submitJournalAction.bind(null, j.id)} testId="ajukan-jurnal" /> : null}
            {(editable || j.status === "submitted") && manual && can(ctx, "m11.journal.create") ? (
              <M11ReasonButton label="Batalkan" title={`Batalkan ${j.number}?`} description="Jurnal tidak dihapus — berstatus Ditolak." action={cancelJournalAction.bind(null, j.id)} destructive />
            ) : null}
            {j.status === "posted" && j.kind !== "auto" && !j.reversalOfId && !d.reversedBy && can(ctx, "m11.journal.reverse") ? (
              <M11ReasonButton
                label="Balik jurnal"
                title={`Buat jurnal pembalik untuk ${j.number}?`}
                description={`Di atas ${formatRupiah(500_000)} diajukan ke pemilik (BR-38). Jurnal asal tidak diubah.`}
                action={reverseJournalAction.bind(null, j.id)}
                testId="balik-jurnal"
              />
            ) : null}
          </div>
        }
      />

      <SectionCard title="Ringkasan">
        <KeyValueList
          columns={3}
          items={[
            { label: "Tanggal jurnal", value: formatTanggal(j.journalDate) },
            { label: "Periode posting", value: d.period ?? "—", hint: j.originPeriod ? `Asal periode ${j.originPeriod}` : undefined },
            { label: "Nilai", value: formatRupiah(j.totalDebit) },
            {
              label: "Sumber",
              value: d.source ? d.source.href ? <Link href={d.source.href} className="text-primary hover:underline">{d.source.label}</Link> : d.source.label : j.sourceType === "manual" ? "Jurnal manual" : (j.sourceType ?? "—"),
              hint: d.module ? `Modul ${d.module}` : undefined,
            },
            { label: "Diposting", value: j.postedAt ? formatTanggalJam(j.postedAt) : "—" },
            { label: "Lampiran bukti", value: j.attachmentId ? <a href={`/api/attachments/${j.attachmentId}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">Buka lampiran</a> : manual ? <ToneBadge tone="warning">Belum ada (wajib)</ToneBadge> : "—" },
            { label: "Tinjauan pemilik", value: j.requiresOwnerReview ? (j.ownerReviewedAt ? `Ditinjau ${formatTanggalJam(j.ownerReviewedAt)}` : "Menunggu tinjauan") : "—" },
            { label: "Pembalik akrual", value: j.autoReverseOn ? formatTanggal(j.autoReverseOn) : "—" },
            {
              label: "Pembalik",
              value: d.reversedBy ? <JournalLink id={d.reversedBy.id} number={d.reversedBy.number} /> : d.reversalOf ? <>Membalik <JournalLink id={d.reversalOf.id} number={d.reversalOf.number} /></> : "—",
              hint: j.reversalReason ?? undefined,
            },
          ]}
        />
      </SectionCard>

      <SectionCard title="Baris jurnal" flush>
        <div className="overflow-x-auto">
          <Table data-testid="baris-jurnal">
            <TableHeader>
              <TableRow>
                <TableHead>Akun</TableHead>
                <TableHead>Pusat laba</TableHead>
                <TableHead>Outlet</TableHead>
                <TableHead>Memo</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Kredit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    <Link href={`/akuntansi/buku-besar?akun=${l.accountId}&dari=${d.period ?? ""}`} className="font-mono text-primary hover:underline">
                      {l.accountCode}
                    </Link>{" "}
                    {l.accountName}
                  </TableCell>
                  <TableCell>{l.profitCenter}</TableCell>
                  <TableCell>{l.outletName ?? "—"}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{l.description ?? ""}</TableCell>
                  <TableCell className="text-right">
                    <Amount value={l.debit} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Amount value={l.credit} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={4}>Jumlah {debit === credit ? "(seimbang)" : "(TIDAK seimbang)"}</TableCell>
                <TableCell className="text-right font-semibold">{formatRupiah(debit)}</TableCell>
                <TableCell className="text-right font-semibold">{formatRupiah(credit)}</TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      </SectionCard>

      {editable && can(ctx, "m11.journal.create") ? (
        <SectionCard title="Lampiran bukti" description="Foto/PDF bukti wajib sebelum diajukan (BR-35).">
          <M11ActionForm action={attachEvidenceAction} submitLabel="Unggah lampiran" testId="unggah-lampiran">
            <input type="hidden" name="journalId" value={j.id} />
            <FormInput label="Berkas" name="evidence" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" required />
          </M11ActionForm>
        </SectionCard>
      ) : null}

      {d.approval || d.pendingApprovals.length ? (
        <SectionCard title="Persetujuan">
          <KeyValueList
            items={[
              { label: "Permintaan", value: d.approval ? `${d.approval.number} · ${label("approval_type", d.approval.type)}` : d.pendingApprovals.map((a) => a.number).join(", ") },
              { label: "Status", value: d.approval ? <StatusBadge enumName="approval_status" value={d.approval.status} /> : <StatusBadge enumName="approval_status" value="submitted" /> },
            ]}
          />
          <Link href="/persetujuan" className="mt-2 inline-block text-sm text-primary hover:underline">
            Buka kotak persetujuan
          </Link>
        </SectionCard>
      ) : null}

      {d.details?.payable || d.payable ? (
        <SectionCard title="Utang dari jurnal ini">
          <KeyValueList
            items={[
              { label: "Kepada", value: d.payable?.payeeName ?? d.details?.payable?.payeeName },
              { label: "Jatuh tempo", value: d.payable ? formatTanggal(d.payable.dueDate) : d.details?.payable?.dueDate },
              { label: "Nilai", value: formatRupiah(d.payable?.amount ?? d.details?.payable?.amount ?? 0) },
              { label: "Terbayar", value: d.payable ? formatRupiah(d.payable.settledAmount) : "—" },
            ]}
          />
        </SectionCard>
      ) : null}

      {d.details?.accountantNote ? (
        <SectionCard title="Catatan akuntan">
          <p className="text-sm">{d.details.accountantNote}</p>
        </SectionCard>
      ) : null}

      {d.queue.length ? (
        <SectionCard title="Riwayat daftar tunggu">
          <ul className="grid gap-1 text-sm">
            {d.queue.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center gap-2">
                <QueueStatusBadge status={q.status} /> {label("journal_queue_reason", q.reason)} — {q.message}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}
