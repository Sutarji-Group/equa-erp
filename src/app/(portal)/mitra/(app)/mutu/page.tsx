import type { Metadata } from "next";

import { P3ActionForm } from "@/components/p3-partner/action-form";
import { CheckField, Field, MonthFilter } from "@/components/p3-partner/fields";
import { Phase3Disabled } from "@/components/p3-partner/phase3-disabled";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { label } from "@/lib/labels";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import * as p3 from "@/server/modules/p3-partner";

import { requirePortalSession } from "../../_session";
import { signSopAction } from "../../actions";

export const metadata: Metadata = { title: "Mutu outlet" };

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("id-ID", { maximumFractionDigits: 1 }));

/**
 * Mutu outlet dari sudut pandang mitra (Tahap 3 US-P3-05, US-P3-01 KP-4): skor bulanan (daftar periksa harian di POS,
 * audit pembina, uji air lab), temuan & tenggat tindak lanjut, hasil uji air, daftar periksa onboarding + tanda tangan
 * digital SOP.
 */
export default async function PortalQualityPage({ searchParams }: { searchParams: Promise<{ bulan?: string }> }) {
  const sp = await searchParams;
  const { ctx, user } = await requirePortalSession();
  const q = await p3.portalQuality(ctx, { month: sp.bulan ?? null });
  if (!q.enabled) {
    return (
      <>
        <PageHeader title="Mutu outlet" />
        <Phase3Disabled what="Skor mutu, audit, dan uji air outlet" />
      </>
    );
  }
  const pendingSop = q.onboarding.filter((v) => v.items.some((i) => i.item === "sop_signed" && !i.completedAt));

  return (
    <>
      <PageHeader title="Mutu outlet" description="Skor mutu bulanan = gabungan kepatuhan daftar periksa harian, skor audit pembina, dan hasil uji air laboratorium." />
      <MonthFilter month={q.month} />

      <SectionCard title={`Skor mutu — ${q.month}`}>
        {q.outlets.length === 0 ? (
          <EmptyState title="Belum ada outlet" compact />
        ) : (
          <ul className="grid gap-2 text-sm" data-testid="skor-mutu-mitra">
            {q.outlets.map((o) => (
              <li key={o.outletId} className="flex flex-wrap items-center gap-2 rounded-md border bg-background p-3">
                <span className="font-medium">{o.outletName}</span>
                {o.score.totalScore === null ? <ToneBadge tone="muted">Skor belum ada</ToneBadge> : <ToneBadge tone={o.score.belowThreshold ? "danger" : "success"}>Skor {fmt(o.score.totalScore)}</ToneBadge>}
                <span className="text-muted-foreground">
                  daftar periksa {o.score.compliance.filledDays}/{o.score.compliance.operatingDays} hari · audit {fmt(o.score.auditScore)} · uji air {fmt(o.score.testScore)} · ambang {fmt(o.score.threshold)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {pendingSop.length ? (
        <SectionCard title="Tanda tangan SOP" description="Baca SOP mutu EQUA yang diserahkan pembina, lalu tanda tangani secara digital.">
          {pendingSop.map((v) => (
            <P3ActionForm key={v.outletId} action={signSopAction.bind(null, v.outletId)} submitLabel={`Tanda tangani SOP ${v.outletName}`} testId={`form-sop-${v.outletId}`} className="max-w-xl">
              <Field label="Nama lengkap (tanda tangan)" name="signerName" required defaultValue={user.name} />
              <CheckField name="agree" label="Saya telah membaca dan menerima SOP mutu EQUA untuk outlet ini." />
            </P3ActionForm>
          ))}
        </SectionCard>
      ) : null}

      {q.onboarding.length ? (
        <SectionCard title="Daftar periksa onboarding">
          <ul className="grid gap-3 text-sm">
            {q.onboarding.map((v) => (
              <li key={`${v.contract.id}:${v.outletId}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{v.outletName}</span>
                  <ToneBadge tone={v.done === v.total ? "success" : "warning"}>
                    {v.done}/{v.total} butir
                  </ToneBadge>
                  {v.activatedOn ? <span className="text-muted-foreground">aktif sejak {formatTanggal(v.activatedOn)}</span> : null}
                </div>
                <ul className="mt-1 grid gap-0.5 text-xs">
                  {v.items.map((i) => (
                    <li key={i.id}>
                      {i.completedAt ? "✓" : "○"} {label("onboarding_item", i.item)}
                      {i.completedAt ? ` — ${formatTanggalJam(i.completedAt)}` : ""}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Audit pembina">
          {q.audits.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada audit.</p>
          ) : (
            <ul className="grid gap-2 text-sm">
              {q.audits.map((a) => (
                <li key={a.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{formatTanggal(a.scheduledDate)}</span>
                    <span className="text-muted-foreground">{a.outletName}</span>
                    <StatusBadge enumName="partner_audit_status" value={a.status} />
                    {a.score !== null ? <ToneBadge tone="info">skor {fmt(a.score)}</ToneBadge> : null}
                  </div>
                  {a.findings.length ? (
                    <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
                      {a.findings.map((f, i) => (
                        <li key={i}>{String(f.text ?? "")}</li>
                      ))}
                    </ul>
                  ) : null}
                  {a.followUpDueDate && !a.followUpDoneAt ? <p className="text-xs text-destructive">Tindak lanjut paling lambat {formatTanggal(a.followUpDueDate)}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        <SectionCard title="Uji air laboratorium">
          {q.tests.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada hasil uji.</p>
          ) : (
            <ul className="grid gap-1 text-sm">
              {q.tests.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2">
                  <span>{formatTanggal(t.testDate)}</span>
                  <span className="text-muted-foreground">
                    {t.outletName} · {t.laboratory ?? "-"}
                  </span>
                  <ToneBadge tone={t.passed ? "success" : "danger"}>{t.passed ? "Lulus" : "Tidak lulus"}</ToneBadge>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </>
  );
}
