import type { Metadata } from "next";
import Link from "next/link";

import { ReportActionButton, ReportReasonButton } from "@/components/m9-reports/action-controls";
import { EmptyState } from "@/components/shared/empty-state";
import { KpiTile } from "@/components/shared/kpi-tile";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import * as m9 from "@/server/modules/m9-reports";

import { inboxAction } from "./actions";

export const metadata: Metadata = { title: "Kotak masuk" };

/**
 * Kotak masuk pengecualian pemilik (US-M9-04): "Perlu tindakan" per jenis (persetujuan, selisih ≥ ambang, rit gagal,
 * anomali GPS, susut air) dengan tindakan langsung; lewat tenggat naik ke puncak & bertanda; selisih lewat 24 jam
 * dihitung KPI-03; "Info" = notifikasi lain (tidak dapat dihapus — tandai selesai). Pengaturan per jenis di
 * /pengaturan/notifikasi.
 */
export default async function InboxPage() {
  const { ctx } = await requirePermission("m9.inbox.read");
  const box = await m9.getInbox(ctx);

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6" data-testid="inbox-page">
      <PageHeader
        title="Kotak masuk"
        description="Semua yang menunggu keputusan Anda di satu tempat. Butir hilang dari daftar setelah diputuskan di mana pun."
        actions={
          <Link href="/pengaturan/notifikasi" className="text-sm font-medium text-primary hover:underline">
            Pengaturan notifikasi
          </Link>
        }
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile label="Perlu tindakan" value={box.actionCount} tone={box.actionCount ? "warning" : "success"} />
        <KpiTile label="Lewat tenggat" value={box.overdueCount} tone={box.overdueCount ? "danger" : "success"} />
        <KpiTile label={`Selisih lewat ${box.kpi03.followUpHours} jam (KPI-03, 60 hari)`} value={box.kpi03.overdue} tone={box.kpi03.overdue ? "danger" : "success"} />
      </div>

      <section aria-labelledby="perlu-tindakan" className="grid min-w-0 gap-4" data-testid="inbox-action">
        <h2 id="perlu-tindakan" className="text-base font-semibold">
          Perlu tindakan
        </h2>
        {box.action.length ? (
          box.action.map((g) => (
            <SectionCard
              key={g.kind}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {g.label} ({g.items.length})
                  {g.overdue ? (
                    <ToneBadge tone="danger" dot>
                      {g.overdue} lewat tenggat
                    </ToneBadge>
                  ) : null}
                </span>
              }
            >
              <ul className="grid gap-2" data-testid={`inbox-group-${g.kind}`}>
                {g.items.map((i) => (
                  <li key={i.key} className={`grid gap-2 rounded-md border px-3 py-2 text-sm ${i.overdue ? "border-destructive/40 bg-destructive/5" : ""}`} data-testid="inbox-item" data-overdue={i.overdue ? "true" : undefined}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <span className="min-w-0 flex-1">
                        {i.link ? (
                          <Link href={i.link} className="font-medium text-primary hover:underline">
                            {i.title}
                          </Link>
                        ) : (
                          <span className="font-medium">{i.title}</span>
                        )}
                        {i.body ? <span className="block text-muted-foreground">{i.body}</span> : null}
                        <span className="block text-xs text-muted-foreground">
                          {formatTanggalJam(i.createdAt)}
                          {i.deadlineAt ? ` · tenggat ${formatTanggalJam(i.deadlineAt)}` : ""}
                          {i.status ? ` · ${i.status}` : ""}
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        {i.overdue ? (
                          <ToneBadge tone="danger" dot>
                            Lewat tenggat
                          </ToneBadge>
                        ) : null}
                        {i.valueText ? <span className="font-semibold">{i.valueText}</span> : null}
                      </span>
                    </div>
                    {i.actions.length ? (
                      <div className="flex flex-wrap gap-2">
                        {i.actions.includes("approve") ? <ReportActionButton label={i.approveLabel ?? "Setujui"} action={inboxAction.bind(null, g.kind, i.id, "approve", undefined)} testId="inbox-approve" /> : null}
                        {i.actions.includes("reject") ? (
                          <ReportReasonButton label={i.rejectLabel ?? "Tolak"} title={`${i.rejectLabel ?? "Tolak"}: ${i.title}`} description="Alasan wajib diisi." destructive textLabel="Alasan" action={inboxAction.bind(null, g.kind, i.id, "reject")} testId="inbox-reject" />
                        ) : null}
                        {i.actions.includes("request_explanation") ? (
                          <ReportReasonButton label="Minta keterangan" title={`Minta keterangan: ${i.title}`} description="Penerima mendapat notifikasi berisi pertanyaan Anda." textLabel="Keterangan yang diminta" action={inboxAction.bind(null, g.kind, i.id, "request_explanation")} testId="inbox-ask" />
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </SectionCard>
          ))
        ) : (
          <EmptyState title="Tidak ada yang menunggu keputusan" description="Semua pengecualian sudah ditindaklanjuti." compact />
        )}
      </section>

      <SectionCard title={`Info (${box.info.length})`} description="Notifikasi lain — tandai selesai bila sudah dibaca/ditindaklanjuti (tidak dapat dihapus).">
        {box.info.length ? (
          <ul className="grid gap-2" data-testid="inbox-info">
            {box.info.map((i) => (
              <li key={i.key} className="flex flex-wrap items-start justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  {i.link ? (
                    <Link href={i.link} className="font-medium text-primary hover:underline">
                      {i.title}
                    </Link>
                  ) : (
                    <span className="font-medium">{i.title}</span>
                  )}
                  {i.body ? <span className="block text-muted-foreground">{i.body}</span> : null}
                  <span className="block text-xs text-muted-foreground">
                    {formatTanggalJam(i.createdAt)}
                    {i.status ? ` · ${i.status}` : ""}
                  </span>
                </span>
                <ReportActionButton label="Tandai selesai" variant="outline" action={inboxAction.bind(null, "info", i.id, "done", undefined)} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Tidak ada notifikasi info.</p>
        )}
      </SectionCard>
    </div>
  );
}
