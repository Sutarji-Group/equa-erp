import type { Metadata } from "next";

import { P3ActionForm } from "@/components/p3-partner/action-form";
import { CheckField, Field, FileField, MonthFilter, SelectField, TextAreaField } from "@/components/p3-partner/fields";
import { Phase3Disabled } from "@/components/p3-partner/phase3-disabled";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTanggal } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as p3 from "@/server/modules/p3-partner";

import { phase3Enabled } from "../_data";
import { closeAuditAction, conductAuditAction, recordLabTestAction, scheduleAuditAction } from "../actions";

export const metadata: Metadata = { title: "Mutu & audit mitra" };

const AUDIT_ITEMS = [
  { key: "kebersihan", label: "Kebersihan area" },
  { key: "pencucian", label: "Pencucian galon" },
  { key: "sterilisasi", label: "Sterilisasi" },
  { key: "peralatan", label: "Peralatan & tandon" },
  { key: "administrasi", label: "Administrasi & penanganan uang" },
];

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("id-ID", { maximumFractionDigits: 1 }));

/**
 * Mutu outlet mitra (US-P3-05): kepatuhan daftar periksa harian POS, audit pembina terjadwal (skor, temuan, tenggat
 * tindak lanjut), uji air lab (sertifikat, tindakan bila tidak lulus), skor mutu bulanan berbobot (< PAR-80 → teguran).
 */
