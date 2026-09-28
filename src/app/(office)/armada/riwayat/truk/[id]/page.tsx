import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ReplayPlayer } from "@/components/m12-fleet/replay-player";
import { TrackMap } from "@/components/m12-fleet/track-map";
import { EventKindBadge, EventStatusBadge, formatDistance, formatDuration } from "@/components/m12-fleet/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { OfficeBreadcrumbLabel } from "@/components/shared/office-shell";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isUuid } from "@/lib/ids";
import type { EnumValue, FleetEventKind } from "@/lib/labels";
import { addDays, businessDateToUtcRange, formatJam, formatTanggal, isBusinessDate, toBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { NotFoundError } from "@/server/core/errors";
import { can } from "@/server/core/rbac";
import * as m12 from "@/server/modules/m12-fleet";

export const metadata: Metadata = { title: "Riwayat truk per hari" };

async function load(ctx: Parameters<typeof m12.getTruckDay>[0], input: { truckId: string; date: string }) {
  try {
    return await m12.getTruckDay(ctx, input);
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}

/**
 * Riwayat satu truk satu hari (US-M12-03 KP-2/KP-3; KPI-07): jarak total, bergerak/berhenti, gerak pertama & terakhir,
 * rit terjadwal vs Selesai, jarak antar-rit, titik berhenti, kejadian, putar ulang jejak hari itu.
 */
export default async function TruckDayPage({ params, searchParams }: PageProps<"/armada/riwayat/truk/[id]">) {
  const { ctx } = await requirePermission("m12.trip_history.read");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const sp = await searchParams;
  const today = toBusinessDate(ctx.now);
  const date = typeof sp.tanggal === "string" && isBusinessDate(sp.tanggal) && sp.tanggal <= today ? sp.tanggal : today;
  const day = await load(ctx, { truckId: id, date });
  if (!day) notFound();
  const canExport = can(ctx, "m12.trip_history.export");
  const dayEnd = businessDateToUtcRange(date).end;
  const replayTo = (date === today ? ctx.now : new Date(dayEnd.getTime() - 1000)).toISOString();

  return (
    <div className="grid gap-6">
      <OfficeBreadcrumbLabel label={`${day.truckCode} ${formatTanggal(date, { weekday: false })}`} />
      <PageHeader
        title={`Truk ${day.truckCode} — ${formatTanggal(date)}`}
        description={`${day.plateNumber}. Jarak dari jejak perangkat; bila hanya titik status ponsel, jarak diestimasi rute peta.`}
        backHref={`/armada/riwayat?tanggal=${date}`}
        backLabel="Riwayat perjalanan"
        meta={day.isEstimated ? <ToneBadge tone="warning">Jarak estimasi</ToneBadge> : null}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="icon" aria-label="Hari sebelumnya">
              <Link href={`/armada/riwayat/truk/${id}?tanggal=${addDays(date, -1)}`}>
                <ChevronLeft aria-hidden />
              </Link>
            </Button>
            {date < today ? (
              <Button asChild variant="outline" size="icon" aria-label="Hari berikutnya">
                <Link href={`/armada/riwayat/truk/${id}?tanggal=${addDays(date, 1)}`}>
                  <ChevronRight aria-hidden />
                </Link>
              </Button>
            ) : null}
            {canExport ? (
              <ExportButtons excelHref={`/api/export/m12.stops?format=xlsx&from=${date}&to=${date}&truckId=${id}`} pdfHref={`/api/export/m12.trips?format=pdf&from=${date}&to=${date}&truckId=${id}`} />
            ) : null}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Jarak total" value={formatDistance(day.distanceM)} hint={day.isEstimated ? "Estimasi dari titik status" : `${day.pointCount} posisi`} />
        <KpiTile label="Bergerak / berhenti" value={`${formatDuration(day.movingS)} / ${formatDuration(day.stoppedS)}`} />
        <KpiTile label="Gerak pertama–terakhir" value={day.firstMoveAt ? `${formatJam(day.firstMoveAt)}–${day.lastMoveAt ? formatJam(day.lastMoveAt) : "…"}` : "—"} />
        <KpiTile label="Rit Selesai / terjadwal (KPI-07)" value={`${day.completedTrips} / ${day.scheduledTrips}`} hint={day.failedTrips ? `${day.failedTrips} gagal` : undefined} tone={day.scheduledTrips && day.completedTrips < day.scheduledTrips ? "warning" : undefined} />
        <KpiTile label="Jarak antar-rit" value={formatDistance(day.betweenTripDistanceM)} hint="Kembali ke sumber di antara rit" />
        <KpiTile label="GPS mati/dicabut" value={day.gpsDeadMinutes ? `${day.gpsDeadMinutes} mnt` : "—"} tone={day.gpsDeadMinutes > 120 ? "danger" : undefined} />
      </div>

      <SectionCard title="Jejak hari ini" description="Oranye = titik berhenti ≥ PAR-49.">
        <TrackMap path={day.path} estimated={day.isEstimated} stops={day.stops} ariaLabel={`Jejak truk ${day.truckCode}`} />
      </SectionCard>

      {can(ctx, "m12.position.read") && !day.isEstimated && day.pointCount > 1 ? (
        <SectionCard title="Putar ulang" description="Jejak 24 jam sampai akhir hari ini.">
          <ReplayPlayer truckId={id} to={replayTo} />
        </SectionCard>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title={`Rit (${day.trips.length})`} flush>
          {day.trips.length === 0 ? (
            <EmptyState compact title="Tidak ada rit berjejak" />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Rit</TableHead>
                    <TableHead>Pelanggan</TableHead>
                    <TableHead>Waktu</TableHead>
                    <TableHead className="text-right">Jarak</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {day.trips.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell>
                        <Link href={`/armada/riwayat/rit/${t.id}`} className="font-medium text-primary hover:underline">
                          {t.number}
                        </Link>
                        <span className="block">
                          <StatusBadge enumName="trip_status" value={t.status as EnumValue<"trip_status">} />
                        </span>
                      </TableCell>
                      <TableCell>{t.customerName}</TableCell>
                      <TableCell>{t.departedAt ? `${formatJam(t.departedAt)}–${t.endedAt ? formatJam(t.endedAt) : "…"}` : "—"}</TableCell>
                      <TableCell className="text-right">
                        {formatDistance(t.distanceM)}
                        {t.isEstimated ? <span className="block text-xs text-warning-foreground">estimasi</span> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </SectionCard>

        <SectionCard title={`Titik berhenti (${day.stops.length})`} flush>
          {day.stops.length === 0 ? (
            <EmptyState compact title="Tidak ada titik berhenti ≥ PAR-49" />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Waktu</TableHead>
                    <TableHead className="text-right">Lama</TableHead>
                    <TableHead>Tempat</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {day.stops.map((s) => (
                    <TableRow key={s.startedAt}>
                      <TableCell>
                        {formatJam(s.startedAt)}–{formatJam(s.endedAt)}
                      </TableCell>
                      <TableCell className="text-right">{formatDuration(s.durationS)}</TableCell>
                      <TableCell>{s.place ?? "Di luar lokasi sah"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard title={`Kejadian armada (${day.events.length})`} flush>
        {day.events.length === 0 ? (
          <EmptyState compact title="Tidak ada kejadian" />
        ) : (
          <ul className="grid gap-2 p-4 text-sm">
            {day.events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2">
                <EventKindBadge kind={e.kind as FleetEventKind} />
                <EventStatusBadge status={e.status as EnumValue<"fleet_event_status">} />
                <span className="text-muted-foreground">{formatJam(e.startedAt)}</span>
                {e.distanceM != null ? <span>{formatDistance(e.distanceM)}</span> : null}
                {e.durationS != null ? <span>{formatDuration(e.durationS)}</span> : null}
                {can(ctx, "m12.fleet_event.read") ? (
                  <Link href={`/armada/kejadian/${e.id}`} className="text-primary hover:underline">
                    Rincian
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
