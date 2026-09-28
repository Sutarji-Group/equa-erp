/**
 * M12 — potongan tampilan bersama layar armada (isomorfik: dipakai Server & Client Components). Lencana status truk,
 * jenis/status kejadian, status GPS, dan format jarak/lama dalam istilah lapangan.
 */
import { ToneBadge, type StatusTone } from "@/components/shared/status-badge";
import { label, type EnumValue, type FleetEventKind } from "@/lib/labels";

export type LiveTone = "primary" | "success" | "warning" | "danger" | "muted";

/** Nada peta (MapTone) → nada lencana. */
export function badgeTone(tone: LiveTone): StatusTone {
  return tone === "primary" ? "info" : tone;
}

export function LiveStatusBadge({ status, tone }: { status: EnumValue<"fleet_live_status">; tone: LiveTone }) {
  return (
    <ToneBadge tone={badgeTone(tone)} dot>
      {label("fleet_live_status", status)}
    </ToneBadge>
  );
}

const EVENT_STATUS_TONE: Record<EnumValue<"fleet_event_status">, StatusTone> = {
  detected: "warning",
  explained: "info",
  reviewed: "neutral",
  done: "muted",
};

export function EventStatusBadge({ status }: { status: EnumValue<"fleet_event_status"> }) {
  return <ToneBadge tone={EVENT_STATUS_TONE[status]}>{label("fleet_event_status", status)}</ToneBadge>;
}

const DANGER_KINDS: readonly FleetEventKind[] = ["location_deviation_l2", "location_source_inconsistent", "off_hours_trip", "device_unplugged", "fill_without_geofence", "supply_without_geofence"];
const WARNING_KINDS: readonly FleetEventKind[] = ["off_schedule_trip", "unknown_stop", "device_offline", "geofence_without_fill", "location_deviation_l1", "no_location"];

export function eventKindTone(kind: FleetEventKind): StatusTone {
  if (DANGER_KINDS.includes(kind)) return "danger";
  if (WARNING_KINDS.includes(kind)) return "warning";
  return "neutral";
}

export function EventKindBadge({ kind }: { kind: FleetEventKind }) {
  return <ToneBadge tone={eventKindTone(kind)}>{label("fleet_event_kind", kind)}</ToneBadge>;
}

export function GpsStateBadge({ state }: { state: string | null }) {
  if (!state) return <ToneBadge tone="muted">Belum mengirim</ToneBadge>;
  const tone: StatusTone = state === "active" ? "success" : "danger";
  return (
    <ToneBadge tone={tone} dot>
      {label("gps_state", state as EnumValue<"gps_state">)}
    </ToneBadge>
  );
}

/** Jarak meter → "12,3 km" / "850 m". */
export function formatDistance(m: number | null | undefined): string {
  if (m === null || m === undefined) return "—";
  if (Math.abs(m) < 1000) return `${Math.round(m).toLocaleString("id-ID")} m`;
  return `${(m / 1000).toLocaleString("id-ID", { maximumFractionDigits: 1, minimumFractionDigits: 1 })} km`;
}

/** Lama detik → "1 jam 5 mnt" / "12 mnt". */
export function formatDuration(s: number | null | undefined): string {
  if (s === null || s === undefined) return "—";
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes} mnt`;
  const h = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${h} jam ${rest} mnt` : `${h} jam`;
}

/** Umur posisi (menit) → "baru saja" / "3 mnt lalu" / "2 jam lalu". */
export function formatAge(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "—";
  if (minutes < 1) return "baru saja";
  if (minutes < 60) return `${minutes} mnt lalu`;
  const h = Math.floor(minutes / 60);
  return h < 48 ? `${h} jam lalu` : `${Math.floor(h / 24)} hari lalu`;
}

/** Nomor WA dari telepon lokal (08… → 628…). */
export function waLink(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^0-9]/g, "");
  if (!digits) return null;
  return `https://wa.me/${digits.startsWith("0") ? `62${digits.slice(1)}` : digits}`;
}
