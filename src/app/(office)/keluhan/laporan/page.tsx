import type { Metadata } from "next";

import { P2OfficeTabs } from "@/components/p2-customer/office-tabs";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumValues, label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { requirePermission } from "@/server/core/auth/office";
import * as p2 from "@/server/modules/p2-customer";

import { p2Tabs } from "../_tabs";

export const metadata: Metadata = { title: "Laporan aplikasi pelanggan" };

/**
 * Laporan aplikasi pelanggan: adopsi (8.2 "Pemilik — penilaian, keluhan, adopsi") dan laporan bulanan keluhan per
 * jenis & per truk (US-P2-06 KP-3).
 */
export default async function LaporanAplikasiPage({ searchParams }: PageProps<"/keluhan/laporan">) {
  const { ctx } = await requirePermission("p2.adoption.read");
  const sp = await searchParams;
  const month = typeof sp.bulan === "string" && /^\d{4}-\d{2}$/.test(sp.bulan) ? sp.bulan : null;
  const [a, rep] = await Promise.all([p2.adoptionOverview(ctx, { month }), p2.complaintReport(ctx, { month })]);
  const kinds = enumValues("complaint_kind");
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Laporan aplikasi pelanggan"
        description={`Bulan ${a.month}. Aplikasi ${a.enabled ? "aktif" : "belum aktif (flag phase2.customer_app mati)"}.`}
        actions={<ExportButtons excelHref={`/api/export/p2.complaints_monthly?format=xlsx&month=${a.month}`} pdfHref={`/api/export/p2.complaints_monthly?format=pdf&month=${a.month}`} />}
      />
      <P2OfficeTabs tabs={p2Tabs(ctx)} current="/keluhan/laporan" />
      <form method="get" className="flex items-end gap-2 text-sm">
        <label className="grid gap-1">
          Bulan
          <input type="month" name="bulan" defaultValue={a.month} className="h-9 rounded-md border border-input bg-transparent px-2" />
        </label>
        <button type="submit" className="h-9 rounded-md border px-3">
          Tampilkan
        </button>
      </form>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="adoption">
        <KpiTile label="Akun terhubung" value={a.linkedAccounts} hint={a.accounts.map((x) => `${x.label}: ${x.count}`).join(" · ") || "Belum ada akun"} />
        <KpiTile label="Pesanan dari aplikasi" value={`${a.ordersFromApp} dari ${a.ordersTotal}`} hint={`${a.appSharePct.toLocaleString("id-ID")}% dari pesanan truk`} />
        <KpiTile label="Konfirmasi tepat waktu (PAR-75)" value={a.appOrdersConfirmedOnTime} hint={`Terlambat ${a.appOrdersConfirmedLate} · ditolak ${a.appOrdersRejected} · batal pelanggan ${a.appOrdersCancelledByCustomer}`} tone={a.appOrdersConfirmedLate ? "warning" : "neutral"} />
        <KpiTile label="Pembayaran digital" value={formatRupiah(a.digitalPayments.amount)} hint={`${a.digitalPayments.count} transaksi · biaya gerbang ${formatRupiah(a.digitalPayments.fees)}`} />
        <KpiTile label="Rata-rata penilaian" value={a.rating.count ? a.rating.average.toLocaleString("id-ID") : "—"} hint={`${a.rating.count} penilaian`} />
        <KpiTile label="Keluhan" value={a.complaints.total} hint={`Belum selesai ${a.complaints.open} · lewat tenggat ${a.complaints.overdue}`} tone={a.complaints.overdue ? "danger" : "neutral"} />
        <KpiTile label="Rata-rata tanggapan pertama" value={rep.avgFirstResponseHours != null ? `${rep.avgFirstResponseHours.toLocaleString("id-ID")} jam` : "—"} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Keluhan per jenis" flush>
          <Table data-testid="complaints-by-kind">
            <TableHeader>
              <TableRow>
                <TableHead>Jenis</TableHead>
                <TableHead className="text-right">Jumlah</TableHead>
                <TableHead className="text-right">Belum selesai</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rep.byKind.map((k) => (
                <TableRow key={k.kind}>
                  <TableCell>{k.label}</TableCell>
                  <TableCell className="text-right tabular">{k.count}</TableCell>
                  <TableCell className="text-right tabular">{k.open}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SectionCard>
        <SectionCard title="Keluhan per truk" flush>
          {rep.byTruck.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Belum ada keluhan bulan ini.</p>
          ) : (
            <Table data-testid="complaints-by-truck">
              <TableHeader>
                <TableRow>
                  <TableHead>Truk</TableHead>
                  <TableHead className="text-right">Jumlah</TableHead>
                  {kinds.map((k) => (
                    <TableHead key={k} className="hidden text-right md:table-cell">
                      {label("complaint_kind", k)}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rep.byTruck.map((t) => (
                  <TableRow key={t.truckId ?? "none"}>
                    <TableCell>{t.truck}</TableCell>
                    <TableCell className="text-right tabular">{t.count}</TableCell>
                    {kinds.map((k) => (
                      <TableCell key={k} className="hidden text-right tabular md:table-cell">
                        {t.kinds[k] ?? 0}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
