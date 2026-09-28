import type { Metadata } from "next";

import { FilterForm, FilterInput, LinkTabs, ScrollTable, hrefWith } from "@/components/m9-reports/fields";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatRupiah } from "@/lib/money";
import { formatTanggal } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { can } from "@/server/core/rbac";
import * as m9 from "@/server/modules/m9-reports";

export const metadata: Metadata = { title: "Kinerja sopir & depot" };

const isMonth = (v: string | undefined): v is string => !!v && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
const pct = (v: number | null) => (v === null ? "—" : `${v.toLocaleString("id-ID")}%`);

/**
 * Kinerja per sopir/truk dan per depot/operator (US-M9-05) — hanya pemilik. Peringkat hanya antar peran sebanding
 * (sopir–sopir, operator depot–operator depot, kasir toko–kasir toko) dengan zona/rute agar adil; deret hari tanpa
 * selisih sebagai dasar insentif nihil selisih (BR-12).
 */
export default async function PerformancePage({ searchParams }: { searchParams: Promise<{ bulan?: string; tampil?: string }> }) {
  const { ctx } = await requirePermission("m9.performance.read");
  const sp = await searchParams;
  const today = ctxBusinessDate(ctx);
  const month = isMonth(sp.bulan) ? sp.bulan : today.slice(0, 7);
  const view = sp.tampil === "depot" ? "depot" : "sopir";
  const r = await m9.getPerformance(ctx, { month });
  const canExport = can(ctx, "m9.report.export");
  const exportKey = view === "depot" ? "m9.performance_outlets" : "m9.performance_drivers";

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6" data-testid="performance-page">
      <PageHeader
        title="Kinerja sopir & depot"
        description={`${formatTanggal(r.from)} – ${formatTanggal(r.to)} · rit tepat waktu = Selesai dalam ± ${r.onTimeWindowMinutes} menit dari jam diminta`}
        actions={canExport ? <ExportButtons excelHref={hrefWith(`/api/export/${exportKey}`, { format: "xlsx", month })} pdfHref={hrefWith(`/api/export/${exportKey}`, { format: "pdf", month })} /> : null}
      />
      <FilterForm action="/laporan/kinerja">
        <input type="hidden" name="tampil" value={view} />
        <FilterInput type="month" name="bulan" value={month} label="Bulan" max={today.slice(0, 7)} />
      </FilterForm>
      <LinkTabs
        label="Kelompok"
        active={view}
        tabs={[
          { key: "sopir", label: "Sopir & truk", href: hrefWith("/laporan/kinerja", { bulan: month }) },
          { key: "depot", label: "Depot/toko & operator", href: hrefWith("/laporan/kinerja", { bulan: month, tampil: "depot" }) },
        ]}
      />

      {view === "sopir" ? (
        <>
          <SectionCard title="Sopir (peringkat sesama sopir)" description="Urutan: % selesai, % tepat waktu, selisih setoran, setoran terlambat." flush>
            <ScrollTable testId="perf-drivers">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Sopir</TableHead>
                    <TableHead>Zona/rute</TableHead>
                    <TableHead className="text-right">Terjadwal</TableHead>
                    <TableHead className="text-right">Selesai</TableHead>
                    <TableHead>Gagal (alasan)</TableHead>
                    <TableHead className="text-right">Tepat waktu</TableHead>
                    <TableHead className="text-right">Parsial</TableHead>
                    <TableHead className="text-right">Lokasi &gt;200 m / &gt;1 km</TableHead>
                    <TableHead>BR-25</TableHead>
                    <TableHead className="text-right">Selisih setoran</TableHead>
                    <TableHead className="text-right">Setor terlambat</TableHead>
                    <TableHead className="text-right">Jarak</TableHead>
                    <TableHead className="text-right">Pengeluaran rit</TableHead>
                    <TableHead className="text-right">Hari tanpa selisih</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.drivers.length ? (
                    r.drivers.map((d) => (
                      <TableRow key={d.employeeId}>
                        <TableCell>{d.rank}</TableCell>
                        <TableCell className="font-medium">
                          {d.name}
                          <span className="block text-xs text-muted-foreground">{d.truckCodes.join(", ")}</span>
                        </TableCell>
                        <TableCell className="text-xs">{d.zones.join(", ") || "—"}</TableCell>
                        <TableCell className="text-right">{d.scheduled}</TableCell>
                        <TableCell className="text-right">
                          {d.completed} <span className="text-xs text-muted-foreground">({pct(d.completionPct)})</span>
                        </TableCell>
                        <TableCell className="text-xs">
                          {d.failed}
                          {Object.entries(d.failedByReason).map(([k, v]) => (
                            <span key={k} className="block text-muted-foreground">
                              {k}: {v}
                            </span>
                          ))}
                        </TableCell>
                        <TableCell className="text-right">
                          {d.onTime}/{d.onTimeEligible} <span className="text-xs text-muted-foreground">({pct(d.onTimePct)})</span>
                        </TableCell>
                        <TableCell className="text-right">{d.partialVolume}</TableCell>
                        <TableCell className="text-right">
                          {d.deviationOver200m} / {d.deviationOver1km}
                          {d.locationSourceInconsistent ? <span className="block text-xs text-muted-foreground">GPS tak konsisten {d.locationSourceInconsistent}×</span> : null}
                        </TableCell>
                        <TableCell className="max-w-48 text-xs whitespace-normal">
                          {d.br25Events} kejadian, {d.br25Explained} dijelaskan
                          {d.br25Notes.map((note, i) => (
                            <span key={i} className="block text-muted-foreground">
                              “{note}”
                            </span>
                          ))}
                        </TableCell>
                        <TableCell className="text-right">
                          {d.discrepancyCount}× <span className="block text-xs">{formatRupiah(d.discrepancyValue, { signed: true })}</span>
                        </TableCell>
                        <TableCell className="text-right">{d.lateDeposits}</TableCell>
                        <TableCell className="text-right">{d.distanceKm.toLocaleString("id-ID")} km</TableCell>
                        <TableCell className="text-right">{formatRupiah(d.tripExpenses)}</TableCell>
                        <TableCell className="text-right">{d.daysWithoutDiscrepancy ?? "—"}</TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={15} className="text-center text-sm text-muted-foreground">
                        Belum ada rit bersopir pada bulan ini.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </ScrollTable>
          </SectionCard>
          <SectionCard title="Truk" flush>
            <ScrollTable testId="perf-trucks">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Truk</TableHead>
                    <TableHead className="text-right">Terjadwal</TableHead>
                    <TableHead className="text-right">Selesai</TableHead>
                    <TableHead className="text-right">Gagal</TableHead>
                    <TableHead className="text-right">Internal</TableHead>
                    <TableHead className="text-right">% selesai</TableHead>
                    <TableHead className="text-right">Jarak</TableHead>
                    <TableHead className="text-right">Pengeluaran rit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.trucks.map((t) => (
                    <TableRow key={t.truckId}>
                      <TableCell className="font-medium">{t.code}</TableCell>
                      <TableCell className="text-right">{t.scheduled}</TableCell>
                      <TableCell className="text-right">{t.completed}</TableCell>
                      <TableCell className="text-right">{t.failed}</TableCell>
                      <TableCell className="text-right">{t.internalCompleted}</TableCell>
                      <TableCell className="text-right">{pct(t.completionPct)}</TableCell>
                      <TableCell className="text-right">{t.distanceKm.toLocaleString("id-ID")} km</TableCell>
                      <TableCell className="text-right">{formatRupiah(t.tripExpenses)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollTable>
          </SectionCard>
        </>
      ) : (
        <>
          <SectionCard title="Depot & toko" flush>
            <ScrollTable testId="perf-outlets">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Outlet</TableHead>
                    <TableHead className="text-right">Galon/hari</TableHead>
                    <TableHead className="text-right">Transaksi</TableHead>
                    <TableHead className="text-right">Penjualan</TableHead>
                    <TableHead className="text-right">Void</TableHead>
                    <TableHead className="text-right">Selisih kas</TableHead>
                    <TableHead className="text-right">Selisih stok</TableHead>
                    <TableHead className="text-right">Setor terlambat</TableHead>
                    <TableHead className="text-right">Kas &gt; batas</TableHead>
                    <TableHead className="text-right">Pasokan diterima / kelebihan</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.outlets.map((o) => (
                    <TableRow key={o.outletId}>
                      <TableCell className="font-medium">
                        {o.code}
                        <span className="block text-xs text-muted-foreground">{o.name}</span>
                      </TableCell>
                      <TableCell className="text-right">{o.gallonsPerDay.toLocaleString("id-ID")}</TableCell>
                      <TableCell className="text-right">{o.transactions}</TableCell>
                      <TableCell className="text-right">{formatRupiah(o.sales)}</TableCell>
                      <TableCell className="text-right">
                        {o.voidCount}× <span className="block text-xs">{formatRupiah(o.voidValue)}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        {o.cashDifferenceCount}× <span className="block text-xs">{formatRupiah(o.cashDifferenceValue, { signed: true })}</span>
                      </TableCell>
                      <TableCell className="text-right">{o.stockDifferenceCount}</TableCell>
                      <TableCell className="text-right">{o.lateDeposits}</TableCell>
                      <TableCell className="text-right">{o.cashOverLimit}</TableCell>
                      <TableCell className="text-right">
                        {o.supplyReceivedL === null ? "—" : `${o.supplyReceivedL.toLocaleString("id-ID")} L`}
                        {o.waterExcessPct !== null ? <span className="block text-xs">{o.waterExcessPct.toLocaleString("id-ID")}%</span> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollTable>
          </SectionCard>
          <SectionCard title="Operator & kasir (peringkat per kelompok)" description="Urutan: selisih kas, void, setoran terlambat, galon per hari." flush>
            <ScrollTable testId="perf-operators">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Kelompok</TableHead>
                    <TableHead>#</TableHead>
                    <TableHead>Nama</TableHead>
                    <TableHead>Outlet</TableHead>
                    <TableHead className="text-right">Shift</TableHead>
                    <TableHead className="text-right">Galon/hari</TableHead>
                    <TableHead className="text-right">Transaksi</TableHead>
                    <TableHead className="text-right">Void</TableHead>
                    <TableHead className="text-right">Selisih kas</TableHead>
                    <TableHead className="text-right">Selisih stok</TableHead>
                    <TableHead className="text-right">Setor terlambat</TableHead>
                    <TableHead className="text-right">Hari tanpa selisih</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.operators.map((o) => (
                    <TableRow key={o.userId}>
                      <TableCell className="text-xs">{o.groupLabel}</TableCell>
                      <TableCell>{o.rank}</TableCell>
                      <TableCell className="font-medium">{o.name}</TableCell>
                      <TableCell className="text-xs">{o.outlets.join(", ")}</TableCell>
                      <TableCell className="text-right">{o.shifts}</TableCell>
                      <TableCell className="text-right">{o.gallonsPerDay.toLocaleString("id-ID")}</TableCell>
                      <TableCell className="text-right">{o.transactions}</TableCell>
                      <TableCell className="text-right">
                        {o.voidCount}× <span className="block text-xs">{formatRupiah(o.voidValue)}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        {o.cashDifferenceCount}× <span className="block text-xs">{formatRupiah(o.cashDifferenceValue, { signed: true })}</span>
                      </TableCell>
                      <TableCell className="text-right">{o.stockDifferenceCount}</TableCell>
                      <TableCell className="text-right">{o.lateDeposits}</TableCell>
                      <TableCell className="text-right">{o.daysWithoutDiscrepancy ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollTable>
          </SectionCard>
        </>
      )}
      <p className="text-xs text-muted-foreground">Sopir dan operator melihat kinerjanya sendiri di aplikasinya (riwayat setoran & shift).</p>
    </div>
  );
}
