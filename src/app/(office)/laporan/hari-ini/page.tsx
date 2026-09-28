import type { Metadata } from "next";
import Link from "next/link";

import { ReportActionButton, ReportReasonButton } from "@/components/m9-reports/action-controls";
import { FilterForm, FilterInput, LinkTabs, ScrollTable, hrefWith } from "@/components/m9-reports/fields";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { H0Range } from "@/client/m9-reports/types";
import { formatRupiah } from "@/lib/money";
import { formatJam, formatTanggal, formatTanggalJam, isBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { toUserMessage } from "@/server/core/errors";
import { can } from "@/server/core/rbac";
import * as m9 from "@/server/modules/m9-reports";

import { decideDiscrepancyAction, markReviewedAction } from "../actions";

export const metadata: Metadata = { title: "Hari ini (H+0)" };

const RANGES: { key: H0Range; label: string }[] = [
  { key: "today", label: "Hari ini" },
  { key: "yesterday", label: "Kemarin" },
  { key: "last7", label: "7 hari" },
  { key: "month", label: "Bulan berjalan" },
];

const DRILL: Record<string, "truck" | "depot" | "discrepancy" | "receivable"> = { truk: "truck", depot: "depot", selisih: "discrepancy", piutang: "receivable" };

const n = (v: number) => v.toLocaleString("id-ID");

/**
 * Dashboard H+0 (US-M9-01): enam blok (omzet per lini, kas, piutang, rit per truk, galon per depot, pengecualian) untuk
 * hari ini / kemarin / 7 hari / bulan berjalan / tanggal riwayat. Sebelum tutup kas: angka berjalan berlabel "belum
 * ditutup"; sesudahnya: versi terbit terkunci + cap waktu. Setiap angka turun ke rincian di halaman ini (KP-3); selisih
 * disetujui/ditolak di sini (KP-4). Tata letak satu kolom di ponsel; tabel bergulir di dalam kartu (KP-5).
 */
export default async function H0Page({ searchParams }: { searchParams: Promise<{ rentang?: string; tanggal?: string; rinci?: string; id?: string }> }) {
  const { ctx } = await requirePermission("m9.daily_summary.read");
  const sp = await searchParams;
  const range = RANGES.some((r) => r.key === sp.rentang) ? (sp.rentang as H0Range) : undefined;
  const date = sp.tanggal && isBusinessDate(sp.tanggal) ? sp.tanggal : null;
  let dash: m9.DailyDashboard | null = null;
  let loadError: string | null = null;
  try {
    dash = await m9.getDailyDashboard(ctx, date ? { date } : { range });
  } catch (error) {
    loadError = toUserMessage(error);
  }
  if (loadError !== null || !dash) {
    return (
      <div className="grid gap-4">
        <PageHeader title="Hari ini (H+0)" />
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {loadError}
        </p>
        <Link href="/laporan/hari-ini" className="text-sm font-medium text-primary hover:underline">
          Kembali ke hari ini
        </Link>
      </div>
    );
  }
  const d = dash.data;
  const base = { rentang: date ? null : dash.range === "today" ? null : dash.range, tanggal: date };
  const drillHref = (rinci: string, id?: string) => hrefWith("/laporan/hari-ini", { ...base, rinci, id: id ?? null });
  const drillKind = sp.rinci ? DRILL[sp.rinci] : undefined;
  let drill: m9.DrilldownResult | null = null;
  let drillError: string | null = null;
  if (drillKind) {
    try {
      drill = await m9.getDailyDrilldown(ctx, { kind: drillKind, from: dash.from, to: dash.to, id: sp.id ?? null });
    } catch (error) {
      drillError = toUserMessage(error);
    }
  }
  const period = dash.isSingleDay ? formatTanggal(dash.from) : `${formatTanggal(dash.from)} – ${formatTanggal(dash.to)}`;
  const st = dash.status;
  const canExport = can(ctx, "m9.report.export");
  const unclosedText = dash.unclosed ? "Belum ditutup — angka dapat berubah" : undefined;

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6" data-testid="h0-page">
      <PageHeader
        title="Hari ini (H+0)"
        description={period}
        actions={
          canExport ? (
            dash.isSingleDay ? (
              <ExportButtons excelHref={hrefWith("/api/export/m9.daily_summary", { format: "xlsx", date: dash.from })} pdfHref={hrefWith("/api/export/m9.daily_summary", { format: "pdf", date: dash.from })} />
            ) : (
              <ExportButtons excelHref={hrefWith("/api/export/m9.daily_summaries", { format: "xlsx", from: dash.from, to: dash.to })} pdfHref={hrefWith("/api/export/m9.daily_summaries", { format: "pdf", from: dash.from, to: dash.to })} />
            )
          ) : null
        }
      />
      <LinkTabs
        label="Rentang"
        active={date && dash.range === "history" ? "" : dash.range}
        tabs={RANGES.map((r) => ({ key: r.key, label: r.label, href: r.key === "today" ? "/laporan/hari-ini" : `/laporan/hari-ini?rentang=${r.key}` }))}
      />
      <FilterForm action="/laporan/hari-ini" testId="h0-filter">
        <FilterInput name="tanggal" value={date} label="Riwayat per tanggal" max={dash.today} />
      </FilterForm>

      {/* Status terbit (KP-2) */}
      <div
        data-testid="h0-status"
        data-status={st.status}
        className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-4 py-3 text-sm ${dash.unclosed ? "border-dashed border-warning bg-warning/10" : "bg-card"}`}
      >
        <ToneBadge tone={st.status === "running" ? "warning" : st.status === "reviewed" ? "success" : st.status === "mixed" ? "warning" : "info"} dot>
          {st.label}
        </ToneBadge>
        {dash.unclosed ? <span className="font-medium">Belum ditutup — angka dapat berubah</span> : null}
        {dash.isSingleDay && st.publishedAt ? (
          <span>
            Kas ditutup {st.cashClosedAt ? formatJam(st.cashClosedAt) : "—"} · H+0 terbit {formatTanggalJam(st.publishedAt)}
            {st.publishMinutes !== null ? ` (${st.publishMinutes} menit)` : ""}
          </span>
        ) : null}
        {!dash.isSingleDay && st.totalDays ? (
          <span>
            {st.publishedDays} dari {st.totalDays} hari sudah terbit
          </span>
        ) : null}
        {st.publishedLate ? (
          <ToneBadge tone="danger" dot>
            Terbit terlambat
          </ToneBadge>
        ) : null}
        {st.reviewedAt ? <span className="text-muted-foreground">Ditinjau {formatTanggalJam(st.reviewedAt)}</span> : null}
        {dash.isSingleDay && dash.canReview && st.status === "published" ? (
          <span className="ml-auto">
            <ReportActionButton label="Tandai sudah ditinjau" variant="outline" action={markReviewedAction.bind(null, dash.from)} testId="h0-review" />
          </span>
        ) : null}
      </div>

      {drillKind ? (
        <SectionCard
          title={drill?.title ?? "Rincian"}
          actions={
            <Link href={hrefWith("/laporan/hari-ini", base)} className="text-sm font-medium text-primary hover:underline">
              Tutup rincian
            </Link>
          }
          flush
        >
          <div data-testid="h0-drilldown" className="min-w-0">
            {drillError ? <p className="p-4 text-sm text-destructive">{drillError}</p> : drill ? <Drilldown drill={drill} /> : null}
          </div>
        </SectionCard>
      ) : null}

      {/* Blok 1 — Omzet per lini (BR-33) */}
      <section aria-labelledby="blok-omzet" className="grid min-w-0 gap-3" data-testid="h0-revenue">
        <h2 id="blok-omzet" className="text-base font-semibold">
          Omzet per lini
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile label="L2 Air truk" value={<MoneyText value={d.revenue.L2.amount} />} hint={`${n(d.revenue.L2.trips)} rit pelanggan Selesai`} unclosed={unclosedText} href={drillHref("truk", d.trips.byTruck[0]?.truckId)} hrefLabel="Rit per truk" />
          <KpiTile label="L3 Depot" value={<MoneyText value={d.revenue.L3.amount} />} hint={`${n(d.revenue.L3.transactions)} transaksi`} />
          <KpiTile label="L4 Toko" value={<MoneyText value={d.revenue.L4.amount} />} hint={`${n(d.revenue.L4.transactions)} transaksi`} />
          <KpiTile label="Omzet luar (L2+L3+L4)" value={<MoneyText value={d.revenue.external} />} tone="success" hint="Tidak termasuk transfer internal" />
        </div>
        <p className="rounded-md bg-muted px-3 py-2 text-sm" data-testid="h0-internal">
          Transfer internal (terpisah, bukan omzet luar — BR-33): pasokan air truk → depot {formatRupiah(d.revenue.internal.truckToDepot.amount)} ({n(d.revenue.internal.truckToDepot.trips)} rit, {n(d.revenue.internal.truckToDepot.liters)} L)
          {d.revenue.internal.storeToDepot.transfers ? ` · barang toko → depot ${formatRupiah(d.revenue.internal.storeToDepot.amount)} (${n(d.revenue.internal.storeToDepot.transfers)} kiriman)` : ""}
        </p>
      </section>

      <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-2">
        {/* Blok 2 — Kas */}
        <SectionCard title="Kas seharusnya vs diterima" description="Definisi posisi kas M4 (tunai; transfer & QRIS dicocokkan terpisah)." flush>
          <div className="grid gap-3 p-4 sm:grid-cols-3" data-testid="h0-cash">
            <KpiTile label="Seharusnya" value={<MoneyText value={d.cash.expected} />} />
            <KpiTile label="Diterima" value={<MoneyText value={d.cash.received} />} />
            <KpiTile label="Selisih" value={<MoneyText value={d.cash.discrepancy} signed />} tone={d.cash.discrepancy ? "danger" : "success"} href={drillHref("selisih")} hrefLabel="Rincian setoran" />
          </div>
          <ScrollTable>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sumber</TableHead>
                  <TableHead className="text-right">Seharusnya</TableHead>
                  <TableHead className="text-right">Diterima</TableHead>
                  <TableHead className="text-right">Selisih</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.cash.byLine.map((l) => (
                  <TableRow key={l.line}>
                    <TableCell>{l.label}</TableCell>
                    <TableCell className="text-right">{formatRupiah(l.expected)}</TableCell>
                    <TableCell className="text-right">{formatRupiah(l.received)}</TableCell>
                    <TableCell className={`text-right ${l.discrepancy ? "font-medium text-destructive" : ""}`}>{formatRupiah(l.discrepancy, { signed: true })}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollTable>
          <p className="px-4 py-3 text-xs text-muted-foreground">
            Transfer belum dicocokkan {formatRupiah(d.cash.unmatchedTransfers)}
            {d.cash.office.physical !== null ? ` · kas kantor sistem ${formatRupiah(d.cash.office.system ?? 0)} vs fisik ${formatRupiah(d.cash.office.physical)}` : ""}
            {d.cash.kpi02Minutes !== null ? ` · setoran terakhir → tutup kas ${d.cash.kpi02Minutes} menit (KPI-02)` : ""}
          </p>
        </SectionCard>

        {/* Blok 3 — Piutang */}
        <SectionCard title="Piutang" description="Saldo per akhir rentang; KPI-04 = lewat tempo ÷ total piutang terbuka.">
          <div className="grid grid-cols-2 gap-3" data-testid="h0-receivables">
            <KpiTile label="Saldo" value={<MoneyText value={d.receivables.balance} />} href={drillHref("piutang")} hrefLabel="Per pelanggan" />
            <KpiTile label="Lewat tempo (KPI-04)" value={`${d.receivables.overduePct.toLocaleString("id-ID")}%`} tone={d.receivables.overduePct < d.receivables.targetPct ? "success" : "danger"} hint={`${formatRupiah(d.receivables.overdue)} · sasaran < ${d.receivables.targetPct}%`} />
            <KpiTile label="Terbentuk" value={<MoneyText value={d.receivables.formed} />} />
            <KpiTile label="Dilunasi" value={<MoneyText value={d.receivables.paid} />} />
          </div>
        </SectionCard>

        {/* Blok 4 — Rit per truk */}
        <SectionCard title="Rit per truk" description="Terjadwal (terbit) vs Selesai vs Gagal; rit internal pasokan depot dihitung terpisah." flush>
          <ScrollTable testId="h0-trips">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Truk</TableHead>
                  <TableHead className="text-right">Terjadwal</TableHead>
                  <TableHead className="text-right">Selesai</TableHead>
                  <TableHead className="text-right">Gagal</TableHead>
                  <TableHead className="text-right">Berjalan</TableHead>
                  <TableHead className="text-right">Internal</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.trips.byTruck.length ? (
                  d.trips.byTruck.map((t) => (
                    <TableRow key={t.truckId}>
                      <TableCell>
                        <Link href={drillHref("truk", t.truckId)} className="font-medium text-primary hover:underline">
                          {t.truckCode}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right">{t.scheduled}</TableCell>
                      <TableCell className="text-right">{t.completed}</TableCell>
                      <TableCell className={`text-right ${t.failed ? "text-destructive" : ""}`}>{t.failed}</TableCell>
                      <TableCell className="text-right">{t.running}</TableCell>
                      <TableCell className="text-right">
                        {t.internalCompleted}/{t.internalScheduled}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                      Belum ada rit terjadwal.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="font-medium">Total</TableCell>
                  <TableCell className="text-right font-semibold">{d.trips.totals.scheduled}</TableCell>
                  <TableCell className="text-right font-semibold">{d.trips.totals.completed}</TableCell>
                  <TableCell className="text-right font-semibold">{d.trips.totals.failed}</TableCell>
                  <TableCell className="text-right">{d.trips.totals.running}</TableCell>
                  <TableCell className="text-right">
                    {d.trips.totals.internalCompleted}/{d.trips.totals.internalScheduled}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </ScrollTable>
        </SectionCard>

        {/* Blok 5 — Galon per depot */}
        <SectionCard title="Galon per depot" description={`${n(d.gallons.total)} galon · ${n(d.gallons.liters)} L`} flush>
          <ScrollTable testId="h0-gallons">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Depot</TableHead>
                  <TableHead className="text-right">Galon</TableHead>
                  <TableHead className="text-right">Liter</TableHead>
                  <TableHead className="text-right">Transaksi</TableHead>
                  <TableHead className="text-right">Penjualan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.gallons.byDepot.length ? (
                  d.gallons.byDepot.map((g) => (
                    <TableRow key={g.outletId}>
                      <TableCell>
                        <Link href={drillHref("depot", g.outletId)} className="font-medium text-primary hover:underline">
                          {g.code}
                        </Link>
                        <span className="block text-xs text-muted-foreground">{g.name}</span>
                      </TableCell>
                      <TableCell className="text-right">{n(g.gallons)}</TableCell>
                      <TableCell className="text-right">{n(g.liters)}</TableCell>
                      <TableCell className="text-right">{n(g.transactions)}</TableCell>
                      <TableCell className="text-right">{formatRupiah(g.sales)}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                      Belum ada penjualan depot.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </ScrollTable>
        </SectionCard>
      </div>

      {/* Blok 6 — Pengecualian (KP-4: putuskan selisih di sini) */}
      <SectionCard title="Pengecualian yang menunggu keputusan" description="Selisih ≥ ambang, persetujuan, rit gagal, kejadian GPS, susut air.">
        <div className="grid gap-4" data-testid="h0-exceptions">
          <div className="grid gap-2">
            <h3 className="text-sm font-semibold">Selisih setoran menunggu keputusan pemilik ({dash.pendingDiscrepancies.length})</h3>
            {dash.pendingDiscrepancies.length ? (
              <ul className="grid gap-2">
                {dash.pendingDiscrepancies.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-3 py-2 text-sm" data-testid="h0-pending-discrepancy">
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{p.sourceLabel}</span>
                      {p.personName ? ` — ${p.personName}` : ""} · {formatTanggal(p.businessDate)}
                      <span className="block text-xs text-muted-foreground">{p.explanation ? `Penjelasan: ${p.explanation}` : "Belum ada penjelasan Admin Keuangan."}</span>
                      {p.overdue ? (
                        <ToneBadge tone="danger" dot className="mt-1">
                          Lewat 24 jam (KPI-03)
                        </ToneBadge>
                      ) : null}
                    </span>
                    <span className="font-semibold text-destructive">{formatRupiah(p.amount, { signed: true })}</span>
                    {dash.canDecide ? (
                      <span className="flex gap-2">
                        <ReportActionButton label="Setujui" action={decideDiscrepancyAction.bind(null, p.id, "approve", undefined)} testId="h0-approve" />
                        <ReportReasonButton
                          label="Tolak"
                          title="Tolak penjelasan selisih"
                          description="Alasan wajib diisi. Selisih dikembalikan ke Admin Keuangan untuk ditindaklanjuti."
                          destructive
                          action={decideDiscrepancyAction.bind(null, p.id, "reject")}
                          textLabel="Alasan menolak"
                          testId="h0-reject"
                        />
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Tidak ada selisih yang menunggu keputusan.</p>
            )}
          </div>
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <p>
              Persetujuan menunggu: <strong>{d.exceptions.approvalsPending}</strong>
              {d.exceptions.approvalsOverdue ? <span className="text-destructive"> ({d.exceptions.approvalsOverdue} lewat tenggat)</span> : null} ·{" "}
              <Link href="/kotak-masuk" className="font-medium text-primary hover:underline">
                Kotak masuk
              </Link>
            </p>
            <p>Transfer belum dicocokkan: {formatRupiah(d.exceptions.unmatchedTransfers)}</p>
            <p>
              Kejadian GPS: {d.exceptions.fleet.offSchedule} di luar jadwal · {d.exceptions.fleet.unknownStops} berhenti tak dikenal · {d.exceptions.fleet.deviationsL2} lokasi &gt; 1 km · {d.exceptions.fleet.awaitingReview} menunggu tinjauan
            </p>
            <p>
              Air: {d.exceptions.water.lossFlags.length} susut di atas ambang · {d.exceptions.water.utilizationHigh.length} utilisasi tinggi · {d.exceptions.water.productionIncomplete.length} produksi belum lengkap
            </p>
          </div>
          {d.exceptions.failedTrips.length ? (
            <div className="grid gap-1">
              <h3 className="text-sm font-semibold">Rit gagal ({d.exceptions.failedTrips.length})</h3>
              <ul className="grid gap-1 text-sm">
                {d.exceptions.failedTrips.map((f) => (
                  <li key={f.id}>
                    {f.number} — {f.customerName}
                    {f.truckCode ? ` · truk ${f.truckCode}` : ""} · {f.reason ?? "tanpa alasan"}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </SectionCard>

      {/* Catatan tambahan (KP-6, 7.9.7) */}
      {dash.addenda.length || dash.correctionsRecorded.length ? (
        <SectionCard title="Catatan tambahan setelah terbit" description="Transaksi terlambat sinkron & koreksi tidak mengubah angka H+0 yang sudah terbit.">
          <ul className="grid gap-2 text-sm" data-testid="h0-addenda">
            {dash.addenda.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-2">
                <ToneBadge tone={a.kind === "correction" ? "warning" : "info"} dot>
                  {a.kindLabel}
                </ToneBadge>
                <span>
                  {formatTanggal(a.businessDate)}: {a.description}
                  {a.recordedOn !== a.businessDate ? ` (dicatat ${formatTanggal(a.recordedOn)})` : ""}
                </span>
              </li>
            ))}
            {dash.correctionsRecorded
              .filter((c) => !dash.addenda.some((a) => a.id === c.id))
              .map((c) => (
                <li key={c.id} className="flex flex-wrap gap-2">
                  <ToneBadge tone="warning" dot>
                    Koreksi atas {formatTanggal(c.businessDate)}
                  </ToneBadge>
                  <span>
                    {c.description} —{" "}
                    <Link href={`/laporan/hari-ini?tanggal=${c.businessDate}`} className="text-primary hover:underline">
                      buka H+0 {formatTanggal(c.businessDate)}
                    </Link>
                  </span>
                </li>
              ))}
          </ul>
        </SectionCard>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Dihitung {dash.computeMs} ms. Semua angka bersumber dari modul asal dengan satu definisi (omzet, kas, piutang, rit, galon) yang sama dengan laporan bulanan dan tren.
      </p>
    </div>
  );
}

function Drilldown({ drill }: { drill: m9.DrilldownResult }) {
  if (drill.kind === "truck") {
    return (
      <ScrollTable>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rit</TableHead>
              <TableHead>Pelanggan</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Harga</TableHead>
              <TableHead>Bayar</TableHead>
              <TableHead>Waktu</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {drill.rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">
                  {r.number}
                  {r.isInternal ? <span className="block text-xs text-muted-foreground">Internal (pasokan depot)</span> : null}
                </TableCell>
                <TableCell>{r.customerName}</TableCell>
                <TableCell>
                  {r.statusLabel}
                  {r.failReason ? <span className="block text-xs text-destructive">{r.failReason}</span> : null}
                </TableCell>
                <TableCell className="text-right">{formatRupiah(r.price)}</TableCell>
                <TableCell>{r.paymentMethod}</TableCell>
                <TableCell>{r.at ? formatTanggalJam(r.at) : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollTable>
    );
  }
  if (drill.kind === "depot") {
    return (
      <ScrollTable>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Shift</TableHead>
              <TableHead>Operator</TableHead>
              <TableHead className="text-right">Penjualan</TableHead>
              <TableHead className="text-right">Transaksi</TableHead>
              <TableHead className="text-right">Galon</TableHead>
              <TableHead className="text-right">Void</TableHead>
              <TableHead className="text-right">Selisih kas</TableHead>
              <TableHead>Setoran</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {drill.rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  {formatTanggal(r.businessDate)}
                  <span className="block text-xs text-muted-foreground">
                    {formatJam(r.openedAt)}–{r.closedAt ? formatJam(r.closedAt) : "buka"}
                  </span>
                </TableCell>
                <TableCell>{r.operatorName}</TableCell>
                <TableCell className="text-right">{formatRupiah(r.sales)}</TableCell>
                <TableCell className="text-right">{r.transactions}</TableCell>
                <TableCell className="text-right">{r.gallons}</TableCell>
                <TableCell className="text-right">{r.voidCount}</TableCell>
                <TableCell className="text-right">{r.cashDifference === null ? "—" : formatRupiah(r.cashDifference, { signed: true })}</TableCell>
                <TableCell>{r.depositStatus}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollTable>
    );
  }
  if (drill.kind === "discrepancy") {
    return (
      <ScrollTable>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Setoran</TableHead>
              <TableHead>Sumber</TableHead>
              <TableHead className="text-right">Seharusnya</TableHead>
              <TableHead className="text-right">Diterima</TableHead>
              <TableHead className="text-right">Selisih</TableHead>
              <TableHead>Alasan</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {drill.rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">
                  {r.number}
                  <span className="block text-xs text-muted-foreground">{formatTanggal(r.businessDate)}</span>
                </TableCell>
                <TableCell>
                  {r.sourceLabel}
                  {r.personName ? <span className="block text-xs text-muted-foreground">{r.personName}</span> : null}
                </TableCell>
                <TableCell className="text-right">{formatRupiah(r.expected)}</TableCell>
                <TableCell className="text-right">{r.received === null ? "—" : formatRupiah(r.received)}</TableCell>
                <TableCell className={`text-right ${r.discrepancy ? "font-medium text-destructive" : ""}`}>{r.discrepancy === null ? "—" : formatRupiah(r.discrepancy, { signed: true })}</TableCell>
                <TableCell className="max-w-48 whitespace-normal">{r.reason ?? "—"}</TableCell>
                <TableCell>
                  {r.status}
                  {r.awaitingOwner ? <span className="block text-xs text-destructive">Menunggu pemilik</span> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollTable>
    );
  }
  return (
    <ScrollTable>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Pelanggan</TableHead>
            <TableHead className="text-right">Terbentuk</TableHead>
            <TableHead className="text-right">Dilunasi</TableHead>
            <TableHead className="text-right">Saldo</TableHead>
            <TableHead className="text-right">Lewat tempo</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {drill.rows.map((r) => (
            <TableRow key={r.customerId}>
              <TableCell className="font-medium">{r.customerName}</TableCell>
              <TableCell className="text-right">{formatRupiah(r.formed)}</TableCell>
              <TableCell className="text-right">{formatRupiah(r.paid)}</TableCell>
              <TableCell className="text-right">{formatRupiah(r.balance)}</TableCell>
              <TableCell className={`text-right ${r.overdue ? "font-medium text-destructive" : ""}`}>{formatRupiah(r.overdue)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollTable>
  );
}
