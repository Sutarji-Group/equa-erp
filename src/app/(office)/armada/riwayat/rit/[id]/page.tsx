import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { TrackMap } from "@/components/m12-fleet/track-map";
import { EventKindBadge, EventStatusBadge, formatDistance, formatDuration } from "@/components/m12-fleet/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KeyValueList } from "@/components/shared/key-value-list";
import { OfficeBreadcrumbLabel } from "@/components/shared/office-shell";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isUuid } from "@/lib/ids";
import type { EnumValue, FleetEventKind } from "@/lib/labels";
import { formatJam, formatTanggalJam, toBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { NotFoundError } from "@/server/core/errors";
import { can } from "@/server/core/rbac";
import * as m12 from "@/server/modules/m12-fleet";

export const metadata: Metadata = { title: "Riwayat rit" };

const STATUS_TEXT: Record<string, string> = { departed: "Berangkat", arrived: "Tiba", completed: "Selesai", failed: "Gagal" };

async function load(ctx: Parameters<typeof m12.getTripHistory>[0], id: string) {
  try {
    return await m12.getTripHistory(ctx, id);
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}

/** Riwayat satu rit (US-M12-03 KP-1/KP-4): jejak, jarak, durasi, titik berhenti, lama di pelanggan, bukti kirim, pengisian. */
export default async function TripHistoryPage({ params }: PageProps<"/armada/riwayat/rit/[id]">) {
  const { ctx } = await requirePermission("m12.trip_history.read");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const detail = await load(ctx, id);
  if (!detail) notFound();
  const { trip, track } = detail;
  const date = trip.completionBusinessDate ?? trip.scheduledDate ?? toBusinessDate(ctx.now);
  const canExport = can(ctx, "m12.trip_history.export");

  return (
    <div className="grid gap-6">
      <OfficeBreadcrumbLabel label={trip.number} />
      <PageHeader
        title={`Rit ${trip.number}`}
        description={`${detail.truckCode} · ${detail.customerName} · ${detail.addressText}`}
        backHref={`/armada/riwayat?tanggal=${date}`}
        backLabel="Riwayat perjalanan"
        meta={
          <>
            <StatusBadge enumName="trip_status" value={trip.status as EnumValue<"trip_status">} />
            {track.isEstimated ? <ToneBadge tone="warning">Jarak estimasi</ToneBadge> : null}
            {track.hasGaps && !track.isEstimated ? <ToneBadge tone="muted">Ada celah jejak</ToneBadge> : null}
            {trip.isInternal ? <ToneBadge tone="info">Rit internal</ToneBadge> : null}
          </>
        }
        actions={canExport ? <ExportButtons excelHref={`/api/export/m12.stops?format=xlsx&from=${date}&to=${date}&truckId=${trip.truckId}`} pdfHref={`/api/export/m12.trips?format=pdf&from=${date}&to=${date}&truckId=${trip.truckId}`} /> : null}
      />

      <SectionCard>
        <KeyValueList
          columns={3}
          items={[
            { label: "Pesanan", value: <Link href={`/pesanan/${trip.orderId}`} className="text-primary hover:underline">{detail.orderNumber}</Link> },
            { label: "Pelaksana", value: detail.driverName ?? "—" },
            { label: "Berangkat", value: track.startedAt ? formatTanggalJam(track.startedAt) : "—" },
            { label: trip.status === "failed" ? "Gagal" : "Selesai", value: track.endedAt ? formatTanggalJam(track.endedAt) : "Masih berjalan" },
            { label: "Jarak", value: `${formatDistance(track.distanceM)}${track.isEstimated ? " (estimasi rute peta dari titik status)" : ""}` },
            { label: "Durasi", value: formatDuration(track.durationS) },
            { label: "Lama di pelanggan", value: formatDuration(track.timeAtCustomerS) },
            { label: "Titik berhenti ≥ PAR-49", value: `${track.stops.length}× · ${formatDuration(track.stops.reduce((s, x) => s + x.durationS, 0))}` },
            { label: "Sumber jejak", value: track.source === "gps_device" ? "Perangkat GPS" : track.source === "phone" ? "GPS ponsel cadangan" : track.source === "mixed" ? "Perangkat GPS + ponsel" : "Titik status rit saja" },
          ]}
        />
      </SectionCard>

      <SectionCard title="Peta jejak" description="Jalur disederhanakan; oranye = titik berhenti, hijau = titik status rit, abu-abu = tujuan.">
        <TrackMap
          path={track.path}
          estimated={track.isEstimated}
          stops={track.stops}
          statusPoints={detail.statusPoints}
          target={track.target ? { ...track.target, label: track.target.kind === "depot" ? "Depot tujuan" : "Alamat kirim" } : null}
          ariaLabel={`Jejak rit ${trip.number}`}
        />
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Titik berhenti" flush>
          {track.stops.length === 0 ? (
            <EmptyState compact title={track.isEstimated ? "Tidak tersedia (hanya titik status)" : "Tidak ada titik berhenti ≥ PAR-49"} />
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
                  {track.stops.map((s) => (
                    <TableRow key={s.startedAt}>
                      <TableCell>
                        {formatJam(s.startedAt)}–{formatJam(s.endedAt)}
                      </TableCell>
                      <TableCell className="text-right">{formatDuration(s.durationS)}</TableCell>
                      <TableCell>
                        {s.place ?? (
                          <a className="text-primary hover:underline" href={`https://www.google.com/maps?q=${s.lat},${s.lng}`} target="_blank" rel="noreferrer">
                            Di luar lokasi dikenal
                          </a>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Titik status, bukti kirim & pengisian">
          <ul className="grid gap-2 text-sm">
            {detail.statusPoints.map((s) => (
              <li key={s.status}>
                {STATUS_TEXT[s.status] ?? s.status} {formatTanggalJam(s.at)} ·{" "}
                <a className="text-primary hover:underline" href={`https://www.google.com/maps?q=${s.lat},${s.lng}`} target="_blank" rel="noreferrer">
                  lokasi
                </a>
              </li>
            ))}
            {detail.statusPoints.length === 0 ? <li className="text-muted-foreground">Tanpa titik status berlokasi.</li> : null}
            <li className="flex flex-wrap gap-2">
              {detail.photos.length ? (
                detail.photos.map((p, i) => (
                  <a key={p.id} href={`/api/attachments/${p.id}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    {p.kind === "signature" ? "Tanda tangan" : `Foto bukti kirim ${i + 1}`}
                  </a>
                ))
              ) : (
                <span className="text-muted-foreground">Belum ada bukti kirim.</span>
              )}
            </li>
            <li>
              {detail.fill ? (
                <>
                  Pengisian {detail.fill.volumeL.toLocaleString("id-ID")} L di {detail.fill.waterSourceName} {formatTanggalJam(detail.fill.filledAt)}
                  {detail.fill.geofenceFlag ? (
                    <ToneBadge tone="danger" className="ml-2">
                      Tanpa geofence sumber
                    </ToneBadge>
                  ) : null}
                </>
              ) : (
                <span className="text-muted-foreground">Pengisian (M8) belum tercatat untuk rit ini.</span>
              )}
            </li>
          </ul>
        </SectionCard>
      </div>

      <SectionCard title="Kejadian terkait" flush>
        {detail.events.length === 0 ? (
          <EmptyState compact title="Tidak ada kejadian armada untuk rit ini" />
        ) : (
          <ul className="grid gap-2 p-4 text-sm">
            {detail.events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2">
                <EventKindBadge kind={e.kind as FleetEventKind} />
                <EventStatusBadge status={e.status as EnumValue<"fleet_event_status">} />
                <span className="text-muted-foreground">{formatTanggalJam(e.startedAt)}</span>
                {e.distanceM != null ? <span>{formatDistance(e.distanceM)}</span> : null}
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
