import type { Metadata } from "next";
import Link from "next/link";

import { P3ActionForm } from "@/components/p3-partner/action-form";
import { SelectField, TextAreaField } from "@/components/p3-partner/fields";
import { KeyValueList } from "@/components/shared/key-value-list";
import { MoneyText } from "@/components/shared/money-text";
import { OfficeBreadcrumbLabel } from "@/components/shared/office-shell";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as p3 from "@/server/modules/p3-partner";

import { completeSupportAction, linkSparePartAction, respondSupportAction } from "../../actions";

export const metadata: Metadata = { title: "Permintaan dukungan" };

/**
 * Rincian permintaan dukungan mitra (US-P3-11 KP-1..KP-3): uraian & foto, cap waktu tiap perubahan status, tanggapan
 * pembina/admin EQUA, rujukan penjualan spare part toko harga mitra (M7, BR-18), tandai Selesai.
 */
export default async function SupportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await requirePermission("p3.support_request.read");
  const r = await p3.getSupportRequest(ctx, id);
  const canRespond = can(ctx, "p3.support_request.respond");
  const candidates = canRespond && r.status !== "done" ? await p3.supportSaleCandidates(ctx, id) : [];
  const saleOptions = candidates.map((s) => ({ value: s.id, label: `${s.number ?? s.id.slice(0, 8)} · ${formatTanggal(s.businessDate)} · ${formatRupiah(s.total)}` }));

  return (
    <div className="grid gap-6">
      <OfficeBreadcrumbLabel label={`Dukungan ${r.tenantName}`} />
      <PageHeader title={`${label("support_request_kind", r.kind)} — ${r.tenantName}`} backHref="/kemitraan/dukungan" backLabel="Dukungan teknis" meta={<StatusBadge enumName="support_request_status" value={r.status} />} />
      <SectionCard title="Permintaan">
        <KeyValueList
          columns={3}
          items={[
            { label: "Outlet", value: r.outletName },
            { label: "Diajukan", value: formatTanggalJam(r.submittedAt) },
            { label: "Batas tanggap (PAR-76)", value: r.slaDueAt ? formatTanggalJam(r.slaDueAt) : "—" },
            { label: "Ditanggapi", value: r.respondedAt ? formatTanggalJam(r.respondedAt) : "—" },
            { label: "Waktu tanggap", value: r.responseHours !== null ? `${r.responseHours} jam` : "—" },
            { label: "SLA", value: <StatusBadge enumName="partner_sla_status" value={r.slaStatus} /> },
            { label: "Selesai", value: r.doneAt ? formatTanggalJam(r.doneAt) : "—" },
          ]}
        />
        <p className="mt-4 whitespace-pre-line text-sm">{r.description}</p>
        {r.photoAttachmentId ? (
          <a href={`/kemitraan/lampiran/${r.photoAttachmentId}`} target="_blank" rel="noreferrer" className="mt-3 inline-block">
            {/* eslint-disable-next-line @next/next/no-img-element -- lampiran privat lewat route terotorisasi */}
            <img src={`/kemitraan/lampiran/${r.photoAttachmentId}`} alt="Foto permintaan dukungan" className="max-h-64 rounded-md border" />
          </a>
        ) : null}
        {r.response ? (
          <div className="mt-4 rounded-md border bg-muted/40 p-3 text-sm">
            <div className="font-medium">Tanggapan EQUA</div>
            <p className="whitespace-pre-line">{r.response}</p>
          </div>
        ) : null}
        {r.sale ? (
          <p className="mt-3 text-sm">
            Spare part: penjualan toko{" "}
            <Link href="/toko" className="text-primary hover:underline">
              {r.sale.number ?? r.sale.id.slice(0, 8)}
            </Link>{" "}
            ({formatTanggal(r.sale.businessDate)}, <MoneyText value={r.sale.total} />, harga mitra)
          </p>
        ) : null}
      </SectionCard>
      {canRespond && r.status === "submitted" ? (
        <SectionCard title="Tanggapi" description="Waktu tanggap dihitung sampai tanggapan ini disimpan.">
          <P3ActionForm action={respondSupportAction.bind(null, r.id)} submitLabel="Kirim tanggapan" testId="form-tanggapi-dukungan" className="max-w-2xl">
            <TextAreaField label="Tanggapan untuk mitra" name="response" required rows={4} />
            {saleOptions.length ? <SelectField label="Rujuk penjualan spare part (opsional)" name="relatedPosSaleId" options={saleOptions} hint="Penjualan toko ke pelanggan mitra dengan harga mitra." /> : null}
          </P3ActionForm>
        </SectionCard>
      ) : null}
      {canRespond && r.status !== "done" ? (
        <div className="grid gap-4 md:grid-cols-2">
          {r.status === "responded" && !r.sale && saleOptions.length ? (
            <SectionCard title="Rujuk penjualan spare part">
              <P3ActionForm action={linkSparePartAction.bind(null, r.id)} submitLabel="Rujuk">
                <SelectField label="Penjualan toko (harga mitra)" name="posSaleId" required options={saleOptions} />
              </P3ActionForm>
            </SectionCard>
          ) : null}
          {r.status === "responded" ? (
            <SectionCard title="Tandai selesai">
              <P3ActionForm action={completeSupportAction.bind(null, r.id)} submitLabel="Selesai" testId="form-selesai-dukungan">
                <TextAreaField label="Catatan penyelesaian (opsional)" name="note" rows={2} />
              </P3ActionForm>
            </SectionCard>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
