import type { Metadata } from "next";
import Link from "next/link";

import { M12ActionForm, NoteField } from "@/components/m12-fleet/action-form";
import { EventKindBadge, EventStatusBadge, formatDistance, formatDuration } from "@/components/m12-fleet/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumValues, label, type FleetEventKind } from "@/lib/labels";
import { addDays, formatJam, formatTanggal, formatTanggalJam, isBusinessDate, toBusinessDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m12 from "@/server/modules/m12-fleet";

import { reviewEventAction } from "../actions";

export const metadata: Metadata = { title: "Kejadian armada" };

const TABS = [
  { key: "tinjauan", label: "Tinjauan pemilik" },
  { key: "terbuka", label: "Belum selesai" },
  { key: "semua", label: "Semua kejadian" },
  { key: "h0", label: "Ringkasan H+0" },
  { key: "pola", label: "Pola berulang" },
] as const;
type Tab = (typeof TABS)[number]["key"];

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/**
 * Kejadian armada (US-M12-04 KP-3, US-M12-05 KP-3/KP-4, US-M12-06 KP-4, US-M12-08 KP-2): daftar tinjauan pemilik
 * (penyimpangan tingkat 2, sumber lokasi tidak konsisten, perjalanan di luar jadwal/jam, berhenti tidak dikenal,
 * penanda geofence) dengan tindakan terima / minta keterangan / tindak lanjut; ringkasan H+0 (tanpa keterangan saat
 * tutup kas, perangkat mati > 2 jam); pola per sopir & pelanggan. Kejadian tidak pernah dihapus (BR-38).
 */
export default async function KejadianPage({ searchParams }: PageProps<"/armada/kejadian">) {
  const { ctx } = await requirePermission("m12.fleet_event.read");
  const sp = await searchParams;
  const today = toBusinessDate(ctx.now);
  const canReview = can(ctx, "m12.fleet_event.review");
  const tab: Tab = pick(sp.tampil, TABS.map((t) => t.key)) ?? (canReview ? "tinjauan" : "terbuka");
  const to = typeof sp.sampai === "string" && isBusinessDate(sp.sampai) ? sp.sampai : today;
  const from = typeof sp.dari === "string" && isBusinessDate(sp.dari) && sp.dari <= to ? sp.dari : addDays(to, tab === "tinjauan" ? -30 : -6);
  const date = typeof sp.tanggal === "string" && isBusinessDate(sp.tanggal) ? sp.tanggal : today;
  const group = pick(sp.kelompok, enumValues("fleet_event_group"));
  const kind = pick(sp.jenis, enumValues("fleet_event_kind"));
  const status = pick(sp.status, enumValues("fleet_event_status"));

  const tabHref = (key: Tab) => `/armada/kejadian?tampil=${key}`;
  const exportQuery = new URLSearchParams({ from, to, ...(tab === "tinjauan" ? { view: "review" } : tab === "terbuka" ? { view: "open" } : {}), ...(kind ? { kind } : {}), ...(status ? { status } : {}) }).toString();

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Kejadian armada"
        description="Penyimpangan lokasi Selesai, perjalanan di luar jadwal/jam, berhenti tidak dikenal, geofence, dan perangkat GPS. Keputusan berjejak; kejadian tidak dihapus."
        actions={<ExportButtons excelHref={`/api/export/m12.fleet_events?format=xlsx&${exportQuery}`} pdfHref={`/api/export/m12.fleet_events?format=pdf&${exportQuery}`} />}
      />

      <nav className="flex flex-wrap gap-2" aria-label="Tampilan kejadian">
        {TABS.map((t) => (
          <Button key={t.key} asChild size="sm" variant={t.key === tab ? "default" : "outline"}>
            <Link href={tabHref(t.key)} aria-current={t.key === tab ? "page" : undefined}>
              {t.label}
            </Link>
          </Button>
        ))}
      </nav>

      {tab === "h0" ? (
        <H0Section ctx={ctx} date={date} />
      ) : tab === "pola" ? (
        <PatternSection ctx={ctx} from={addDays(today, -29)} to={today} />
      ) : (
        <EventList ctx={ctx} tab={tab} filter={{ from, to, group, kind, status, view: tab === "tinjauan" ? "review" : tab === "terbuka" ? "open" : "all" }} canReview={canReview} />
      )}
    </div>
  );
}

type Ctx = Awaited<ReturnType<typeof requirePermission>>["ctx"];

