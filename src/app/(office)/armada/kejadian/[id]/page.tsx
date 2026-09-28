import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { M12ActionForm, NoteField } from "@/components/m12-fleet/action-form";
import { TrackMap } from "@/components/m12-fleet/track-map";
import { EventKindBadge, EventStatusBadge, formatDistance, formatDuration } from "@/components/m12-fleet/ui";
import { KeyValueList, type KeyValueItem } from "@/components/shared/key-value-list";
import { OfficeBreadcrumbLabel } from "@/components/shared/office-shell";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Timeline } from "@/components/shared/timeline";
import { isUuid } from "@/lib/ids";
import { label, type EnumValue } from "@/lib/labels";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { NotFoundError } from "@/server/core/errors";
import { can } from "@/server/core/rbac";
import * as m12 from "@/server/modules/m12-fleet";

import { closeEventAction, reviewEventAction } from "../../actions";

export const metadata: Metadata = { title: "Rincian kejadian armada" };

const ACTION_TEXT: Record<string, string> = {
  detect: "Terdeteksi sistem",
  explain: "Keterangan sopir",
  review: "Ditinjau",
  request_explanation: "Keterangan diminta",
  close: "Ditutup",
  flag: "Ditandai tanpa keterangan saat tutup kas",
};

async function load(ctx: Parameters<typeof m12.getFleetEvent>[0], id: string) {
  try {
    return await m12.getFleetEvent(ctx, id);
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}

type Point = { lat: number; lng: number };
const asPoint = (v: unknown): Point | null => (v && typeof v === "object" && typeof (v as Point).lat === "number" && typeof (v as Point).lng === "number" ? (v as Point) : null);

/**
 * Rincian kejadian armada: waktu, lokasi, jarak/durasi, truk, pengguna aktif, peta kecil (titik kejadian, tujuan,
 * posisi perangkat), keterangan sopir, tindakan tinjauan (US-M12-04 KP-3, US-M12-05 KP-3/KP-4) dan jejak keputusan.
 */
export default async function FleetEventPage({ params }: PageProps<"/armada/kejadian/[id]">) {
  const { ctx } = await requirePermission("m12.fleet_event.read");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const ev = await load(ctx, id);
  if (!ev) notFound();
  const d = ev.details as Record<string, unknown>;
  const canReview = can(ctx, "m12.fleet_event.review");
  const canRequest = can(ctx, "m12.fleet_event.request_explanation");
  const open = ev.status !== "done";
  const devicePoint = asPoint(d.devicePoint) ?? asPoint(d.devicePosition);
  const thresholds = d.thresholds as { reasonGtM?: number } | undefined;

  const items: KeyValueItem[] = [
    { label: "Truk", value: ev.truckCode ?? "—" },
    { label: "Mulai", value: formatTanggalJam(ev.startedAt) },
    { label: "Selesai", value: ev.endedAt ? formatTanggalJam(ev.endedAt) : "—" },
    { label: "Jarak", value: formatDistance(ev.distanceM) },
    { label: "Lama", value: formatDuration(ev.durationS) },
    { label: "Pengguna aktif", value: ev.userName ?? "—" },
  ];
  if (ev.tripId) {
    items.push({ label: "Rit", value: <Link href={`/armada/riwayat/rit/${ev.tripId}`} className="text-primary hover:underline">{ev.tripNumber}</Link> });
    items.push({ label: "Pelanggan", value: ev.customerName ?? "—" });
    items.push({ label: "Alamat", value: ev.addressText ?? "—" });
  }
  if (typeof d.reasonLabel === "string") items.push({ label: "Alasan sopir (saat Selesai)", value: d.reasonLabel });
  if (typeof d.targetName === "string") items.push({ label: "Tujuan pembanding", value: `${d.targetKind === "depot" ? "Depot" : "Alamat"} ${d.targetName}` });
  if (typeof d.sourceName === "string") items.push({ label: "Sumber air", value: d.sourceName });
  if (typeof d.outletName === "string") items.push({ label: "Depot", value: d.outletName });
  if (typeof d.deviceCode === "string") items.push({ label: "Perangkat", value: d.deviceCode });
  if (typeof d.locationName === "string") items.push({ label: "Lokasi", value: d.locationName });
  if (d.offHours === true) items.push({ label: "Jam layanan (PAR-07)", value: "Di luar jam layanan" });
  if (typeof d.unexplainedAtCashClose === "string") items.push({ label: "Tutup kas", value: <ToneBadge tone="danger">Belum ada keterangan saat kas ditutup</ToneBadge> });

  return (
    <div className="grid gap-6">
      <OfficeBreadcrumbLabel label={ev.kindLabel} />
      <PageHeader
        title={ev.kindLabel}
        description={`${ev.truckCode ?? "—"} · ${formatTanggalJam(ev.startedAt)}`}
        backHref="/armada/kejadian"
        backLabel="Kejadian armada"
        meta={
          <>
            <EventKindBadge kind={ev.kind} />
            <EventStatusBadge status={ev.status} />
            {ev.needsReview ? <ToneBadge tone="warning">Menunggu tinjauan pemilik</ToneBadge> : null}
            {ev.awaitingExplanation ? <ToneBadge tone="warning">Menunggu keterangan sopir</ToneBadge> : null}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard>
          <KeyValueList columns={2} items={items} />
        </SectionCard>
        <SectionCard title="Peta kecil" description="Merah = titik kejadian/Selesai; abu-abu = tujuan; biru = posisi perangkat GPS.">
          <TrackMap
            height={300}
            point={ev.lat != null && ev.lng != null ? { lat: ev.lat, lng: ev.lng, label: "Kejadian" } : null}
            target={ev.target ? { ...ev.target, label: "Tujuan", radiusM: thresholds?.reasonGtM } : null}
            devicePoint={devicePoint ? { ...devicePoint, label: "Perangkat GPS" } : null}
            ariaLabel="Peta kejadian"
          />
        </SectionCard>
      </div>

      <SectionCard title="Keterangan & tinjauan">
        <KeyValueList
          columns={2}
          items={[
            { label: "Keterangan sopir", value: ev.explanation ? `"${ev.explanation}"` : ev.requiresExplanation ? "Belum diisi" : "Tidak diminta" },
            { label: "Diberikan oleh", value: ev.explainedByName ? `${ev.explainedByName}, ${formatTanggalJam(ev.explainedAt!)}${ev.explanationLate ? " (terlambat)" : ""}` : "—" },
            { label: "Keputusan", value: ev.reviewDecision ? label("fleet_review_decision", ev.reviewDecision as EnumValue<"fleet_review_decision">) : "—" },
            { label: "Catatan tinjauan", value: ev.reviewNote ?? "—" },
            { label: "Ditinjau oleh", value: ev.reviewedByName ? `${ev.reviewedByName}, ${formatTanggalJam(ev.reviewedAt!)}` : "—" },
            { label: "Selesai", value: ev.doneAt ? formatTanggalJam(ev.doneAt) : "—" },
          ]}
        />
        {open && (canReview || canRequest) ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            {canReview && ev.status !== "reviewed" ? (
              <M12ActionForm action={reviewEventAction.bind(null, ev.id, "accepted")} submitLabel="Terima alasan" testId="aksi-terima">
                <NoteField label="Catatan (opsional)" />
              </M12ActionForm>
            ) : null}
            {canRequest && !ev.explanation ? (
              <M12ActionForm action={reviewEventAction.bind(null, ev.id, "request_explanation")} submitLabel="Minta keterangan sopir" variant="outline" testId="aksi-minta">
                <NoteField label="Pesan ke sopir" required placeholder="Mis. jelaskan tujuan perjalanan pukul 13.10." hint="Tampil sebagai tugas keterangan di aplikasi sopir hari ini." />
              </M12ActionForm>
            ) : null}
            {canReview && ev.status !== "reviewed" ? (
              <M12ActionForm action={reviewEventAction.bind(null, ev.id, "follow_up")} submitLabel="Tandai tindak lanjut" variant="outline" testId="aksi-tindak-lanjut">
                <NoteField label="Tindak lanjut di luar sistem" required />
              </M12ActionForm>
            ) : null}
            {canReview && ev.status === "reviewed" ? (
              <M12ActionForm action={closeEventAction.bind(null, ev.id)} submitLabel="Tandai Selesai" testId="aksi-selesai">
                <NoteField label="Hasil tindak lanjut" required />
              </M12ActionForm>
            ) : null}
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title="Jejak keputusan">
        <Timeline
          items={[...ev.trail].reverse().map((t, i) => ({
            id: `${i}-${t.action}`,
            title: ACTION_TEXT[t.action] ?? t.action,
            at: t.at,
            actor: t.actorName,
            description: t.reason ?? undefined,
          }))}
        />
      </SectionCard>
    </div>
  );
}
