"use client";

/**
 * Catat pengisian truk dalam 3 langkah (US-M8-02 KP-1..KP-3, 7.8.6, US-M8-07 KP-3):
 * 1. Truk — truk yang dijadwalkan mengisi di sumber ini hari ini tampil pertama; truk lain dapat dipilih dengan
 *    konfirmasi (Dispatcher diberi tahu).
 * 2. Volume & rit — bawaan volume standar rit (PAR-15), ubah dengan alasan (mis. sisa muatan rit gagal); rit tujuan
 *    disarankan = rit berikutnya truk itu yang belum Berangkat; "tanpa rit" tetap dapat dicatat (ditandai ke kantor).
 * 3. Foto (opsional) & simpan.
 */
import { Droplets, Truck } from "lucide-react";
import { useState } from "react";

import {
  FILL_VOLUME_REASONS,
  fillableTrips,
  formatLiter,
  M8_ATTACHMENT_KINDS,
  M8_COMMANDS,
  sortTrucksForSource,
  volumeNeedsReason,
  type M8TruckRef,
  type TruckFillPayload,
} from "@/client/m8-production/contract";
import { BigButton } from "@/components/field/big-button";
import { PhotoCapture, type CapturedPhoto } from "@/components/field/photo-capture";
import { StepScreen } from "@/components/field/step-screen";
import { newId } from "@/lib/ids";
import { cn } from "@/lib/utils";

import { useProduction } from "./production-context";
import { Banner, Choices, ErrorText, FigureRow, NumberField, Pill, TextField } from "./ui";

const OTHER_REASON = "__other";
const NO_TRIP = "__none";

function TruckButton({ truck, selected, onSelect }: { truck: M8TruckRef; selected: boolean; onSelect: () => void }) {
  const next = truck.trips.find((t) => t.id === truck.nextTripId);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      data-testid={`truk-${truck.code}`}
      className={cn(
        "flex min-h-16 w-full flex-col items-start gap-1 rounded-xl border-2 px-4 py-3 text-left focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none",
        selected ? "border-primary bg-primary/10" : "bg-background hover:bg-accent",
      )}
    >
      <span className="flex w-full items-center justify-between gap-2 text-lg font-bold">
        <span>
          {truck.code} · {truck.plateNumber}
        </span>
        {truck.filledTodayL > 0 ? <Pill tone="info">{formatLiter(truck.filledTodayL)} hari ini</Pill> : null}
      </span>
      <span className="text-base text-muted-foreground">
        {next ? `Rit berikutnya ${next.number} · ${next.isInternal ? `pasokan ${next.destinationName ?? "depot"}` : next.customerName}` : "Tidak ada rit terjadwal yang belum diisi"}
      </span>
      {truck.carriedWater ? <span className="text-base font-semibold text-warning-foreground">Masih membawa air rit gagal {truck.carriedWater.tripNumber}</span> : null}
    </button>
  );
}

