import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { P2ActionForm } from "@/components/p2-customer/action-form";
import { KeyValueList } from "@/components/shared/key-value-list";
import { OfficeBreadcrumbLabel } from "@/components/shared/office-shell";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { NotFoundError } from "@/server/core/errors";
import { can } from "@/server/core/rbac";
import { formatWaNumber } from "@/server/core/wa";
import * as p2 from "@/server/modules/p2-customer";

import { disputeFromComplaintAction, reassignComplaintAction, resolveComplaintAction, respondComplaintAction } from "../actions";

export const metadata: Metadata = { title: "Rincian keluhan" };

/**
 * Rincian keluhan (US-P2-06 KP-2/KP-3): tanggapi (tampil ke pelanggan), pindah kotak, sengketa faktur untuk keluhan
 * volume/tagihan (Admin Keuangan, 7.5.6), tutup dengan penyelesaian tercatat. Riwayat tindak lanjut tanpa hapus.
 */
export default async function KeluhanDetailKantorPage({ params }: PageProps<"/keluhan/[id]">) {
  const { ctx } = await requirePermission("p2.complaint.read");
  const { id } = await params;
  let c: p2.OfficeComplaintDetail;
  try {
    c = await p2.getComplaint(ctx, id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const canRespond = can(ctx, "p2.complaint.respond");
  const canDispute = can(ctx, "m5.invoice.dispute") && (c.kind === "volume" || c.kind === "billing") && c.status !== "done";
  return (
    <div className="grid gap-6">
      <OfficeBreadcrumbLabel label={`Keluhan ${c.customerName}`} />
      <PageHeader
        title={`Keluhan ${label("complaint_kind", c.kind).toLowerCase()} — ${c.customerName}`}
        backHref="/keluhan"
        meta={
          <>
            <StatusBadge enumName="complaint_status" value={c.status} tone={c.status === "done" ? "success" : c.status === "responded" ? "info" : "warning"} />
            <ToneBadge tone="neutral">{label("complaint_box", c.box)}</ToneBadge>
            {c.overdue ? <ToneBadge tone="danger">Lewat tenggat tanggapan</ToneBadge> : null}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="grid gap-6">
          <SectionCard title="Keluhan">
            <p className="whitespace-pre-line" data-testid="complaint-text">
              {c.description}
            </p>
            {c.photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- lampiran berotorisasi
              <img src={c.photoUrl} alt="Foto keluhan pelanggan" className="mt-3 max-h-80 rounded-md border" />
            ) : null}
            <div className="mt-4">
              <KeyValueList
                columns={2}
                items={[
                  { label: "Diajukan", value: formatTanggalJam(c.createdAt) },
                  { label: "Tenggat tanggapan (PAR-75)", value: c.dueAt ? formatTanggalJam(c.dueAt) : "—" },
                  { label: "Tanggapan pertama", value: c.firstResponseAt ? formatTanggalJam(c.firstResponseAt) : "Belum" },
                  { label: "Selesai", value: c.resolvedAt ? formatTanggalJam(c.resolvedAt) : "—" },
                  { label: "Pesanan", value: c.orderNumber ?? "—" },
                  { label: "Pengiriman / truk", value: [c.tripNumber, c.truck].filter(Boolean).join(" · ") || "—" },
                  { label: "WhatsApp pelanggan", value: c.customerPhone ? formatWaNumber(c.customerPhone) : "—" },
                  { label: "Faktur terkait", value: c.invoice ? `${c.invoice.number}${c.invoice.disputed ? " (bersengketa)" : ""}` : "—" },
                ]}
              />
            </div>
            <Link href={`/master/pelanggan/${c.customerId}`} className="mt-3 inline-block text-sm text-primary underline">
              Buka kartu pelanggan
            </Link>
          </SectionCard>
          <SectionCard title="Riwayat tindak lanjut">
            {c.actions.length === 0 ? (
              <p className="text-sm text-muted-foreground">Belum ada tindak lanjut.</p>
            ) : (
              <ol className="grid gap-3 text-sm" data-testid="complaint-actions">
                {c.actions.map((a) => (
                  <li key={a.id} className="rounded-md border p-3">
                    <p className="text-xs text-muted-foreground">
                      {a.actionLabel} · {formatTanggalJam(a.at)} · {a.actorName ?? "Sistem"} {a.visibleToCustomer ? "· tampil ke pelanggan" : "· internal"}
                    </p>
                    <p className="whitespace-pre-line">{a.note}</p>
                  </li>
                ))}
              </ol>
            )}
          </SectionCard>
        </div>
        <div className="grid content-start gap-6">
          {canRespond && c.canRespond ? (
            <>
              <SectionCard title="Tanggapi pelanggan">
                <P2ActionForm action={respondComplaintAction.bind(null, c.id)} submitLabel="Kirim tanggapan" testId="respond-form">
                  <textarea name="response" rows={4} required minLength={5} placeholder="Tanggapan tampil ke pelanggan (aplikasi & WhatsApp)" className="rounded-md border border-input bg-background px-3 py-2 text-sm" />
                </P2ActionForm>
              </SectionCard>
              <SectionCard title="Tutup keluhan">
                <P2ActionForm action={resolveComplaintAction.bind(null, c.id)} submitLabel="Tutup dengan penyelesaian" variant="secondary" testId="resolve-form">
                  <textarea name="resolution" rows={3} required minLength={5} placeholder="Penyelesaian yang dilakukan (tercatat, tampil ke pelanggan)" className="rounded-md border border-input bg-background px-3 py-2 text-sm" />
                </P2ActionForm>
              </SectionCard>
            </>
          ) : canRespond && c.status !== "done" ? (
            <SectionCard title="Tanggapan">
              <p className="text-sm text-muted-foreground">Keluhan ini ada di kotak {label("complaint_box", c.box)}. Pindahkan kotak bila perlu Anda tangani.</p>
            </SectionCard>
          ) : null}
          {canRespond && c.status !== "done" ? (
            <SectionCard title="Pindah kotak">
              <P2ActionForm action={reassignComplaintAction.bind(null, c.id)} submitLabel="Pindahkan" variant="outline">
                <select name="box" defaultValue={c.box === "dispatcher" ? "finance_admin" : "dispatcher"} className="h-9 rounded-md border border-input bg-background px-2 text-sm">
                  <option value="dispatcher">Operasional (Dispatcher)</option>
                  <option value="finance_admin">Tagihan (Admin Keuangan)</option>
                </select>
                <input name="note" required minLength={3} placeholder="Alasan" className="h-9 rounded-md border border-input bg-background px-2 text-sm" />
              </P2ActionForm>
            </SectionCard>
          ) : null}
          {canDispute && c.disputeCandidates.length ? (
            <SectionCard title="Sengketa faktur (7.5.6)" description="Pengingat & penahanan faktur ditunda; keputusan nota kredit / ditolak oleh pemilik.">
              <P2ActionForm action={disputeFromComplaintAction.bind(null, c.id)} submitLabel="Tandai faktur bersengketa" variant="outline" testId="dispute-form">
                <select name="invoiceId" className="h-9 rounded-md border border-input bg-background px-2 text-sm">
                  {c.disputeCandidates.map((i) => (
                    <option key={i.id} value={i.id} disabled={i.disputed}>
                      {i.number} · sisa {formatRupiah(i.outstanding)}
                      {i.disputed ? " (sudah bersengketa)" : ""}
                    </option>
                  ))}
                </select>
                <input name="note" required minLength={5} placeholder="Catatan sengketa" className="h-9 rounded-md border border-input bg-background px-2 text-sm" />
              </P2ActionForm>
            </SectionCard>
          ) : null}
        </div>
      </div>
    </div>
  );
}
