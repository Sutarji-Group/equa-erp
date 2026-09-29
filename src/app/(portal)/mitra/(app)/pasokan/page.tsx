import type { Metadata } from "next";

import { MonthFilter } from "@/components/p3-partner/fields";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import * as p3 from "@/server/modules/p3-partner";

import { requirePortalSession } from "../../_session";

export const metadata: Metadata = { title: "Pasokan & neraca air" };

const num = (n: number | null | undefined, digits = 0) => (n === null || n === undefined ? "—" : n.toLocaleString("id-ID", { maximumFractionDigits: digits }));

/**
 * Pasokan air diterima & neraca air versi mitra (RL-7 US-P3-08 KP-2/KP-3, US-P3-10 KP-2) dan riwayat pembelian air &
 * spare part per bulan (US-P3-03 KP-5). Pasokan dikonfirmasi operator di POS outlet (menu Pasokan air).
 */
export default async function PortalSupplyPage({ searchParams }: { searchParams: Promise<{ bulan?: string }> }) {
  const sp = await searchParams;
  const { ctx } = await requirePortalSession();
  const report = await p3.portalSupplyReport(ctx, { month: sp.bulan ?? null });
  const history = await p3.portalPurchaseHistory(ctx);

  return (
    <>
      <PageHeader title="Pasokan & neraca air" description="Air dari truk EQUA yang diterima outlet Anda, dibandingkan galon yang terjual (galon × 19 L)." />
      <MonthFilter month={report.month} />

      <SectionCard title={`Neraca air — ${report.month}`}>
        {report.balance.length === 0 ? (
          <EmptyState title="Belum ada data neraca air" compact />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Outlet</TableHead>
                  <TableHead className="text-right">Stok awal</TableHead>
                  <TableHead className="text-right">Dari EQUA</TableHead>
                  <TableHead className="text-right">Sumber lain</TableHead>
                  <TableHead className="text-right">Tersedia</TableHead>
                  <TableHead className="text-right">Terjual</TableHead>
                  <TableHead className="text-right">Kelebihan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.balance.map((b) => (
                  <TableRow key={b.outletId}>
                    <TableCell>{b.outletName}</TableCell>
                    <TableCell className="text-right">{num(b.openingL)} L</TableCell>
                    <TableCell className="text-right">{num(b.receivedFromEquaL)} L</TableCell>
                    <TableCell className="text-right">{num(b.otherSourceL)} L</TableCell>
                    <TableCell className="text-right">{num(b.availableL)} L</TableCell>
                    <TableCell className="text-right">
                      {num(b.soldL)} L<div className="text-xs text-muted-foreground">{num(b.gallonsSold)} galon</div>
                    </TableCell>
                    <TableCell className="text-right">
                      <ToneBadge tone={b.exceeded ? "danger" : "success"}>
                        {num(b.excessL)} L ({num(b.excessPct, 1)}%)
                      </ToneBadge>
                      <div className="text-xs text-muted-foreground">toleransi {num(b.tolerancePct, 1)}%</div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Pasokan air diterima" description="Status Tiba = belum dikonfirmasi operator di POS. Selisih kirim–terima diteruskan ke Dispatcher EQUA.">
        {report.supply.length === 0 ? (
          <EmptyState title="Belum ada pasokan pada bulan ini" compact />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-pasokan-mitra">
              <TableHeader>
                <TableRow>
                  <TableHead>Tanggal</TableHead>
                  <TableHead>Outlet</TableHead>
                  <TableHead>Asal</TableHead>
                  <TableHead className="text-right">Dikirim</TableHead>
                  <TableHead className="text-right">Diterima</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.supply.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">{formatTanggal(r.businessDate)}</TableCell>
                    <TableCell>{r.outletName}</TableCell>
                    <TableCell>{label("water_supply_source", r.source)}</TableCell>
                    <TableCell className="text-right">{num(r.deliveredVolumeL)} L</TableCell>
                    <TableCell className="text-right">
                      {r.receivedVolumeL === null ? "—" : `${num(r.receivedVolumeL)} L`}
                      {r.differenceL ? <div className="text-xs text-destructive">selisih {num(r.differenceL)} L</div> : null}
                    </TableCell>
                    <TableCell>
                      <StatusBadge enumName="water_supply_status" value={r.status} />
                      {r.confirmedAt ? <div className="text-xs text-muted-foreground">{formatTanggalJam(r.confirmedAt)}</div> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Riwayat pembelian dari EQUA per bulan" actions={<ExportButtons excelHref="/api/export/p3.partner_purchases?format=xlsx" pdfHref="/api/export/p3.partner_purchases?format=pdf" />}>
        {history.length === 0 ? (
          <EmptyState title="Belum ada pembelian" compact />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Bulan</TableHead>
                  <TableHead className="text-right">Rit air</TableHead>
                  <TableHead className="text-right">Liter air</TableHead>
                  <TableHead className="text-right">Nilai air</TableHead>
                  <TableHead className="text-right">Spare part</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((h) => (
                  <TableRow key={h.month}>
                    <TableCell>{h.month}</TableCell>
                    <TableCell className="text-right">{num(h.waterTrips)}</TableCell>
                    <TableCell className="text-right">{num(h.waterL)} L</TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={h.waterAmount} />
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={h.sparePartAmount} />
                      <div className="text-xs text-muted-foreground">{num(h.sparePartTransactions)} transaksi</div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
    </>
  );
}
