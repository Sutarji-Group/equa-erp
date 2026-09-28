"use client";

/**
 * Layar "Hari ini" operator produksi: status pembacaan meter pagi/malam per meter (jam batas), produksi, pengisian truk
 * hari ini + truk terjadwal yang belum diisi, tugas (investigasi susut, uji mutu jatuh tempo), neraca terakhir. Satu
 * ketukan ke setiap tindakan (US-M8-07 KP-3).
 */
import { ClipboardCheck, FlaskConical, Gauge, Search, Truck, Waves } from "lucide-react";

import { formatLiter, formatPct, isLateReading, PHASE_LABEL, wibClock, type M8MeterRef, type MeterPhase } from "@/client/m8-production/contract";
import { BigButton } from "@/components/field/big-button";
import { label } from "@/lib/labels";
import { formatTanggal } from "@/lib/time";

import { useProduction } from "./production-context";
import { Banner, FigureRow, Pill, Section } from "./ui";

function ReadingCell({ meter, phase }: { meter: M8MeterRef; phase: MeterPhase }) {
  const { today, go } = useProduction();
  const r = meter.today[phase];
  if (r) {
    return (
      <div className="flex flex-col gap-0.5" data-testid={`meter-${meter.code}-${phase}`}>
        <span className="text-base text-muted-foreground">{PHASE_LABEL[phase]}</span>
        <span className="text-xl font-bold tabular-nums">{formatLiter(r.readingL)}</span>
        <span className="text-base text-muted-foreground">
          {wibClock(r.readAt)} · {r.local ? "tersimpan di ponsel" : r.status === "flagged" ? "perlu verifikasi" : "terkirim"}
          {r.lateReason ? " · terlambat" : ""}
        </span>
      </div>
    );
  }
  const late = today ? isLateReading(phase, new Date(), today.rules) : false;
  return (
    <div className="flex flex-col gap-1" data-testid={`meter-${meter.code}-${phase}`}>
      <span className="text-base text-muted-foreground">{PHASE_LABEL[phase]}</span>
      <BigButton variant={late ? "danger" : "outline"} onClick={() => go({ name: "meter", meterId: meter.id, phase })}>
        {late ? "Terlambat — catat" : "Catat"}
      </BigButton>
    </div>
  );
}