async function EventList({ ctx, tab, filter, canReview }: { ctx: Ctx; tab: Tab; filter: m12.FleetEventFilter & { from: string; to: string }; canReview: boolean }) {
  const rows = await m12.listFleetEvents(ctx, filter);
  const canRequest = can(ctx, "m12.fleet_event.request_explanation");
  return (
    <>
      {tab === "semua" ? (
        <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
          <input type="hidden" name="tampil" value="semua" />
          <label className="grid gap-1">
            Dari
            <input type="date" name="dari" defaultValue={filter.from} className="h-9 rounded-md border border-input bg-transparent px-2" />
          </label>
          <label className="grid gap-1">
            Sampai
            <input type="date" name="sampai" defaultValue={filter.to} className="h-9 rounded-md border border-input bg-transparent px-2" />
          </label>
          <label className="grid gap-1">
            Kelompok
            <select name="kelompok" defaultValue={filter.group ?? ""} className="h-9 rounded-md border border-input bg-background px-2">
              <option value="">Semua (tanpa masuk/keluar geofence)</option>
              {enumValues("fleet_event_group").map((g) => (
                <option key={g} value={g}>
                  {label("fleet_event_group", g)}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            Status
            <select name="status" defaultValue={filter.status ?? ""} className="h-9 rounded-md border border-input bg-background px-2">
              <option value="">Semua</option>
              {enumValues("fleet_event_status").map((s) => (
                <option key={s} value={s}>
                  {label("fleet_event_status", s)}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="outline" size="sm">
            Tampilkan
          </Button>
        </form>
      ) : null}

      <SectionCard
        title={tab === "tinjauan" ? `Menunggu tinjauan pemilik (${rows.length})` : tab === "terbuka" ? `Belum selesai (${rows.length})` : `Kejadian ${formatTanggal(filter.from, { weekday: false })} – ${formatTanggal(filter.to, { weekday: false })} (${rows.length})`}
        description={tab === "tinjauan" ? "Terima alasan, minta keterangan (tugas ke aplikasi sopir), atau tandai tindak lanjut di luar sistem." : undefined}
      >
        {rows.length === 0 ? (
          <EmptyState compact title={tab === "tinjauan" ? "Tidak ada kejadian yang menunggu tinjauan" : "Tidak ada kejadian"} />
        ) : (
          <ul className="grid gap-3" data-testid="daftar-kejadian">
            {rows.map((e) => (
              <li key={e.id} className="grid gap-2 rounded-lg border p-3" data-testid={`kejadian-${e.id}`}>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <EventKindBadge kind={e.kind} />
                  <EventStatusBadge status={e.status} />
                  <span className="font-medium">{e.truckCode ?? "—"}</span>
                  <span className="text-muted-foreground">{formatTanggalJam(e.startedAt)}</span>
                  {e.tripNumber ? <span className="text-muted-foreground">· Rit {e.tripNumber}</span> : null}
                  {e.customerName ? <span className="text-muted-foreground">· {e.customerName}</span> : null}
                  {e.awaitingExplanation ? <ToneBadge tone="warning">Menunggu keterangan sopir</ToneBadge> : null}
                  {(e.details as { unexplainedAtCashClose?: string }).unexplainedAtCashClose ? <ToneBadge tone="danger">Tanpa keterangan saat tutup kas</ToneBadge> : null}
                </div>
                <p className="text-sm">
                  {e.distanceM != null ? `Jarak ${formatDistance(e.distanceM)}. ` : ""}
                  {e.durationS != null ? `Lama ${formatDuration(e.durationS)}. ` : ""}
                  {e.userName ? `Pengguna aktif: ${e.userName}. ` : ""}
                  {(e.details as { reasonLabel?: string | null }).reasonLabel ? `Alasan sopir: ${(e.details as { reasonLabel: string }).reasonLabel}. ` : ""}
                  {e.explanation ? `Keterangan sopir: "${e.explanation}"${e.explanationLate ? " (terlambat)" : ""}.` : ""}
                </p>
                <div className="flex flex-wrap items-start gap-3">
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/armada/kejadian/${e.id}`}>Rincian & peta</Link>
                  </Button>
                  {tab === "tinjauan" && canReview && e.needsReview ? (
                    <M12ActionForm action={reviewEventAction.bind(null, e.id, "accepted")} submitLabel="Terima alasan" className="min-w-64 flex-1" testId={`terima-${e.id}`}>
                      <NoteField label="Catatan (opsional)" placeholder="Mis. sudah dikonfirmasi ke pelanggan." />
                    </M12ActionForm>
                  ) : null}
                  {tab === "tinjauan" && canRequest && !canReview && e.status !== "done" && !e.explanation ? (
                    <M12ActionForm action={reviewEventAction.bind(null, e.id, "request_explanation")} submitLabel="Minta keterangan" variant="outline" className="min-w-64 flex-1">
                      <NoteField label="Pesan ke sopir" required />
                    </M12ActionForm>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </>
  );
}

async function H0Section({ ctx, date }: { ctx: Ctx; date: string }) {
  const s = await m12.getFleetDaySummary(ctx, date);
  return (
    <div className="grid gap-6" data-testid="ringkasan-h0">
      <form method="get" className="flex flex-wrap items-center gap-2 text-sm">
        <input type="hidden" name="tampil" value="h0" />
        <input type="date" name="tanggal" defaultValue={date} aria-label="Tanggal" className="h-9 rounded-md border border-input bg-transparent px-2" />
        <Button type="submit" variant="outline" size="sm">
          Tampilkan
        </Button>
      </form>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <KpiTile label="Tanpa keterangan sopir" value={String(s.unexplained.length)} tone={s.unexplained.length ? "danger" : "success"} />
        <KpiTile label="Di luar jadwal/jam" value={String(s.counts.offSchedule)} />
        <KpiTile label="Berhenti tidak dikenal" value={String(s.counts.unknownStops)} />
        <KpiTile label="Penyimpangan tingkat 2" value={String(s.counts.deviationsL2)} tone={s.counts.deviationsL2 ? "warning" : undefined} />
        <KpiTile label="Sumber lokasi tidak konsisten" value={String(s.counts.inconsistent)} tone={s.counts.inconsistent ? "warning" : undefined} />
        <KpiTile label="Penanda geofence" value={String(s.counts.geofenceFlags)} />
      </div>
      <SectionCard title={`Kejadian tanpa keterangan — ${formatTanggal(date)}`} description="Masuk kotak masuk pemilik saat kas ditutup (BR-25).">
        {s.unexplained.length === 0 ? (
          <EmptyState compact title="Semua kejadian sudah diberi keterangan" />
        ) : (
          <ul className="grid gap-2 text-sm">
            {s.unexplained.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-2">
                <EventKindBadge kind={u.kind as FleetEventKind} />
                <span className="font-medium">{u.truckCode ?? "—"}</span>
                <span className="text-muted-foreground">{formatJam(u.startedAt)}</span>
                <Link href={`/armada/kejadian/${u.id}`} className="text-primary hover:underline">
                  Rincian
                </Link>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard title={`Perangkat GPS mati/dicabut > ${Math.round(s.deviceOutageThresholdMinutes / 60)} jam`} description="US-M12-08 KP-2.">
        {s.deviceOutages.length === 0 ? (
          <EmptyState compact title="Tidak ada" />
        ) : (
          <ul className="grid gap-2 text-sm">
            {s.deviceOutages.map((d) => (
              <li key={d.truckId}>
                <Link href={`/armada/perangkat?truk=${d.truckId}`} className="font-medium text-primary hover:underline">
                  {d.truckCode}
                </Link>{" "}
                — {formatDuration(d.minutes * 60)} tanpa sinyal perangkat
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

async function PatternSection({ ctx, from, to }: { ctx: Ctx; from: string; to: string }) {
  const p = await m12.locationDeviationPatterns(ctx, { from, to });
  const table = (rows: m12.PatternRow[], title: string, testId: string) => (
    <SectionCard title={title} flush>
      {rows.length === 0 ? (
        <EmptyState compact title="Tidak ada penyimpangan" />
      ) : (
        <div className="overflow-x-auto">
          <Table data-testid={testId}>
            <TableHeader>
              <TableRow>
                <TableHead>Nama</TableHead>
                <TableHead className="text-right">Penyimpangan</TableHead>
                <TableHead className="text-right">Tingkat 2</TableHead>
                <TableHead className="text-right">Sumber tidak konsisten</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.key} className={cn(r.locationEvents >= 3 && "bg-warning/10")}>
                  <TableCell>{r.name}</TableCell>
                  <TableCell className="text-right">{r.locationEvents}</TableCell>
                  <TableCell className="text-right">{r.level2}</TableCell>
                  <TableCell className="text-right">{r.inconsistent}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </SectionCard>
  );
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>
          Penyimpangan lokasi Selesai 30 hari terakhir ({formatTanggal(from, { weekday: false })} – {formatTanggal(to, { weekday: false })}); masukan tinjauan pola US-M9-05.
        </span>
        <ExportButtons excelHref={`/api/export/m12.location_patterns?format=xlsx&from=${from}&to=${to}`} pdfHref={`/api/export/m12.location_patterns?format=pdf&from=${from}&to=${to}`} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {table(p.byDriver, "Per sopir", "pola-sopir")}
        {table(p.byCustomer, "Per pelanggan", "pola-pelanggan")}
      </div>
    </div>
  );
}

