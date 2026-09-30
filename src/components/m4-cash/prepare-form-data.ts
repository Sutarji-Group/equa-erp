/**
 * Siapkan FormData formulir kas sebelum dikirim ke Server Action (KODE PERAMBAN): foto (slip setor bank, bukti kas
 * kecil, bukti uang rusak) dikompresi di perangkat ≤ PAR-38 (`maxBytes` dari server lewat `useCashPhotoMaxBytes`;
 * bawaan 150 KB — D-14 butir 2) agar tidak melewati batas badan Server Action (4 MB, D-10 butir 3 / B-18) dan hemat
 * penyimpanan. Berkas non-foto (CSV/Excel/PDF) dibiarkan apa adanya.
 */
import { compressImage, DEFAULT_MAX_PHOTO_BYTES } from "@/client/media/compress-image";

const COMPRESSIBLE = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function prepareCashFormData(fd: FormData, maxBytes = DEFAULT_MAX_PHOTO_BYTES): Promise<FormData> {
  const out = new FormData();
  for (const [key, value] of fd.entries()) {
    if (typeof value === "string" || !(value instanceof Blob)) {
      out.append(key, value);
      continue;
    }
    const file = value as File;
    if (file.size === 0 || !COMPRESSIBLE.has(file.type) || file.size <= maxBytes) {
      out.append(key, file, file.name);
      continue;
    }
    try {
      const res = await compressImage(file, { maxBytes });
      const name = (file.name || "foto").replace(/\.[a-z0-9]+$/i, "") + ".jpg";
      out.append(key, new File([res.blob], name, { type: res.blob.type || "image/jpeg" }), name);
    } catch {
      // Perangkat tidak dapat memproses foto → kirim apa adanya (server menolak dengan pesan tindakan bila terlalu besar).
      out.append(key, file, file.name);
    }
  }
  return out;
}
