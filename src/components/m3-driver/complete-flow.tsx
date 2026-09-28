"use client";

/**
 * Selesai rit dalam 3 langkah (US-M3-03, US-M3-04):
 * 1. Bukti kirim — foto dari kamera aplikasi (≤ PAR-38, maks. m3.driver_rules), nama penerima (bawaan kontak), tanda
 *    tangan (lewati hanya dengan alasan), volume (bawaan PAR-15; beda → alasan dari daftar).
 * 2. Pembayaran (tidak dapat dilewati; rit internal tanpa bayar) — tunai (bawaan harga; kurang → alasan), transfer
 *    (foto bukti + jumlah; rekening PT tampil), tempo (pesanan tempo / tempo disetujui Dispatcher).
 * 3. Lokasi & simpan — jarak ke alamat dihitung lokal; > PAR-16 alasan wajib (> 1 km: tinjauan pemilik).
 * Semua tersimpan di ponsel lebih dulu (outbox) lalu terkirim otomatis.
 */
import { Camera, CheckCircle2, MapPin } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { distanceToAddressM, locationRule, M3_ATTACHMENT_KINDS, M3_COMMANDS, type CompletePayload, type FieldLocation } from "@/client/m3-driver/contract";
import { currentPosition, geoFailureText, type GeoFailure } from "@/client/m3-driver/geo";
import type { EnqueueAttachment } from "@/client/offline";
import { BigButton } from "@/components/field/big-button";
import { PhotoCapture, type CapturedPhoto } from "@/components/field/photo-capture";
import { SignaturePad, type SignaturePadHandle } from "@/components/field/signature-pad";
import { StepScreen } from "@/components/field/step-screen";
import { enumOptions } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { cn } from "@/lib/utils";

import { useDriver } from "./driver-context";
import { Banner, Choices, ErrorText, FigureRow, NumberField, TextField } from "./ui";

type Method = "cash" | "transfer" | "credit";

