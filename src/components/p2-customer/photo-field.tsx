"use client";

/**
 * Isian foto keluhan: foto dikompres di perangkat (≤ bawaan PAR-38 150 KB, sisi 1.280 px) sebelum dikirim lewat Server Action, lalu
 * dipasang ke input berkas bernama `name` (DataTransfer). Gagal kompres → berkas asli dipakai.
 */
import { useRef, useState } from "react";

import { compressImage } from "@/client/media/compress-image";

export function PhotoField({ name = "photo", label = "Foto (opsional)" }: { name?: string; label?: string }) {
  const hidden = useRef<HTMLInputElement>(null);
  const [info, setInfo] = useState<string | null>(null);
  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !hidden.current) return;
    let out: File = file;
    try {
      const res = await compressImage(file);
      out = new File([res.blob], (file.name || "foto").replace(/\.[^.]+$/, "") + ".jpg", { type: res.blob.type || "image/jpeg" });
    } catch {
      out = file;
    }
    const dt = new DataTransfer();
    dt.items.add(out);
    hidden.current.files = dt.files;
    setInfo(`Foto siap dikirim (${Math.round(out.size / 1024)} KB).`);
  }
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <input type="file" accept="image/*" capture="environment" onChange={onChange} className="text-sm" />
      <input ref={hidden} type="file" name={name} className="hidden" tabIndex={-1} aria-hidden />
      {info ? <span className="text-xs font-normal text-muted-foreground">{info}</span> : null}
    </label>
  );
}
