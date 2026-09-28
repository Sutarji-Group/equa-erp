import type { Metadata } from "next";
import Link from "next/link";

import { FilterForm, FilterInput, FilterSelect, Liter, M8Badge, Pct, TabLinks } from "@/components/m8-production/office-ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions } from "@/lib/labels";
import { addDays, formatTanggal, isBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { getDb } from "@/server/core/db";
import * as m8 from "@/server/modules/m8-production";

export const metadata: Metadata = { title: "Neraca air" };

type Search = { dari?: string; sampai?: string; sumber?: string; status?: string; tab?: string; bulan?: string };

function qs(params: Record<string, string | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) u.set(k, v);
  return u.toString();
}

/**
 * Neraca air harian & bulanan per sumber (US-M8-04): produksi − Σ pengisian (termasuk pasokan depot, dikurangi air rit
 * gagal yang kembali) = susut; susut > PAR-18 → investigasi; susut negatif → verifikasi Admin Keuangan. Daftar kerja
 * (produksi bertanda PAR-68, neraca menunggu tindakan, pengisian tanpa rit) + ekspor Excel/PDF.
 */
export default async function NeracaAirPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { ctx } = await requirePermission("m8.water_balance.read");
  const sp = await searchParams;
  const today = ctxBusinessDate(ctx);
  const tab = sp.tab === "bulanan" ? "bulanan" : "harian";
  const to = sp.sampai && isBusinessDate(sp.sampai) ? sp.sampai : today;
  const from = sp.dari && isBusinessDate(sp.dari) ? sp.dari : addDays(to, -6);
  const month = sp.bulan && /^\d{4}-\d{2}$/.test(sp.bulan) ? sp.bulan : today.slice(0, 7);
  const sourceId = sp.sumber || null;
  const sources = await m8.sourceOptions(ctx);
  const rules = await m8.m8Rules(getDb(), today, ctx.tenantId);
  const worklist = await m8.productionWorklist(ctx);
  const sourceOpts = sources.map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }));
  const tabs = [
    { key: "harian", label: "Harian", href: `/produksi/neraca-air?${qs({ dari: from, sampai: to, sumber: sourceId })}` },
    { key: "bulanan", label: "Bulanan", href: `/produksi/neraca-air?${qs({ tab: "bulanan", bulan: month, sumber: sourceId })}` },
  ];

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Neraca air"
        description={`Produksi meter − Σ pengisian truk (termasuk pasokan depot) = susut. Batas susut ${rules.lossMaxPct}% (PAR-18); rata-rata 7 hari & level tandon hanya informasi.`}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile
          label="Produksi perlu verifikasi"
          value={worklist.flaggedProductions.length}
          tone={worklist.flaggedProductions.length ? "warning" : undefined}
          hint={`Menyimpang > ${rules.deviationPct}% dari rata-rata 7 hari (PAR-68)`}
        />
        <KpiTile label="Neraca menunggu tindakan" value={worklist.balances.length} tone={worklist.balances.length ? "danger" : undefined} hint="Susut di atas ambang, investigasi, susut negatif" />
        <KpiTile label="Pengisian tanpa rit" value={worklist.fillIssues} tone={worklist.fillIssues ? "warning" : undefined} href="/produksi/pengisian?tab=semua" hrefLabel="Lihat pengisian" />
      </div>

      {worklist.flaggedProductions.length || worklist.balances.length ? (
        <SectionCard title="Daftar kerja" description="Buka rincian untuk memverifikasi produksi, menerima/mengembalikan penjelasan susut, atau memverifikasi susut negatif.">
          <ul className="grid gap-2 text-sm" data-testid="daftar-kerja">
            {worklist.flaggedProductions.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
                <span>
                  Produksi {p.sourceName} {formatTanggal(p.businessDate)}: <Liter value={p.producedL} /> (menyimpang <Pct value={p.deviationPct} danger />)
                </span>
                <Link className="text-primary hover:underline" href={`/produksi/neraca-air/rincian?${qs({ sumber: p.waterSourceId, tanggal: p.businessDate })}`}>
                  Verifikasi
                </Link>
              </li>
            ))}
            {worklist.balances.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
                <span className="flex flex-wrap items-center gap-2">
                  {b.sourceName} {formatTanggal(b.businessDate)} · susut <Liter value={b.lossL} /> (<Pct value={b.lossPct} danger={(b.lossPct ?? 0) > rules.lossMaxPct} />)
                  <M8Badge enumName="water_balance_status" value={b.status} />
                </span>
                <Link className="text-primary hover:underline" href={`/produksi/neraca-air/rincian?${qs({ sumber: b.waterSourceId, tanggal: b.businessDate })}`}>
                  Buka rincian
                </Link>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <TabLinks tabs={tabs} active={tab} testId="tab-neraca" />

      {tab === "harian" ? <DailyTab ctxFrom={from} ctxTo={to} sourceId={sourceId} status={sp.status ?? null} sourceOpts={sourceOpts} lossMaxPct={rules.lossMaxPct} /> : <MonthlyTab month={month} sourceId={sourceId} sourceOpts={sourceOpts} />}
    </div>
  );
}

