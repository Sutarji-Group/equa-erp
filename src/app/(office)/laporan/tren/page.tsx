import type { Metadata } from "next";

import { ChangeText, LinkTabs, ScrollTable, hrefWith } from "@/components/m9-reports/fields";
import { TrendCharts } from "@/components/m9-reports/trend-charts";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatRupiah } from "@/lib/money";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m9 from "@/server/modules/m9-reports";

export const metadata: Metadata = { title: "Tren" };

/**
 * Tren mingguan/bulanan 13 periode (US-M9-06): grafik & tabel omzet per lini, rit per truk, galon per depot, piutang
 * (saldo, % lewat tempo) + perubahan terhadap periode sebelumnya. Definisi sama dengan H+0 & laporan bulanan.
 */
export default async function TrendPage({ searchParams }: { searchParams: Promise<{ periode?: string }> }) {
  const { ctx } = await requirePermission("m9.trend.read");
  const sp = await searchParams;
  const granularity = sp.periode === "bulan" ? "month" : "week";
  const r = await m9.getTrend(ctx, { granularity });
  const last = r.points.at(-1);
  const canExport = can(ctx, "m9.report.export");
  const key = granularity === "week" ? "m9.trend_weekly" : "m9.trend_monthly";

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6" data-testid="trend-page">
      <PageHeader
        title="Tren"
        description={`${r.points.length} ${granularity === "week" ? "minggu" : "bulan"} terakhir — perubahan dibanding periode sebelumnya.`}
        actions={canExport ? <ExportButtons excelHref={hrefWith(`/api/export/${key}`, { format: "xlsx" })} pdfHref={hrefWith(`/api/export/${key}`, { format: "pdf" })} /> : null}
      />
      <LinkTabs
        label="Periode"
        active={granularity}
        tabs={[
          { key: "week", label: "Mingguan", href: "/laporan/tren" },
          { key: "month", label: "Bulanan", href: "/laporan/tren?periode=bulan" },
        ]}
      />
      {last ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile label={`Omzet luar (${last.label})`} value={<MoneyText value={last.external} />} hint={<ChangeText value={r.change.external} />} />
          <KpiTile label="Rit selesai" value={last.tripsCompleted} hint={<ChangeText value={r.change.tripsCompleted} />} />
          <KpiTile label="Galon depot" value={last.gallons.toLocaleString("id-ID")} hint={<ChangeText value={r.change.gallons} />} />
          <KpiTile label="Piutang lewat tempo" value={`${last.overduePct.toLocaleString("id-ID")}%`} hint={<ChangeText value={r.change.overduePct} invert />} />
        </div>
      ) : null}
      <TrendCharts points={r.points} />
      <SectionCard title="Tabel tren" flush>
        <ScrollTable testId="trend-table">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{granularity === "week" ? "Minggu mulai" : "Bulan"}</TableHead>
                <TableHead className="text-right">L2</TableHead>
                <TableHead className="text-right">L3</TableHead>
                <TableHead className="text-right">L4</TableHead>
                <TableHead className="text-right">Omzet luar</TableHead>
                <TableHead className="text-right">Internal</TableHead>
                <TableHead className="text-right">Rit</TableHead>
                <TableHead className="text-right">Galon</TableHead>
                <TableHead className="text-right">Saldo piutang</TableHead>
                <TableHead className="text-right">% lewat tempo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.points.map((p) => (
                <TableRow key={p.key}>
                  <TableCell className="font-medium">{p.label}</TableCell>
                  <TableCell className="text-right">{formatRupiah(p.L2)}</TableCell>
                  <TableCell className="text-right">{formatRupiah(p.L3)}</TableCell>
                  <TableCell className="text-right">{formatRupiah(p.L4)}</TableCell>
                  <TableCell className="text-right font-medium">{formatRupiah(p.external)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{formatRupiah(p.internal)}</TableCell>
                  <TableCell className="text-right">
                    {p.tripsCompleted}/{p.tripsScheduled}
                  </TableCell>
                  <TableCell className="text-right">{p.gallons.toLocaleString("id-ID")}</TableCell>
                  <TableCell className="text-right">{formatRupiah(p.receivableBalance)}</TableCell>
                  <TableCell className="text-right">{p.overduePct.toLocaleString("id-ID")}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollTable>
      </SectionCard>
      <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-2">
        <SectionCard title="Rit selesai per truk" flush>
          <ScrollTable>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Truk</TableHead>
                  {r.points.slice(-6).map((p) => (
                    <TableHead key={p.key} className="text-right">
                      {p.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.trucks.map((code) => (
                  <TableRow key={code}>
                    <TableCell className="font-medium">{code}</TableCell>
                    {r.points.slice(-6).map((p) => (
                      <TableCell key={p.key} className="text-right">
                        {p.byTruck[code] ?? 0}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollTable>
        </SectionCard>
        <SectionCard title="Galon per depot" flush>
          <ScrollTable>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Depot</TableHead>
                  {r.points.slice(-6).map((p) => (
                    <TableHead key={p.key} className="text-right">
                      {p.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.depots.map((code) => (
                  <TableRow key={code}>
                    <TableCell className="font-medium">{code}</TableCell>
                    {r.points.slice(-6).map((p) => (
                      <TableCell key={p.key} className="text-right">
                        {(p.byDepot[code] ?? 0).toLocaleString("id-ID")}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollTable>
        </SectionCard>
      </div>
    </div>
  );
}
