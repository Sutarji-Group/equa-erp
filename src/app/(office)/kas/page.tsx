import type { Metadata } from "next";
import Link from "next/link";

import { DateFilterInput, FilterForm, hrefWith } from "@/components/m4-cash/fields";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge, type StatusTone } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, isBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m4 from "@/server/modules/m4-cash";

export const metadata: Metadata = { title: "Kas hari ini" };

function toneOf(status: m4.CashSourceRow["status"]): StatusTone {
  switch (status) {
    case "closed":
    case "cash_day_closed":
      return "success";
    case "received":
      return "info";
    case "submitted":
    case "shift_open":
      return "warning";
    case "none":
      return "muted";
    default:
      return "neutral";
  }
}

/**
 * Kas hari ini (US-M4-01): satu baris per sumber (sopir bertugas, depot, toko, kas kantor) — seharusnya, status setoran,
 * diterima, selisih, alasan; kolom terpisah transfer belum dicocokkan & QRIS; sorotan terlambat; total per lini.
 */
export default async function CashTodayPage({ searchParams }: { searchParams: Promise<{ tanggal?: string }> }) {
  const { ctx } = await requirePermission("m4.cash_position.read");
  const sp = await searchParams;
  const date = sp.tanggal && isBusinessDate(sp.tanggal) ? sp.tanggal : null;
  const pos = await m4.getCashPosition(ctx, { date });
  const canExport = can(ctx, "m4.cash_position.export");
  const flagged = pos.rows.filter((r) => r.flags.length).length;
  const byLine = (line: m4.CashLine) => pos.rows.filter((r) => r.line === line);

  return (
    <div className="grid grid-cols-1 gap-6">
      <PageHeader
        title="Kas hari ini"
        description={`${formatTanggal(pos.date)} — angka seharusnya dihitung sistem dari data sopir, depot, dan toko yang sudah tersinkron.`}
        actions={
          canExport ? (
            <ExportButtons excelHref={hrefWith("/api/export/m4.cash_position", { format: "xlsx", date: pos.date })} pdfHref={hrefWith("/api/export/m4.cash_position", { format: "pdf", date: pos.date })} />
          ) : null
        }
      />
      <FilterForm action="/kas">
        <DateFilterInput name="tanggal" value={pos.date} label="Tanggal (riwayat)" />
      </FilterForm>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Seharusnya (semua sumber)" value={<MoneyText value={pos.overall.expected} />} unclosed={pos.cashDayStatus === "open" ? "Kas belum ditutup — angka dapat berubah" : undefined} />
        <KpiTile label="Diterima" value={<MoneyText value={pos.overall.received} />} />
        <KpiTile label="Selisih" value={<MoneyText value={pos.overall.discrepancy} signed />} tone={pos.overall.discrepancy ? "danger" : "success"} href="/kas/selisih" hrefLabel="Lihat selisih" />
        <KpiTile label="Perlu perhatian" value={`${flagged} sumber`} tone={flagged ? "warning" : "success"} hint={`Transfer belum cocok ${formatRupiah(pos.overall.unmatchedTransfers)} · QRIS ${formatRupiah(pos.overall.qris)}`} />
      </div>

      {pos.totals.map((total) => {
        const rows = byLine(total.line);
        if (!rows.length) return null;
        return (
          <SectionCard key={total.line} title={total.label} flush>
            <div className="overflow-x-auto">
              <Table data-testid={`kas-${total.line}`}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Sumber</TableHead>
                    <TableHead className="text-right">Seharusnya</TableHead>
                    <TableHead>Status setoran</TableHead>
                    <TableHead className="text-right">Diterima</TableHead>
                    <TableHead className="text-right">Selisih</TableHead>
                    <TableHead>Alasan</TableHead>
                    <TableHead className="text-right">Transfer belum cocok</TableHead>
                    <TableHead className="text-right">QRIS</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.key} className={r.flags.length ? "bg-warning/10" : undefined} data-flagged={r.flags.length ? "true" : undefined}>
                      <TableCell className="min-w-56 whitespace-normal">
                        <span className="font-medium">
                          {r.depositIds[0] ? (
                            <Link href={`/kas/setoran/${r.depositIds[r.depositIds.length - 1]}`} className="text-primary hover:underline">
                              {r.label}
                            </Link>
                          ) : (
                            r.label
                          )}
                        </span>
                        {r.detail ? <span className="block text-xs text-muted-foreground">{r.detail}</span> : null}
                        {r.flags.map((f) => (
                          <span key={f.code} className="mt-1 block text-xs font-medium text-destructive">
                            ⚠ {f.text}
                          </span>
                        ))}
                      </TableCell>
                      <TableCell className="text-right font-medium">{formatRupiah(r.expected)}</TableCell>
                      <TableCell>
                        <ToneBadge tone={toneOf(r.status)} dot>
                          {r.statusText}
                        </ToneBadge>
                      </TableCell>
                      <TableCell className="text-right">{r.received === null ? "—" : formatRupiah(r.received)}</TableCell>
                      <TableCell className={`text-right ${r.discrepancy ? "font-medium text-destructive" : ""}`}>{r.discrepancy === null ? "—" : formatRupiah(r.discrepancy, { signed: true })}</TableCell>
                      <TableCell className="max-w-48 whitespace-normal text-sm">{r.reason ?? "—"}</TableCell>
                      <TableCell className="text-right">{r.unmatchedTransfers ? formatRupiah(r.unmatchedTransfers) : "—"}</TableCell>
                      <TableCell className="text-right">{r.qris ? formatRupiah(r.qris) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell className="font-medium">Total {total.label.toLowerCase()}</TableCell>
                    <TableCell className="text-right font-semibold">{formatRupiah(total.expected)}</TableCell>
                    <TableCell />
                    <TableCell className="text-right font-semibold">{formatRupiah(total.received)}</TableCell>
                    <TableCell className="text-right font-semibold">{formatRupiah(total.discrepancy, { signed: true })}</TableCell>
                    <TableCell />
                    <TableCell className="text-right">{formatRupiah(total.unmatchedTransfers)}</TableCell>
                    <TableCell className="text-right">{formatRupiah(total.qris)}</TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          </SectionCard>
        );
      })}
      <p className="text-xs text-muted-foreground">
        Sorotan: setoran sopir belum diajukan &gt; {pos.thresholds.driverSubmitHours} jam setelah rit terakhir Selesai (PAR-44), setoran depot/toko belum diterima &gt; {pos.thresholds.depotLateDays} hari sejak tutup shift
        (PAR-27), kas di laci outlet melebihi batas (PAR-02). Transfer & QRIS tidak termasuk kas fisik (PTB-04).
      </p>
    </div>
  );
}
