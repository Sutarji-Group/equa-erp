import type { Metadata } from "next";
import Link from "next/link";

import { Amount, FilterForm, FilterInput, exportHref } from "@/components/m11-accounting/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { type StatusTone, ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatRupiah } from "@/lib/money";
import { formatTanggal } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m11 from "@/server/modules/m11-accounting";

export const metadata: Metadata = { title: "Utang usaha" };

type Search = Promise<{ per?: string }>;

const BUCKET_TONE: Record<string, StatusTone> = { not_due: "success", d1_7: "warning", d8_30: "danger", over_30: "danger" };

/**
 * Utang usaha (US-M11-07): utang dari nota pembelian M7 (termasuk saldo awal bertanda tangan) dan jurnal manual
 * bertanda utang; umur & jadwal pembayaran; laporan per pemasok & jatuh tempo; saldo buku sebagai pembanding.
 */
export default async function PayablesPage({ searchParams }: { searchParams: Search }) {
  const { ctx } = await requirePermission("m11.payable.read");
  const sp = await searchParams;
  const view = await m11.payablesView(ctx, { asOf: sp.per ?? null });
  const overdue = view.rows.filter((r) => r.daysOverdue > 0).reduce((s, r) => s + r.outstanding, 0);

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Utang usaha"
        description="Pembayaran pemasok dicatat di Toko > Utang pemasok (kas kantor/transfer); utang jurnal manual dibayar lewat jurnal pembayaran."
        actions={
          <div className="flex flex-wrap gap-2">
            {can(ctx, "m11.journal.create") ? (
              <Button asChild size="sm" variant="outline">
                <Link href="/akuntansi/jurnal/baru">Catat jurnal utang / pembayaran</Link>
              </Button>
            ) : null}
            <ExportButtons excelHref={exportHref("m11.payables", "xlsx", { asOf: view.asOf })} pdfHref={exportHref("m11.payables", "pdf", { asOf: view.asOf })} />
          </div>
        }
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile label="Total utang" value={<MoneyText value={view.total} />} hint={`Per ${formatTanggal(view.asOf)}`} />
        <KpiTile label="Lewat jatuh tempo" value={<MoneyText value={overdue} />} tone={overdue ? "danger" : "success"} />
        <KpiTile label="Saldo buku utang pemasok" value={view.bookBalance !== null ? <MoneyText value={view.bookBalance} /> : "—"} hint="Dari buku besar akun utang pemasok" />
      </div>

      <SectionCard title="Per pemasok & umur" flush actions={<FilterForm action="/akuntansi/utang"><FilterInput name="per" value={sp.per} label="Per tanggal" type="date" /></FilterForm>}>
        {view.bySupplier.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="utang-per-pemasok">
              <TableHeader>
                <TableRow>
                  <TableHead>Pemasok / pihak</TableHead>
                  <TableHead className="text-right">Belum jatuh tempo</TableHead>
                  <TableHead className="text-right">1–7 hari</TableHead>
                  <TableHead className="text-right">8–30 hari</TableHead>
                  <TableHead className="text-right">&gt; 30 hari</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.bySupplier.map((s) => (
                  <TableRow key={s.supplierName}>
                    <TableCell>{s.supplierName}</TableCell>
                    <TableCell className="text-right">
                      <Amount value={s.not_due} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={s.d1_7} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={s.d8_30} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={s.over_30} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={s.total} strong />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={5}>Jumlah</TableCell>
                  <TableCell className="text-right font-semibold">{formatRupiah(view.total)}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        ) : (
          <EmptyState title="Tidak ada utang terbuka" compact />
        )}
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-3">
        <SectionCard title="Jadwal pembayaran" className="lg:col-span-1">
          <ul className="grid gap-1 text-sm" data-testid="jadwal-utang">
            {view.schedule.map((s) => (
              <li key={s.when} className="flex justify-between gap-2">
                <span>{s.when}</span>
                <Amount value={s.amount} />
              </li>
            ))}
          </ul>
        </SectionCard>
        <SectionCard title="Rincian utang" flush className="lg:col-span-2">
          <div className="overflow-x-auto">
            <Table data-testid="rincian-utang">
              <TableHeader>
                <TableRow>
                  <TableHead>Dokumen</TableHead>
                  <TableHead>Pemasok</TableHead>
                  <TableHead>Jatuh tempo</TableHead>
                  <TableHead className="text-right">Nilai</TableHead>
                  <TableHead className="text-right">Sisa</TableHead>
                  <TableHead>Umur</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.rows.map((r) => (
                  <TableRow key={`${r.source}-${r.id}`}>
                    <TableCell className="text-sm">
                      <Link href={r.href} className="text-primary hover:underline">
                        {r.number ?? r.description}
                      </Link>
                      {r.isOpening ? <ToneBadge tone="info" className="ml-2">Saldo awal</ToneBadge> : null}
                      <span className="block text-xs text-muted-foreground">{r.source === "journal" ? "Jurnal manual" : "Nota pembelian"}</span>
                    </TableCell>
                    <TableCell>{r.supplierName}</TableCell>
                    <TableCell>{r.dueDate ? formatTanggal(r.dueDate, { weekday: false }) : "—"}</TableCell>
                    <TableCell className="text-right">
                      <Amount value={r.total} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={r.outstanding} strong />
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={BUCKET_TONE[r.bucket] ?? "neutral"} dot>
                        {m11.PAYABLE_AGING_LABELS[r.bucket]}
                      </ToneBadge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
