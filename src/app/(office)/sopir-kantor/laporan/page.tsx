import type { Metadata } from "next";

import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { addDays, formatTanggal, formatTanggalJam, isBusinessDate, toBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m3 from "@/server/modules/m3-driver";

export const metadata: Metadata = { title: "Laporan sopir" };

const KIND_LABEL = { trip_completed: "Rit selesai", trip_failed: "Rit gagal", collection: "Pelunasan" } as const;
const METHOD_LABEL: Record<string, string> = { cash: "Tunai", transfer: "Transfer", credit: "Tempo", none: "—" };

/**
 * Laporan aplikasi sopir: pencatatan "dicatat kantor" (US-M3-09 KP-5, KPI-01 "tidak di sumber") dan setoran sopir,
 * plus tautan ekspor Excel/PDF untuk semua laporan M3 sesuai izin.
 */
export default async function LaporanSopirPage({ searchParams }: PageProps<"/sopir-kantor/laporan">) {
  const { ctx } = await requirePermission(["m3.office_entry.read", "m3.payment_report.read"]);
  const sp = await searchParams;
  const today = toBusinessDate(ctx.now);
  const to = typeof sp.sampai === "string" && isBusinessDate(sp.sampai) ? sp.sampai : today;
  const from = typeof sp.dari === "string" && isBusinessDate(sp.dari) && sp.dari <= to ? sp.dari : addDays(to, -30);
  const canOffice = can(ctx, "m3.office_entry.read");
  const canPayments = can(ctx, "m3.payment_report.read");
  const canTrips = can(ctx, "m2.trip.read") || can(ctx, "m3.trip_incident.read");
  const officeRows = canOffice ? await m3.officeEntryReport(ctx, { from, to }) : [];
  const depositRows = canPayments ? await m3.driverDepositReport(ctx, { from, to }) : [];
  const q = `from=${from}&to=${to}`;
  const exports: { key: string; title: string; show: boolean }[] = [
    { key: "m3.trips", title: "Rit sopir & bukti kirim", show: canTrips },
    { key: "m3.trip_payments", title: "Pembayaran rit", show: canPayments },
    { key: "m3.collections", title: "Pelunasan lewat sopir", show: canPayments },
    { key: "m3.expenses", title: "Pengeluaran rit", show: canPayments },
    { key: "m3.driver_deposits", title: "Setoran sopir", show: canPayments },
    { key: "m3.office_entries", title: "Dicatat kantor", show: canOffice },
  ];

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Laporan sopir"
        description={`${formatTanggal(from)} – ${formatTanggal(to)}.`}
        actions={
          <form method="get" className="flex flex-wrap items-center gap-2">
            <input type="date" name="dari" defaultValue={from} aria-label="Dari tanggal" className="h-9 rounded-md border border-input bg-transparent px-2 text-sm" />
            <input type="date" name="sampai" defaultValue={to} aria-label="Sampai tanggal" className="h-9 rounded-md border border-input bg-transparent px-2 text-sm" />
            <Button type="submit" variant="outline" size="sm">
              Tampilkan
            </Button>
          </form>
        }
      />

      <SectionCard title="Unduh laporan" description="Excel & PDF memakai rentang tanggal di atas.">
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {exports
            .filter((e) => e.show)
            .map((e) => (
              <li key={e.key} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                <span>{e.title}</span>
                <ExportButtons excelHref={`/api/export/${e.key}?format=xlsx&${q}`} pdfHref={`/api/export/${e.key}?format=pdf&${q}`} />
              </li>
            ))}
        </ul>
      </SectionCard>

      {canOffice ? (
        <SectionCard title={`Dicatat kantor (${officeRows.length})`} description="Pencatatan atas nama sopir oleh kantor — dihitung sebagai data yang tidak tercatat di sumber (KPI-01).">
          {officeRows.length === 0 ? (
            <EmptyState compact title="Tidak ada pencatatan kantor pada rentang ini" />
          ) : (
            <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <Table data-testid="office-entry-report">
                <TableHeader>
                  <TableRow>
                    <TableHead>Tanggal</TableHead>
                    <TableHead>Jenis</TableHead>
                    <TableHead>Rit</TableHead>
                    <TableHead>Pelanggan</TableHead>
                    <TableHead>Sopir</TableHead>
                    <TableHead className="text-right">Jumlah</TableHead>
                    <TableHead>Alasan</TableHead>
                    <TableHead>Dicatat oleh</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {officeRows.map((r, i) => (
                    <TableRow key={`${r.kind}-${r.tripNumber ?? i}-${r.recordedAt.getTime()}`}>
                      <TableCell className="whitespace-nowrap">{formatTanggal(r.businessDate)}</TableCell>
                      <TableCell>
                        <ToneBadge tone={r.kind === "trip_failed" ? "danger" : "warning"}>{KIND_LABEL[r.kind]}</ToneBadge>
                      </TableCell>
                      <TableCell>
                        {r.tripNumber ?? "—"}
                        {r.truckCode ? <span className="block text-xs text-muted-foreground">{r.truckCode}</span> : null}
                      </TableCell>
                      <TableCell>{r.customerName}</TableCell>
                      <TableCell>{r.driverName ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        {r.amount !== null ? <MoneyText value={r.amount} /> : "—"}
                        {r.paymentMethod ? <span className="block text-xs text-muted-foreground">{METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod}</span> : null}
                      </TableCell>
                      <TableCell className="max-w-72 text-sm">{r.reason ?? "—"}</TableCell>
                      <TableCell>
                        {r.recordedByName ?? "—"}
                        <span className="block text-xs text-muted-foreground">{formatTanggalJam(r.recordedAt)}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </SectionCard>
      ) : null}

      {canPayments ? (
        <SectionCard title={`Setoran sopir (${depositRows.length})`} description="Seharusnya disetor dihitung sistem; selisih & penutupan dilakukan di Kas & setoran (M4).">
          {depositRows.length === 0 ? (
            <EmptyState compact title="Belum ada setoran sopir pada rentang ini" />
          ) : (
            <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tanggal</TableHead>
                    <TableHead>No.</TableHead>
                    <TableHead>Sopir</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Seharusnya</TableHead>
                    <TableHead className="text-right">Diterima</TableHead>
                    <TableHead>Setor</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {depositRows.map((d) => (
                    <TableRow key={d.number}>
                      <TableCell className="whitespace-nowrap">{formatTanggal(d.businessDate)}</TableCell>
                      <TableCell>{d.number}</TableCell>
                      <TableCell>
                        {d.driverName ?? "—"}
                        {d.truckCode ? <span className="block text-xs text-muted-foreground">{d.truckCode}</span> : null}
                      </TableCell>
                      <TableCell>
                        <StatusBadge enumName="deposit_status" value={d.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        <MoneyText value={d.expectedNet} />
                      </TableCell>
                      <TableCell className="text-right">{d.receivedAmount !== null ? <MoneyText value={d.receivedAmount} /> : "—"}</TableCell>
                      <TableCell>
                        {d.submittedAt ? formatTanggalJam(d.submittedAt) : "—"}
                        {d.submittedLate ? <ToneBadge tone="warning" className="ml-1">Terlambat</ToneBadge> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </SectionCard>
      ) : null}
    </div>
  );
}
