import type { Metadata } from "next";
import Link from "next/link";

import { ReportActionForm } from "@/components/m9-reports/action-controls";
import { Field, ScrollTable, SelectField, TextareaField, hrefWith } from "@/components/m9-reports/fields";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge, type StatusTone } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatRupiah } from "@/lib/money";
import { addDays, formatTanggal } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { can } from "@/server/core/rbac";
import * as m9 from "@/server/modules/m9-reports";

import { extendParallelAction, recordParallelCheckAction, startParallelAction, withdrawPaperAction } from "../actions";

export const metadata: Metadata = { title: "Periode paralel" };

const TONE: Record<m9.ParallelUnitView["status"], StatusTone> = { running: "info", withdrawn: "success", early_pending: "warning", overdue: "danger" };

/**
 * Periode paralel nota kertas per unit (NFR-35, PRD 11.5; masukan KPI-05 & KPI-11): lembar pencocokan harian (nota
 * kertas vs sistem, selisih terjelaskan/tidak), tanggal nota kertas ditarik; tarik lebih awal dari hari ke-14 hanya
 * bila syarat PAR-84 terpenuhi DAN disetujui pemilik; perpanjangan maks PAR-88 atas keputusan komite pengarah.
 */
export default async function ParallelPage() {
  const { ctx } = await requirePermission("m9.parallel_run.read");
  const today = ctxBusinessDate(ctx);
  const canCreate = can(ctx, "m9.parallel_run.create");
  const [units, checks, options] = await Promise.all([m9.listParallelUnits(ctx), m9.listParallelChecks(ctx, { from: addDays(today, -30), to: today }), m9.parallelUnitOptions(ctx)]);
  const running = units.filter((u) => !u.withdrawnDate);
  const runningOptions = running.map((u) => ({ value: `${u.unitType}:${u.unitId}`, label: u.unitLabel }));
  const canExport = can(ctx, "m9.report.export");

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6" data-testid="parallel-page">
      <PageHeader
        title="Periode paralel"
        description="Nota kertas dan sistem berjalan bersama maksimal 2 minggu per unit; nota kertas ditarik paling lambat hari ke-14."
        actions={canExport ? <ExportButtons excelHref={hrefWith("/api/export/m9.parallel_run_checks", { format: "xlsx", from: addDays(today, -30), to: today })} pdfHref={hrefWith("/api/export/m9.parallel_run_checks", { format: "pdf", from: addDays(today, -30), to: today })} /> : null}
      />

      <SectionCard title="Unit" flush>
        <ScrollTable testId="parallel-units">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Unit</TableHead>
                <TableHead>Mulai</TableHead>
                <TableHead>Hari ke-</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Lembar (cocok / tak terjelaskan)</TableHead>
                <TableHead>Syarat PAR-84</TableHead>
                <TableHead>Nota kertas ditarik</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {units.length ? (
                units.map((u) => (
                  <TableRow key={u.id} data-status={u.status}>
                    <TableCell className="font-medium">{u.unitLabel}</TableCell>
                    <TableCell>{formatTanggal(u.parallelStartDate)}</TableCell>
                    <TableCell>
                      {u.dayNumber} / {u.maxDay}
                      {u.extensionDays ? <span className="block text-xs text-muted-foreground">+{u.extensionDays} hari (komite)</span> : null}
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={TONE[u.status]} dot>
                        {u.statusLabel}
                      </ToneBadge>
                      {u.pendingApprovalId ? (
                        <Link href={`/persetujuan?id=${u.pendingApprovalId}`} className="block text-xs text-primary hover:underline">
                          Lihat persetujuan
                        </Link>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">
                      {u.checks} ({u.matchedDays} / {u.unexplained})
                    </TableCell>
                    <TableCell className="max-w-64 text-xs whitespace-normal">{u.par84 ? (u.par84.met ? "Terpenuhi" : u.par84.reasons.join(" ")) : "—"}</TableCell>
                    <TableCell>
                      {u.withdrawnDate ? formatTanggal(u.withdrawnDate) : "—"}
                      {u.earlyApproved ? <span className="block text-xs text-muted-foreground">Lebih awal, disetujui pemilik</span> : null}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                    Belum ada unit dalam periode paralel.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ScrollTable>
      </SectionCard>

      {canCreate ? (
        <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-2">
          <SectionCard title="Lembar pencocokan harian" description="Jumlah & nilai nota kertas; angka sistem dihitung otomatis dari transaksi unit hari itu.">
            {runningOptions.length ? (
              <ReportActionForm action={recordParallelCheckAction} submitLabel="Simpan lembar" testId="parallel-check-form">
                <SelectField label="Unit" name="unit" options={runningOptions} required />
                <Field label="Tanggal" name="businessDate" type="date" defaultValue={today} max={today} required />
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Jumlah nota kertas" name="paperCount" inputMode="numeric" required />
                  <Field label="Nilai nota kertas (Rp)" name="paperAmount" inputMode="numeric" required />
                </div>
                <SelectField
                  label="Bila ada selisih"
                  name="explained"
                  emptyLabel="Tidak ada selisih"
                  options={[
                    { value: "yes", label: "Terjelaskan" },
                    { value: "no", label: "Tak terjelaskan" },
                  ]}
                />
                <TextareaField label="Penyebab selisih" name="cause" hint="Wajib bila angka nota kertas berbeda dengan sistem." />
              </ReportActionForm>
            ) : (
              <p className="text-sm text-muted-foreground">Mulai periode paralel unit terlebih dahulu.</p>
            )}
          </SectionCard>
          <SectionCard title="Mulai periode paralel unit">
            <ReportActionForm action={startParallelAction} submitLabel="Mulai" testId="parallel-start-form">
              <SelectField label="Unit" name="unit" options={options} emptyLabel="Pilih truk/outlet" required />
              <Field label="Tanggal mulai" name="parallelStartDate" type="date" defaultValue={today} required />
              <TextareaField label="Catatan" name="notes" />
            </ReportActionForm>
          </SectionCard>
        </div>
      ) : null}

      {canCreate && running.length ? (
        <SectionCard title="Tarik nota kertas / perpanjang" description="Sebelum hari ke-14: syarat PAR-84 wajib terpenuhi lalu disetujui pemilik. Perpanjangan hanya atas keputusan komite pengarah (maks PAR-88).">
          <div className="grid gap-4">
            {running.map((u) => (
              <details key={u.id} className="rounded-md border p-3" data-testid="parallel-unit-actions">
                <summary className="cursor-pointer text-sm font-medium">
                  {u.unitLabel} — hari ke-{u.dayNumber}
                </summary>
                <div className="mt-3 grid gap-4 md:grid-cols-2">
                  <ReportActionForm action={withdrawPaperAction.bind(null, u.id)} submitLabel={u.dayNumber < 14 ? "Ajukan tarik lebih awal" : "Catat tarik nota kertas"}>
                    <Field label="Tanggal nota kertas ditarik" name="withdrawnDate" type="date" defaultValue={today} max={today} required />
                    <TextareaField label="Alasan (opsional)" name="reason" />
                  </ReportActionForm>
                  <ReportActionForm action={extendParallelAction.bind(null, u.id)} submitLabel="Perpanjang" variant="outline">
                    <Field label="Tambah hari" name="extensionDays" inputMode="numeric" required />
                    <TextareaField label="Keputusan komite pengarah" name="reason" required />
                  </ReportActionForm>
                </div>
              </details>
            ))}
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title="Lembar pencocokan 30 hari terakhir" flush>
        <ScrollTable testId="parallel-checks">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tanggal</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead className="text-right">Nota / sistem</TableHead>
                <TableHead className="text-right">Nilai nota / sistem</TableHead>
                <TableHead className="text-right">Selisih</TableHead>
                <TableHead>Keterangan</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {checks.length ? (
                checks.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{formatTanggal(c.businessDate)}</TableCell>
                    <TableCell>{c.unitLabel}</TableCell>
                    <TableCell className="text-right">
                      {c.paperCount} / {c.systemCount}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatRupiah(c.paperAmount)} / {formatRupiah(c.systemAmount)}
                    </TableCell>
                    <TableCell className={`text-right ${c.differenceCount || c.differenceAmount ? "font-medium text-destructive" : ""}`}>
                      {c.differenceCount} · {formatRupiah(c.differenceAmount, { signed: true })}
                    </TableCell>
                    <TableCell className="max-w-64 text-xs whitespace-normal">
                      {c.differenceCount || c.differenceAmount ? (c.explained ? "Terjelaskan" : "Tak terjelaskan") : "Cocok"}
                      {c.cause ? ` — ${c.cause}` : ""}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                    Belum ada lembar pencocokan.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ScrollTable>
      </SectionCard>
    </div>
  );
}