async function DailyTab({ ctxFrom, ctxTo, sourceId, status, sourceOpts, lossMaxPct }: { ctxFrom: string; ctxTo: string; sourceId: string | null; status: string | null; sourceOpts: { value: string; label: string }[]; lossMaxPct: number }) {
  const { ctx } = await requirePermission("m8.water_balance.read");
  const rows = await m8.listWaterBalances(ctx, { from: ctxFrom, to: ctxTo, sourceId, status });
  const totals = rows.reduce(
    (a, r) => ({ produced: a.produced + (r.isIncomplete ? 0 : (r.producedL ?? 0)), filled: a.filled + r.filledTotalL, loss: a.loss + (r.isIncomplete ? 0 : (r.lossL ?? 0)), over: a.over + (r.status === "over_threshold" || r.status === "investigating" ? 1 : 0) }),
    { produced: 0, filled: 0, loss: 0, over: 0 },
  );
  const exportQs = qs({ from: ctxFrom, to: ctxTo, sourceId });
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <FilterForm action="/produksi/neraca-air">
          <FilterInput label="Dari" name="dari" defaultValue={ctxFrom} />
          <FilterInput label="Sampai" name="sampai" defaultValue={ctxTo} />
          <FilterSelect label="Sumber air" name="sumber" options={sourceOpts} defaultValue={sourceId} allLabel="Semua sumber" />
          <FilterSelect label="Status" name="status" options={enumOptions("water_balance_status")} defaultValue={status} allLabel="Semua status" />
        </FilterForm>
        <ExportButtons excelHref={`/api/export/m8.water_balance_daily?format=xlsx&${exportQs}`} pdfHref={`/api/export/m8.water_balance_daily?format=pdf&${exportQs}`} />
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <KpiTile label="Produksi (hari lengkap)" value={<Liter value={totals.produced} />} />
        <KpiTile label="Σ pengisian" value={<Liter value={totals.filled} />} />
        <KpiTile label="Susut" value={<Liter value={totals.loss} />} hint={totals.produced ? `${((totals.loss / totals.produced) * 100).toLocaleString("id-ID", { maximumFractionDigits: 2 })}% produksi` : undefined} />
        <KpiTile label="Hari susut di atas ambang" value={totals.over} tone={totals.over ? "danger" : undefined} />
      </div>
      <SectionCard title="Neraca harian per sumber" description={`${formatTanggal(ctxFrom)} s.d. ${formatTanggal(ctxTo)}. Klik tanggal untuk rincian pembacaan, pengisian, dan tindakan.`} flush>
        {rows.length === 0 ? (
          <EmptyState title="Belum ada neraca" description="Neraca terbentuk otomatis setelah pembacaan malam (atau cek malam 23.00)." compact />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-neraca">
              <TableHeader>
                <TableRow>
                  <TableHead>Tanggal</TableHead>
                  <TableHead>Sumber</TableHead>
                  <TableHead className="text-right">Produksi</TableHead>
                  <TableHead className="text-right">Pelanggan</TableHead>
                  <TableHead className="text-right">Pasokan depot</TableHead>
                  <TableHead className="text-right">Kembali (rit gagal)</TableHead>
                  <TableHead className="text-right">Susut</TableHead>
                  <TableHead className="text-right">Susut %</TableHead>
                  <TableHead className="text-right">Rata-rata 7 hari</TableHead>
                  <TableHead className="text-right">Utilisasi</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link className="font-medium text-primary hover:underline" href={`/produksi/neraca-air/rincian?${qs({ sumber: r.waterSourceId, tanggal: r.businessDate })}`}>
                        {formatTanggal(r.businessDate)}
                      </Link>
                    </TableCell>
                    <TableCell>{r.sourceName}</TableCell>
                    <TableCell className="text-right">
                      <Liter value={r.producedL} />
                      <span className="block text-xs">
                        <M8Badge enumName="production_status" value={r.productionStatus} />
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={r.filledCustomerL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={r.filledDepotL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={r.returnedL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={r.lossL} className={(r.lossL ?? 0) < 0 ? "text-destructive" : undefined} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Pct value={r.lossPct} danger={(r.lossPct ?? 0) > lossMaxPct || (r.lossPct ?? 0) < 0} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Pct value={r.avgLoss7dPct} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Pct value={r.utilizationPct} />
                    </TableCell>
                    <TableCell>
                      <M8Badge enumName="water_balance_status" value={r.status} />
                      {r.isIncomplete ? <span className="block text-xs text-warning-foreground">belum lengkap</span> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
      <div className="flex flex-wrap gap-2 text-sm">
        <span className="text-muted-foreground">Ekspor lain:</span>
        <a className="text-primary hover:underline" href={`/api/export/m8.daily_production?format=xlsx&${exportQs}`}>
          Produksi harian (Excel)
        </a>
        <a className="text-primary hover:underline" href={`/api/export/m8.meter_readings?format=xlsx&${exportQs}`}>
          Pembacaan meter (Excel)
        </a>
      </div>
    </div>
  );
}

async function MonthlyTab({ month, sourceId, sourceOpts }: { month: string; sourceId: string | null; sourceOpts: { value: string; label: string }[] }) {
  const { ctx } = await requirePermission("m8.water_balance.read");
  const rows = await m8.monthlyWaterBalance(ctx, { month, sourceId });
  const exportQs = qs({ month, sourceId });
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <FilterForm action="/produksi/neraca-air" hidden={{ tab: "bulanan" }}>
          <FilterInput label="Bulan" name="bulan" type="month" defaultValue={month} />
          <FilterSelect label="Sumber air" name="sumber" options={sourceOpts} defaultValue={sourceId} allLabel="Semua sumber" />
        </FilterForm>
        <ExportButtons excelHref={`/api/export/m8.water_balance_monthly?format=xlsx&${exportQs}`} pdfHref={`/api/export/m8.water_balance_monthly?format=pdf&${exportQs}`} />
      </div>
      <SectionCard title={`Neraca bulanan ${month}`} description="Per sumber dan gabungan: produksi, pengisian pelanggan, pasokan depot, susut, rata-rata per hari (US-M8-04 KP-4)." flush>
        {rows.length === 0 ? (
          <EmptyState title="Belum ada data bulan ini" compact />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-neraca-bulanan">
              <TableHeader>
                <TableRow>
                  <TableHead>Sumber</TableHead>
                  <TableHead className="text-right">Hari produksi</TableHead>
                  <TableHead className="text-right">Produksi</TableHead>
                  <TableHead className="text-right">Pengisian pelanggan</TableHead>
                  <TableHead className="text-right">Pasokan depot</TableHead>
                  <TableHead className="text-right">Kembali</TableHead>
                  <TableHead className="text-right">Susut</TableHead>
                  <TableHead className="text-right">Susut %</TableHead>
                  <TableHead className="text-right">Produksi/hari</TableHead>
                  <TableHead className="text-right">Susut/hari</TableHead>
                  <TableHead className="text-right">Selisih pasokan</TableHead>
                  <TableHead className="text-right">Hari belum lengkap / di atas ambang / negatif</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.sourceId ?? "gabungan"} className={r.sourceId ? undefined : "font-semibold"}>
                    <TableCell>{r.sourceName}</TableCell>
                    <TableCell className="text-right">{r.daysWithProduction}</TableCell>
                    <TableCell className="text-right">
                      <Liter value={r.producedL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={r.customerFillsL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={r.depotSupplyL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={r.returnedL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={r.lossL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Pct value={r.lossPct} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={r.avgProducedPerDayL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={r.avgLossPerDayL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={r.supplyDifferenceL} />
                    </TableCell>
                    <TableCell className="text-right">
                      {r.incompleteDays} / {r.overThresholdDays} / {r.negativeDays}
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
