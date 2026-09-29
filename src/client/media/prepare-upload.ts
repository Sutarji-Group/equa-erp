/**
 * Siapkan berkas unggahan formulir kantor (KODE PERAMBAN; D-10 butir 3, B-18): foto JPEG/PNG/WebP yang lebih besar dari
 * `OFFICE_PHOTO_TARGET_BYTES` dikompres di perangkat (canvas) sebelum dikirim lewat Server Action; berkas lain dibiarkan.
 * Gagal kompres → berkas asli dipakai (pemeriksaan ukuran `checkUploadSizes` yang menolak dengan pesan tindakan).
 */
import {
  COMPRESSIBLE_IMAGE_TYPES,
  OFFICE_PHOTO_MAX_DIMENSION,
  OFFICE_PHOTO_TARGET_BYTES,
} from "@/lib/upload-limits";

import { compressImage, type CompressOptions, type CompressResult } from "./compress-image";

export type Compressor = (file: Blob, options: CompressOptions) => Promise<Pick<CompressResult, "blob">>;

/** Nama berkas hasil kompresi (`.jpg`). */
export function jpegName(name: string): string {
  return (name || "foto").replace(/\.[a-z0-9]+$/i, "") + ".jpg";
}

/** Perlu dikompres? (foto berukuran di atas sasaran). */
export function shouldCompress(file: { type: string; size: number }, targetBytes = OFFICE_PHOTO_TARGET_BYTES): boolean {
  return COMPRESSIBLE_IMAGE_TYPES.has(file.type) && file.size > targetBytes;
}

/** Kompres foto besar; kembalikan daftar berkas (urutan sama) dan apakah ada yang berubah. */
export async function prepareOfficeFiles(
  files: readonly File[],
  opts: { targetBytes?: number; compress?: Compressor } = {},
): Promise<{ files: File[]; changed: boolean }> {
  const targetBytes = opts.targetBytes ?? OFFICE_PHOTO_TARGET_BYTES;
  const compress = opts.compress ?? compressImage;
  const out: File[] = [];
  let changed = false;
  for (const file of files) {
    if (!shouldCompress(file, targetBytes)) {
      out.push(file);
      continue;
    }
    try {
      const res = await compress(file, { maxBytes: targetBytes, maxDimension: OFFICE_PHOTO_MAX_DIMENSION, minDimension: 800 });
      if (res.blob.size > 0 && res.blob.size < file.size) {
        out.push(new File([res.blob], jpegName(file.name), { type: res.blob.type || "image/jpeg", lastModified: file.lastModified }));
        changed = true;
        continue;
      }
    } catch {
      // Perangkat tidak dapat memproses foto → berkas asli (diperiksa ukurannya oleh pemanggil).
    }
    out.push(file);
  }
  return { files: out, changed };
}
