import type { Metadata } from "next";

import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { toUserMessage } from "@/server/core/errors";
import * as p3 from "@/server/modules/p3-partner";

import { requirePortalSession } from "../../_session";

export const metadata: Metadata = { title: "Penjualan outlet" };

const num = (n: number) => n.toLocaleString("id-ID");
const isDate = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/**
 * Penjualan outlet mitra (RL-7 US-P3-10 KP-2): penjualan per hari per outlet, galon, void, selisih shift — dihitung
 * fungsi laporan POS (M6) yang sama dengan yang dipakai EQUA (B-13). Saringan outlet lain → ditolak & tercatat.
 */
export default async function PortalSalesPage({ searchParams }: { searchParams: Promise<{ dari?: string; sampai?: string; outlet?: string }> }) {
  const sp = await searchParams;
  const { ctx } = await requirePortalSession();
  const home = await p3.portalHome(ctx);
  // Outlet di luar tenant sendiri tetap diteruskan ke layanan → ditolak & tercatat di log akses (US-P3-10 KP-4).
  const outletId = sp.outlet && /^[0-9a-f-]{36}$/i.test(sp.outlet) ? sp.outlet : null;
  let report: Awaited<ReturnType<typeof p3.portalSalesReport>>;
  try {
    report = await p3.portalSalesReport(ctx, { from: isDate(sp.dari), to: isDate(sp.sampai), outletId });
  } catch (error) {
    return (
      <>
        <PageHeader title="Penjualan outlet" />
        <EmptyState title="Data tidak dapat ditampilkan" description={toUserMessage(error)} />
      </>
    );
  }
  const q = new URLSearchParams({ from: report.from, to: report.to, ...(outletId ? { outletId } : {}) }).toString();
  const totals = report.daily.reduce((s, d) => ({ sales: s.sales + d.salesTotal, gallons: s.gallons + d.gallons, trx: s.trx + d.transactions, voids: s.voids + d.voidCount, diff: s.diff + d.cashDifference }), { sales: 0, gallons: 0, trx: 0, voids: 0, diff: 0 });

  return (
    <>
      <PageHeader title="Penjualan outlet" description="Angka yang sama dengan laporan outlet EQUA." actions={<ExportButtons excelHref={`/api/export/p3.partner_sales?format=xlsx&${q}`} pdfHref={`/api/export/p3.partner_sales?format=pdf&${q}`} />} />
      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-sm font-medium">
          Dari
          <input type="date" name="dari" defaultValue={report.from} className="h-10 rounded-md border border-input bg-background px-3 text-base" />
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Sampai
          <input type="date" name="sampai" defaultValue={report.to} className="h-10 rounded-md border border-input bg-background px-3 text-base" />
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Outlet
          <select name="outlet" defaultValue={outletId ?? ""} className="h-10 rounded-md border border-input bg-background px-3 text-base">
            <option value="">Semua outlet</option>
            {home.outlets.map((o) => (
              <option key={o.id} value={o.id}>
                {o.code} — {o.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="h-10 rounded-md border border-input bg-secondary px-4 text-sm font-medium">
          Tampilkan
        </button>
      </form>

      <SectionCard title="Penjualan per hari per outlet" description={`Total ${num(totals.trx)} transaksi · ${num(totals.gallons)} galon · ${num(totals.voids)} void`}>
        {report.daily.length === 0 ? (
          <EmptyState title="Belum ada penjualan pada rentang ini" compact />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-penjualan-mitra">
              <TableHeader>
                <TableRow>
                  <TableHead>Tanggal</TableHead>
                  <TableHead>Outlet</TableHead>
                  <TableHead className="text-right">Transaksi</TableHead>
                  <TableHead className="text-right">Galon</TableHead>
                  <TableHead className="text-right">Penjualan</TableHead>
                  <TableHead className="text-right">Void</TableHead>
                  <TableHead className="text-right">Selisih shift</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.daily.map((d) => (
                  <TableRow key={`${d.outletId}:${d.businessDate}`}>
                    <TableCell className="whitespace-nowrap">{formatTanggal(d.businessDate)}</TableCell>
                    <TableCell>{d.outletName}</TableCell>
                    <TableCell className="text-right">{num(d.transactions)}</TableCell>
                    <TableCell className="text-right">{num(d.gallons)}</TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={d.salesTotal} />
                    </TableCell>
                    <TableCell className="text-right">{d.voidCount ? `${num(d.voidCount)} (${num(d.voidAmount)})` : "—"}</TableCell>
                    <TableCell className="text-right">{d.cashDifference ? <ToneBadge tone="warning"><MoneyText value={d.cashDifference} /></ToneBadge> : "—"}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="font-medium">
                  <TableCell colSpan={2}>Total</TableCell>
                  <TableCell className="text-right">{num(totals.trx)}</TableCell>
                  <TableCell className="text-right">{num(totals.gallons)}</TableCell>
                  <TableCell className="text-right">
                    <MoneyText value={totals.sales} />
                  </TableCell>
                  <TableCell className="text-right">{num(totals.voids)}</TableCell>
                  <TableCell className="text-right">
                    <MoneyText value={totals.diff} />
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Void">
          {report.voids.length === 0 ? (
            <p className="text-sm text-muted-foreground">Tidak ada void.</p>
          ) : (
            <ul className="grid gap-1 text-sm">
              {report.voids.map((v) => (
                <li key={`${v.outletId}:${v.businessDate}`} className="flex flex-wrap gap-2">
                  <span>{formatTanggal(v.businessDate)}</span>
                  <span className="text-muted-foreground">{v.outletName}</span>
                  <span>
                    {num(v.voidCount)} void · <MoneyText value={v.voidAmount} />
                  </span>
                  {v.pendingCount ? <ToneBadge tone="warning">{num(v.pendingCount)} menunggu</ToneBadge> : null}
                  {v.overLimit ? <ToneBadge tone="danger">melebihi batas harian</ToneBadge> : null}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        <SectionCard title="Shift & selisih kas">
          {report.shifts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada shift.</p>
          ) : (
            <ul className="grid gap-1 text-sm">
              {report.shifts.slice(0, 60).map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-2">
                  <span>{formatTanggal(s.businessDate)}</span>
                  <span className="text-muted-foreground">
                    {s.outletName} · {s.operatorName ?? "-"}
                  </span>
                  <StatusBadge enumName="shift_status" value={s.status} />
                  {s.closedAt ? <span className="text-xs text-muted-foreground">tutup {formatTanggalJam(s.closedAt)}</span> : null}
                  {s.cashDifference ? (
                    <ToneBadge tone="warning">
                      selisih <MoneyText value={s.cashDifference} />
                    </ToneBadge>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted-foreground">Setoran & selisih kas outlet mitra dikelola mitra sendiri; tidak masuk kas EQUA.</p>
        </SectionCard>
      </div>
    </>
  );
}