export function FillFlow({ truckId }: { truckId?: string }) {
  const { today, send, go, session } = useProduction();
  const trucks = sortTrucksForSource(today?.trucks ?? []);
  const planned = trucks.filter((t) => t.planned);
  const others = trucks.filter((t) => !t.planned);
  const [step, setStep] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(truckId ?? (planned.length === 1 ? planned[0]!.id : null));
  const [showOthers, setShowOthers] = useState(false);
  const [confirmUnplanned, setConfirmUnplanned] = useState(false);
  const truck = trucks.find((t) => t.id === selectedId) ?? null;
  const standard = today?.rules.standardVolumeL ?? 5_000;
  const [volume, setVolume] = useState<number | null>(standard);
  const [reason, setReason] = useState<string | null>(null);
  const [reasonNote, setReasonNote] = useState("");
  const [tripChoice, setTripChoice] = useState<string | null>(null);
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  if (!today) return null;
  const trips = truck ? fillableTrips(truck) : [];
  const effectiveTrip = tripChoice ?? truck?.nextTripId ?? NO_TRIP;
  const trip = trips.find((t) => t.id === effectiveTrip) ?? null;
  const needsReason = volume !== null && volumeNeedsReason(volume, standard);
  const reasonText = reason === OTHER_REASON ? reasonNote.trim() : (reason ?? "");

  const problem = (): string | null => {
    if (step === 0) {
      if (!truck) return "Pilih truk yang sedang diisi.";
      if (!truck.planned && !confirmUnplanned) return `Truk ${truck.code} tidak dijadwalkan mengisi di sumber ini. Centang konfirmasi bila memang mengisi di sini.`;
    }
    if (step >= 1 && truck) {
      if (volume === null || volume <= 0) return "Isi volume pengisian (liter).";
      if (volume > truck.capacityL) return `Volume ${formatLiter(volume)} melebihi kapasitas tangki truk ${truck.code} (${formatLiter(truck.capacityL)}).`;
      if (needsReason && reasonText.length < 3) return `Volume berbeda dari ${formatLiter(standard)} — pilih alasannya.`;
    }
    return null;
  };

  const next = () => {
    const p = problem();
    setError(p);
    if (!p) setStep((s) => Math.min(2, s + 1));
  };

  const save = async () => {
    const p = problem();
    setError(p);
    if (p || !truck || volume === null) return;
    setSaving(true);
    try {
      const payload: TruckFillPayload = {
        fillId: newId(),
        truckId: truck.id,
        tripId: trip?.id ?? null,
        volumeL: volume,
        volumeReason: needsReason ? reasonText : null,
        ...(truck.planned ? {} : { unplannedConfirmed: true }),
      };
      await send(M8_COMMANDS.truckFill, payload, `Isi truk ${truck.code}${trip ? ` rit ${trip.number}` : " tanpa rit"}: ${formatLiter(volume)}`, photo ? [{ kind: M8_ATTACHMENT_KINDS.fillPhoto, blob: photo.blob, capturedAt: photo.capturedAt }] : []);
      setDone(`Pengisian truk ${truck.code} ${formatLiter(volume)}${trip ? ` untuk rit ${trip.number}` : " tanpa rit"} tersimpan${session.sync.online ? " dan sedang dikirim." : " di ponsel. Terkirim otomatis saat ada sinyal."}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menyimpan. Coba lagi.");
    } finally {
      setSaving(false);
    }
  };

  if (done) {
    return (
      <div className="flex flex-col gap-4" data-testid="isi-tersimpan">
        <Banner tone="success">{done}</Banner>
        <BigButton icon={<Truck aria-hidden />} onClick={() => go({ name: "fill" })} variant="secondary">
          Isi truk berikutnya
        </BigButton>
        <BigButton onClick={() => go({ name: "today" })}>Kembali ke Hari ini</BigButton>
      </div>
    );
  }

  if (trucks.length === 0) return <Banner tone="warning">Belum ada truk aktif. Hubungi Dispatcher.</Banner>;

  const actions = (
    <div className="flex flex-col gap-3">
      <ErrorText>{error}</ErrorText>
      {step < 2 ? (
        <BigButton onClick={next}>Lanjut</BigButton>
      ) : (
        <BigButton icon={<Droplets aria-hidden />} onClick={save} loading={saving}>
          Simpan pengisian
        </BigButton>
      )}
      {step > 0 ? (
        <BigButton variant="secondary" onClick={() => (setError(null), setStep((s) => s - 1))}>
          Kembali
        </BigButton>
      ) : null}
    </div>
  );

  return (
    <StepScreen steps={["Truk", "Volume & rit", "Simpan"]} current={step} title="Isi truk" description={today.source?.name} actions={actions}>
      {step === 0 ? (
        <div className="flex flex-col gap-3" data-testid="langkah-truk">
          <p className="text-base font-medium">Truk dijadwalkan mengisi di sini hari ini</p>
          <div role="radiogroup" aria-label="Truk dijadwalkan" className="flex flex-col gap-2">
            {planned.length ? (
              planned.map((t) => <TruckButton key={t.id} truck={t} selected={selectedId === t.id} onSelect={() => (setSelectedId(t.id), setTripChoice(null), setConfirmUnplanned(false))} />)
            ) : (
              <p className="rounded-xl border-2 border-dashed p-3 text-base text-muted-foreground">Tidak ada truk yang dijadwalkan mengisi di sumber ini (lagi) hari ini.</p>
            )}
          </div>
          {others.length ? (
            showOthers ? (
              <div role="radiogroup" aria-label="Truk lain" className="flex flex-col gap-2">
                <p className="text-base font-medium">Truk lain (di luar rencana sumber ini)</p>
                {others.map((t) => (
                  <TruckButton key={t.id} truck={t} selected={selectedId === t.id} onSelect={() => (setSelectedId(t.id), setTripChoice(null), setConfirmUnplanned(false))} />
                ))}
              </div>
            ) : (
              <BigButton variant="outline" onClick={() => setShowOthers(true)}>
                Truk lain…
              </BigButton>
            )
          ) : null}
          {truck && !truck.planned ? (
            <label className="flex items-start gap-3 rounded-xl border-2 border-warning bg-warning/15 p-3 text-base">
              <input type="checkbox" className="mt-1 size-6" checked={confirmUnplanned} onChange={(e) => setConfirmUnplanned(e.target.checked)} />
              <span>
                Ya, truk {truck.code} memang mengisi di sini{truck.plannedSourceName ? ` (rencananya di ${truck.plannedSourceName})` : ""}. Dispatcher akan diberi tahu.
              </span>
            </label>
          ) : null}
        </div>
      ) : null}
      {step === 1 && truck ? (
        <div className="flex flex-col gap-4" data-testid="langkah-volume">
          <p className="text-lg font-semibold">
            Truk {truck.code} · {truck.plateNumber}
          </p>
          {truck.carriedWater ? (
            <Banner tone="warning">
              Truk masih membawa air rit gagal {truck.carriedWater.tripNumber}. Catat volume yang benar-benar diisi dan pilih alasan &quot;Sisa muatan&quot;.
            </Banner>
          ) : null}
          <NumberField id="volume-isi" label="Volume diisi" value={volume} onChange={setVolume} suffix="L" hint={`Bawaan ${formatLiter(standard)} · kapasitas tangki ${formatLiter(truck.capacityL)}`} />
          {needsReason ? (
            <>
              <Choices
                label="Alasan volume berbeda"
                columns={1}
                value={reason}
                onChange={setReason}
                options={[...FILL_VOLUME_REASONS.map((r) => ({ value: r as string, label: r })), { value: OTHER_REASON, label: "Lainnya" }]}
              />
              {reason === OTHER_REASON ? <TextField id="alasan-volume" label="Keterangan alasan" value={reasonNote} onChange={setReasonNote} /> : null}
            </>
          ) : null}
          <Choices
            label="Rit tujuan"
            columns={1}
            value={effectiveTrip}
            onChange={setTripChoice}
            options={[
              ...trips.map((t) => ({
                value: t.id,
                label: `${t.number} · ${t.isInternal ? `Pasokan ${t.destinationName ?? "depot"}` : t.customerName}${t.id === truck.nextTripId ? " (disarankan)" : ""}`,
              })),
              { value: NO_TRIP, label: "Tanpa rit (ditandai ke Dispatcher & pemilik)" },
            ]}
          />
        </div>
      ) : null}
      {step === 2 && truck && volume !== null ? (
        <div className="flex flex-col gap-4" data-testid="langkah-simpan-isi">
          <div className="flex flex-col gap-1 rounded-xl border-2 p-3">
            <FigureRow label="Truk" value={truck.code} />
            <FigureRow label="Volume" value={formatLiter(volume)} strong />
            <FigureRow label="Rit" value={trip ? `${trip.number}${trip.isInternal ? " · pasokan depot" : ""}` : "Tanpa rit"} tone={trip ? undefined : "warning"} />
            {needsReason ? <FigureRow label="Alasan" value={reasonText} /> : null}
          </div>
          <PhotoCapture label="Foto pengisian (opsional)" compress={{ maxBytes: today.rules.maxPhotoKb * 1024 }} onCapture={setPhoto} onClear={() => setPhoto(null)} />
        </div>
      ) : null}
    </StepScreen>
  );
}
