import type { Metadata } from "next";
import Link from "next/link";

import { MonthFilter } from "@/components/p3-partner/fields";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { getDb } from "@/server/core/db";
import * as p3 from "@/server/modules/p3-partner";

import { monthParam } from "../_data";

export const metadata: Metadata = { title: "Dukungan teknis mitra" };

const STATUS_FILTERS = [
  { value: "", label: "Semua" },
  { value: "submitted", label: "Diajukan" },
  { value: "responded", label: "Ditanggapi" },
  { value: "done", label: "Selesai" },
];

/**
 * Permintaan dukungan teknis mitra (US-P3-11): antrean Diajukan → Ditanggapi → Selesai, waktu tanggap & SLA PAR-76
 * (48 jam), ringkasan kepatuhan SLA per bulan per mitra (masuk laporan bulanan mitra, KP-2).
 */
export default async function SupportPage({ searchParams }: { searchParams: Promise<{ status?: string; bulan?: string }> }) {
  const sp = await searchParams;
  const { ctx } = await requirePermission("p3.support_request.read");
  const month = monthParam(sp.bulan, ctxBusinessDate(ctx));
  const rows = await p3.listSupportRequests(ctx, { status: sp.status ?? null });
  const tenantIds = [...new Set(rows.map((r) => r.tenantId))];
  const summaries = await Promise.all(tenantIds.map(async (id) => ({ tenantId: id, tenantName: rows.find((r) => r.tenantId === id)?.tenantName ?? "-", s: await p3.supportSlaSummary(getDb(), id, month, ctx.now) })));
  const open = rows.filter((r) => r.status === "submitted").length;
  const late = rows.filter((r) => r.slaStatus === "late" || (r.status === "submitted" && r.slaBreached)).length;

  return (
    <div className="grid gap-6">
      <PageHeader title="Dukungan teknis mitra" description="Tanggapi permintaan mitra dalam SLA (PAR-76). Spare part dijual lewat POS toko dengan harga mitra lalu dirujuk dari permintaan." actions={<ExportButtons excelHref="/api/export/p3.support_requests?format=xlsx" pdfHref="/api/export/p3.support_requests?format=pdf" />} />
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile label="Menunggu tanggapan" value={String(open)} tone={open ? "warning" : "neutral"} />
        <KpiTile label="Lewat SLA" value={String(late)} tone={late ? "danger" : "neutral"} />
        <KpiTile label="Total permintaan" value={String(rows.length)} />
      </div>
      <nav className="flex flex-wrap gap-2" aria-label="Saring status">
        {STATUS_FILTERS.map((f) => (
          <Link key={f.value} href={f.value ? `/kemitraan/dukungan?status=${f.value}` : "/kemitraan/dukungan"} className={`rounded-full border px-3 py-1 text-sm ${(sp.status ?? "") === f.value ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}>
            {f.label}
          </Link>
        ))}
      </nav>
      <SectionCard title="Permintaan">
        {rows.length === 0 ? (
          <EmptyState title="Belum ada permintaan dukungan" compact />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-dukungan">
              <TableHeader>
                <TableRow>
                  <TableHead>Diajukan</TableHead>
                  <TableHead>Mitra / outlet</TableHead>
                  <TableHead>Jenis</TableHead>
                  <TableHead>Uraian</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>SLA</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">
                      <Link href={`/kemitraan/dukungan/${r.id}`} className="text-primary hover:underline">
                        {formatTanggalJam(r.submittedAt)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {r.tenantName}
                      <div className="text-xs text-muted-foreground">{r.outletName}</div>
                    </TableCell>
                    <TableCell>{label("support_request_kind", r.kind)}</TableCell>
                    <TableCell className="max-w-xs truncate" title={r.description}>
                      {r.description}
                    </TableCell>
                    <TableCell>
                      <StatusBadge enumName="support_request_status" value={r.status} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge enumName="partner_sla_status" value={r.slaStatus} />
                      {r.responseHours !== null ? <span className="ml-1 text-xs text-muted-foreground">{r.responseHours} jam</span> : r.slaDueAt ? <div className="text-xs text-muted-foreground">batas {formatTanggalJam(r.slaDueAt)}</div> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
      <SectionCard title={`Kepatuhan SLA per mitra — ${month}`} description="Waktu tanggap = Diajukan → Ditanggapi. Ringkasan ini masuk laporan bulanan mitra.">
        <MonthFilter month={month} hidden={{ status: sp.status }} />
        {summaries.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Belum ada data.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mitra</TableHead>
                  <TableHead className="text-right">Permintaan</TableHead>
                  <TableHead className="text-right">Ditanggapi tepat waktu</TableHead>
                  <TableHead className="text-right">Lewat SLA</TableHead>
                  <TableHead className="text-right">Rata-rata tanggap</TableHead>
                  <TableHead className="text-right">Kepatuhan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summaries.map(({ tenantId, tenantName, s }) => (
                  <TableRow key={tenantId}>
                    <TableCell>{tenantName}</TableCell>
                    <TableCell className="text-right">{s.total}</TableCell>
                    <TableCell className="text-right">{s.respondedOnTime}</TableCell>
                    <TableCell className="text-right">{s.late ? <ToneBadge tone="danger">{s.late}</ToneBadge> : 0}</TableCell>
                    <TableCell className="text-right">{s.avgResponseHours !== null ? `${s.avgResponseHours} jam` : "—"}</TableCell>
                    <TableCell className="text-right">{s.compliancePct !== null ? `${s.compliancePct}%` : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
