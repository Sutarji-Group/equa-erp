import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { formatDistance, formatDuration } from "@/components/m12-fleet/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { EnumValue } from "@/lib/labels";
import { addDays, formatJam, formatTanggal, isBusinessDate, toBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m12 from "@/server/modules/m12-fleet";

export const metadata: Metadata = { title: "Riwayat perjalanan" };

/**
 * Riwayat perjalanan per truk per hari & per rit (US-M12-03; KPI-07): jarak, waktu bergerak/berhenti, gerak pertama &
 * terakhir, rit terjadwal vs Selesai, jarak antar-rit; per rit jejak, titik berhenti, lama di pelanggan. Jarak dari
 * jejak perangkat; hanya titik status → estimasi rute peta (ditandai). Ekspor PDF ringkasan & Excel titik berhenti.
 */
export default async function RiwayatPage({ searchParams }: PageProps<"/armada/riwayat">) {
  const { ctx } = await requirePermission("m12.trip_history.read");
  const sp = await searchParams;
  const today = toBusinessDate(ctx.now);
  const date = typeof sp.tanggal === "string" && isBusinessDate(sp.tanggal) && sp.tanggal <= today ? sp.tanggal : today;
  const [days, trips] = await Promise.all([m12.listTruckDays(ctx, { date }), m12.listTripHistory(ctx, { date })]);
  const canExport = can(ctx, "m12.trip_history.export");
  const q = `from=${date}&to=${date}`;
  const totalKm = days.rows.reduce((s, r) => s + (r.distanceM ?? 0), 0);
  const scheduled = days.rows.reduce((s, r) => s + r.scheduledTrips, 0);
  const completed = days.rows.reduce((s, r) => s + r.completedTrips, 0);

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Riwayat perjalanan"
        description={`${formatTanggal(date)} — jejak, jarak, dan titik berhenti per truk dan per rit.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="icon" aria-label="Hari sebelumnya">
              <Link href={`/armada/riwayat?tanggal=${addDays(date, -1)}`}>
                <ChevronLeft aria-hidden />
              </Link>
            </Button>
            <form method="get" className="flex items-center gap-2">
              <input type="date" name="tanggal" defaultValue={date} max={today} aria-label="Tanggal" className="h-9 rounded-md border border-input bg-transparent px-2 text-sm" />
              <Button type="submit" variant="outline" size="sm">
                Tampilkan
              </Button>
            </form>
            {date < today ? (
              <Button asChild variant="outline" size="icon" aria-label="Hari berikutnya">
                <Link href={`/armada/riwayat?tanggal=${addDays(date, 1)}`}>
                  <ChevronRight aria-hidden />
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile label="Jarak armada" value={formatDistance(totalKm)} hint={days.rows.some((r) => r.isEstimated) ? "Sebagian estimasi (hanya titik status)" : "Dari jejak perangkat/ponsel"} />
        <KpiTile label="Rit Selesai / terjadwal (KPI-07)" value={`${completed} / ${scheduled}`} tone={scheduled && completed < scheduled ? "warning" : undefined} />
        <KpiTile label="Rit berjejak" value={String(trips.rows.length)} hint={`${trips.rows.filter((r) => r.hasGaps).length} dengan celah jejak`} />
      </div>

      <SectionCard
        title="Per truk"
        description="Jarak total, waktu bergerak & berhenti, gerak pertama & terakhir, jarak antar-rit (kembali ke sumber), berdampingan dengan rit terjadwal vs Selesai."
        actions={canExport ? <ExportButtons excelHref={`/api/export/m12.truck_days?format=xlsx&${q}`} pdfHref={`/api/export/m12.truck_days?format=pdf&${q}`} /> : null}
        flush
      >
        {days.rows.length === 0 ? (
          <EmptyState compact title="Tidak ada truk aktif" />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="riwayat-truk">
              <TableHeader>
                <TableRow>
                  <TableHead>Truk</TableHead>
                  <TableHead className="text-right">Jarak</TableHead>
                  <TableHead className="text-right">Bergerak</TableHead>
                  <TableHead className="text-right">Berhenti</TableHead>
                  <TableHead>Gerak pertama–terakhir</TableHead>
                  <TableHead className="text-right">Rit Selesai / terjadwal</TableHead>
                  <TableHead className="text-right">Antar-rit</TableHead>
                  <TableHead className="text-right">GPS mati</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {days.rows.map((r) => (
                  <TableRow key={r.truckId}>
                    <TableCell>
                      <Link href={`/armada/riwayat/truk/${r.truckId}?tanggal=${date}`} className="font-medium text-primary hover:underline">
                        {r.truckCode}
                      </Link>
                      <span className="block text-xs text-muted-foreground">{r.plateNumber}</span>
                    </TableCell>
                    <TableCell className="text-right">
                      {formatDistance(r.distanceM)}
                      {r.isEstimated ? (
                        <ToneBadge tone="warning" className="ml-1">
                          estimasi
                        </ToneBadge>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">{formatDuration(r.movingS)}</TableCell>
                    <TableCell className="text-right">{formatDuration(r.stoppedS)}</TableCell>
                    <TableCell>{r.firstMoveAt ? `${formatJam(r.firstMoveAt)}–${r.lastMoveAt ? formatJam(r.lastMoveAt) : "…"}` : "—"}</TableCell>
                    <TableCell className="text-right">
                      {r.completedTrips} / {r.scheduledTrips}
                      {r.failedTrips ? <span className="block text-xs text-destructive">{r.failedTrips} gagal</span> : null}
                    </TableCell>
                    <TableCell className="text-right">{formatDistance(r.betweenTripDistanceM)}</TableCell>
                    <TableCell className="text-right">{r.gpsDeadMinutes ? `${r.gpsDeadMinutes} mnt` : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Per rit"
        description="Jejak Berangkat → Selesai/Gagal. Buka rit untuk peta, titik berhenti, bukti kirim, dan pengisian."
        actions={
          canExport ? (
            <div className="flex flex-wrap gap-2">
              <ExportButtons excelHref={`/api/export/m12.trips?format=xlsx&${q}`} pdfHref={`/api/export/m12.trips?format=pdf&${q}`} />
              <Button asChild variant="outline" size="sm">
                <a href={`/api/export/m12.stops?format=xlsx&${q}`}>Excel titik berhenti</a>
              </Button>
            </div>
          ) : null
        }
        flush
      >
        {trips.rows.length === 0 ? (
          <EmptyState compact title="Belum ada rit berjejak pada tanggal ini" />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="riwayat-rit">
              <TableHeader>
                <TableRow>
                  <TableHead>Rit</TableHead>
                  <TableHead>Truk</TableHead>
                  <TableHead>Pelanggan</TableHead>
                  <TableHead>Berangkat–akhir</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Jarak</TableHead>
                  <TableHead className="text-right">Durasi</TableHead>
                  <TableHead className="text-right">Berhenti</TableHead>
                  <TableHead className="text-right">Di pelanggan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trips.rows.map((r) => (
                  <TableRow key={r.tripId}>
                    <TableCell>
                      <Link href={`/armada/riwayat/rit/${r.tripId}`} className="font-medium text-primary hover:underline">
                        {r.number}
                      </Link>
                      {r.isInternal ? <span className="block text-xs text-muted-foreground">Rit internal</span> : null}
                    </TableCell>
                    <TableCell>{r.truckCode}</TableCell>
                    <TableCell>
                      {r.customerName}
                      <span className="block text-xs text-muted-foreground">{r.driverName ?? "—"}</span>
                    </TableCell>
                    <TableCell>{r.departedAt ? `${formatJam(r.departedAt)}–${r.endedAt ? formatJam(r.endedAt) : "berjalan"}` : "—"}</TableCell>
                    <TableCell>
                      <StatusBadge enumName="trip_status" value={r.status as EnumValue<"trip_status">} />
                    </TableCell>
                    <TableCell className="text-right">
                      {formatDistance(r.distanceM)}
                      {r.isEstimated ? (
                        <ToneBadge tone="warning" className="ml-1">
                          estimasi
                        </ToneBadge>
                      ) : null}
                      {r.hasGaps && !r.isEstimated ? <span className="block text-xs text-muted-foreground">ada celah jejak</span> : null}
                    </TableCell>
                    <TableCell className="text-right">{formatDuration(r.durationS)}</TableCell>
                    <TableCell className="text-right">{r.stopCount ? `${r.stopCount}× · ${formatDuration(r.stopTotalS)}` : "—"}</TableCell>
                    <TableCell className="text-right">{formatDuration(r.timeAtCustomerS)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
