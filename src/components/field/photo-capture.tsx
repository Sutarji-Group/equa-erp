"use client";

import { Camera, LoaderCircle, RotateCcw } from "lucide-react";
import { type ChangeEvent, useEffect, useId, useRef, useState } from "react";

import { type CompressOptions, compressImage, formatBytes } from "@/client/media/compress-image";
import { fieldPhotoMaxBytes } from "@/client/offline/params";
import { cn } from "@/lib/utils";

import { BigButton } from "./big-button";

export type CapturedPhoto = {
  /** JPEG terkompresi (≤ PAR-38; bawaan 150 KB, sisi panjang 1.280 px). */
  blob: Blob;
  /** URL objek untuk pratinjau (dicabut otomatis saat diganti/dilepas komponen). */
  previewUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
  /** Waktu pengambilan di perangkat. */
  capturedAt: Date;
};

export type PhotoCaptureProps = {
  /** Dipanggil setelah foto diambil & dikompres. */
  onCapture: (photo: CapturedPhoto) => void;
  /** Dipanggil saat pengguna mengambil ulang/menghapus foto. */
  onClear?: () => void;
  /** Label tombol, mis. "Foto bukti kirim". */
  label?: string;
  /**
   * Opsi kompresi. Tanpa `maxBytes` → PAR-38 dari data pull perangkat (`fieldPhotoMaxBytes`, D-14 butir 2); modul yang
   * membawa aturan sendiri (mis. `rules.maxPhotoKb` M3/M8) boleh mengisinya.
   */
  compress?: CompressOptions;
  disabled?: boolean;
  className?: string;
};

/**
 * Ambil foto dari KAMERA (bukan galeri; `capture="environment"`), kompres di perangkat ke ≤ PAR-38 JPEG (bawaan
 * 150 KB, sisi panjang 1.280 px; PRD US-M3-03 KP-1 & KP-6, NFR-17), tampilkan pratinjau. Blob dikembalikan untuk
 * dimasukkan ke outbox.
 */
export function PhotoCapture({ onCapture, onClear, label = "Ambil foto", compress, disabled, className }: PhotoCaptureProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (photo) URL.revokeObjectURL(photo.previewUrl);
    };
  }, [photo]);

  async function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Berkas bukan foto. Ambil foto dengan kamera.");
      return;
    }
    setProcessing(true);
    setError(null);
    try {
      // PAR-38 dari server (data pull) bila pemanggil tidak memberi batas sendiri — bukan konstanta.
      const maxBytes = compress?.maxBytes ?? (await fieldPhotoMaxBytes());
      const result = await compressImage(file, { ...compress, maxBytes });
      const captured: CapturedPhoto = {
        blob: result.blob,
        previewUrl: URL.createObjectURL(result.blob),
        width: result.width,
        height: result.height,
        sizeBytes: result.blob.size,
        capturedAt: new Date(),
      };
      setPhoto(captured);
      onCapture(captured);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Foto gagal diproses. Ambil ulang foto.");
    } finally {
      setProcessing(false);
    }
  }

  function retake() {
    setPhoto(null);
    onClear?.();
    inputRef.current?.click();
  }

  return (
    <div data-slot="photo-capture" className={cn("flex flex-col gap-3", className)}>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        onChange={handleChange}
        disabled={disabled || processing}
        aria-label={label}
      />
      {photo ? (
        <figure className="overflow-hidden rounded-xl border-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- URL objek lokal, bukan aset jaringan */}
          <img src={photo.previewUrl} alt="Pratinjau foto" className="max-h-80 w-full bg-muted object-contain" />
          <figcaption className="px-3 py-2 text-sm text-muted-foreground">
            Foto tersimpan · {formatBytes(photo.sizeBytes)}
          </figcaption>
        </figure>
      ) : null}
      {processing ? (
        <BigButton variant="secondary" disabled icon={<LoaderCircle className="animate-spin" aria-hidden />}>
          Memproses foto…
        </BigButton>
      ) : photo ? (
        <BigButton variant="secondary" onClick={retake} disabled={disabled} icon={<RotateCcw aria-hidden />}>
          Ambil ulang
        </BigButton>
      ) : (
        <BigButton onClick={() => inputRef.current?.click()} disabled={disabled} icon={<Camera aria-hidden />}>
          {label}
        </BigButton>
      )}
      {error ? (
        <p role="alert" className="text-base font-semibold text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
