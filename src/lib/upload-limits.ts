/**
 * Batas unggah formulir kantor lewat Server Action (D-10 butir 3, backlog B-18) — isomorfik (klien & server).
 *
 * - Badan permintaan Server Action dibatasi `serverActions.bodySizeLimit = '4mb'` (next.config.ts), di bawah batas badan
 *   permintaan Vercel 4,5 MB. Batas itu berlaku untuk SELURUH badan multipart (berkas + isian + overhead batas/kepala
 *   bagian), sehingga berkas diberi ruang sisa `MULTIPART_HEADROOM_BYTES`.
 * - Foto (JPEG/PNG/WebP) dikompres di peramban sebelum dikirim (`OFFICE_PHOTO_*`); berkas lain (PDF, Excel, CSV) tidak
 *   dapat dikompres di peramban → yang melebihi batas ditolak dengan pesan tindakan sebelum dikirim.
 */

/** Nilai `serverActions.bodySizeLimit` di next.config.ts. */
export const SERVER_ACTION_BODY_LIMIT = "4mb";

/** Batas badan Server Action dalam byte (4 MB). */
export const SERVER_ACTION_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

/** Ruang untuk isian formulir lain & overhead multipart (Next menyarankan 10–20 KB; diberi 64 KB). */
export const MULTIPART_HEADROOM_BYTES = 64 * 1024;

/** Ukuran total berkas maksimum dalam satu formulir kantor. */
export const MAX_OFFICE_UPLOAD_BYTES = SERVER_ACTION_BODY_LIMIT_BYTES - MULTIPART_HEADROOM_BYTES;

/** Foto kantor (slip, nota, perjanjian yang difoto) dikompres bila lebih besar dari ini — tetap terbaca. */
export const OFFICE_PHOTO_TARGET_BYTES = 1024 * 1024;

/** Sisi terpanjang foto kantor setelah kompresi (dokumen tetap terbaca). */
export const OFFICE_PHOTO_MAX_DIMENSION = 2400;

/** Tipe gambar yang dapat dikompres di peramban. */
export const COMPRESSIBLE_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);

/** `4_194_304` → `"4 MB"`, `5_452_595` → `"5,2 MB"`, `312_345` → `"305 KB"`. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1).replace(".", ",")} MB`;
}

export type UploadFileInfo = { name: string; size: number; type?: string };

export type UploadCheck = { ok: true; totalBytes: number } | { ok: false; totalBytes: number; message: string };

const LIMIT_TEXT = formatFileSize(SERVER_ACTION_BODY_LIMIT_BYTES);

/** Saran tindakan per jenis berkas yang terlalu besar. */
function adviceFor(file: UploadFileInfo): string {
  const type = file.type ?? "";
  const name = file.name.toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) {
    return "Perkecil PDF (pindai ulang hitam-putih/resolusi lebih rendah atau simpan ulang dengan kualitas lebih kecil) atau pisahkan halamannya, lalu pilih lagi.";
  }
  if (COMPRESSIBLE_IMAGE_TYPES.has(type) || /\.(jpe?g|png|webp)$/.test(name)) {
    return "Foto tidak dapat diperkecil otomatis di perangkat ini. Ambil ulang foto dengan resolusi lebih rendah, lalu pilih lagi.";
  }
  return "Perkecil berkas (mis. hapus lembar/kolom yang tidak perlu) atau pisahkan menjadi beberapa berkas, lalu pilih lagi.";
}

/**
 * Periksa ukuran berkas formulir terhadap batas Server Action. Satu berkas > batas → pesan untuk berkas itu; total
 * beberapa berkas > batas → pesan total. Berkas kosong (input tanpa pilihan) diabaikan.
 */
export function checkUploadSizes(files: readonly UploadFileInfo[], maxBytes: number = MAX_OFFICE_UPLOAD_BYTES): UploadCheck {
  const real = files.filter((f) => f.size > 0);
  const totalBytes = real.reduce((s, f) => s + f.size, 0);
  const big = real.find((f) => f.size > maxBytes);
  if (big) {
    return {
      ok: false,
      totalBytes,
      message: `Berkas "${big.name}" berukuran ${formatFileSize(big.size)}, melebihi batas unggah ${LIMIT_TEXT}. ${adviceFor(big)}`,
    };
  }
  if (totalBytes > maxBytes) {
    return {
      ok: false,
      totalBytes,
      message: `Total lampiran ${formatFileSize(totalBytes)} melebihi batas unggah ${LIMIT_TEXT} per formulir. Kirim lampiran satu per satu atau perkecil berkasnya, lalu coba lagi.`,
    };
  }
  return { ok: true, totalBytes };
}

/** Pesan bila Server Action gagal di luar layanan (jaringan putus, badan permintaan melebihi batas). */
export const ACTION_TRANSPORT_FAILURE_MESSAGE = `Formulir gagal terkirim. Periksa koneksi internet lalu coba lagi; bila melampirkan berkas, pastikan totalnya di bawah ${LIMIT_TEXT}.`;
