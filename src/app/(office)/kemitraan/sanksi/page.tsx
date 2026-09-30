import type { Metadata } from "next";
import Link from "next/link";

import { P3ActionForm } from "@/components/p3-partner/action-form";
import { Field, SelectField, TextAreaField } from "@/components/p3-partner/fields";
import { Phase3Disabled } from "@/components/p3-partner/phase3-disabled";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { enumValues, label } from "@/lib/labels";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as p3 from "@/server/modules/p3-partner";

import { phase3Enabled } from "../_data";
import { liftSanctionAction, markExportedAction, proposeSanctionAction } from "../actions";

export const metadata: Metadata = { title: "Sanksi mitra" };

const LEVELS = [
  { value: "warning", label: "Teguran tertulis" },
  { value: "supply_suspension", label: "Penghentian pasokan sementara" },
  { value: "termination", label: "Pemutusan" },
];

/**
 * Sanksi bertingkat mitra (Tahap 3 US-P3-07, PTB-58/59): pemicu otomatis tercatat (tunggakan, neraca air, skor mutu,
 * temuan audit lewat tenggat, POS tidak dipakai, uji air) → usulan pembina/Admin Keuangan → keputusan pemilik
 * (Persetujuan, beralasan). Pencabutan beralasan oleh pemilik; pemutusan → ekspor data outlet ≤ 30 hari (PTB-58).
 */
