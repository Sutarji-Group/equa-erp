import type { Metadata } from "next";
import Link from "next/link";

import { ActionForm } from "@/components/m1-master/action-form";
import { TextAreaField } from "@/components/m1-master/fields";
import { ImportSummaryView, type ImportSummaryData } from "@/components/m1-master/import-summary";
import { KpiTile } from "@/components/shared/kpi-tile";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { label } from "@/lib/labels";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m1 from "@/server/modules/m1-master";

import { signSignoffAction } from "./actions";

export const metadata: Metadata = { title: "Tanda tangan data awal" };

type SignoffSummary = { kinds?: Record<string, ImportSummaryData & { batchId?: string }>; updatedAt?: string };

/**
 * Tanda tangan data awal (US-M1-06 KP-4, NFR-34): ringkasan per kelompok (jumlah pelanggan per segmen & zona, daftar
 * Tempo migrasi & total batas, armada/kru/karyawan, depot & sumber air) ditandatangani pemilik sebelum go-live.
 * Kemajuan kunci koordinat 30 hari pertama (KP-5) ditampilkan di sini juga.
 */
export default async function TandaTanganPage() {
  const { ctx } = await requirePermission("m1.data_signoff.read");
  const [signoffs, status] = await Promise.all([m1.listSignoffs(ctx), m1.initialDataStatus(ctx)]);
  const canSign = can(ctx, "m1.data_signoff.sign");
  const coords = status.coordinates;

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Tanda tangan data awal"
        description="Pemilik meninjau dan menandatangani ringkasan setiap kelompok data awal sebelum go-live. Impor ulang setelah tanda tangan membuat draf baru yang menggantikan versi lama."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <KpiTile
          label="Koordinat terkunci"
          value={`${coords.percentLocked}%`}
          hint={`${coords.locked}/${coords.total} alamat${coords.goLiveDate ? ` · go-live ${formatTanggal(coords.goLiveDate, { weekday: false })}` : ""}${coords.dayOfWindow ? ` · hari ke-${coords.dayOfWindow}/${coords.windowDays}` : ` · target ${coords.windowDays} hari pertama`}`}
          tone={coords.windowEnded && coords.unlocked > 0 ? "danger" : coords.percentLocked >= 100 ? "success" : undefined}
        />
        {status.groups.map((g) => (
          <KpiTile key={g.group} label={g.label} value={g.status === "signed" ? "Ditandatangani" : g.status === "draft" ? "Menunggu" : "Belum diimpor"} hint={g.signedAt ? formatTanggalJam(g.signedAt) : undefined} tone={g.status === "signed" ? "success" : g.status === "draft" ? "warning" : undefined} />
        ))}
      </div>

      {status.allSigned ? (
        <Alert role="status">
          <AlertDescription>Semua kelompok data awal Data master sudah ditandatangani.</AlertDescription>
        </Alert>
      ) : null}

      {m1.M1_SIGNOFF_GROUPS.map((group) => {
        const history = signoffs.filter((s) => s.group === group);
        const current = history.find((s) => s.status !== "superseded");
        const summary = (current?.summary ?? {}) as SignoffSummary;
        const kinds = Object.entries(summary.kinds ?? {});
        return (
          <SectionCard
            key={group}
            title={label("data_signoff_group", group)}
            description={current ? current.title : "Belum ada impor produksi untuk kelompok ini."}
            actions={current ? <StatusBadge enumName="signoff_status" value={current.status} tone={current.status === "signed" ? "success" : "warning"} /> : null}
          >
            {current ? (
              <div className="grid gap-4">
                {kinds.map(([kind, s]) => (
                  <div key={kind} className="grid gap-2">
                    <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {label("import_kind", kind)}
                      {s.batchId ? (
                        <Link href={`/master/impor/${s.batchId}`} className="text-xs font-normal text-primary underline-offset-4 hover:underline">
                          Laporan batch
                        </Link>
                      ) : null}
                    </h3>
                    <ImportSummaryView summary={s} />
                  </div>
                ))}
                {current.status === "signed" ? (
                  <p className="text-sm text-muted-foreground">
                    Ditandatangani {current.signedAt ? formatTanggalJam(current.signedAt) : ""}
                    {current.notes ? ` · Catatan: ${current.notes}` : ""}
                  </p>
                ) : canSign ? (
                  <ActionForm action={signSignoffAction.bind(null, current.id)} submitLabel="Tanda tangani ringkasan" aria-label={`Tanda tangani ${label("data_signoff_group", group)}`}>
                    {group === "customers" ? (
                      <p className="text-sm text-muted-foreground">Dengan menandatangani, pelanggan pada daftar Tempo migrasi di atas ditetapkan statusnya (batas &amp; tempo sesuai berkas) dan Admin Keuangan diberi tahu.</p>
                    ) : null}
                    <TextAreaField label="Catatan (opsional)" name="note" maxLength={500} />
                  </ActionForm>
                ) : (
                  <p className="text-sm text-muted-foreground">Menunggu tanda tangan pemilik.</p>
                )}
                {history.length > 1 ? (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-primary">Riwayat versi ({history.length})</summary>
                    <ul className="mt-2 grid gap-1">
                      {history.map((h) => (
                        <li key={h.id} className="flex flex-wrap gap-2">
                          <span>{formatTanggalJam(h.createdAt)}</span>
                          <StatusBadge enumName="signoff_status" value={h.status} />
                          {h.signedAt ? <span className="text-muted-foreground">ditandatangani {formatTanggalJam(h.signedAt)}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Unggah berkas mode produksi di{" "}
                <Link href="/master/impor" className="text-primary underline-offset-4 hover:underline">
                  Impor data awal
                </Link>
                .
              </p>
            )}
          </SectionCard>
        );
      })}
    </div>
  );
}
