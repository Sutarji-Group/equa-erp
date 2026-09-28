"use client";

/**
 * Catat angka meter dalam 3 langkah (US-M8-01 KP-1..KP-3, US-M8-07 KP-3):
 * 1. Meter & pembacaan — meter sumber ini + pagi (awal) / malam (akhir), disarankan otomatis.
 * 2. Angka — liter bulat; lebih kecil dari pembacaan sebelumnya ditolak dengan pesan (kecuali putaran tercatat admin).
 * 3. Foto & simpan — foto meter dari kamera aplikasi (≤ PAR-38) wajib; lewat jam batas → alasan terlambat wajib.
 * Tersimpan di ponsel lebih dulu (outbox) lalu terkirim otomatis; setelah tersimpan angka tidak dapat diubah operator.
 */
import { Camera, Gauge } from "lucide-react";
import { useState } from "react";

import {
  formatLiter,
  isLateReading,
  M8_ATTACHMENT_KINDS,
  M8_COMMANDS,
  meterReadingProblem,
  PHASE_LABEL,
  readingLimits,
  suggestedPhase,
  type MeterPhase,
  type MeterReadingPayload,
} from "@/client/m8-production/contract";
import { BigButton } from "@/components/field/big-button";
import { PhotoCapture, type CapturedPhoto } from "@/components/field/photo-capture";
import { StepScreen } from "@/components/field/step-screen";
import { newId } from "@/lib/ids";
import { cn } from "@/lib/utils";

import { useProduction } from "./production-context";
import { Banner, Choices, ErrorText, FigureRow, NumberField, TextField } from "./ui";

