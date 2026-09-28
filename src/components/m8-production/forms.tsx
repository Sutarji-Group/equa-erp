"use client";

/**
 * Formulir singkat aplikasi operator produksi (offline, satu layar):
 * - Level tandon opsional (US-M8-04 KP-3, PTB-41) — liter atau persen.
 * - Investigasi susut di atas ambang (US-M8-04 KP-2, BR-26) — alasan dari daftar + foto; "Lainnya" wajib keterangan.
 * - Hasil uji mutu air sumber (US-M8-06 KP-2) — tanggal, laboratorium, parameter & nilai, lulus/tidak, foto sertifikat;
 *   tidak lulus → tindakan (deskripsi, penanggung jawab, tenggat) wajib.
 */
import { FlaskConical, Plus, Search, Trash2, Waves } from "lucide-react";
import { useState } from "react";

import {
  formatLiter,
  formatPct,
  M8_ATTACHMENT_KINDS,
  M8_COMMANDS,
  type LossInvestigationPayload,
  type LossReason,
  type QualityResultLine,
  type QualityTestPayload,
  type TankLevelPayload,
} from "@/client/m8-production/contract";
import { BigButton } from "@/components/field/big-button";
import { PhotoCapture, type CapturedPhoto } from "@/components/field/photo-capture";
import { newId } from "@/lib/ids";
import { enumOptions, label } from "@/lib/labels";
import { toBusinessDate } from "@/lib/time";

import { useProduction } from "./production-context";
import { Banner, Choices, ErrorText, FigureRow, NumberField, Section, TextField } from "./ui";

function Saved({ text, testId }: { text: string; testId: string }) {
  const { go } = useProduction();
  return (
    <div className="flex flex-col gap-4" data-testid={testId}>
      <Banner tone="success">{text}</Banner>
      <BigButton onClick={() => go({ name: "today" })}>Kembali ke Hari ini</BigButton>
    </div>
  );
}

function savedSuffix(online: boolean): string {
  return online ? " dan sedang dikirim." : " di ponsel. Terkirim otomatis saat ada sinyal.";
}

// =====================================================================================================================
// Level tandon
// =====================================================================================================================

