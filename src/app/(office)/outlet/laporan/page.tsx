import type { Metadata } from "next";
import Link from "next/link";

import { LinkTabs, RangeFilter, SignedNumber } from "@/components/m6-pos/office-ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatJam, formatTanggal, isBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import * as m6 from "@/server/modules/m6-pos";

export const metadata: Metadata = { title: "Laporan outlet" };

const TABS = [
  { key: "harian", label: "Ringkasan harian", report: "m6.outlet_daily" },
  { key: "void", label: "Void", report: "m6.voids" },
  { key: "pemakaian", label: "Pemakaian bahan vs penjualan", report: "m6.usage_vs_sales" },
  { key: "air", label: "Neraca air", report: "m6.water_balance" },
  { key: "pasokan", label: "Pasokan air", report: "m6.water_supply" },
  { key: "shift", label: "Shift", report: "m6.shifts" },
  { key: "opname", label: "Opname", report: "m6.stock_counts" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

type Search = { tab?: string; dari?: string; sampai?: string; outlet?: string; periode?: string };

/**
 * Laporan outlet (M6): ringkasan harian per depot/toko, void per outlet per hari, pemakaian bahan vs penjualan (rasio
 * per galon), neraca air, pasokan air, shift, opname. Semua berlingkup tenant pelaku (NFR-30) dan dapat diekspor
 * Excel/PDF lewat /api/export.
 */
export default async function OutletReportsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { ctx } = await requirePermission("m6.outlet.read");
  const sp = await searchParams;
  const tab: TabKey = TABS.some((t) => t.key === sp.tab) ? (sp.tab as TabKey) : "harian";
  const def = m6.defaultRange(ctx, tab === "pemakaian" || tab === "air" ? 28 : 7);
  const from = sp.dari && isBusinessDate(sp.dari) ? sp.dari : def.from;
  const to = sp.sampai && isBusinessDate(sp.sampai) && sp.sampai >= from ? sp.sampai : def.to;
  const outletList = await m6.listTenantOutlets(ctx);
  const outletId = sp.outlet && outletList.some((o) => o.id === sp.outlet) ? sp.outlet : null;
  const granularity = sp.periode === "month" ? "month" : "week";
  const report = TABS.find((t) => t.key === tab)!.report;
  const query = new URLSearchParams({ from, to, ...(outletId ? { outletId } : {}), ...(tab === "pemakaian" ? { granularity } : {}) }).toString();
  const hrefFor = (key: string) => `/outlet/laporan?${new URLSearchParams({ tab: key, dari: from, sampai: to, ...(outletId ? { outlet: outletId } : {}) }).toString()}`;
  const input = { from, to, outletId };

  return (
    <div className="grid gap-6">
      <PageHeader title="Laporan outlet" backHref="/outlet" backLabel="Pemantauan outlet" description="Angka per depot/toko tenant Anda. Shift yang belum ditutup dapat berubah." />
      <LinkTabs tabs={TABS} active={tab} hrefFor={hrefFor} label="Jenis laporan outlet" />
      <SectionCard
        title={TABS.find((t) => t.key === tab)!.label}
        description={`${formatTanggal(from)} – ${formatTanggal(to)}`}
        actions={<ExportButtons excelHref={`/api/export/${report}?format=xlsx&${query}`} pdfHref={`/api/export/${report}?format=pdf&${query}`} />}
      >
        <div className="mb-4">
          <RangeFilter
            action="/outlet/laporan"
            from={from}
            to={to}
            outlets={outletList}
            outletId={outletId}
            hidden={{ tab }}
            extra={
              tab === "pemakaian" ? (
                <label className="grid gap-1 text-xs font-medium">
                  Periode
                  <select name="periode" defaultValue={granularity} className="h-9 rounded-md border bg-background px-2 text-sm">
                    <option value="week">Mingguan</option>
                    <option value="month">Bulanan</option>
                  </select>
                </label>
              ) : undefined
            }
          />
        </div>
        {tab === "harian" ? <DailyTable rows={await m6.dailyOutletReport(ctx, input)} /> : null}
        {tab === "void" ? <VoidTable rows={await m6.voidReport(ctx, input)} /> : null}
        {tab === "pemakaian" ? <UsageTable rows={await m6.usageVsSalesReport(ctx, { ...input, granularity })} /> : null}
        {tab === "air" ? <WaterBalanceTable rows={await m6.waterBalanceReport(ctx, input)} /> : null}
        {tab === "pasokan" ? <SupplyTable rows={await m6.waterSupplyReport(ctx, input)} /> : null}
        {tab === "shift" ? <ShiftTable rows={await m6.shiftReport(ctx, input)} /> : null}
        {tab === "opname" ? <StockCountTable rows={await m6.stockCountReport(ctx, input)} /> : null}
      </SectionCard>
    </div>
  );
}

function Empty() {
  return <EmptyState compact title="Tidak ada data pada rentang ini" description="Ubah rentang tanggal atau pilih outlet lain." />;
}

function DailyTable({ rows }: { rows: m6.DailyOutletRow[] }) {
  if (!rows.length) return <Empty />;
  return (
    <div className="overflow-x-auto">
      <Table data-testid="laporan-harian">
        <TableHeader>
          <TableRow>
            <TableHead>Tanggal</TableHead>
            <TableHead>Outlet</TableHead>
            <TableHead className="text-right">Penjualan</TableHead>
            <TableHead className="text-right">Tunai</TableHead>
            <TableHead className="text-right">QRIS</TableHead>
            <TableHead className="text-right">Transaksi</TableHead>
            <TableHead className="text-right">Galon</TableHead>
            <TableHead className="text-right">Void</TableHead>
            <TableHead className="text-right">Setoran</TableHead>
            <TableHead className="text-right">Selisih kas</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={`${r.outletId}:${r.businessDate}`}>
              <TableCell>{formatTanggal(r.businessDate)}</TableCell>
              <TableCell>
                {r.outletCode} · {r.outletName}
              </TableCell>
              <TableCell className="text-right">{formatRupiah(r.salesTotal)}</TableCell>
              <TableCell className="text-right">{formatRupiah(r.cashSales)}</TableCell>
              <TableCell className="text-right">{formatRupiah(r.qrisSales)}</TableCell>
              <TableCell className="text-right">{r.transactions}</TableCell>
              <TableCell className="text-right">{r.gallons}</TableCell>
              <TableCell className="text-right">
                {r.voidCount} · {formatRupiah(r.voidAmount)}
              </TableCell>
              <TableCell className="text-right">{formatRupiah(r.depositTotal)}</TableCell>
              <TableCell className="text-right">
                <SignedNumber value={r.cashDifference} money />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function VoidTable({ rows }: { rows: m6.VoidReportRow[] }) {
  if (!rows.length) return <Empty />;
  return (
    <div className="overflow-x-auto">
      <Table data-testid="laporan-void">
        <TableHeader>
          <TableRow>
            <TableHead>Tanggal</TableHead>
            <TableHead>Outlet</TableHead>
            <TableHead className="text-right">Jumlah void</TableHead>
            <TableHead className="text-right">Nilai</TableHead>
            <TableHead className="text-right">Menunggu</TableHead>
            <TableHead className="text-right">Void QRIS</TableHead>
            <TableHead>Batas PAR-03</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={`${r.outletId}:${r.businessDate}`}>
              <TableCell>{formatTanggal(r.businessDate)}</TableCell>
              <TableCell>
                {r.outletCode} · {r.outletName}
              </TableCell>
              <TableCell className="text-right">{r.voidCount}</TableCell>
              <TableCell className="text-right">{formatRupiah(r.voidAmount)}</TableCell>
              <TableCell className="text-right">{r.pendingCount}</TableCell>
              <TableCell className="text-right">{r.qrisVoidCount}</TableCell>
              <TableCell>{r.overLimit ? <ToneBadge tone="danger">Melebihi</ToneBadge> : <ToneBadge tone="muted">Wajar</ToneBadge>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function UsageTable({ rows }: { rows: m6.UsageReportRow[] }) {
  if (!rows.length) return <Empty />;
  return (
    <div className="overflow-x-auto">
      <p className="mb-2 text-xs text-muted-foreground">Pemakaian efektif = pemakaian resep − penyesuaian opname. Rasio = pemakaian efektif per galon terjual; bandingkan antar depot.</p>
      <Table data-testid="laporan-pemakaian">
        <TableHeader>
          <TableRow>
            <TableHead>Periode</TableHead>
            <TableHead>Outlet</TableHead>
            <TableHead>Bahan</TableHead>
            <TableHead className="text-right">Galon terjual</TableHead>
            <TableHead className="text-right">Pemakaian resep</TableHead>
            <TableHead className="text-right">Penyesuaian opname</TableHead>
            <TableHead className="text-right">Selisih hitung shift</TableHead>
            <TableHead className="text-right">Pemakaian efektif</TableHead>
            <TableHead className="text-right">Rasio/galon</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={`${r.outletId}:${r.period}:${r.productId}`}>
              <TableCell>{r.period}</TableCell>
              <TableCell>{r.outletCode}</TableCell>
              <TableCell>{r.productName}</TableCell>
              <TableCell className="text-right">{r.gallonsSold}</TableCell>
              <TableCell className="text-right">{r.expectedUsage}</TableCell>
              <TableCell className="text-right">
                <SignedNumber value={r.opnameAdjustment} />
              </TableCell>
              <TableCell className="text-right">
                <SignedNumber value={r.shiftDifference} />
              </TableCell>
              <TableCell className="text-right">{r.effectiveUsage}</TableCell>
              <TableCell className="text-right">{r.ratioPerGallon === null ? "—" : r.ratioPerGallon.toLocaleString("id-ID")}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function WaterBalanceTable({ rows }: { rows: Awaited<ReturnType<typeof m6.waterBalanceReport>> }) {
  if (!rows.length) return <Empty />;
  const L = (n: number) => `${n.toLocaleString("id-ID")} L`;
  return (
    <div className="overflow-x-auto">
      <p className="mb-2 text-xs text-muted-foreground">Galon terjual × ukuran tidak boleh melebihi stok awal + air diterima. Kelebihan di atas toleransi PAR-59 dikirim ke pemilik.</p>
      <Table data-testid="laporan-neraca-air">
        <TableHeader>
          <TableRow>
            <TableHead>Depot</TableHead>
            <TableHead className="text-right">Stok awal</TableHead>
            <TableHead className="text-right">Diterima</TableHead>
            <TableHead className="text-right">Terjual (galon × ukuran)</TableHead>
            <TableHead className="text-right">Penyesuaian</TableHead>
            <TableHead className="text-right">Stok akhir</TableHead>
            <TableHead className="text-right">Kelebihan</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.outletId}>
              <TableCell>{r.outletName}</TableCell>
              <TableCell className="text-right">{L(r.openingL)}</TableCell>
              <TableCell className="text-right">{L(r.receivedL)}</TableCell>
              <TableCell className="text-right">{L(r.soldL)}</TableCell>
              <TableCell className="text-right">{L(r.adjustmentL)}</TableCell>
              <TableCell className="text-right">{L(r.closingL)}</TableCell>
              <TableCell className="text-right">
                {L(r.excessL)} ({r.excessPct.toLocaleString("id-ID")}%)
              </TableCell>
              <TableCell>{r.exceeded ? <ToneBadge tone="danger">Melebihi {r.tolerancePct}%</ToneBadge> : <ToneBadge tone="success">Sesuai</ToneBadge>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function SupplyTable({ rows }: { rows: Awaited<ReturnType<typeof m6.waterSupplyReport>> }) {
  if (!rows.length) return <Empty />;
  return (
    <div className="overflow-x-auto">
      <Table data-testid="laporan-pasokan">
        <TableHeader>
          <TableRow>
            <TableHead>Tanggal</TableHead>
            <TableHead>Depot</TableHead>
            <TableHead>Sumber</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Diserahkan</TableHead>
            <TableHead className="text-right">Diterima</TableHead>
            <TableHead className="text-right">Selisih</TableHead>
            <TableHead>Keterangan</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>{formatTanggal(r.businessDate)}</TableCell>
              <TableCell>{r.outletCode}</TableCell>
              <TableCell>{label("water_supply_source", r.source)}</TableCell>
              <TableCell>
                <StatusBadge enumName="water_supply_status" value={r.status} />
              </TableCell>
              <TableCell className="text-right">{r.deliveredVolumeL ?? "—"}</TableCell>
              <TableCell className="text-right">{r.receivedVolumeL ?? "—"}</TableCell>
              <TableCell className="text-right">
                <SignedNumber value={r.differenceL} suffix=" L" />
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{r.differenceReason ?? r.otherSourceReason ?? "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ShiftTable({ rows }: { rows: Awaited<ReturnType<typeof m6.shiftReport>> }) {
  if (!rows.length) return <Empty />;
  return (
    <div className="overflow-x-auto">
      <Table data-testid="laporan-shift">
        <TableHeader>
          <TableRow>
            <TableHead>Tanggal</TableHead>
            <TableHead>Outlet</TableHead>
            <TableHead>Operator</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Tunai</TableHead>
            <TableHead className="text-right">QRIS</TableHead>
            <TableHead className="text-right">Selisih kas</TableHead>
            <TableHead className="text-right">Setoran</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <Link href={`/outlet/shift/${r.id}`} className="text-primary hover:underline">
                  {formatTanggal(r.businessDate)}
                </Link>
                <span className="block text-xs text-muted-foreground">
                  {formatJam(r.openedAt)}–{r.closedAt ? formatJam(r.closedAt) : "…"}
                </span>
              </TableCell>
              <TableCell>{r.outletCode}</TableCell>
              <TableCell>{r.operatorName ?? "—"}</TableCell>
              <TableCell>
                <StatusBadge enumName="shift_status" value={r.status} />
              </TableCell>
              <TableCell className="text-right">{r.cashSales === null ? "—" : formatRupiah(r.cashSales)}</TableCell>
              <TableCell className="text-right">{r.qrisSales === null ? "—" : formatRupiah(r.qrisSales)}</TableCell>
              <TableCell className="text-right">
                <SignedNumber value={r.cashDifference} money />
              </TableCell>
              <TableCell className="text-right">{r.depositAmount === null ? "—" : formatRupiah(r.depositAmount)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function StockCountTable({ rows }: { rows: Awaited<ReturnType<typeof m6.stockCountReport>> }) {
  if (!rows.length) return <Empty />;
  return (
    <div className="overflow-x-auto">
      <Table data-testid="laporan-opname">
        <TableHeader>
          <TableRow>
            <TableHead>Periode</TableHead>
            <TableHead>Outlet</TableHead>
            <TableHead>Bahan</TableHead>
            <TableHead className="text-right">Sistem</TableHead>
            <TableHead className="text-right">Fisik</TableHead>
            <TableHead className="text-right">Selisih</TableHead>
            <TableHead className="text-right">Nilai selisih</TableHead>
            <TableHead>Alasan</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>{r.periodLabel}</TableCell>
              <TableCell>{r.outletCode}</TableCell>
              <TableCell>{r.productName}</TableCell>
              <TableCell className="text-right">{r.systemQtyAtCount}</TableCell>
              <TableCell className="text-right">{r.physicalQty}</TableCell>
              <TableCell className="text-right">
                <SignedNumber value={r.differenceQty} />
              </TableCell>
              <TableCell className="text-right">
                <SignedNumber value={r.differenceValue} money />
              </TableCell>
              <TableCell className="text-xs">{r.reason ? `${label("stock_adjust_reason", r.reason)}${r.reasonNote ? ` — ${r.reasonNote}` : ""}` : "—"}</TableCell>
              <TableCell>
                <StatusBadge enumName="stock_count_status" value={r.status} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