export function MeterFlow({ meterId, phase: initialPhase }: { meterId?: string; phase?: MeterPhase }) {
  const { today, send, go, session } = useProduction();
  const meters = today?.meters ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(meterId ?? (meters.length === 1 ? meters[0]!.id : null));
  const meter = meters.find((m) => m.id === selectedId) ?? null;
  const [phase, setPhase] = useState<MeterPhase | null>(initialPhase ?? (meter ? suggestedPhase(meter) : null));
  const [step, setStep] = useState(0);
  const [value, setValue] = useState<number | null>(null);
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [lateReason, setLateReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  if (!today) return null;
  if (meters.length === 0) return <Banner tone="warning">Belum ada meter aktif di sumber ini. Minta admin sistem mendaftarkan meter.</Banner>;

  const already = meter && phase ? meter.today[phase] : null;
  const limits = meter && phase ? readingLimits(meter, phase) : null;
  const late = phase ? isLateReading(phase, new Date(), today.rules) : false;
  const deadline = phase === "morning" ? today.rules.morningDeadline : today.rules.eveningDeadline;
  const produced = meter && phase === "evening" && value !== null && meter.today.morning ? value - meter.today.morning.readingL : null;

  const problem = (): string | null => {
    if (step === 0) {
      if (!meter) return "Pilih meter.";
      if (!phase) return "Pilih pembacaan pagi atau malam.";
      if (already) return `Pembacaan ${PHASE_LABEL[phase].toLowerCase()} meter ${meter.code} hari ini sudah dicatat (${formatLiter(already.readingL)}). Koreksi hanya oleh Admin Keuangan.`;
    }
    if (step >= 1) {
      if (value === null) return "Ketik angka pada meter (liter).";
      const p = meterReadingProblem({ value, previousL: limits!.previousL, nextL: limits!.nextL, rolloverPending: !!meter!.rollover, meterCode: meter!.code });
      if (p) return p;
    }
    if (step === 2) {
      if (!photo) return "Ambil foto meter dari kamera aplikasi.";
      if (late && lateReason.trim().length < 3) return `Sudah lewat jam ${deadline.replace(":", ".")} — isi alasan terlambat.`;
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
    if (p || !meter || !phase || value === null || !photo) return;
    setSaving(true);
    try {
      const payload: MeterReadingPayload = { readingId: newId(), waterMeterId: meter.id, phase, readingL: value, lateReason: late ? lateReason.trim() : null };
      await send(M8_COMMANDS.meterReading, payload, `Meter ${meter.code} ${PHASE_LABEL[phase].toLowerCase()}: ${formatLiter(value)}`, [
        { kind: M8_ATTACHMENT_KINDS.meterPhoto, blob: photo.blob, capturedAt: photo.capturedAt },
      ]);
      setDone(`Angka meter ${meter.code} ${PHASE_LABEL[phase].toLowerCase()} ${formatLiter(value)} tersimpan${session.sync.online ? " dan sedang dikirim." : " di ponsel. Terkirim otomatis saat ada sinyal."}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menyimpan. Coba lagi.");
    } finally {
      setSaving(false);
    }
  };

  if (done) {
    return (
      <div className="flex flex-col gap-4" data-testid="meter-tersimpan">
        <Banner tone="success">{done}</Banner>
        <BigButton onClick={() => go({ name: "today" })}>Kembali ke Hari ini</BigButton>
      </div>
    );
  }

  const actions = (
    <div className="flex flex-col gap-3">
      <ErrorText>{error}</ErrorText>
      {step < 2 ? (
        <BigButton onClick={next}>Lanjut</BigButton>
      ) : (
        <BigButton icon={<Gauge aria-hidden />} onClick={save} loading={saving}>
          Simpan angka meter
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
    <StepScreen steps={["Meter", "Angka", "Foto & simpan"]} current={step} title="Catat angka meter" description={today.source?.name} actions={actions}>
      {step === 0 ? (
        <div className="flex flex-col gap-4" data-testid="langkah-meter">
          {meters.length > 1 ? (
            <Choices
              label="Meter"
              columns={1}
              value={selectedId}
              onChange={(id) => {
                setSelectedId(id);
                const m = meters.find((x) => x.id === id);
                if (m && !initialPhase) setPhase(suggestedPhase(m));
              }}
              options={meters.map((m) => ({ value: m.id, label: `${m.code}${m.name ? ` · ${m.name}` : ""}` }))}
            />
          ) : (
            <p className="text-lg font-semibold">
              Meter {meters[0]!.code}
              {meters[0]!.name ? ` · ${meters[0]!.name}` : ""}
            </p>
          )}
          <Choices
            label="Pembacaan"
            value={phase}
            onChange={setPhase}
            options={[
              { value: "morning", label: `${PHASE_LABEL.morning}${meter?.today.morning ? " ✓" : ""}` },
              { value: "evening", label: `${PHASE_LABEL.evening}${meter?.today.evening ? " ✓" : ""}` },
            ]}
          />
          {meter ? (
            <div className="flex flex-col gap-1 rounded-xl border-2 p-3">
              <FigureRow label="Pagi hari ini" value={meter.today.morning ? formatLiter(meter.today.morning.readingL) : "belum"} />
              <FigureRow label="Malam hari ini" value={meter.today.evening ? formatLiter(meter.today.evening.readingL) : "belum"} />
            </div>
          ) : null}
          {meter?.rollover ? <Banner tone="info">Putaran meter sudah dicatat admin: angka yang lebih kecil dari sebelumnya diterima sekali.</Banner> : null}
        </div>
      ) : null}
      {step === 1 && meter && phase ? (
        <div className="flex flex-col gap-4" data-testid="langkah-angka">
          <p className="text-lg">
            Meter <strong>{meter.code}</strong> · {PHASE_LABEL[phase]}
          </p>
          <NumberField
            id="angka-meter"
            label="Angka pada meter"
            value={value}
            onChange={setValue}
            suffix="L"
            large
            hint={`Angka sebelumnya: ${formatLiter(limits!.previousL)}${limits!.nextL !== null ? ` · angka malam: ${formatLiter(limits!.nextL)}` : ""}`}
          />
          {produced !== null && produced >= 0 ? (
            <p className="text-lg" data-testid="produksi-sementara">
              Produksi hari ini: <strong>{formatLiter(produced)}</strong>
            </p>
          ) : null}
        </div>
      ) : null}
      {step === 2 && meter && phase ? (
        <div className="flex flex-col gap-4" data-testid="langkah-foto">
          <p className={cn("text-2xl font-bold tabular-nums")}>{formatLiter(value)}</p>
          <PhotoCapture
            label="Foto meter"
            compress={{ maxBytes: today.rules.maxPhotoKb * 1024 }}
            onCapture={setPhoto}
            onClear={() => setPhoto(null)}
          />
          {!photo ? (
            <p className="flex items-center gap-2 text-base text-muted-foreground">
              <Camera className="size-5" aria-hidden /> Foto angka meter wajib (bukti untuk verifikasi).
            </p>
          ) : null}
          {late ? (
            <>
              <Banner tone="warning">Sudah lewat jam {deadline.replace(":", ".")} — pembacaan ini tercatat terlambat. Tulis alasannya.</Banner>
              <TextField id="alasan-terlambat" label="Alasan terlambat" value={lateReason} onChange={setLateReason} placeholder="Mis. listrik padam, hujan deras" />
            </>
          ) : null}
        </div>
      ) : null}
    </StepScreen>
  );
}
