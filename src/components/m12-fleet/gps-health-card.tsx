/**
 * Kartu kesehatan perangkat GPS (US-M12-08 KP-4): terakhir terlihat, posisi terakhir, daya, versi, baterai, status
 * GPS (Aktif/Mati/Dicabut), kejadian terbuka, GPS ponsel cadangan, jumlah mati 30 hari. Presentasional (Server
 * Component) — halaman perangkat M10 dapat menyematkannya dengan data `getGpsDeviceHealth(ctx, deviceId)` dari M12.
 */
import Link from "next/link";

import { KeyValueList } from "@/components/shared/key-value-list";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { label, type EnumValue } from "@/lib/labels";
import { formatTanggalJam } from "@/lib/time";
import type { GpsDeviceHealth } from "@/server/modules/m12-fleet";

import { formatAge, GpsStateBadge } from "./ui";

export function GpsHealthCard({ health, title = "Kesehatan perangkat GPS" }: { health: GpsDeviceHealth; title?: string }) {
  return (
    <SectionCard
      title={title}
      description="Diperbarui setiap posisi masuk dari penghubung vendor (US-M12-08)."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <GpsStateBadge state={health.gpsState} />
          {health.stale ? <ToneBadge tone="warning">Posisi basi</ToneBadge> : null}
          {health.phoneTracking ? <ToneBadge tone="info">GPS ponsel aktif</ToneBadge> : null}
        </div>
      }
    >
      <KeyValueList
        columns={3}
        items={[
          { label: "Truk", value: health.truckCode ? <Link href={`/armada/perangkat?truk=${health.truckId}`} className="text-primary hover:underline">{health.truckCode}</Link> : "Belum dipasang" },
          { label: "Vendor", value: health.vendor ?? "—" },
          { label: "Versi perangkat", value: health.firmwareVersion ?? "—" },
          { label: "Terakhir terlihat", value: health.lastSeenAt ? formatTanggalJam(health.lastSeenAt) : "—" },
          { label: "Posisi terakhir", value: health.lastPositionAt ? `${formatTanggalJam(health.lastPositionAt)} (${formatAge(health.minutesSinceLastPosition)})` : "Belum pernah mengirim" },
          { label: "Daya", value: health.powerConnected === null ? "—" : health.powerConnected ? "Tersambung" : "Terputus" },
          { label: "Baterai", value: health.batteryPct != null ? `${health.batteryPct}%` : "—" },
          { label: "IMEI", value: health.imei ?? "—" },
          {
            label: "Kejadian terbuka",
            value: health.openOutage ? (
              <Link href={`/armada/kejadian/${health.openOutage.id}`} className="text-primary hover:underline">
                {label("fleet_event_kind", health.openOutage.kind as EnumValue<"fleet_event_kind">)} sejak {formatTanggalJam(health.openOutage.startedAt)} ({health.openOutage.minutes} mnt)
              </Link>
            ) : (
              "—"
            ),
          },
          { label: "GPS ponsel cadangan", value: health.phoneTracking ? `Aktif sejak ${formatTanggalJam(health.phoneTracking.since)} (${health.phoneTracking.reason === "admin_forced" ? "dipaksa admin" : "perangkat mati"})` : "Tidak aktif" },
          { label: "Mati/dicabut 30 hari", value: `${health.outages30d}× · ${health.outageMinutes30d} mnt` },
        ]}
      />
    </SectionCard>
  );
}
