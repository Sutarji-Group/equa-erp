import type { Metadata } from "next";
import Link from "next/link";

import { FilterDate, FilterForm, FilterSelect, PiiExportForm, hrefWith } from "@/components/m5-receivables/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions, isEnumValue, type CustomerSegment, type EnumValue } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, isBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m5 from "@/server/modules/m5-receivables";

export const metadata: Metadata = { title: "Umur piutang" };

const BUCKETS = ["not_due", "d1_7", "d8_30", "over_30"] as const;

type Search = { per?: string; segmen?: string; lini?: string };

/**
 * Umur piutang (US-M5-04 KP-1/KP-4; KPI-04): per pelanggan, segmen, dan lini (air truk, toko) — belum jatuh tempo /
 * 1–7 / 8–30 / > 30 hari + belum ditagih; % lewat tempo terhadap total piutang; posisi per tanggal mana pun. Ekspor
 * ber-data pelanggan hanya pemilik/Admin Keuangan dengan tujuan tercatat (BR-39).
 */
export default async function AgingPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { ctx } = await requirePermission("m5.aging.read");
  const sp = await searchParams;
  const asOf = sp.per && isBusinessDate(sp.per) ? sp.per : null;
  const segment = sp.segmen && isEnumValue("customer_segment", sp.segmen) ? (sp.segmen as CustomerSegment) : null;
  const line = sp.lini && isEnumValue("receivable_line", sp.lini) ? (sp.lini as EnumValue<"receivable_line">) : null;
  const r = await m5.agingReport(ctx, { asOf, segment, line });
  const t = r.totals;
  const canExportPii = can(ctx, "m5.aging.export");
  const onTarget = t.overduePct < r.kpi04TargetPercent;

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Umur piutang"
        description={`Posisi per ${formatTanggal(r.asOf)}. Ringkasan dikirim otomatis ke pemilik setiap minggu (PAR-40).`}
        actions={<ExportButtons excelHref={hrefWith("/api/export/m5.aging_groups", { format: "xlsx", asOf: r.asOf })} pdfHref={hrefWith("/api/export/m5.aging_groups", { format: "pdf", asOf: r.asOf })} />}
      />
      <FilterForm action="/piutang/umur" testId="filter-umur">
        <FilterDate name="per" value={r.asOf} label="Posisi per" />
        <FilterSelect name="segmen" value={segment} label="Segmen" emptyLabel="Semua segmen" options={enumOptions("customer_segment")} />
        <FilterSelect name="lini" value={line} label="Lini" emptyLabel="Semua lini" options={enumOptions("receivable_line")} />
      </FilterForm>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Total piutang" value={<MoneyText value={t.total} />} hint={`Belum ditagih ${formatRupiah(t.unbilled)}`} />
        <KpiTile label="Lewat tempo" value={<MoneyText value={t.overdue} />} tone={t.overdue ? "warning" : undefined} />
        <KpiTile label="% lewat tempo (KPI-04)" value={<span data-testid="kpi04">{`${t.overduePct.toLocaleString("id-ID")}%`}</span>} hint={`Sasaran < ${r.kpi04TargetPercent.toLocaleString("id-ID")}%`} tone={onTarget ? "success" : "danger"} />
        <KpiTile label={r.bucketLabels.over_30} value={<MoneyText value={t.over_30} />} tone={t.over_30 ? "danger" : undefined} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {[
          { title: "Per lini", rows: r.byLine, testId: "umur-lini" },
          { title: "Per segmen", rows: r.bySegment, testId: "umur-segmen" },
        ].map((g) => (
          <SectionCard key={g.title} title={g.title} flush>
            {g.rows.length ? (
              <div className="overflow-x-auto">
                <Table data-testid={g.testId}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Kelompok</TableHead>
                      {BUCKETS.map((b) => (
                        <TableHead key={b} className="text-right">
                          {r.bucketLabels[b]}
                        </TableHead>
                      ))}
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {g.rows.map((row) => (
                      <TableRow key={row.key}>
                        <TableCell className="font-medium">{row.label}</TableCell>
                        {BUCKETS.map((b) => (
                          <TableCell key={b} className={`text-right ${b !== "not_due" && row[b] ? "text-destructive" : ""}`}>
                            {row[b] ? formatRupiah(row[b]) : "—"}
                          </TableCell>
                        ))}
                        <TableCell className="text-right font-medium">{formatRupiah(row.total)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <EmptyState title="Tidak ada piutang" compact />
            )}
          </SectionCard>
        ))}
      </div>

      <SectionCard
        title="Per pelanggan"
        description="Pelanggan dalam masa transisi tetap tampil (US-M5-03 KP-5); pelanggan nonaktif tetap tampil sampai lunas atau dihapusbukukan (PTB-28)."
        actions={canExportPii ? <PiiExportForm reportKey="m5.aging" filters={{ asOf: r.asOf, segment: segment ?? undefined, line: line ?? undefined }} testId="ekspor-umur" /> : null}
        flush
      >
        {r.customers.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="umur-pelanggan">
              <TableHeader>
                <TableRow>
                  <TableHead>Pelanggan</TableHead>
                  {BUCKETS.map((b) => (
                    <TableHead key={b} className="text-right">
                      {r.bucketLabels[b]}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">Belum ditagih</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.customers.map((c) => (
                  <TableRow key={c.customerId} className="align-top">
                    <TableCell>
                      <Link href={`/piutang/pelanggan/${c.customerId}`} className="font-medium text-primary hover:underline">
                        {c.name}
                      </Link>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                        {c.code ?? ""} <StatusBadge enumName="credit_status" value={c.creditStatus} />
                        {c.inTransition ? <ToneBadge tone="info">Masa transisi</ToneBadge> : null}
                      </span>
                    </TableCell>
                    {BUCKETS.map((b) => (
                      <TableCell key={b} className={`text-right ${b !== "not_due" && c[b] ? "text-destructive" : ""}`}>
                        {c[b] ? formatRupiah(c[b]) : "—"}
                      </TableCell>
                    ))}
                    <TableCell className="text-right">{c.unbilled ? formatRupiah(c.unbilled) : "—"}</TableCell>
                    <TableCell className="text-right font-medium">{formatRupiah(c.total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Tidak ada piutang untuk saringan ini" compact />
        )}
      </SectionCard>
    </div>
  );
}
