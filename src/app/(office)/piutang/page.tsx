import type { Metadata } from "next";
import Link from "next/link";

import { M5ActionButton } from "@/components/m5-receivables/action-buttons";
import { ReminderBadge } from "@/components/m5-receivables/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatRupiah } from "@/lib/money";
import { formatTanggal } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m5 from "@/server/modules/m5-receivables";

import { evaluateHoldsAction } from "./actions";

export const metadata: Metadata = { title: "Ringkasan piutang" };

/**
 * Ringkasan piutang (US-M5-04 KP-3; KPI-04): posisi piutang kapan saja + daftar tindakan harian Admin Keuangan —
 * pelanggan yang perlu diingatkan (H-3/H+1) dan yang akan/sudah Ditahan.
 */
export default async function ReceivableOverviewPage() {
  const { ctx } = await requirePermission("m5.receivable.read");
  const [overview, actions, aging] = await Promise.all([m5.receivableOverview(ctx), m5.dailyActionList(ctx), m5.agingReport(ctx)]);
  const t = overview.totals;
  const canEvaluate = can(ctx, "m5.credit_hold.evaluate");
  const onTarget = t.overduePct < aging.kpi04TargetPercent;

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Ringkasan piutang"
        description={`Posisi per ${formatTanggal(overview.date)}. Faktur terbentuk otomatis dari rit tempo, penjualan tempo toko, kurang bayar, dan faktur bulanan.`}
        actions={
          <div className="flex flex-wrap gap-2">
            {canEvaluate ? <M5ActionButton label="Hitung ulang Ditahan" action={evaluateHoldsAction} testId="hitung-ditahan" /> : null}
            <Button asChild variant="outline" size="sm">
              <Link href="/piutang/umur">Umur piutang</Link>
            </Button>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Total piutang" value={<MoneyText value={t.total} />} hint={`${overview.openInvoiceCount} faktur terbuka · belum ditagih ${formatRupiah(t.unbilled)}`} href="/piutang/faktur?status=unpaid" hrefLabel="Lihat faktur" />
        <KpiTile
          label="Lewat tempo (KPI-04)"
          value={`${t.overduePct.toLocaleString("id-ID")}%`}
          hint={`${formatRupiah(t.overdue)} · sasaran < ${aging.kpi04TargetPercent.toLocaleString("id-ID")}%`}
          tone={onTarget ? "success" : "danger"}
          href="/piutang/umur"
          hrefLabel="Umur piutang"
        />
        <KpiTile label="Pelanggan Ditahan" value={String(overview.onHoldCount)} tone={overview.onHoldCount ? "danger" : undefined} href="/piutang/status-kredit" hrefLabel="Status kredit" />
        <KpiTile label="Uang muka tersedia" value={<MoneyText value={overview.openAdvanceTotal} />} hint="Otomatis dialokasikan ke faktur berikutnya" href="/piutang/pelunasan#uang-muka" hrefLabel="Uang muka" />
        <KpiTile label="Faktur bersengketa" value={String(overview.disputedCount)} tone={overview.disputedCount ? "warning" : undefined} href="/piutang/faktur?sengketa=1" hrefLabel="Lihat" />
        <KpiTile label="Transfer belum diterima" value={String(overview.pendingTransferCount)} hint="Piutang sementara dari transfer yang tidak ditemukan" href="/piutang/faktur?transfer=1" hrefLabel="Lihat" />
        <KpiTile label="Faktur bulanan belum dikirim" value={String(overview.monthlyReadyCount)} tone={overview.monthlyReadyCount ? "warning" : undefined} href="/piutang/faktur-bulanan" hrefLabel="Faktur bulanan" />
        <KpiTile label="Perlu diingatkan hari ini" value={String(actions.remind.length)} hint={`H-${actions.daysBeforeDue} sebelum & H+${actions.daysAfterDue} sesudah jatuh tempo (PAR-13)`} href="/piutang/pengingat" hrefLabel="Daftar pengingat" />
      </div>

      <SectionCard title={`Perlu diingatkan hari ini (H-${actions.daysBeforeDue} / H+${actions.daysAfterDue})`} description="Buka WhatsApp dari daftar pengingat; status 'Dibuka' tercatat." flush>
        {actions.remind.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="tindakan-ingatkan">
              <TableHeader>
                <TableRow>
                  <TableHead>Pelanggan</TableHead>
                  <TableHead>Pengingat</TableHead>
                  <TableHead>Faktur</TableHead>
                  <TableHead className="text-right">Total sisa</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {actions.remind.map((g) => (
                  <TableRow key={g.key}>
                    <TableCell>
                      <Link href={`/piutang/pelanggan/${g.customerId}`} className="font-medium text-primary hover:underline">
                        {g.customerName}
                      </Link>
                    </TableCell>
                    <TableCell>{m5.reminderKindLabel(g.kind, actions)}</TableCell>
                    <TableCell className="text-xs">{g.invoices.map((i) => i.number).join(", ")}</TableCell>
                    <TableCell className="text-right">{formatRupiah(g.total)}</TableCell>
                    <TableCell>
                      <ReminderBadge status={g.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Tidak ada pelanggan yang perlu diingatkan hari ini" compact />
        )}
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Akan Ditahan" description={`Faktur mendekati batas ${actions.toleranceDays} hari lewat tempo (PAR-09). Tagih sebelum tanggal Ditahan.`} flush>
          {actions.willHold.length ? (
            <div className="overflow-x-auto">
              <Table data-testid="tindakan-akan-ditahan">
                <TableHeader>
                  <TableRow>
                    <TableHead>Pelanggan</TableHead>
                    <TableHead className="text-right">Lewat tempo</TableHead>
                    <TableHead>Ditahan mulai</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {actions.willHold.map((r) => (
                    <TableRow key={r.customerId}>
                      <TableCell>
                        <Link href={`/piutang/pelanggan/${r.customerId}`} className="font-medium text-primary hover:underline">
                          {r.name}
                        </Link>
                        <span className="block text-xs text-muted-foreground">{r.worstDaysPastDue} hari lewat tempo</span>
                      </TableCell>
                      <TableCell className="text-right">{formatRupiah(r.overdueTotal)}</TableCell>
                      <TableCell>{formatTanggal(r.holdOn, { weekday: false })}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState title="Tidak ada pelanggan yang akan Ditahan" compact />
          )}
        </SectionCard>

        <SectionCard title="Sudah Ditahan" description="Pesanan tempo baru diblokir; dilepas otomatis saat seluruh faktur lewat tempo lunas." flush>
          {actions.onHold.length ? (
            <div className="overflow-x-auto">
              <Table data-testid="tindakan-ditahan">
                <TableHeader>
                  <TableRow>
                    <TableHead>Pelanggan</TableHead>
                    <TableHead className="text-right">Lewat tempo</TableHead>
                    <TableHead>Terlama</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {actions.onHold.map((r) => (
                    <TableRow key={r.customerId}>
                      <TableCell>
                        <Link href={`/piutang/pelanggan/${r.customerId}`} className="font-medium text-primary hover:underline">
                          {r.name}
                        </Link>
                        <span className="block">
                          <StatusBadge enumName="credit_status" value={r.creditStatus} />
                        </span>
                      </TableCell>
                      <TableCell className="text-right">{formatRupiah(r.overdueTotal)}</TableCell>
                      <TableCell>{r.worstDaysPastDue ? <ToneBadge tone="danger">{r.worstDaysPastDue} hari</ToneBadge> : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState title="Tidak ada pelanggan Ditahan" compact />
          )}
        </SectionCard>
      </div>

      {actions.transition.length ? (
        <SectionCard title="Masa transisi (penahanan ditunda pemilik)" description="Tetap tampil di laporan lewat tempo (US-M5-03 KP-5)." flush>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pelanggan</TableHead>
                  <TableHead className="text-right">Lewat tempo</TableHead>
                  <TableHead>Berakhir</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {actions.transition.map((r) => (
                  <TableRow key={r.customerId}>
                    <TableCell>
                      <Link href={`/piutang/pelanggan/${r.customerId}`} className="font-medium text-primary hover:underline">
                        {r.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right">{formatRupiah(r.overdueTotal)}</TableCell>
                    <TableCell>{r.holdDeferralUntil ? formatTanggal(r.holdDeferralUntil, { weekday: false }) : "—"}</TableCell>
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
