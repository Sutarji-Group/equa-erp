import type { Metadata } from "next";

import { FilterForm, FilterInput, FilterSelect, Liter, Pct } from "@/components/m8-production/office-ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { firstDayOfMonth, formatTanggal, lastDayOfMonth } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { getDb } from "@/server/core/db";
import { can } from "@/server/core/rbac";
import * as m8 from "@/server/modules/m8-production";

export const metadata: Metadata = { title: "Utilisasi kapasitas" };

/**
 * Utilisasi kapasitas sumber air (US-M8-05): harian = Σ pengisian ÷ kapasitas harian (K1); bulanan = rata-rata harian,
 * hari di atas PAR-19, ruang tumbuh (liter/hari & setara rit); per sumber dan gabungan. Ekspor data harian 6 bulan untuk
 * studi kelayakan kapasitas (K22) — pemilik.
 */
export default async function UtilisasiPage({ searchParams }: { searchParams: Promise<{ bulan?: string; sumber?: string }> }) {
  const { ctx } = await requirePermission("m8.utilization.read");
  const sp = await searchParams;
  const today = ctxBusinessDate(ctx);
  const month = sp.bulan && /^\d{4}-\d{2}$/.test(sp.bulan) ? sp.bulan : today.slice(0, 7);
  const sourceId = sp.sumber || null;
  const rules = await m8.m8Rules(getDb(), today, ctx.tenantId);
  const sources = await m8.sourceOptions(ctx);
  const monthly = await m8.utilizationMonthly(ctx, { month, sourceId });
  const from = firstDayOfMonth(`${month}-01`);
  const lastOfMonth = lastDayOfMonth(from);
  const to = lastOfMonth < today ? lastOfMonth : today;
  const daily = to >= from ? (await m8.utilizationDaily(ctx, { from, to, sourceId })).sort((a, b) => b.businessDate.localeCompare(a.businessDate) || a.sourceCode.localeCompare(b.sourceCode)) : [];
  const combined = monthly.find((r) => r.sourceId === null) ?? (monthly.length === 1 ? monthly[0] : undefined);
  const canExport = can(ctx, "m8.utilization.export");
  const range = m8.utilizationExportRange(today, rules.utilizationExportMonths);
  const qsMonth = new URLSearchParams({ month, ...(sourceId ? { sourceId } : {}) }).toString();

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Utilisasi kapasitas"
        description={`Σ pengisian ÷ kapasitas harian sumber. Di atas ${rules.utilizationHighPct}% (PAR-19) ditandai; ${rules.utilizationStreakDays} hari berturut (PAR-85) → notifikasi pemilik.`}
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <FilterForm action="/produksi/utilisasi">
              <FilterInput label="Bulan" name="bulan" type="month" defaultValue={month} />
              <FilterSelect label="Sumber air" name="sumber" options={sources.map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))} defaultValue={sourceId} allLabel="Semua sumber" />
            </FilterForm>
            <ExportButtons excelHref={`/api/export/m8.utilization_monthly?format=xlsx&${qsMonth}`} pdfHref={`/api/export/m8.utilization_monthly?format=pdf&${qsMonth}`} />
          </div>
        }
      />

      {combined ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile label="Rata-rata utilisasi" value={<Pct value={combined.avgUtilizationPct} />} hint={`${combined.sourceName} · ${combined.days} hari`} />
          <KpiTile label="Utilisasi tertinggi" value={<Pct value={combined.maxUtilizationPct} danger={(combined.maxUtilizationPct ?? 0) > rules.utilizationHighPct} />} />
          <KpiTile label={`Hari > ${rules.utilizationHighPct}%`} value={combined.daysAboveThreshold} tone={combined.daysAboveThreshold ? "warning" : undefined} />
          <KpiTile label="Ruang tumbuh" value={<Liter value={combined.growthRoomL} />} hint={`≈ ${combined.growthRoomTrips.toLocaleString("id-ID", { maximumFractionDigits: 1 })} rit/hari`} />
        </div>
      ) : null}

      <SectionCard title={`Utilisasi bulanan ${month}`} description="Ruang tumbuh = kapasitas − rata-rata pengisian harian; setara rit = ÷ volume standar rit (PAR-15)." flush>
        {monthly.length === 0 ? (
          <EmptyState title="Belum ada data" compact />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-utilisasi-bulanan">
              <TableHeader>
                <TableRow>
                  <TableHead>Sumber</TableHead>
                  <TableHead className="text-right">Kapasitas/hari</TableHead>
                  <TableHead className="text-right">Hari</TableHead>
                  <TableHead className="text-right">Σ pengisian</TableHead>
                  <TableHead className="text-right">Rata-rata/hari</TableHead>
                  <TableHead className="text-right">Rata-rata utilisasi</TableHead>
                  <TableHead className="text-right">Tertinggi</TableHead>
                  <TableHead className="text-right">Hari &gt; {rules.utilizationHighPct}%</TableHead>
                  <TableHead className="text-right">Ruang tumbuh</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {monthly.map((r) => (
                  <TableRow key={r.sourceId ?? "gabungan"} className={r.sourceId ? undefined : "font-semibold"}>
                    <TableCell>{r.sourceName}</TableCell>
                    <TableCell className="text-right">
                      <Liter value={r.capacityL} />
                    </TableCell>
                    <TableCell className="text-right">{r.days}</TableCell>
                    <TableCell className="text-right">
                      <Liter value={r.totalFilledL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={r.avgFilledL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Pct value={r.avgUtilizationPct} danger={(r.avgUtilizationPct ?? 0) > rules.utilizationHighPct} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Pct value={r.maxUtilizationPct} />
                    </TableCell>
                    <TableCell className="text-right">{r.daysAboveThreshold}</TableCell>
                    <TableCell className="text-right">
                      <Liter value={r.growthRoomL} /> <span className="text-xs text-muted-foreground">(≈ {r.growthRoomTrips.toLocaleString("id-ID", { maximumFractionDigits: 1 })} rit)</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Utilisasi harian"
        description={`${formatTanggal(from)} s.d. ${formatTanggal(to)}`}
        actions={
          canExport ? (
            <ExportButtons excelHref={`/api/export/m8.utilization_daily?format=xlsx`} className="justify-end" />
          ) : null
        }
        flush
      >
        {canExport ? (
          <p className="px-6 pb-2 text-xs text-muted-foreground" data-testid="info-ekspor-6-bulan">
            Ekspor Excel memuat data harian {rules.utilizationExportMonths} bulan ({formatTanggal(range.from)} s.d. {formatTanggal(range.to)}) per sumber & gabungan dalam satu berkas (K22).
          </p>
        ) : null}
        {daily.length === 0 ? (
          <EmptyState title="Belum ada data" compact />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-utilisasi-harian">
              <TableHeader>
                <TableRow>
                  <TableHead>Tanggal</TableHead>
                  <TableHead>Sumber</TableHead>
                  <TableHead className="text-right">Σ pengisian</TableHead>
                  <TableHead className="text-right">Pelanggan</TableHead>
                  <TableHead className="text-right">Pasokan depot</TableHead>
                  <TableHead className="text-right">Jumlah isi</TableHead>
                  <TableHead className="text-right">Utilisasi</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {daily.map((r) => (
                  <TableRow key={`${r.businessDate}:${r.sourceId ?? "gab"}`} className={r.sourceId ? undefined : "bg-muted/40"}>
                    <TableCell>{formatTanggal(r.businessDate)}</TableCell>
                    <TableCell>{r.sourceName}</TableCell>
                    <TableCell className="text-right">
                      <Liter value={r.filledL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={r.customerL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={r.depotL} />
                    </TableCell>
                    <TableCell className="text-right">{r.fillCount}</TableCell>
                    <TableCell className="text-right">
                      <Pct value={r.utilizationPct} danger={r.high} /> {r.high ? <ToneBadge tone="danger">&gt; {rules.utilizationHighPct}%</ToneBadge> : null}
                    </TableCell>
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