export function TankForm() {
  const { today, send, session } = useProduction();
  const [unit, setUnit] = useState<"pct" | "liter">("pct");
  const [value, setValue] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  if (!today) return null;
  if (done) return <Saved text={done} testId="tandon-tersimpan" />;

  const save = async () => {
    if (value === null) return setError("Isi level tandon.");
    if (unit === "pct" && value > 100) return setError("Persen maksimal 100.");
    setSaving(true);
    setError(null);
    try {
      const payload: TankLevelPayload = { tankLevelId: newId(), levelL: unit === "liter" ? value : null, levelPct: unit === "pct" ? value : null, notes: notes.trim() || null };
      const text = unit === "pct" ? `${value}%` : formatLiter(value);
      await send(M8_COMMANDS.tankLevel, payload, `Level tandon ${text}`);
      setDone(`Level tandon ${text} tersimpan${savedSuffix(session.sync.online)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menyimpan. Coba lagi.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="form-tandon">
      <p className="text-base text-muted-foreground">Opsional — membantu menjelaskan pergeseran stok air antar hari. Peringatan susut tetap memakai angka harian.</p>
      <Choices
        label="Satuan"
        value={unit}
        onChange={setUnit}
        options={[
          { value: "pct", label: "Persen (%)" },
          { value: "liter", label: "Liter" },
        ]}
      />
      <NumberField id="level-tandon" label="Level tandon" value={value} onChange={setValue} suffix={unit === "pct" ? "%" : "L"} large />
      <TextField id="catatan-tandon" label="Catatan (opsional)" value={notes} onChange={setNotes} placeholder="Mis. tandon utama" />
      {today.tankLevels.length ? (
        <Section title="Hari ini">
          {today.tankLevels.map((t) => (
            <FigureRow key={t.id} label={new Date(t.readAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" })} value={t.levelPct !== null ? `${t.levelPct}%` : formatLiter(t.levelL)} />
          ))}
        </Section>
      ) : null}
      <ErrorText>{error}</ErrorText>
      <BigButton icon={<Waves aria-hidden />} onClick={save} loading={saving}>
        Simpan level tandon
      </BigButton>
    </div>
  );
}

// =====================================================================================================================
// Investigasi susut
// =====================================================================================================================

export function InvestigationForm({ waterBalanceId }: { waterBalanceId: string }) {
  const { today, send, session } = useProduction();
  const task = today?.investigations.find((i) => i.waterBalanceId === waterBalanceId);
  const [reason, setReason] = useState<LossReason | null>(task?.reason ?? null);
  const [note, setNote] = useState(task?.note ?? "");
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  if (!today) return null;
  if (done) return <Saved text={done} testId="investigasi-tersimpan" />;
  if (!task) return <Banner tone="info">Tugas investigasi ini sudah selesai atau tidak ditemukan.</Banner>;

  const save = async () => {
    if (!reason) return setError("Pilih alasan susut dari daftar.");
    if (reason === "other" && note.trim().length < 3) return setError("Alasan \"Lainnya\" wajib diberi keterangan singkat.");
    if (!photo) return setError("Ambil foto bukti dari kamera aplikasi.");
    setSaving(true);
    setError(null);
    try {
      const payload: LossInvestigationPayload = { waterBalanceId, reason, note: note.trim() || null };
      await send(M8_COMMANDS.lossInvestigation, payload, `Investigasi susut ${task.businessDate}: ${label("loss_reason", reason)}`, [
        { kind: M8_ATTACHMENT_KINDS.investigationPhoto, blob: photo.blob, capturedAt: photo.capturedAt },
      ]);
      setDone(`Penjelasan susut ${task.businessDate} tersimpan${savedSuffix(session.sync.online)} Pemilik akan menerima atau mengembalikan penjelasan.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menyimpan. Coba lagi.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="form-investigasi">
      <Section title={`Susut ${task.businessDate}`}>
        <FigureRow label="Produksi" value={formatLiter(task.producedL)} />
        <FigureRow label="Pengisian" value={formatLiter(task.filledTotalL)} />
        <FigureRow label="Susut" value={`${formatLiter(task.lossL)} (${formatPct(task.lossPct)})`} strong tone="danger" />
      </Section>
      {task.reviewNote ? <Banner tone="warning">Dikembalikan pemilik: {task.reviewNote}</Banner> : null}
      <Choices label="Alasan susut" columns={1} value={reason} onChange={setReason} options={enumOptions("loss_reason")} />
      <TextField id="keterangan-susut" label={reason === "other" ? "Keterangan (wajib)" : "Keterangan (opsional)"} value={note} onChange={setNote} multiline />
      <PhotoCapture label="Foto bukti" compress={{ maxBytes: today.rules.maxPhotoKb * 1024 }} onCapture={setPhoto} onClear={() => setPhoto(null)} />
      <ErrorText>{error}</ErrorText>
      <BigButton icon={<Search aria-hidden />} onClick={save} loading={saving}>
        Kirim penjelasan susut
      </BigButton>
    </div>
  );
}

// =====================================================================================================================
// Hasil uji mutu
// =====================================================================================================================

type Line = QualityResultLine & { key: string };

const blankLine = (): Line => ({ key: newId(), parameter: "", value: "", unit: "", limit: "", passed: true });

export function QualityForm({ scheduleId }: { scheduleId?: string | null }) {
  const { today, send, session } = useProduction();
  const schedule = today?.quality.schedules.find((s) => s.id === scheduleId) ?? null;
  const [testDate, setTestDate] = useState(toBusinessDate(new Date()));
  const [laboratory, setLaboratory] = useState(schedule?.laboratory ?? "");
  const [lines, setLines] = useState<Line[]>(() => (schedule?.parameters.length ? schedule.parameters.map((p) => ({ ...blankLine(), parameter: p })) : [blankLine()]));
  const [certificate, setCertificate] = useState<CapturedPhoto | null>(null);
  const [actionText, setActionText] = useState("");
  const [owner, setOwner] = useState<string | null>(null);
  const [due, setDue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  if (!today) return null;
  if (done) return <Saved text={done} testId="uji-tersimpan" />;
  const passed = lines.every((l) => l.passed);

  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const save = async () => {
    if (laboratory.trim().length < 2) return setError("Isi nama laboratorium.");
    if (lines.some((l) => !l.parameter.trim() || !l.value.trim())) return setError("Lengkapi nama parameter dan nilainya.");
    if (!certificate) return setError("Ambil foto sertifikat hasil uji.");
    if (!passed && (actionText.trim().length < 5 || !owner || !due)) return setError("Hasil tidak lulus: isi tindakan, penanggung jawab, dan tenggat.");
    setSaving(true);
    setError(null);
    try {
      const payload: QualityTestPayload = {
        qualityTestId: newId(),
        scheduleId: schedule?.id ?? null,
        testDate,
        laboratory: laboratory.trim(),
        results: lines.map((l) => ({ parameter: l.parameter.trim(), value: l.value.trim(), unit: l.unit?.trim() || null, limit: l.limit?.trim() || null, passed: l.passed })),
        passed,
        action: passed ? null : { description: actionText.trim(), ownerEmployeeId: owner!, dueDate: due },
      };
      await send(M8_COMMANDS.qualityTest, payload, `Hasil uji mutu ${testDate}: ${passed ? "lulus" : "tidak lulus"}`, [
        { kind: M8_ATTACHMENT_KINDS.certificate, blob: certificate.blob, capturedAt: certificate.capturedAt },
      ]);
      setDone(`Hasil uji mutu ${testDate} (${passed ? "lulus" : "tidak lulus"}) tersimpan${savedSuffix(session.sync.online)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menyimpan. Coba lagi.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="form-uji-mutu">
      <TextField id="tanggal-uji" type="date" label="Tanggal uji" value={testDate} onChange={setTestDate} />
      <TextField id="laboratorium" label="Laboratorium" value={laboratory} onChange={setLaboratory} placeholder="Mis. Labkesda Cianjur" />
      <div className="flex flex-col gap-3">
        <p className="text-base font-medium">Parameter & nilai</p>
        {lines.map((l, i) => (
          <div key={l.key} className="flex flex-col gap-2 rounded-xl border-2 p-3">
            <TextField id={`param-${i}`} label="Parameter" value={l.parameter} onChange={(v) => update(l.key, { parameter: v })} placeholder="Mis. E. coli" />
            <div className="grid grid-cols-2 gap-2">
              <TextField id={`nilai-${i}`} label="Nilai" value={l.value} onChange={(v) => update(l.key, { value: v })} />
              <TextField id={`satuan-${i}`} label="Satuan" value={l.unit ?? ""} onChange={(v) => update(l.key, { unit: v })} />
            </div>
            <TextField id={`batas-${i}`} label="Batas" value={l.limit ?? ""} onChange={(v) => update(l.key, { limit: v })} />
            <Choices
              label={`Hasil ${l.parameter || `parameter ${i + 1}`}`}
              value={l.passed ? "pass" : "fail"}
              onChange={(v) => update(l.key, { passed: v === "pass" })}
              options={[
                { value: "pass", label: "Lulus" },
                { value: "fail", label: "Tidak lulus" },
              ]}
            />
            {lines.length > 1 ? (
              <BigButton variant="outline" icon={<Trash2 aria-hidden />} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                Buang parameter ini
              </BigButton>
            ) : null}
          </div>
        ))}
        <BigButton variant="secondary" icon={<Plus aria-hidden />} onClick={() => setLines((ls) => [...ls, blankLine()])}>
          Tambah parameter
        </BigButton>
      </div>
      <Banner tone={passed ? "success" : "danger"}>Hasil keseluruhan: {passed ? "LULUS" : "TIDAK LULUS"}</Banner>
      {!passed ? (
        <Section title="Tindakan wajib">
          <TextField id="tindakan" label="Tindakan" value={actionText} onChange={setActionText} multiline placeholder="Mis. klorinasi tandon & uji ulang" />
          <Choices label="Penanggung jawab" columns={1} value={owner} onChange={setOwner} options={today.quality.employees.map((e) => ({ value: e.id, label: e.name }))} />
          <TextField id="tenggat" type="date" label="Tenggat" value={due} onChange={setDue} />
        </Section>
      ) : null}
      <PhotoCapture label="Foto sertifikat" compress={{ maxBytes: today.rules.maxPhotoKb * 1024 }} onCapture={setCertificate} onClear={() => setCertificate(null)} />
      <ErrorText>{error}</ErrorText>
      <BigButton icon={<FlaskConical aria-hidden />} onClick={save} loading={saving}>
        Simpan hasil uji
      </BigButton>
    </div>
  );
}
