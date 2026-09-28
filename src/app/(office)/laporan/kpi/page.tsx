import type { Metadata } from "next";
import Link from "next/link";

import { ReportActionForm } from "@/components/m9-reports/action-controls";
import { Field, FilterForm, FilterInput, KpiStatusBadge, ScrollTable, TextareaField, hrefWith } from "@/components/m9-reports/fields";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { can } from "@/server/core/rbac";
import * as m9 from "@/server/modules/m9-reports";

import { setOwnerHoursAction } from "../actions";

export const metadata: Metadata = { title: "KPI program" };

const isMonth = (v: string | undefined): v is string => !!v && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
const STATUS_CELL: Record<string, string> = { met: "bg-success/10", not_met: "bg-destructive/10", baseline: "bg-blue-500/10", pending: "bg-warning/15", no_data: "" };

/**
 * Laporan KPI program KPI-01–KPI-11 (US-M9-07): definisi & rumus PRD 1.3, nilai bulan, target BRD 2.3, status, riwayat
 * bulanan sejak pilot; KPI-10 diisi pemilik; KPI-11 dari pengguna aktif + tanggal nota kertas ditarik per unit;
 * ekspor PDF untuk rapat komite pengarah (12.8).
 */
export default async function KpiPage({ searchParams }: { searchParams: Promise<{ bulan?: string }> }) {
  const { ctx } = await requirePermission("m9.kpi.read");
  const sp = await searchParams;
  const today = ctxBusinessDate(ctx);
  const month = isMonth(sp.bulan) && `${sp.bulan}-01` <= today ? sp.bulan : today.slice(0, 7);
  const page = await m9.getKpiReport(ctx, { month });
  const canExport = can(ctx, "m9.report.export");
  const current = page.ownerHours.find((h) => h.month === month);

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6" data-testid="kpi-page">
      <PageHeader
        title="KPI program"
        description={`KPI-01–KPI-11 bulan ${month}${page.current.complete ? "" : " (berjalan)"} — tinjauan komite pengarah bulan 10–12.`}
        actions={canExport ? <ExportButtons excelHref={hrefWith("/api/export/m9.kpi", { format: "xlsx", month })} pdfHref={hrefWith("/api/export/m9.kpi", { format: "pdf", month })} /> : null}
      />
      <FilterForm action="/laporan/kpi">
        <FilterInput type="month" name="bulan" value={month} label="Bulan" max={today.slice(0, 7)} />
      </FilterForm>

      <SectionCard title="Nilai, target, dan status" flush>
        <ScrollTable testId="kpi-current">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>KPI</TableHead>
                <TableHead>Cara ukur (PRD 1.3)</TableHead>
                <TableHead className="text-right">Nilai</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.current.values.map((k) => (
                <TableRow key={k.code} data-kpi={k.code} data-status={k.status}>
                  <TableCell className="min-w-40 whitespace-normal">
                    <span className="font-medium">{k.code}</span> {k.name}
                    <span className="block text-xs text-muted-foreground">Sumber: {k.source}</span>
                  </TableCell>
                  <TableCell className="max-w-96 text-xs whitespace-normal">
                    {k.formula}
                    {k.detail ? <span className="mt-1 block text-muted-foreground">{k.detail}</span> : null}
                  </TableCell>
                  <TableCell className="text-right font-semibold whitespace-nowrap">{k.display}</TableCell>
                  <TableCell className="whitespace-nowrap">{k.target}</TableCell>
                  <TableCell>
                    <KpiStatusBadge status={k.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollTable>
      </SectionCard>

      <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-2">
        {page.canInputOwnerHours ? (
          <SectionCard title="KPI-10 — jam pemilik per minggu" description="Diisi pemilik dari catatannya sendiri (rata-rata per minggu dalam bulan).">
            <ReportActionForm action={setOwnerHoursAction} submitLabel="Simpan jam" testId="kpi10-form" resetOnSuccess={false}>
              <input type="hidden" name="month" value={month} />
              <Field label={`Jam per minggu (${month})`} name="hoursPerWeek" type="text" inputMode="decimal" defaultValue={current ? String(current.value).replace(".", ",") : ""} required hint="Contoh: 6,5" />
              <TextareaField label="Catatan (opsional)" name="note" defaultValue={current?.note ?? ""} />
            </ReportActionForm>
          </SectionCard>
        ) : null}
        <SectionCard title="KPI-11 — nota kertas ditarik per unit" description="Tanggal nota kertas ditarik dicatat manajer proyek / Admin Keuangan pada periode paralel (NFR-35).">
          <p className="text-sm">
            {page.current.values.find((v) => v.code === "KPI-11")?.detail ?? "—"}{" "}
            {can(ctx, "m9.parallel_run.read") ? (
              <Link href="/laporan/periode-paralel" className="font-medium text-primary hover:underline">
                Buka periode paralel
              </Link>
            ) : null}
          </p>
        </SectionCard>
      </div>

      <SectionCard title="Riwayat bulanan" description="Sejak awal pilot (parameter m9.report_rules.pilot_start_date) atau 12 bulan terakhir." flush>
        <ScrollTable testId="kpi-history">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>KPI</TableHead>
                {page.history.map((h) => (
                  <TableHead key={h.month} className="text-right whitespace-nowrap">
                    {h.month}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(page.current.values.length ? page.current.values : (page.history.at(-1)?.values ?? [])).map((k) => (
                <TableRow key={k.code}>
                  <TableCell className="font-medium whitespace-nowrap">{k.code}</TableCell>
                  {page.history.map((h) => {
                    const v = h.values.find((x) => x.code === k.code);
                    return (
                      <TableCell key={h.month} className={`text-right text-xs whitespace-nowrap ${v ? STATUS_CELL[v.status] : ""}`}>
                        {v?.display ?? "—"}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollTable>
      </SectionCard>
    </div>
  );
}