export function TodayView() {
  const { today, go } = useProduction();
  if (!today) return null;
  const fills = today.fills.filter((f) => !f.reversed);
  const filledL = fills.reduce((a, f) => a + f.volumeL, 0);
  const waiting = today.trucks.filter((t) => t.planned && t.nextTripId);
  const prod = today.production.today;
  const producedPreview = today.meters.reduce<number | null>((acc, m) => {
    if (!m.today.morning || !m.today.evening) return acc;
    return (acc ?? 0) + (m.today.evening.readingL - m.today.morning.readingL);
  }, null);
  const dueQuality = today.quality.schedules.filter((s) => s.dueSoon || s.overdue);
  const openInvestigations = today.investigations.filter((i) => i.status === "over_threshold" || !!i.reviewNote);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-base text-muted-foreground">
        {today.source?.name} · {formatTanggal(today.date)}
      </p>

      {openInvestigations.map((i) => (
        <Banner key={i.waterBalanceId} tone="danger" role="alert" testId="tugas-investigasi">
          <span className="flex flex-col gap-2">
            <span>
              Susut {i.businessDate}: <strong>{formatPct(i.lossPct)}</strong> ({formatLiter(i.lossL)}) di atas batas {formatPct(today.rules.lossMaxPct)}.
              {i.reviewNote ? ` Dikembalikan pemilik: ${i.reviewNote}` : " Isi penjelasan dengan foto."}
            </span>
            <BigButton variant="danger" icon={<Search aria-hidden />} onClick={() => go({ name: "investigation", waterBalanceId: i.waterBalanceId })}>
              Isi penjelasan susut
            </BigButton>
          </span>
        </Banner>
      ))}

      <Section title="Meter" label="Meter hari ini" testId="kartu-meter">
        {today.meters.map((m) => (
          <div key={m.id} className="flex flex-col gap-2">
            <p className="text-lg font-semibold">
              {m.code}
              {m.name ? ` · ${m.name}` : ""}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <ReadingCell meter={m} phase="morning" />
              <ReadingCell meter={m} phase="evening" />
            </div>
            {m.rollover ? <Pill tone="info">Putaran meter tercatat admin</Pill> : null}
          </div>
        ))}
        <FigureRow
          label="Produksi hari ini"
          strong
          testId="produksi-hari-ini"
          value={producedPreview !== null ? formatLiter(producedPreview) : prod?.producedL !== null && prod?.producedL !== undefined ? formatLiter(prod.producedL) : "belum lengkap"}
        />
        {today.production.yesterday ? (
          <FigureRow label="Produksi kemarin" value={`${formatLiter(today.production.yesterday.producedL)} · ${label("production_status", today.production.yesterday.status)}`} />
        ) : null}
        <p className="text-base text-muted-foreground">
          Batas catat: pagi {today.rules.morningDeadline.replace(":", ".")} · malam {today.rules.eveningDeadline.replace(":", ".")}
        </p>
        <BigButton icon={<Gauge aria-hidden />} onClick={() => go({ name: "meter" })}>
          Catat meter
        </BigButton>
      </Section>

      <Section title="Pengisian truk" label="Pengisian hari ini" testId="kartu-pengisian">
        <FigureRow label="Pengisian hari ini" value={`${fills.length} × · ${formatLiter(filledL)}`} strong testId="total-isi" />
        <FigureRow label="Truk terjadwal belum diisi" value={waiting.length ? waiting.map((t) => t.code).join(", ") : "—"} />
        <BigButton size="xl" icon={<Truck aria-hidden />} onClick={() => go({ name: "fill" })}>
          Isi truk
        </BigButton>
      </Section>

      {dueQuality.length ? (
        <Section title="Uji mutu air" testId="kartu-mutu">
          {dueQuality.map((s) => (
            <div key={s.id} className="flex flex-col gap-2">
              <p className="text-base">
                Jadwal uji {s.nextDueDate ? formatTanggal(s.nextDueDate) : "—"}
                {s.laboratory ? ` · ${s.laboratory}` : ""} {s.overdue ? <Pill tone="danger">Terlambat</Pill> : <Pill tone="warning">Segera</Pill>}
              </p>
              <BigButton variant="secondary" icon={<FlaskConical aria-hidden />} onClick={() => go({ name: "quality", scheduleId: s.id })}>
                Catat hasil uji
              </BigButton>
            </div>
          ))}
        </Section>
      ) : null}

      {today.lastBalance ? (
        <Section title={`Neraca air ${formatTanggal(today.lastBalance.businessDate)}`} testId="kartu-neraca">
          <FigureRow label="Produksi" value={formatLiter(today.lastBalance.producedL)} />
          <FigureRow label="Pengisian" value={formatLiter(today.lastBalance.filledTotalL)} />
          <FigureRow
            label="Susut"
            value={`${formatLiter(today.lastBalance.lossL)} (${formatPct(today.lastBalance.lossPct)})`}
            tone={today.lastBalance.status === "over_threshold" || today.lastBalance.status === "negative_anomaly" ? "danger" : undefined}
            strong
          />
          <FigureRow label="Rata-rata susut 7 hari" value={formatPct(today.lastBalance.avgLossPct)} />
          <FigureRow label="Status" value={label("water_balance_status", today.lastBalance.status)} />
        </Section>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <BigButton variant="secondary" icon={<Waves aria-hidden />} onClick={() => go({ name: "tank" })}>
          Level tandon
        </BigButton>
        <BigButton variant="secondary" icon={<ClipboardCheck aria-hidden />} onClick={() => go({ name: "quality" })}>
          Hasil uji mutu
        </BigButton>
      </div>
    </div>
  );
}
