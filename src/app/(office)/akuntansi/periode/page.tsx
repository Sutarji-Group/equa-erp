import type { Metadata } from "next";
import Link from "next/link";

import { PeriodStatusBadge, exportHref, periodLabel } from "@/components/m11-accounting/ui";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import * as m11 from "@/server/modules/m11-accounting";

export const metadata: Metadata = { title: "Periode akuntansi" };

/**
 * Periode akuntansi (US-M11-10): Admin Keuangan menutup (≤ tanggal 10 bulan berikutnya, BR-32), pemilik mengunci &
 * dapat membuka kembali dengan alasan. Rincian periode menampilkan prasyarat dengan tautan tindakannya.
 */
export default async function PeriodsPage() {
  const { ctx } = await requirePermission("m11.period.read");
  const rows = await m11.listPeriods(ctx);

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Periode akuntansi"
        description="Tutup periode paling lambat tanggal 10 bulan berikutnya (pengingat tanggal 5 & 8). Periode Dikunci menolak semua posting; koreksi lewat periode terbuka berikutnya dengan rujukan periode asal."
        actions={<ExportButtons excelHref={exportHref("m11.periods", "xlsx")} pdfHref={exportHref("m11.periods", "pdf")} />}
      />
      <SectionCard flush>
        <div className="overflow-x-auto">
          <Table data-testid="tabel-periode">
            <TableHeader>
              <TableRow>
                <TableHead>Periode</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Revisi</TableHead>
                <TableHead>Ditutup</TableHead>
                <TableHead>Dikunci</TableHead>
                <TableHead>Catatan</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p.period}>
                  <TableCell>
                    <Link href={`/akuntansi/periode/${p.id ?? p.period}`} className="font-medium text-primary hover:underline">
                      {periodLabel(p.period)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <PeriodStatusBadge status={p.status} late={p.closedLate} />
                  </TableCell>
                  <TableCell>{p.revision > 1 ? `Revisi ${p.revision}` : "—"}</TableCell>
                  <TableCell className="text-sm">{p.closedAt ? formatTanggalJam(p.closedAt) : "—"}</TableCell>
                  <TableCell className="text-sm">{p.lockedAt ? formatTanggalJam(p.lockedAt) : "—"}</TableCell>
                  <TableCell className="space-x-1">
                    {p.isRetroactive ? <ToneBadge tone="info">Retroaktif</ToneBadge> : null}
                    {p.accountantReviewNote ? <ToneBadge tone="success">Ditinjau akuntan</ToneBadge> : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
    </div>
  );
}
