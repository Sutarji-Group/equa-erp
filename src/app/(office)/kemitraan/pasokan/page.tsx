import type { Metadata } from "next";
import Link from "next/link";

import { MonthFilter } from "@/components/p3-partner/fields";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import * as p3 from "@/server/modules/p3-partner";

export const metadata: Metadata = { title: "Pasokan & neraca mitra" };

/**
 * Pasokan air & neraca air per mitra per bulan (US-P3-08 KP-2..KP-5): pesanan air mitra & SLA PAR-76, rit Selesai,
 * pasokan tiba/dikonfirmasi/selisih di POS mitra, galon terjual × 19 L vs air diterima (PAR-79). Data agregat saja.
 */
export default async function SupplyPage({ searchParams }: { searchParams: Promise<{ bulan?: string; mitra?: string }> }) {
  const sp = await searchParams;
  const { ctx } = await requirePermission("p3.partner_supply.read");
  const board = await p3.supplyBoard(ctx, { month: sp.bulan ?? null, tenantId: sp.mitra ?? null });
  const q = `bulan=${board.month}${sp.mitra ? `&tenantId=${sp.mitra}` : ""}`;

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Pasokan air & neraca mitra"
        description="Rit pelanggan mitra yang Selesai muncul sebagai 'pasokan tiba' di POS mitra dan dikonfirmasi operator mitra; selisih ke Dispatcher."
        actions={<ExportButtons excelHref={`/api/export/p3.partner_supply?format=xlsx&month=${board.month}${sp.mitra ? `&tenantId=${sp.mitra}` : ""}`} pdfHref={`/api/export/p3.partner_water_balance?format=pdf&month=${board.month}${sp.mitra ? `&tenantId=${sp.mitra}` : ""}`} />}
      />
      <MonthFilter month={board.month} hidden={{ mitra: sp.mitra }} />
      <SectionCard title={`Ringkasan per mitra — ${board.month}`}>
        {board.rows.length === 0 ? (
          <EmptyState title="Belum ada mitra" compact />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-pasokan-mitra">
              <TableHeader>
                <TableRow>
                  <TableHead>Mitra</TableHead>
                  <TableHead className="text-right">Pesanan (lewat SLA)</TableHead>
                  <TableHead className="text-right">Rit Selesai</TableHead>
                  <TableHead className="text-right">Dikirim (L)</TableHead>
                  <TableHead className="text-right">Diterima (L)</TableHead>
                  <TableHead className="text-right">Galon terjual</TableHead>
                  <TableHead className="text-right">Omzet POS</TableHead>
                  <TableHead>Neraca air</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {board.rows.map((r) => (
                  <TableRow key={r.tenant.id}>
                    <TableCell>
                      <Link href={`/kemitraan/mitra/${r.tenant.id}`} className="font-medium text-primary hover:underline">
                        {r.tenant.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right">
                      {r.orders.total} {r.orders.late ? <ToneBadge tone="danger">{r.orders.late} lewat</ToneBadge> : null}
                    </TableCell>
                    <TableCell className="text-right">{r.tripsCompleted}</TableCell>
                    <TableCell className="text-right">{r.deliveredL.toLocaleString("id-ID")}</TableCell>
                    <TableCell className="text-right">{r.receipts.receivedL.toLocaleString("id-ID")}</TableCell>
                    <TableCell className="text-right">{r.sales.gallons.toLocaleString("id-ID")}</TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={r.sales.salesTotal} />
                    </TableCell>
                    <TableCell>
                      {r.balance.map((b) => (
                        <div key={b.outletId} className="text-sm">
                          {b.outletName}: {b.soldL.toLocaleString("id-ID")} / {b.availableL.toLocaleString("id-ID")} L{" "}
                          {b.exceeded ? <ToneBadge tone="danger">+{b.excessPct}% &gt; {b.tolerancePct}%</ToneBadge> : <ToneBadge tone="success">dalam toleransi</ToneBadge>}
                        </div>
                      ))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
      <SectionCard title="Pesanan air mitra lewat SLA (PAR-76)" actions={<ExportButtons excelHref={`/api/export/p3.late_water_orders?format=xlsx&${q.replace("bulan", "month")}`} />}>
        {board.lateOrders.length === 0 ? (
          <p className="text-sm text-muted-foreground">Tidak ada pesanan lewat SLA bulan ini.</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {board.lateOrders.map((o) => (
              <li key={o.orderId}>
                <Link href={`/pesanan/${o.orderId}`} className="text-primary hover:underline">
                  {o.number}
                </Link>{" "}
                · {o.tenantName} · {o.tankCount} tangki · <StatusBadge enumName="order_status" value={o.status} /> · dibuat {formatTanggalJam(o.createdAt)} · batas {o.slaDueAt ? formatTanggalJam(o.slaDueAt) : "-"}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard title="Pasokan menunggu konfirmasi / berselisih di POS mitra">
        {board.pendingReceipts.length === 0 ? (
          <p className="text-sm text-muted-foreground">Semua pasokan sudah dikonfirmasi.</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {board.pendingReceipts.map((r) => (
              <li key={r.id}>
                {formatTanggal(r.businessDate)} · {r.tenantName} · {r.outletName} · rit {r.tripNumber ?? "-"} · dikirim {r.deliveredVolumeL?.toLocaleString("id-ID") ?? "-"} L · <StatusBadge enumName="water_supply_status" value={r.status} />
                {r.differenceL ? ` · selisih ${r.differenceL} L (${r.differenceReason ?? "-"})` : ""}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
