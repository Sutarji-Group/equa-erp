import type { Metadata } from "next";
import Link from "next/link";

import { FilterForm, FilterInput, ScrollTable, hrefWith } from "@/components/m9-reports/fields";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label, type ProfitCenter } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { toUserMessage } from "@/server/core/errors";
import { can } from "@/server/core/rbac";
import * as m9 from "@/server/modules/m9-reports";

export const metadata: Metadata = { title: "Laba kotor bulanan" };

const PCS: ProfitCenter[] = ["L1", "L2", "L3", "L4", "L5", "SHARED"];
const pct = (v: number | null) => (v === null ? "—" : `${v.toLocaleString("id-ID", { maximumFractionDigits: 2 })}%`);
const isMonth = (v: string | undefined): v is string => !!v && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/**
 * Laporan bulanan laba kotor per lini & konsolidasi (US-M9-02): Sementara → Final setelah periode Dikunci (BR-32),
 * eliminasi transfer internal (BR-33), pembanding bulan lalu & tahun lalu, turun ke akun & transaksi sumber, biaya
 * produksi air per liter (PTB-39), omzet bruto & pemantauan PKP (BR-29/30). Ekspor Final identik (US-M9-03 KP-4).
 */
export default async function MonthlyPage({ searchParams }: { searchParams: Promise<{ bulan?: string; lini?: string; akun?: string }> }) {
  const { ctx } = await requirePermission("m9.monthly_report.read");
  const sp = await searchParams;
  const today = ctxBusinessDate(ctx);
  const month = isMonth(sp.bulan) ? sp.bulan : m9.shiftMonth(today.slice(0, 7), -1);
  const lini = PCS.includes(sp.lini as ProfitCenter) ? (sp.lini as ProfitCenter) : null;
  let r: m9.MonthlyGrossProfit | null = null;
  let loadError: string | null = null;
  try {
    r = await m9.getMonthlyReport(ctx, { month });
  } catch (error) {
    loadError = toUserMessage(error);
  }
  if (loadError !== null || !r) {
    return (
      <div className="grid gap-4">
        <PageHeader title="Laba kotor bulanan" />
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {loadError}
        </p>
      </div>
    );
  }
  const drill = lini || sp.akun ? await m9.monthlyDrilldown(ctx, { month, profitCenter: lini, accountId: sp.akun ?? null }) : null;
  const canExport = can(ctx, "m9.report.export");
  const exportHref = (format: string) => hrefWith("/laporan/bulanan/ekspor", { bulan: month, format });
  const final = r.status === "final";

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6" data-testid="monthly-page">
      <PageHeader
        title="Laba kotor bulanan"
        description={`Per lini L1–L5 dan konsolidasi — ${month}`}
        actions={canExport ? <ExportButtons excelHref={exportHref("xlsx")} pdfHref={exportHref("pdf")} /> : null}
      />
      <FilterForm action="/laporan/bulanan" testId="monthly-filter">
        <FilterInput type="month" name="bulan" value={month} label="Bulan" max={today.slice(0, 7)} />
      </FilterForm>

      <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-4 py-3 text-sm ${final ? "bg-card" : "border-dashed border-warning bg-warning/10"}`} data-testid="monthly-status" data-status={r.status}>
        <ToneBadge tone={final ? "success" : "warning"} dot>
          {r.statusLabel}
        </ToneBadge>
        <span>{r.statusNote}</span>
        <span className="text-muted-foreground">Periode: {r.periodStatusLabel}</span>
        {r.final ? <span className="text-muted-foreground">Versi Final r{r.final.revision} · {formatTanggalJam(r.final.generatedAt)}</span> : null}
        <span className={r.availability.late ? "font-medium text-destructive" : "text-muted-foreground"}>
          Tersedia paling lambat {formatTanggal(r.availability.deadline)} (KPI-09){r.availability.late ? " — terlambat" : ""}
        </span>
      </div>
      {r.incompleteNote ? (
        <p role="note" className="rounded-md border border-warning bg-warning/10 px-3 py-2 text-sm" data-testid="monthly-incomplete">
          {r.incompleteNote}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Omzet gabungan" value={<MoneyText value={r.consolidated.revenue} />} hint={`Dieliminasi ${formatRupiah(r.consolidated.eliminatedRevenue)} transfer internal`} />
        <KpiTile label="Harga pokok/biaya langsung" value={<MoneyText value={r.consolidated.directCost} />} />
        <KpiTile label="Laba kotor gabungan" value={<MoneyText value={r.consolidated.grossProfit} />} tone={r.consolidated.grossProfit >= 0 ? "success" : "danger"} hint={`Marjin ${pct(r.consolidated.marginPct)}`} />
        <KpiTile label="Beban operasional (info)" value={<MoneyText value={r.consolidated.operatingExpense} />} />
      </div>

      <SectionCard title="Per lini" description="Ketuk lini untuk turun ke akun, lalu ke jurnal & transaksi sumbernya." flush>
        <ScrollTable testId="monthly-lines">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lini</TableHead>
                <TableHead className="text-right">Omzet</TableHead>
                <TableHead className="text-right">Biaya langsung</TableHead>
                <TableHead className="text-right">Laba kotor</TableHead>
                <TableHead className="text-right">Marjin</TableHead>
                <TableHead className="text-right">Transfer internal</TableHead>
                <TableHead className="text-right">Beban operasional</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.lines.map((l) => (
                <TableRow key={l.profitCenter} data-active={lini === l.profitCenter ? "true" : undefined} className={lini === l.profitCenter ? "bg-accent/40" : undefined}>
                  <TableCell>
                    <Link href={hrefWith("/laporan/bulanan", { bulan: month, lini: l.profitCenter })} className="font-medium text-primary hover:underline">
                      {l.label}
                    </Link>
                    {l.profitCenter === "L5" && !l.revenue ? <span className="block text-xs text-muted-foreground">Kosong sampai Tahap 3</span> : null}
                  </TableCell>
                  <TableCell className="text-right">{formatRupiah(l.revenue)}</TableCell>
                  <TableCell className="text-right">{formatRupiah(l.directCost)}</TableCell>
                  <TableCell className={`text-right font-medium ${l.grossProfit < 0 ? "text-destructive" : ""}`}>{formatRupiah(l.grossProfit)}</TableCell>
                  <TableCell className="text-right">{pct(l.marginPct)}</TableCell>
                  <TableCell className="text-right">{l.internalRevenue || l.internalCost ? formatRupiah(l.internalRevenue - l.internalCost, { signed: true }) : "—"}</TableCell>
                  <TableCell className="text-right">{formatRupiah(l.operatingExpense)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell>Eliminasi transfer internal (BR-33)</TableCell>
                <TableCell className="text-right">{formatRupiah(-r.consolidated.eliminatedRevenue)}</TableCell>
                <TableCell className="text-right">{formatRupiah(-r.consolidated.eliminatedCost)}</TableCell>
                <TableCell className="text-right">{formatRupiah(-(r.consolidated.eliminatedRevenue - r.consolidated.eliminatedCost))}</TableCell>
                <TableCell colSpan={3} />
              </TableRow>
              <TableRow>
                <TableCell className="font-semibold">Konsolidasi</TableCell>
                <TableCell className="text-right font-semibold">{formatRupiah(r.consolidated.revenue)}</TableCell>
                <TableCell className="text-right font-semibold">{formatRupiah(r.consolidated.directCost)}</TableCell>
                <TableCell className="text-right font-semibold">{formatRupiah(r.consolidated.grossProfit)}</TableCell>
                <TableCell className="text-right font-semibold">{pct(r.consolidated.marginPct)}</TableCell>
                <TableCell />
                <TableCell className="text-right">{formatRupiah(r.consolidated.operatingExpense)}</TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </ScrollTable>
      </SectionCard>

      {drill ? (
        <SectionCard
          title={`Rincian ${drill.profitCenter ? label("profit_center", drill.profitCenter) : "semua lini"}`}
          actions={
            <Link href={hrefWith("/laporan/bulanan", { bulan: month })} className="text-sm font-medium text-primary hover:underline">
              Tutup rincian
            </Link>
          }
          flush
        >
          <ScrollTable testId="monthly-accounts">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Akun</TableHead>
                  <TableHead>Golongan</TableHead>
                  <TableHead className="text-right">Nilai</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drill.accounts.length ? (
                  drill.accounts.map((a) => (
                    <TableRow key={a.accountId} className={sp.akun === a.accountId ? "bg-accent/40" : undefined}>
                      <TableCell>
                        <Link href={hrefWith("/laporan/bulanan", { bulan: month, lini: drill.profitCenter, akun: a.accountId })} className="font-medium text-primary hover:underline">
                          {a.code} {a.name}
                        </Link>
                        {a.internal ? <span className="block text-xs text-muted-foreground">Transfer internal — dieliminasi pada konsolidasi</span> : null}
                      </TableCell>
                      <TableCell>{a.cls === "revenue" ? "Pendapatan" : a.cls === "direct" ? "Biaya langsung" : "Beban operasional"}</TableCell>
                      <TableCell className="text-right">{formatRupiah(a.amount)}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">
                      {r.source === "operational" ? "Rincian akun tersedia setelah M11 aktif." : "Belum ada jurnal terposting untuk lini ini."}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </ScrollTable>
          {drill.journals.length ? (
            <ScrollTable testId="monthly-journals">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Jurnal</TableHead>
                    <TableHead>Tanggal</TableHead>
                    <TableHead>Keterangan</TableHead>
                    <TableHead>Transaksi sumber</TableHead>
                    <TableHead className="text-right">Nilai</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {drill.journals.map((j) => (
                    <TableRow key={j.journalId}>
                      <TableCell className="font-medium">
                        {j.number}
                        <span className="block text-xs text-muted-foreground">{j.kindLabel}</span>
                      </TableCell>
                      <TableCell>
                        {formatTanggal(j.date)}
                        {j.originPeriod ? <span className="block text-xs text-muted-foreground">Asal periode {j.originPeriod}</span> : null}
                      </TableCell>
                      <TableCell className="max-w-64 whitespace-normal">{j.description}</TableCell>
                      <TableCell>
                        {j.sourceHref ? (
                          <Link href={j.sourceHref} className="text-primary hover:underline">
                            {j.sourceRef ?? "Buka"}
                          </Link>
                        ) : (
                          (j.sourceRef ?? "—")
                        )}
                      </TableCell>
                      <TableCell className="text-right">{formatRupiah(j.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollTable>
          ) : null}
        </SectionCard>
      ) : null}

      <SectionCard title="Pembanding" description="Bulan sebelumnya dan bulan yang sama tahun lalu (setelah datanya ada).">
        <div className="grid gap-3 sm:grid-cols-2" data-testid="monthly-comparison">
          {[
            { key: "prev", title: "Bulan sebelumnya", row: r.comparison.previous },
            { key: "ly", title: "Tahun lalu", row: r.comparison.lastYear },
          ].map(({ key, title, row }) => (
            <div key={key} className="rounded-lg border p-3 text-sm">
              <p className="font-medium">
                {title}
                {row ? ` (${row.month})` : ""}
              </p>
              {row ? (
                <dl className="mt-2 grid grid-cols-2 gap-1">
                  <dt className="text-muted-foreground">Omzet</dt>
                  <dd className="text-right">{formatRupiah(row.revenue)}</dd>
                  <dt className="text-muted-foreground">Laba kotor</dt>
                  <dd className="text-right">{formatRupiah(row.grossProfit)}</dd>
                  <dt className="text-muted-foreground">Marjin</dt>
                  <dd className="text-right">{pct(row.marginPct)}</dd>
                </dl>
              ) : (
                <p className="mt-2 text-muted-foreground">Belum ada data.</p>
              )}
            </div>
          ))}
        </div>
      </SectionCard>

      <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-2">
        <SectionCard title="Biaya produksi air per liter (L1)" description="Total biaya L1 ÷ liter pengisian truk (M8), per sumber dan gabungan — dasar keputusan kapasitas & harga mitra." flush>
          <div id="biaya-air" className="min-w-0">
            <ScrollTable testId="monthly-water-cost">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Sumber</TableHead>
                    <TableHead className="text-right">Biaya L1</TableHead>
                    <TableHead className="text-right">Liter</TableHead>
                    <TableHead className="text-right">Rp/liter</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...r.waterCost.perSource, r.waterCost.combined].map((w) => (
                    <TableRow key={w.code}>
                      <TableCell className={w.sourceId ? "" : "font-semibold"}>
                        {w.code} {w.name}
                      </TableCell>
                      <TableCell className="text-right">{formatRupiah(w.cost)}</TableCell>
                      <TableCell className="text-right">{w.liters.toLocaleString("id-ID")}</TableCell>
                      <TableCell className="text-right">{w.costPerLiter === null ? "—" : w.costPerLiter.toLocaleString("id-ID", { maximumFractionDigits: 2 })}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollTable>
            <p className="px-4 pt-3 text-xs font-medium">Tren bulanan (gabungan)</p>
            <ScrollTable>
              <Table>
                <TableBody>
                  {r.waterCostTrend.map((t) => (
                    <TableRow key={t.month}>
                      <TableCell>{t.month}</TableCell>
                      <TableCell className="text-right">{formatRupiah(t.cost)}</TableCell>
                      <TableCell className="text-right">{t.liters.toLocaleString("id-ID")} L</TableCell>
                      <TableCell className="text-right">{t.costPerLiter === null ? "—" : `Rp ${t.costPerLiter.toLocaleString("id-ID", { maximumFractionDigits: 2 })}/L`}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollTable>
          </div>
        </SectionCard>

        <SectionCard title="Omzet bruto & pemantauan PKP" description="Untuk konsultan pajak (BR-29, BR-30).">
          <div id="pkp" className="grid gap-3 text-sm" data-testid="monthly-pkp">
            <dl className="grid grid-cols-2 gap-1">
              {(["L1", "L2", "L3", "L4", "L5"] as const).map((pc) => (
                <div key={pc} className="contents">
                  <dt className="text-muted-foreground">Omzet bruto {label("profit_center", pc)}</dt>
                  <dd className="text-right">{formatRupiah(r.grossRevenueByLine[pc] ?? 0)}</dd>
                </div>
              ))}
            </dl>
            <p>
              Omzet 12 bulan berjalan ({r.pkp.months.at(-1)} s.d. {r.pkp.months[0]}): <strong>{formatRupiah(r.pkp.twelveMonthRevenue)}</strong> dari batas PKP {formatRupiah(r.pkp.threshold)} ({pct(r.pkp.pct)}).
            </p>
            {r.pkp.reached !== null ? (
              <ToneBadge tone={r.pkp.reached >= 90 ? "danger" : "warning"} dot>
                Mencapai {r.pkp.reached}% batas PKP — siapkan pengukuhan PKP
              </ToneBadge>
            ) : (
              <p className="text-muted-foreground">Di bawah ambang peringatan {r.pkp.levels.join("% / ")}%.</p>
            )}
          </div>
        </SectionCard>
      </div>

      {r.previousFinals.length ? (
        <p className="text-xs text-muted-foreground">
          Versi Final sebelumnya tetap tersimpan: {r.previousFinals.map((f) => `r${f.revision} (${formatTanggalJam(f.generatedAt)})`).join(", ")}. Perubahan setelah Final hanya lewat jurnal periode berikutnya (BR-32).
        </p>
      ) : null}
    </div>
  );
}
