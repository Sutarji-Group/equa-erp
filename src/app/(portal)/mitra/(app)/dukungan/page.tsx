import type { Metadata } from "next";

import { P3ActionForm } from "@/components/p3-partner/action-form";
import { FileField, SelectField, TextAreaField } from "@/components/p3-partner/fields";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { enumOptions, label } from "@/lib/labels";
import { formatTanggalJam } from "@/lib/time";
import * as p3 from "@/server/modules/p3-partner";

import { requirePortalSession } from "../../_session";
import { submitSupportAction } from "../../actions";

export const metadata: Metadata = { title: "Dukungan teknis" };

const SLA_TONE = { on_time: "success", late: "danger", open: "info" } as const;

/**
 * Dukungan teknis mitra (RL-7 US-P3-11): ajukan permintaan (jenis, uraian, foto, outlet) dan pantau statusnya
 * Diajukan → Ditanggapi → Selesai dengan waktu setiap perubahan; janji tanggap ≤ 48 jam (PAR-76) dapat dibuktikan.
 */
export default async function PortalSupportPage() {
  const { ctx, tenant } = await requirePortalSession();
  const home = await p3.portalHome(ctx);
  const rows = await p3.listSupportRequests(ctx);

  return (
    <>
      <PageHeader title="Dukungan teknis" description="EQUA menanggapi permintaan paling lambat 48 jam sejak diajukan. Kepatuhan waktu tanggap dirangkum di laporan bulanan." />
      {tenant.isActive ? (
        <SectionCard title="Ajukan permintaan">
          <P3ActionForm action={submitSupportAction} submitLabel="Kirim permintaan" testId="form-dukungan-mitra" className="max-w-2xl">
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField label="Outlet" name="outletId" required defaultValue={home.outlets.length === 1 ? home.outlets[0]!.id : null} options={home.outlets.map((o) => ({ value: o.id, label: `${o.code} — ${o.name}` }))} />
              <SelectField label="Jenis" name="kind" required options={enumOptions("support_request_kind")} />
            </div>
            <TextAreaField label="Uraian kendala" name="description" required rows={3} hint="Mis. pompa tidak menyala sejak pagi, lampu UV mati, tablet POS tidak bisa sinkron." />
            <FileField label="Foto (opsional)" name="photo" accept="image/jpeg,image/png,image/webp" hint="Foto kendala, maksimal 4 MB." />
          </P3ActionForm>
        </SectionCard>
      ) : null}

      <SectionCard title="Permintaan saya">
        {rows.length === 0 ? (
          <EmptyState title="Belum ada permintaan" compact />
        ) : (
          <ul className="grid gap-3" data-testid="daftar-dukungan-mitra">
            {rows.map((r) => (
              <li key={r.id} className="rounded-md border bg-background p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{label("support_request_kind", r.kind)}</span>
                  <span className="text-muted-foreground">{r.outletName}</span>
                  <StatusBadge enumName="support_request_status" value={r.status} />
                  <ToneBadge tone={SLA_TONE[r.slaStatus]}>{r.slaStatus === "open" ? "menunggu tanggapan" : r.slaStatus === "late" ? "lewat 48 jam" : "tepat waktu"}</ToneBadge>
                </div>
                <p className="mt-1 whitespace-pre-wrap">{r.description}</p>
                {r.photoAttachmentId ? (
                  <a href={`/mitra/lampiran/${r.photoAttachmentId}`} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-primary underline">
                    Lihat foto
                  </a>
                ) : null}
                <ol className="mt-2 grid gap-0.5 text-xs text-muted-foreground">
                  <li>Diajukan {formatTanggalJam(r.submittedAt)}</li>
                  {r.respondedAt ? (
                    <li>
                      Ditanggapi {formatTanggalJam(r.respondedAt)} ({r.responseHours} jam)
                    </li>
                  ) : r.slaDueAt ? (
                    <li>Batas tanggap {formatTanggalJam(r.slaDueAt)}</li>
                  ) : null}
                  {r.doneAt ? <li>Selesai {formatTanggalJam(r.doneAt)}</li> : null}
                </ol>
                {r.response ? <p className="mt-2 rounded bg-muted p-2 text-sm">Tanggapan EQUA: {r.response}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </>
  );
}
