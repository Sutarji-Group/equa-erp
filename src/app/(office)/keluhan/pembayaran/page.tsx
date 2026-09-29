import type { Metadata } from "next";

import { P2OfficeTabs } from "@/components/p2-customer/office-tabs";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatRupiah } from "@/lib/money";
import { formatTanggalJam, monthOf, toBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as p2 from "@/server/modules/p2-customer";

import { p2Tabs } from "../_tabs";

export const metadata: Metadata = { title: "Pembayaran digital & WA" };

/**
 * Pembayaran digital pelanggan (US-P2-04 KP-3, PTB-50: QRIS/VA; Berhasil → pelunasan M5 + transfer masuk M4 untuk
 * dicocokkan settlement bank; biaya gerbang sebagai beban) dan biaya pesan WhatsApp Business API (US-P2-08 KP-3, NFR-29).
 */
export default async function PembayaranPage({ searchParams }: PageProps<"/keluhan/pembayaran">) {
  const { ctx } = await requirePermission(["p2.payment_intent.read", "p2.wa_cost.read"]);
  const sp = await searchParams;
  const month = typeof sp.bulan === "string" && /^\d{4}-\d{2}$/.test(sp.bulan) ? sp.bulan : monthOf(toBusinessDate(ctx.now));
  const showPay = can(ctx, "p2.payment_intent.read");
  const showWa = can(ctx, "p2.wa_cost.read");
  const [payments, wa] = await Promise.all([showPay ? p2.listPaymentIntents(ctx) : Promise.resolve([]), showWa ? p2.waCostSummary(ctx, { month }) : Promise.resolve(null)]);
  const succeeded = payments.filter((p) => p.status === "succeeded" || p.status === "matched");
  return (
    <div className="grid gap-6">
      <PageHeader title="Pembayaran digital & WhatsApp" description="Pembayaran QRIS/virtual account dari aplikasi pelanggan dan biaya pesan WhatsApp Business API." />
      <P2OfficeTabs tabs={p2Tabs(ctx)} current="/keluhan/pembayaran" />
      {showPay ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <KpiTile label="Pembayaran berhasil" value={succeeded.length} />
            <KpiTile label="Nilai berhasil" value={formatRupiah(succeeded.reduce((s, p) => s + p.amount, 0))} />
            <KpiTile label="Biaya gerbang (beban)" value={formatRupiah(succeeded.reduce((s, p) => s + (p.gatewayFee ?? 0), 0))} hint="Dibukukan sebagai beban (PTB-50)" />
          </div>
          <SectionCard title="Pembayaran digital" flush actions={<ExportButtons excelHref="/api/export/p2.payment_intents?format=xlsx" pdfHref="/api/export/p2.payment_intents?format=pdf" />}>
            {payments.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">Belum ada pembayaran digital.</p>
            ) : (
              <Table data-testid="payment-intents">
                <TableHeader>
                  <TableRow>
                    <TableHead>Dibuat</TableHead>
                    <TableHead>Pelanggan</TableHead>
                    <TableHead className="hidden md:table-cell">Untuk</TableHead>
                    <TableHead className="text-right">Jumlah</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">No. gerbang</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="whitespace-nowrap">{formatTanggalJam(p.createdAt)}</TableCell>
                      <TableCell>
                        {p.customerName}
                        <span className="block text-xs text-muted-foreground">{p.method}</span>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">{p.target}</TableCell>
                      <TableCell className="text-right tabular">
                        {formatRupiah(p.amount)}
                        {p.gatewayFee ? <span className="block text-xs text-muted-foreground">biaya {formatRupiah(p.gatewayFee)}</span> : null}
                      </TableCell>
                      <TableCell>
                        <StatusBadge enumName="payment_intent_status" value={p.status} tone={p.status === "matched" ? "success" : p.status === "succeeded" ? "info" : p.status === "pending" ? "warning" : "muted"} />
                      </TableCell>
                      <TableCell className="hidden font-mono text-xs md:table-cell">{p.gatewayOrderId}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </SectionCard>
        </>
      ) : null}
      {wa ? (
        <SectionCard
          title={`Biaya pesan WhatsApp — ${wa.month}`}
          description={wa.providerActive ? "WhatsApp Business API aktif: konfirmasi, struk, status, dan pengingat terkirim otomatis." : "Mode tautan (wa.me): pesan dibuka manual; tidak ada biaya API."}
          actions={<ExportButtons excelHref={`/api/export/p2.wa_costs?format=xlsx&month=${wa.month}`} pdfHref={`/api/export/p2.wa_costs?format=pdf&month=${wa.month}`} />}
        >
          <form method="get" className="mb-4 flex items-end gap-2 text-sm">
            <label className="grid gap-1">
              Bulan
              <input type="month" name="bulan" defaultValue={wa.month} className="h-9 rounded-md border border-input bg-transparent px-2" />
            </label>
            <button type="submit" className="h-9 rounded-md border px-3">
              Tampilkan
            </button>
          </form>
          <p className="mb-3 text-lg font-semibold" data-testid="wa-cost-total">
            Total {formatRupiah(wa.totalCost)} · {wa.billableMessages} pesan tertagih
          </p>
          <div className="grid gap-6 md:grid-cols-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kategori</TableHead>
                  <TableHead className="text-right">Pesan</TableHead>
                  <TableHead className="text-right">Biaya</TableHead>
                  <TableHead className="text-right">Tarif</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(wa.pricing).map(([cat, price]) => {
                  const row = wa.byCategory.find((c) => c.category === cat);
                  return (
                    <TableRow key={cat}>
                      <TableCell>{cat}</TableCell>
                      <TableCell className="text-right tabular">{row?.count ?? 0}</TableCell>
                      <TableCell className="text-right tabular">{formatRupiah(row?.amount ?? 0)}</TableCell>
                      <TableCell className="text-right tabular">{formatRupiah(price)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Jenis pesan</TableHead>
                  <TableHead className="text-right">Terkirim</TableHead>
                  <TableHead className="text-right">Sampai</TableHead>
                  <TableHead className="text-right">Dibaca</TableHead>
                  <TableHead className="text-right">Gagal</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {wa.byKind.map((k) => (
                  <TableRow key={k.kind}>
                    <TableCell>{k.label}</TableCell>
                    <TableCell className="text-right tabular">{k.sent}</TableCell>
                    <TableCell className="text-right tabular">{k.delivered}</TableCell>
                    <TableCell className="text-right tabular">{k.read}</TableCell>
                    <TableCell className="text-right tabular">{k.failed}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
