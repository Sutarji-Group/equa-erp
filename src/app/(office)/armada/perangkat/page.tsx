import type { Metadata } from "next";
import Link from "next/link";

import { M12ActionForm, NoteField } from "@/components/m12-fleet/action-form";
import { GpsHealthCard } from "@/components/m12-fleet/gps-health-card";
import { formatAge, GpsStateBadge } from "@/components/m12-fleet/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isUuid } from "@/lib/ids";
import { addDays, formatTanggalJam, toBusinessDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m12 from "@/server/modules/m12-fleet";

import { phoneTrackingAction } from "../actions";

export const metadata: Metadata = { title: "Perangkat GPS" };

/**
 * Perangkat GPS truk (US-M12-08; NFR-28): kesehatan (terakhir terlihat, daya, versi, status Aktif/Mati/Dicabut),
 * kejadian mati/dicabut 30 hari + pola berulang per truk, GPS ponsel cadangan (otomatis saat perangkat mati; admin sistem
 * dapat memaksa aktif/nonaktif dengan alasan).
 */
export default async function PerangkatPage({ searchParams }: PageProps<"/armada/perangkat">) {
  const { ctx } = await requirePermission("m12.fleet_event.read");
  const sp = await searchParams;
  const focus = typeof sp.truk === "string" && isUuid(sp.truk) ? sp.truk : null;
  const today = toBusinessDate(ctx.now);
  const from = addDays(today, -29);
  const [devicesList, outages] = await Promise.all([m12.listGpsDevices(ctx), m12.deviceOutageReport(ctx, { from, to: today })]);
  const canPhone = can(ctx, "m12.phone_tracking.enable");
  const installed = devicesList.filter((d) => d.truckId);
  const focused = focus ? devicesList.find((d) => d.truckId === focus) ?? null : null;

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Perangkat GPS"
        description="Perangkat tanpa posisi > PAR-25 menit pada jam layanan atau dengan daya terputus berstatus Mati/Dicabut; GPS ponsel sopir aktif otomatis sebagai cadangan."
        actions={<ExportButtons excelHref="/api/export/m12.gps_devices?format=xlsx" pdfHref="/api/export/m12.gps_devices?format=pdf" />}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Terpasang di truk" value={String(installed.length)} />
        <KpiTile label="Aktif" value={String(installed.filter((d) => d.gpsState === "active" && !d.stale).length)} tone="success" />
        <KpiTile label="Mati / dicabut" value={String(installed.filter((d) => d.gpsState === "dead" || d.gpsState === "unplugged").length)} tone={installed.some((d) => d.gpsState === "dead" || d.gpsState === "unplugged") ? "danger" : undefined} />
        <KpiTile label="GPS ponsel aktif" value={String(installed.filter((d) => d.phoneTracking).length)} />
      </div>

      {focused ? <GpsHealthCard health={focused} title={`Kesehatan perangkat GPS truk ${focused.truckCode}`} /> : null}

      <SectionCard title="Kesehatan perangkat" flush>
        {devicesList.length === 0 ? (
          <EmptyState compact title="Belum ada perangkat GPS terdaftar" description="Daftarkan di Akses > Perangkat lalu pasang di truk (Data master > Armada)." />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="perangkat-gps">
              <TableHeader>
                <TableRow>
                  <TableHead>Perangkat</TableHead>
                  <TableHead>Truk</TableHead>
                  <TableHead>Status GPS</TableHead>
                  <TableHead>Posisi terakhir</TableHead>
                  <TableHead>Terakhir terlihat</TableHead>
                  <TableHead>Daya</TableHead>
                  <TableHead>Versi</TableHead>
                  <TableHead className="text-right">Mati 30 hari</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devicesList.map((d) => (
                  <TableRow key={d.deviceId} className={cn(focus && d.truckId === focus && "bg-primary/5")}>
                    <TableCell>
                      <span className="font-medium">{d.deviceCode}</span>
                      <span className="block text-xs text-muted-foreground">{d.vendor ?? "—"}</span>
                    </TableCell>
                    <TableCell>
                      {d.truckId ? (
                        <Link href={`/armada/perangkat?truk=${d.truckId}`} className="text-primary hover:underline">
                          {d.truckCode}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">{d.isSpare ? "Cadangan" : "Belum dipasang"}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <GpsStateBadge state={d.gpsState} />
                        {d.stale && d.gpsState === "active" ? <ToneBadge tone="warning">Basi</ToneBadge> : null}
                        {d.phoneTracking ? <ToneBadge tone="info">GPS ponsel</ToneBadge> : null}
                      </div>
                      {d.openOutage ? (
                        <Link href={`/armada/kejadian/${d.openOutage.id}`} className="block text-xs text-primary hover:underline">
                          sejak {formatTanggalJam(d.openOutage.startedAt)} ({d.openOutage.minutes} mnt)
                        </Link>
                      ) : null}
                    </TableCell>
                    <TableCell>{d.lastPositionAt ? formatAge(d.minutesSinceLastPosition) : "Belum pernah"}</TableCell>
                    <TableCell>{d.lastSeenAt ? formatTanggalJam(d.lastSeenAt) : "—"}</TableCell>
                    <TableCell>{d.powerConnected === null ? "—" : d.powerConnected ? "Tersambung" : <span className="text-destructive">Terputus</span>}</TableCell>
                    <TableCell>{d.firmwareVersion ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      {d.outages30d}× · {d.outageMinutes30d} mnt
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Mati/dicabut per truk (30 hari)"
        description="Pola berulang dilaporkan ke pemilik (indikasi pencabutan disengaja)."
        actions={<ExportButtons excelHref={`/api/export/m12.device_outages?format=xlsx&from=${from}&to=${today}`} pdfHref={`/api/export/m12.device_outages?format=pdf&from=${from}&to=${today}`} />}
        flush
      >
        {outages.length === 0 ? (
          <EmptyState compact title="Tidak ada perangkat mati/dicabut 30 hari terakhir" />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="pola-perangkat">
              <TableHeader>
                <TableRow>
                  <TableHead>Truk</TableHead>
                  <TableHead className="text-right">Kejadian</TableHead>
                  <TableHead className="text-right">Dicabut</TableHead>
                  <TableHead className="text-right">Total mati</TableHead>
                  <TableHead className="text-right">Terlama</TableHead>
                  <TableHead>Pola</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outages.map((o) => (
                  <TableRow key={o.truckId}>
                    <TableCell>
                      {o.truckCode} <span className="text-xs text-muted-foreground">{o.deviceCode ?? ""}</span>
                    </TableCell>
                    <TableCell className="text-right">{o.count}</TableCell>
                    <TableCell className="text-right">{o.unplugged}</TableCell>
                    <TableCell className="text-right">{o.totalMinutes} mnt</TableCell>
                    <TableCell className="text-right">{o.longestMinutes} mnt</TableCell>
                    <TableCell>{o.pattern ? <ToneBadge tone="danger">Berulang</ToneBadge> : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {canPhone ? (
        <SectionCard title="GPS ponsel cadangan (admin sistem)" description="Paksa aktif untuk truk yang perangkatnya bermasalah tetapi masih mengirim; alasan wajib dan berjejak (US-M3-02 KP-5).">
          <ul className="grid gap-4 md:grid-cols-2">
            {installed.map((d) => (
              <li key={d.deviceId} className="grid gap-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{d.truckCode}</span>
                  {d.phoneTracking ? <ToneBadge tone="info">Aktif ({d.phoneTracking.reason === "admin_forced" ? "dipaksa admin" : "perangkat mati"})</ToneBadge> : <ToneBadge tone="muted">Tidak aktif</ToneBadge>}
                </div>
                <M12ActionForm action={phoneTrackingAction.bind(null, d.truckId!, !d.phoneTracking)} submitLabel={d.phoneTracking ? "Matikan GPS ponsel" : "Aktifkan GPS ponsel"} variant="outline" testId={`gps-ponsel-${d.truckCode}`}>
                  <NoteField label="Alasan" name="reason" required />
                </M12ActionForm>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}