export function CompleteFlow({ tripId }: { tripId: string }) {
  const { trip, today, send, go } = useDriver();
  const t = trip(tripId);
  const settings = today?.settings;
  const [step, setStep] = useState(0);
  const [photos, setPhotos] = useState<(CapturedPhoto | null)[]>([null]);
  const [recipient, setRecipient] = useState(t?.contactName ?? "");
  const signatureRef = useRef<SignaturePadHandle>(null);
  const [signatureEmpty, setSignatureEmpty] = useState(true);
  const [signatureSkip, setSignatureSkip] = useState<string | null>(null);
  /** Tanda tangan diambil saat meninggalkan langkah 1 (kanvas tersembunyi di langkah berikutnya). */
  const [signatureBlob, setSignatureBlob] = useState<Blob | null>(null);
  const [volume, setVolume] = useState<number | null>(settings?.standardVolumeL ?? t?.plannedVolumeL ?? 5000);
  const [partialReason, setPartialReason] = useState<string | null>(null);
  const [partialNote, setPartialNote] = useState("");
  const approvedCredit = t?.paymentMethod === "credit" || t?.creditRequest?.status === "approved";
  const [method, setMethod] = useState<Method>(t?.paymentMethod === "credit" ? "credit" : t?.paymentMethod === "transfer" ? "transfer" : "cash");
  const [amount, setAmount] = useState<number | null>(t?.price ?? null);
  const [underReason, setUnderReason] = useState<string | null>(null);
  const [underNote, setUnderNote] = useState("");
  const [transferProof, setTransferProof] = useState<CapturedPhoto | null>(null);
  const [cashIfRejected, setCashIfRejected] = useState<number | null>(0);
  const [location, setLocation] = useState<FieldLocation>(null);
  const [geoFailure, setGeoFailure] = useState<GeoFailure | null>(null);
  const [locating, setLocating] = useState(false);
  const [locReason, setLocReason] = useState<string | null>(null);
  const [locNote, setLocNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const isInternal = !!t?.isInternal;
  const steps = isInternal ? ["Bukti kirim", "Simpan"] : ["Bukti kirim", "Pembayaran", "Simpan"];
  const lastStep = steps.length - 1;

  useEffect(() => {
    if (step !== lastStep) return;
    let cancelled = false;
    void (async () => {
      setLocating(true);
      const res = await currentPosition();
      if (cancelled) return;
      setLocation(res.location);
      setGeoFailure(res.failure);
      setLocating(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [step, lastStep]);

  if (!t || !settings || !today) return <Banner tone="danger">Rit tidak ditemukan. Kembali ke daftar rit.</Banner>;
  const taken = photos.filter((p): p is CapturedPhoto => !!p);
  const partial = volume !== null && volume !== settings.standardVolumeL;
  const distance = t.coordinateLocked ? distanceToAddressM(location, t) : null;
  const rule = locationRule(distance, settings);
  const paid = method === "credit" ? 0 : (amount ?? 0);
  const under = method === "credit" ? 0 : Math.max(0, t.price - paid);

  const validateStep = (): string | null => {
    if (step === 0) {
      if (taken.length === 0) return "Ambil minimal satu foto bukti kirim dari kamera.";
      if (!isInternal && recipient.trim().length < 2) return "Isi nama penerima.";
      if (!isInternal && signatureEmpty && !signatureSkip) return "Minta tanda tangan penerima, atau pilih alasan dilewati.";
      if (volume === null) return "Isi volume terkirim.";
      if (partial && !partialReason) return `Volume berbeda dari ${settings.standardVolumeL.toLocaleString("id-ID")} L: pilih alasan.`;
      if (partial && partialReason === "other" && partialNote.trim().length < 3) return "Tulis keterangan alasan volume.";
    }
    if (step === 1 && !isInternal) {
      if (method !== "credit") {
        if (amount === null) return "Isi jumlah yang diterima.";
        if (amount > t.price) return `Jumlah lebih besar dari harga ${formatRupiah(t.price)} tidak dapat dicatat — berikan kembalian.`;
        if (method === "transfer" && amount <= 0) return "Isi jumlah transfer sesuai bukti.";
        if (method === "transfer" && !transferProof) return "Ambil foto bukti transfer.";
        if (under > 0 && !underReason) return "Uang kurang dari harga: pilih alasan kurang bayar.";
        if (under > 0 && underReason === "other" && underNote.trim().length < 3) return "Tulis keterangan kurang bayar.";
      }
    }
    if (step === lastStep && rule !== "none" && !locReason) return "Lokasi jauh dari alamat: pilih alasan.";
    return null;
  };

  const next = async () => {
    const v = validateStep();
    setError(v);
    if (v) return;
    if (step === 0 && !isInternal) setSignatureBlob(!signatureSkip && !signatureEmpty ? ((await signatureRef.current?.toBlob()) ?? null) : null);
    setStep((s) => Math.min(lastStep, s + 1));
  };

  const back = () => setStep((s) => Math.max(0, s - 1));

  const save = async () => {
    const v = validateStep();
    if (v) return setError(v);
    setSaving(true);
    setError(null);
    try {
      const attachments: EnqueueAttachment[] = taken.map((p) => ({ kind: M3_ATTACHMENT_KINDS.deliveryPhoto, blob: p.blob, capturedAt: p.capturedAt, lat: location?.lat, lng: location?.lng }));
      if (!isInternal && !signatureSkip && signatureBlob) attachments.push({ kind: M3_ATTACHMENT_KINDS.signature, blob: signatureBlob, contentType: "image/png" });
      if (!isInternal && method === "transfer" && transferProof) attachments.push({ kind: M3_ATTACHMENT_KINDS.transferProof, blob: transferProof.blob, capturedAt: transferProof.capturedAt });
      const payment: CompletePayload["payment"] = isInternal
        ? { method: "none" }
        : method === "cash"
          ? { method: "cash", cashReceived: paid, underpaymentReasonCode: under > 0 ? underReason : null, underpaymentReasonText: under > 0 ? underNote.trim() || null : null }
          : method === "transfer"
            ? { method: "transfer", transferAmount: paid, underpaymentReasonCode: under > 0 ? underReason : null, underpaymentReasonText: under > 0 ? underNote.trim() || null : null }
            : { method: "credit", creditApprovalId: t.creditRequest?.approvalId ?? null, cashReceivedIfRejected: cashIfRejected ?? 0 };
      const payload: CompletePayload = {
        tripId: t.id,
        recipientName: recipient.trim() || null,
        signatureSkipReason: !isInternal && (signatureSkip || !signatureBlob) ? signatureSkip : null,
        deliveredVolumeL: volume ?? 0,
        partialVolumeReason: partial ? partialReason : null,
        partialVolumeNote: partial ? partialNote.trim() || null : null,
        location,
        clientDistanceM: distance,
        locationReason: rule !== "none" ? locReason : null,
        locationReasonNote: rule !== "none" ? locNote.trim() || null : null,
        payment,
      };
      await send(M3_COMMANDS.complete, payload, `Selesai ${t.number}`, attachments);
      go(isInternal ? { name: "list" } : { name: "receipt", tripId: t.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menyimpan. Coba lagi.");
    } finally {
      setSaving(false);
    }
  };

  const actions = (
    <div className="flex flex-col gap-2">
      <ErrorText>{error}</ErrorText>
      {step < lastStep ? (
        <BigButton size="xl" onClick={() => void next()}>
          Lanjut
        </BigButton>
      ) : (
        <BigButton size="xl" variant="success" icon={<CheckCircle2 aria-hidden />} loading={saving || locating} onClick={save}>
          Simpan Selesai
        </BigButton>
      )}
      {step > 0 ? (
        <BigButton variant="outline" onClick={back}>
          Kembali
        </BigButton>
      ) : null}
    </div>
  );

  return (
    <StepScreen steps={steps} current={step} title={`Selesai rit ${t.number}`} description={t.isInternal ? `Internal — ${t.destinationOutletName ?? "depot"}` : t.customerName} actions={actions}>
      {/* Langkah 1 tetap terpasang (disembunyikan) agar foto & tanda tangan tidak hilang saat kembali dari langkah berikutnya. */}
      {
        <div className={cn("flex flex-col gap-4", step !== 0 && "hidden")} data-testid="langkah-bukti" hidden={step !== 0}>
          {photos.map((p, i) => (
            <PhotoCapture
              key={i}
              label={i === 0 ? "Foto bukti kirim" : "Foto tambahan"}
              compress={{ maxBytes: settings.maxPhotoKb * 1024 }}
              onCapture={(photo) => {
                setPhotos((cur) => {
                  const copy = [...cur];
                  copy[i] = photo;
                  if (copy.length < settings.maxDeliveryPhotos && copy.every(Boolean)) copy.push(null);
                  return copy;
                });
              }}
              onClear={() => setPhotos((cur) => cur.map((x, j) => (j === i ? null : x)))}
            />
          ))}
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Camera className="size-4" aria-hidden /> Foto dari kamera aplikasi, dikompres ≤ {settings.maxPhotoKb} KB.
          </p>
          {!isInternal ? (
            <>
              <TextField id="penerima" label="Nama penerima" value={recipient} onChange={setRecipient} />
              {signatureSkip ? (
                <Banner tone="warning">
                  Tanda tangan dilewati: {enumOptions("signature_skip_reason").find((o) => o.value === signatureSkip)?.label}.{" "}
                  <button type="button" className="font-semibold underline" onClick={() => setSignatureSkip(null)}>
                    Minta tanda tangan
                  </button>
                </Banner>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="text-base font-medium">Tanda tangan penerima</p>
                  <SignaturePad ref={signatureRef} onChange={setSignatureEmpty} />
                  <Choices label="Tidak dapat tanda tangan?" value={null} onChange={(v) => setSignatureSkip(v)} options={enumOptions("signature_skip_reason")} />
                </div>
              )}
            </>
          ) : null}
          <NumberField id="volume" testId="volume-terkirim" label="Volume terkirim" suffix="L" value={volume} onChange={setVolume} hint={`Bawaan ${settings.standardVolumeL.toLocaleString("id-ID")} L`} />
          {partial ? (
            <>
              <Choices label="Alasan volume berbeda" value={partialReason} onChange={setPartialReason} options={enumOptions("partial_volume_reason")} />
              {partialReason === "other" ? <TextField id="volume-ket" label="Keterangan" value={partialNote} onChange={setPartialNote} /> : null}
              <Banner tone="info">Harga rit tetap harga pesanan. Dispatcher & Admin Keuangan diberi tahu (volume parsial).</Banner>
            </>
          ) : null}
        </div>
      }

      {step === 1 && !isInternal ? (
        <div className="flex flex-col gap-4" data-testid="langkah-bayar">
          <FigureRow label="Harga pesanan" value={formatRupiah(t.price)} strong testId="harga-bayar" />
          <Choices<Method>
            label="Cara bayar"
            value={method}
            onChange={(m) => {
              setMethod(m);
              setAmount(m === "credit" ? 0 : t.price);
            }}
            options={[
              { value: "cash", label: "Tunai" },
              { value: "transfer", label: "Transfer" },
              ...(approvedCredit || t.paymentMethod !== "credit" ? [{ value: "credit" as const, label: "Tempo" }] : []),
            ]}
          />
          {method === "cash" || method === "transfer" ? (
            <NumberField id="diterima" testId="uang-diterima" label={method === "cash" ? "Uang diterima (tunai)" : "Jumlah transfer (sesuai bukti)"} prefix="Rp" value={amount} onChange={setAmount} hint="Terisi harga. Ubah ke jumlah nyata bila kurang." />
          ) : null}
          {method === "transfer" ? (
            <>
              <Section2 title="Rekening PT untuk pelanggan">
                {today.bankAccounts.length === 0 ? <p className="text-base">Rekening belum diatur — hubungi Admin Keuangan.</p> : null}
                {today.bankAccounts.map((b) => (
                  <p key={b.id} className="text-lg font-semibold">
                    {b.bankName} {b.accountNumber} a.n. {b.accountName}
                  </p>
                ))}
              </Section2>
              <PhotoCapture label="Foto bukti transfer" compress={{ maxBytes: settings.maxPhotoKb * 1024 }} onCapture={setTransferProof} onClear={() => setTransferProof(null)} />
              <Banner tone="info">Transfer tidak menambah kas di tangan; berstatus &quot;belum dicocokkan&quot; sampai dicek Admin Keuangan.</Banner>
            </>
          ) : null}
          {method !== "credit" && under > 0 ? (
            <>
              <Banner tone="warning">Kurang bayar {formatRupiah(under)} — menjadi tagihan pelanggan hari ini.</Banner>
              <Choices label="Alasan kurang bayar" value={underReason} onChange={setUnderReason} options={enumOptions("underpayment_reason")} />
              {underReason === "other" ? <TextField id="kurang-ket" label="Keterangan" value={underNote} onChange={setUnderNote} /> : null}
            </>
          ) : null}
          {method === "credit" && !approvedCredit ? (
            <>
              <Banner tone="warning">
                Tempo belum disetujui Dispatcher{t.creditRequest ? ` (${t.creditRequest.status === "queued" || t.creditRequest.status === "submitted" ? "menunggu" : "tidak disetujui"})` : ""}. Bila tetap tidak disetujui saat terkirim, kekurangan
                dicatat sebagai kurang bayar.
              </Banner>
              <NumberField id="tunai-bila-ditolak" label="Tunai yang tetap diterima" prefix="Rp" value={cashIfRejected} onChange={setCashIfRejected} />
            </>
          ) : null}
          {method === "credit" && approvedCredit ? <Banner tone="success">Tempo: tagihan dicatat sebagai piutang pelanggan (tidak ada uang diterima).</Banner> : null}
        </div>
      ) : null}

      {step === lastStep ? (
        <div className="flex flex-col gap-4" data-testid="langkah-simpan">
          <p className="flex items-center gap-2 text-base">
            <MapPin className="size-5" aria-hidden />
            {locating ? "Mengambil lokasi…" : location ? `Lokasi tercatat (akurasi ±${location.accuracyM ?? "?"} m)` : "Tanpa lokasi"}
          </p>
          {geoFailureText(geoFailure) ? <Banner tone="warning">{geoFailureText(geoFailure)}</Banner> : null}
          {!t.coordinateLocked ? <Banner tone="info">Titik alamat belum dikunci — lokasi Selesai ini diusulkan sebagai titik alamat.</Banner> : null}
          {distance !== null ? <FigureRow label="Jarak ke alamat" value={`${distance.toLocaleString("id-ID")} m`} /> : null}
          {rule !== "none" ? (
            <>
              <Banner tone={rule === "review" ? "danger" : "warning"}>
                Lokasi lebih dari {(rule === "review" ? settings.ownerReviewGtM : settings.reasonRequiredGtM).toLocaleString("id-ID")} m dari alamat — alasan wajib
                {rule === "review" ? "; rit ditinjau pemilik." : "."}
              </Banner>
              <Choices label="Alasan lokasi" value={locReason} onChange={setLocReason} options={enumOptions("location_reason")} />
              {locReason === "other" ? <TextField id="lokasi-ket" label="Keterangan" value={locNote} onChange={setLocNote} /> : null}
            </>
          ) : null}
          <div className="rounded-xl border-2 p-3">
            <FigureRow label="Foto" value={taken.length} />
            <FigureRow label="Volume" value={`${(volume ?? 0).toLocaleString("id-ID")} L`} />
            {!isInternal ? <FigureRow label="Penerima" value={recipient || "—"} /> : null}
            {!isInternal ? <FigureRow label={method === "credit" ? "Tempo" : method === "cash" ? "Tunai diterima" : "Transfer"} value={formatRupiah(method === "credit" ? t.price : paid)} strong /> : null}
            {!isInternal && under > 0 ? <FigureRow label="Kurang bayar" value={formatRupiah(under)} /> : null}
          </div>
        </div>
      ) : null}
    </StepScreen>
  );
}

function Section2({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border-2 border-primary/40 bg-primary/5 p-3">
      <p className="text-base font-semibold">{title}</p>
      {children}
    </div>
  );
}
