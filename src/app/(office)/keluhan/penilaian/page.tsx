import type { Metadata } from "next";

import { P2OfficeTabs } from "@/components/p2-customer/office-tabs";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import * as p2 from "@/server/modules/p2-customer";

import { p2Tabs } from "../_tabs";

export const metadata: Metadata = { title: "Penilaian layanan" };

function AggTable({ rows, head }: { rows: p2.RatingAggregate[]; head: string }) {
  return rows.length === 0 ? (
    <p className="p-4 text-sm text-muted-foreground">Belum ada penilaian.</p>
  ) : (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{head}</TableHead>
          <TableHead className="text-right">Penilaian</TableHead>
          <TableHead className="text-right">Rata-rata</TableHead>
          <TableHead className="text-right">Nilai ≤ 2</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.key}>
            <TableCell>{r.label}</TableCell>
            <TableCell className="text-right tabular">{r.count}</TableCell>
            <TableCell className="text-right tabular">{r.average.toLocaleString("id-ID")}</TableCell>
            <TableCell className="text-right tabular">{r.lowCount}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * Penilaian layanan (US-P2-06 KP-1): agregat per truk & sopir (masukan kinerja M9, US-M9-05); komentar mentah hanya
 * untuk pemilik & Dispatcher (`p2.rating.read`).
 */
export default async function PenilaianPage({ searchParams }: PageProps<"/keluhan/penilaian">) {
  const { ctx } = await requirePermission("p2.rating.read");
  const sp = await searchParams;
  const r = await p2.ratingOverview(ctx, { month: typeof sp.bulan === "string" ? sp.bulan : null });
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Penilaian layanan"
        description="Nilai 1–5 dari pelanggan setelah pengiriman Selesai (sekali per pengiriman)."
        actions={<ExportButtons excelHref={`/api/export/p2.ratings?format=xlsx&month=${r.month}`} pdfHref={`/api/export/p2.ratings?format=pdf&month=${r.month}`} />}
      />
      <P2OfficeTabs tabs={p2Tabs(ctx)} current="/keluhan/penilaian" />
      <form method="get" className="flex items-end gap-2 text-sm">
        <label className="grid gap-1">
          Bulan
          <input type="month" name="bulan" defaultValue={r.month} className="h-9 rounded-md border border-input bg-transparent px-2" />
        </label>
        <button type="submit" className="h-9 rounded-md border px-3">
          Tampilkan
        </button>
      </form>
      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile label="Jumlah penilaian" value={r.overall.count} />
        <KpiTile label="Rata-rata" value={r.overall.average.toLocaleString("id-ID")} tone={r.overall.average && r.overall.average < 3.5 ? "warning" : "neutral"} />
        <KpiTile label="Komentar" value={r.comments.filter((c) => c.comment).length} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Per truk" flush>
          <AggTable rows={r.trucks} head="Truk" />
        </SectionCard>
        <SectionCard title="Per sopir" flush>
          <AggTable rows={r.drivers} head="Sopir" />
        </SectionCard>
      </div>
      <SectionCard title="Komentar pelanggan" description="Hanya pemilik & Dispatcher." flush actions={<ExportButtons excelHref={`/api/export/p2.rating_comments?format=xlsx&month=${r.month}`} />}>
        {r.comments.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Belum ada komentar bulan ini.</p>
        ) : (
          <Table data-testid="rating-comments">
            <TableHeader>
              <TableRow>
                <TableHead>Waktu</TableHead>
                <TableHead>Pelanggan</TableHead>
                <TableHead>Truk / sopir</TableHead>
                <TableHead className="text-right">Nilai</TableHead>
                <TableHead>Komentar</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.comments.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="whitespace-nowrap">{formatTanggalJam(c.createdAt)}</TableCell>
                  <TableCell>
                    {c.customerName}
                    <span className="block text-xs text-muted-foreground">{c.tripNumber}</span>
                  </TableCell>
                  <TableCell>
                    {c.truck ?? "—"}
                    <span className="block text-xs text-muted-foreground">{c.driverName ?? ""}</span>
                  </TableCell>
                  <TableCell className="text-right">{"★".repeat(c.rating)}</TableCell>
                  <TableCell>{c.comment ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}