export default async function SanctionsPage({ searchParams }: { searchParams: Promise<{ status?: string; mitra?: string; id?: string }> }) {
  const sp = await searchParams;
  const { ctx } = await requirePermission(["p3.sanction.propose", "p3.partner.read"]);
  if (!(await phase3Enabled(ctx.tenantId))) {
    return (
      <div className="grid gap-6">
        <PageHeader title="Sanksi mitra" />
        <Phase3Disabled what="Sanksi bertingkat mitra" />
      </div>
    );
  }
  const status = sp.status && (enumValues("sanction_status") as string[]).includes(sp.status) ? sp.status : null;
  const tenantId = sp.mitra && /^[0-9a-f-]{36}$/i.test(sp.mitra) ? sp.mitra : null;
  const rows = await p3.listSanctions(ctx, { status, tenantId });
  const canPropose = can(ctx, "p3.sanction.propose");
  const canLift = can(ctx, "p3.sanction.lift");
  const canExport = can(ctx, "p3.partner_data_export.create");
  const partners = canPropose ? await p3.listPartners(ctx) : [];
  const ended = canExport ? (await p3.listContracts(ctx)).filter((c) => c.status === "terminated" || c.status === "ended") : [];
  const filterHref = (s: string | null) => {
    const q = new URLSearchParams();
    if (s) q.set("status", s);
    if (tenantId) q.set("mitra", tenantId);
    const qs = q.toString();
    return `/kemitraan/sanksi${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Sanksi mitra"
        description="Pemicu tercatat otomatis; setiap tahap (teguran → penghentian pasokan sementara → pemutusan) diputuskan pemilik dengan alasan di Persetujuan."
        actions={<ExportButtons excelHref="/api/export/p3.sanctions?format=xlsx" pdfHref="/api/export/p3.sanctions?format=pdf" />}
      />
      <nav className="flex flex-wrap gap-2" aria-label="Saring status">
        <Link href={filterHref(null)} className={`rounded-full border px-3 py-1 text-sm ${!status ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}>
          Semua
        </Link>
        {enumValues("sanction_status").map((s) => (
          <Link key={s} href={filterHref(s)} className={`rounded-full border px-3 py-1 text-sm ${status === s ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}>
            {label("sanction_status", s)}
          </Link>
        ))}
        {tenantId ? (
          <Link href={status ? `/kemitraan/sanksi?status=${status}` : "/kemitraan/sanksi"} className="rounded-full border border-dashed px-3 py-1 text-sm">
            Hapus saringan mitra
          </Link>
        ) : null}
      </nav>

      <SectionCard title="Pemicu & sanksi" description="Pemicu tidak memblokir apa pun sampai pemilik memutuskan (PTB-59).">
        {rows.length === 0 ? (
          <EmptyState title="Belum ada pemicu atau sanksi" compact />
        ) : (
          <ul className="grid gap-3" data-testid="daftar-sanksi">
            {rows.map((s) => {
              const highlighted = sp.id === s.id;
              const pending = s.approvalStatus === "submitted";
              return (
                <li key={s.id} id={s.id} className={`rounded-md border p-3 text-sm ${highlighted ? "border-primary ring-2 ring-primary/30" : ""}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/kemitraan/mitra/${s.tenantId}`} className="font-medium text-primary hover:underline">
                      {s.tenantName}
                    </Link>
                    <span className="text-muted-foreground">kontrak {s.contractNumber}</span>
                    <ToneBadge tone={s.level === "termination" ? "danger" : s.level === "supply_suspension" ? "warning" : "info"}>{label("sanction_level", s.level)}</ToneBadge>
                    <StatusBadge enumName="sanction_status" value={s.status} />
                    <ToneBadge tone="muted">{label("sanction_trigger", s.trigger)}</ToneBadge>
                    {s.approvalNumber ? (
                      <Link href="/persetujuan" className="text-xs text-primary hover:underline">
                        {s.approvalNumber} · {label("approval_status", s.approvalStatus ?? "submitted")}
                      </Link>
                    ) : null}
                  </div>
                  {s.detail.summary ? <p className="mt-1">{String(s.detail.summary)}</p> : null}
                  <p className="mt-1 text-xs text-muted-foreground">
                    Tercatat {formatTanggalJam(s.createdAt)}
                    {s.decidedAt ? ` · diputuskan ${formatTanggalJam(s.decidedAt)}` : ""}
                    {s.effectiveFrom ? ` · berlaku ${formatTanggal(s.effectiveFrom)}` : ""}
                    {s.liftedAt ? ` · dicabut ${formatTanggalJam(s.liftedAt)}` : ""}
                  </p>
                  {s.decisionReason ? <p className="mt-1 text-xs">Alasan keputusan: {s.decisionReason}</p> : null}
                  {s.liftReason ? <p className="mt-1 text-xs">Alasan pencabutan: {s.liftReason}</p> : null}
                  {s.detail.recoveryConditions ? <p className="mt-1 text-xs">Syarat pemulihan: {String(s.detail.recoveryConditions)}</p> : null}
                  {s.detail.letterText ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-medium text-primary">Surat teguran tertulis</summary>
                      <pre className="mt-1 whitespace-pre-wrap rounded bg-muted p-2 font-sans text-xs">{String(s.detail.letterText)}</pre>
                    </details>
                  ) : null}
                  {s.status === "triggered" && !pending && canPropose ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-sm font-medium text-primary">Ajukan ke pemilik</summary>
                      <P3ActionForm action={proposeSanctionAction} submitLabel="Ajukan sanksi" className="mt-2 max-w-2xl" testId={`form-usul-sanksi-${s.id}`}>
                        <input type="hidden" name="sanctionId" value={s.id} />
                        <div className="grid gap-3 sm:grid-cols-2">
                          <SelectField label="Tingkat" name="level" required defaultValue={s.level} options={LEVELS} hint="Bertingkat: tidak boleh melompati tahap." />
                          <Field label="Tanggal berlaku (opsional)" name="effectiveDate" type="date" />
                        </div>
                        <TextAreaField label="Dasar usulan" name="reason" required rows={2} />
                        <TextAreaField label="Syarat pemulihan (wajib untuk penghentian pasokan; tampil di portal mitra)" name="recoveryConditions" rows={2} />
                      </P3ActionForm>
                    </details>
                  ) : null}
                  {((s.status === "triggered" && !pending) || (s.status === "active" && s.level !== "termination")) && canLift ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-sm font-medium text-primary">{s.status === "active" ? "Cabut sanksi" : "Tidak dilanjutkan"}</summary>
                      <P3ActionForm action={liftSanctionAction.bind(null, s.id)} submitLabel={s.status === "active" ? "Cabut" : "Tutup pemicu"} variant="outline" className="mt-2 max-w-2xl">
                        <TextAreaField label="Alasan (tercatat)" name="reason" required rows={2} />
                      </P3ActionForm>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      {canPropose && partners.length ? (
        <SectionCard title="Usulan sanksi manual" description="Untuk temuan di luar pemicu otomatis. Tahap berikutnya dihitung dari sanksi yang berlaku.">
          <P3ActionForm action={proposeSanctionAction} submitLabel="Ajukan ke pemilik" testId="form-sanksi-manual" className="max-w-2xl">
            <div className="grid gap-3 sm:grid-cols-3">
              <SelectField label="Mitra" name="tenantId" required options={partners.map((p) => ({ value: p.tenant.id, label: `${p.tenant.code} — ${p.tenant.name}` }))} />
              <SelectField label="Tingkat" name="level" options={LEVELS} hint="Kosongkan = tahap berikutnya." />
              <Field label="Tanggal berlaku (opsional)" name="effectiveDate" type="date" />
            </div>
            <TextAreaField label="Dasar usulan" name="reason" required rows={2} />
            <TextAreaField label="Syarat pemulihan" name="recoveryConditions" rows={2} />
          </P3ActionForm>
        </SectionCard>
      ) : null}

      {canExport ? (
        <SectionCard title="Pelepasan data mitra berakhir/diputus (PTB-58)" description="Data outlet diekspor untuk mitra paling lambat 30 hari; data tetap tersimpan di EQUA sesuai retensi.">
          {ended.length === 0 ? (
            <p className="text-sm text-muted-foreground">Tidak ada kontrak yang berakhir atau diputus.</p>
          ) : (
            <ul className="grid gap-2 text-sm" data-testid="daftar-ekspor-mitra">
              {ended.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3">
                  <span className="font-medium">{c.tenantName}</span>
                  <StatusBadge enumName="partner_contract_status" value={c.status} />
                  {c.dataExportDueDate ? <span className="text-muted-foreground">tenggat ekspor {formatTanggal(c.dataExportDueDate)}</span> : null}
                  {c.dataExportedAt ? <ToneBadge tone="success">Diserahkan {formatTanggalJam(c.dataExportedAt)}</ToneBadge> : <ToneBadge tone="warning">Belum diserahkan</ToneBadge>}
                  <a className="text-primary hover:underline" href={`/api/export/p3.partner_data_export?format=xlsx&tenantId=${c.tenantId}`}>
                    Unduh data (Excel)
                  </a>
                  {!c.dataExportedAt ? <P3ActionForm action={markExportedAction.bind(null, c.tenantId)} submitLabel="Tandai sudah diserahkan" variant="outline" resetOnSuccess={false} /> : null}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      ) : null}
    </div>
  );
}