export default async function QualityPage({ searchParams }: { searchParams: Promise<{ bulan?: string }> }) {
  const sp = await searchParams;
  const { ctx } = await requirePermission(["p3.quality_checklist.read", "p3.partner_score.read"]);
  if (!(await phase3Enabled())) {
    return (
      <div className="grid gap-6">
        <PageHeader title="Mutu & audit mitra" />
        <Phase3Disabled what="Mutu & audit outlet mitra" />
      </div>
    );
  }
  const board = await p3.qualityBoard(ctx, { month: sp.bulan ?? null });
  const outletOpts = board.outlets.map((o) => ({ value: o.outletId, label: `${o.tenantName} — ${o.outletName}` }));
  const canAudit = can(ctx, "p3.partner_audit.create");
  const canTest = can(ctx, "p3.partner_quality_test.create");

  return (
    <div className="grid gap-6">
      <PageHeader title="Mutu & audit mitra" description="Skor mutu bulanan = gabungan daftar periksa, audit, uji air (bobot ditetapkan pemilik). Skor di bawah ambang memicu teguran." actions={<ExportButtons excelHref={`/api/export/p3.quality_scores?format=xlsx&month=${board.month}`} pdfHref={`/api/export/p3.quality_scores?format=pdf&month=${board.month}`} />} />
      <MonthFilter month={board.month} />
      <SectionCard title={`Skor mutu per outlet — ${board.month}`}>
        {board.outlets.length === 0 ? (
          <EmptyState title="Belum ada outlet mitra" compact />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-skor-mutu">
              <TableHeader>
                <TableRow>
                  <TableHead>Outlet</TableHead>
                  <TableHead className="text-right">Daftar periksa (hari)</TableHead>
                  <TableHead className="text-right">Kepatuhan</TableHead>
                  <TableHead className="text-right">Lulus semua</TableHead>
                  <TableHead className="text-right">Audit</TableHead>
                  <TableHead className="text-right">Uji air</TableHead>
                  <TableHead className="text-right">Skor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {board.outlets.map((o) => {
                  const s = o.score ?? null;
                  const total = s ? s.totalScore : o.live.totalScore;
                  const below = s ? s.belowThreshold : o.live.belowThreshold;
                  return (
                    <TableRow key={o.outletId}>
                      <TableCell>
                        {o.outletName}
                        <div className="text-xs text-muted-foreground">{o.tenantName}</div>
                      </TableCell>
                      <TableCell className="text-right">
                        {o.compliance.filledDays}/{o.compliance.operatingDays}
                      </TableCell>
                      <TableCell className="text-right">{o.compliance.compliancePct !== null ? `${fmt(o.compliance.compliancePct)}%` : "—"}</TableCell>
                      <TableCell className="text-right">{o.compliance.passRatePct !== null ? `${fmt(o.compliance.passRatePct)}%` : "—"}</TableCell>
                      <TableCell className="text-right">{fmt(s?.auditScore ?? o.live.auditScore)}</TableCell>
                      <TableCell className="text-right">{fmt(s?.testScore ?? o.live.testScore)}</TableCell>
                      <TableCell className="text-right">
                        {total === null ? "—" : <ToneBadge tone={below ? "danger" : "success"}>{fmt(total)}</ToneBadge>}
                        <div className="text-xs text-muted-foreground">{s ? "final" : `sementara · ambang ${o.live.threshold}`}</div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Audit pembina">
        {board.audits.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada audit terjadwal. Jadwal dibuat otomatis tiap PAR interval, atau jadwalkan manual di bawah.</p>
        ) : (
          <ul className="grid gap-3" data-testid="daftar-audit">
            {board.audits.map((a) => (
              <li key={a.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{a.outletName}</span> · dijadwalkan {formatTanggal(a.scheduledDate)} <StatusBadge enumName="partner_audit_status" value={a.status} />
                  {a.score !== null ? <ToneBadge tone="info">skor {fmt(a.score)}</ToneBadge> : null}
                  {a.followUpDueDate && !a.followUpDoneAt ? <ToneBadge tone="warning">tindak lanjut s.d. {formatTanggal(a.followUpDueDate)}</ToneBadge> : null}
                </div>
                {Array.isArray(a.findings) && a.findings.length ? (
                  <ul className="mt-1 list-inside list-disc text-muted-foreground">
                    {a.findings.map((f, i) => (
                      <li key={i}>{String((f as { text?: string }).text ?? "")}</li>
                    ))}
                  </ul>
                ) : null}
                {canAudit && a.status === "scheduled" ? (
                  <P3ActionForm action={conductAuditAction.bind(null, a.id)} submitLabel="Simpan lembar audit" className="mt-2 max-w-3xl" testId="form-audit">
                    <div className="grid gap-3 sm:grid-cols-5">
                      {AUDIT_ITEMS.map((it) => (
                        <div key={it.key}>
                          <input type="hidden" name={`label_${it.key}`} value={it.label} />
                          <Field label={`${it.label} (0–100)`} name={`score_${it.key}`} inputMode="numeric" required />
                        </div>
                      ))}
                    </div>
                    <TextAreaField label="Temuan (satu per baris)" name="findings" rows={3} />
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Tenggat tindak lanjut" name="followUpDueDate" type="date" hint="Kosong = aturan bawaan" />
                      <Field label="Catatan" name="notes" />
                    </div>
                    <FileField label="Foto audit (opsional)" name="photo" />
                  </P3ActionForm>
                ) : null}
                {canAudit && (a.status === "findings" || a.status === "follow_up") ? (
                  <P3ActionForm action={closeAuditAction.bind(null, a.id)} submitLabel="Catat tindak lanjut selesai" variant="outline" className="mt-2 max-w-2xl">
                    <Field label="Catatan tindak lanjut" name="note" required />
                  </P3ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canAudit && outletOpts.length ? (
          <P3ActionForm action={scheduleAuditAction} submitLabel="Jadwalkan audit" className="mt-4 max-w-2xl" testId="form-jadwal-audit">
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField label="Outlet" name="outletId" required options={outletOpts} />
              <Field label="Tanggal" name="scheduledDate" type="date" required />
            </div>
          </P3ActionForm>
        ) : null}
      </SectionCard>

      <SectionCard title="Uji air laboratorium">
        {board.tests.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada hasil uji air outlet mitra.</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {board.tests.map((t) => (
              <li key={t.id}>
                {formatTanggal(t.testDate)} · {board.outlets.find((o) => o.outletId === t.outletId)?.outletName ?? "-"} · {t.laboratory ?? "-"} · {t.passed ? <ToneBadge tone="success">lulus</ToneBadge> : <ToneBadge tone="danger">tidak lulus</ToneBadge>}
                {t.actionRequired ? ` · tindakan: ${t.actionRequired}${t.actionDueDate ? ` (s.d. ${formatTanggal(t.actionDueDate)})` : ""}` : ""}
                {t.certificateAttachmentId ? (
                  <>
                    {" · "}
                    <a href={`/kemitraan/lampiran/${t.certificateAttachmentId}`} className="text-primary hover:underline" target="_blank" rel="noreferrer">
                      sertifikat
                    </a>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canTest && outletOpts.length ? (
          <P3ActionForm action={recordLabTestAction} submitLabel="Catat hasil uji" className="mt-4 max-w-3xl" testId="form-uji-air">
            <div className="grid gap-3 sm:grid-cols-3">
              <SelectField label="Outlet" name="outletId" required options={outletOpts} />
              <Field label="Tanggal uji" name="testDate" type="date" required />
              <Field label="Laboratorium" name="laboratory" required />
              <Field label="Parameter" name="parameter" defaultValue="Mikrobiologi (E. coli)" />
              <Field label="Hasil" name="value" required />
              <Field label="Batas" name="limit" />
            </div>
            <CheckField label="Lulus" name="passed" />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Tindakan bila tidak lulus" name="actionDescription" />
              <Field label="Tenggat tindakan" name="actionDueDate" type="date" />
            </div>
            <FileField label="Sertifikat hasil uji (foto/PDF)" name="certificate" required />
          </P3ActionForm>
        ) : null}
      </SectionCard>

      <SectionCard title="Daftar periksa harian terbaru (diisi operator di POS mitra)">
        {board.checklists.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada daftar periksa.</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {board.checklists.slice(0, 30).map((c) => (
              <li key={c.id}>
                {formatTanggal(c.businessDate)} · {board.outlets.find((o) => o.outletId === c.outletId)?.outletName ?? "-"} · {c.passedAll ? <ToneBadge tone="success">semua lulus</ToneBadge> : <ToneBadge tone="danger">ada butir gagal</ToneBadge>}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
