/**
 * Kompresi foto di perangkat sebelum masuk antrean sinkron (docs/ARCHITECTURE.md §7; PRD US-M3-03 KP-6, PAR-38):
 * target ≤ 300 KB JPEG. Kode PERAMBAN (canvas); inti algoritme `compressWithEncoder` murni & dapat diuji tanpa canvas.
 *
 * Strategi: skala sisi terpanjang ≤ `maxDimension` → encode JPEG mulai `initialQuality`, turunkan kualitas bertahap
 * hingga `minQuality`; bila masih terlalu besar, perkecil dimensi (× `scaleStep`) dan ulangi, sampai ≤ `maxBytes` atau
 * sisi terpanjang < `minDimension` (hasil terkecil dikembalikan dengan `withinLimit: false`).
 */

/** Batas bawaan 300 KB (PAR-38). Nilai sebenarnya diambil dari parameter oleh pemanggil bila tersedia. */
export const DEFAULT_MAX_PHOTO_BYTES = 300 * 1024;

export type CompressOptions = {
  /** Ukuran maksimum hasil (byte). Bawaan 300 KB. */
  maxBytes?: number;
  /** Sisi terpanjang maksimum (px). Bawaan 1600. */
  maxDimension?: number;
  /** Sisi terpanjang minimum sebelum menyerah (px). Bawaan 480. */
  minDimension?: number;
  /** Kualitas JPEG awal (0–1). Bawaan 0,82. */
  initialQuality?: number;
  /** Kualitas JPEG minimum. Bawaan 0,45. */
  minQuality?: number;
  /** Langkah penurunan kualitas. Bawaan 0,1. */
  qualityStep?: number;
  /** Faktor pengecilan dimensi tiap putaran. Bawaan 0,8. */
  scaleStep?: number;
  /** Tipe keluaran. Bawaan `image/jpeg`. */
  mimeType?: string;
};

export type CompressResult = {
  blob: Blob;
  width: number;
  height: number;
  quality: number;
  /** Jumlah percobaan encode. */
  attempts: number;
  /** `true` bila `blob.size ≤ maxBytes`. */
  withinLimit: boolean;
  originalBytes: number;
};

/** Fungsi encode: gambar ulang pada ukuran (w×h) lalu hasilkan blob dengan kualitas q. */
export type ImageEncoder = (width: number, height: number, quality: number) => Promise<Blob>;

/** Skala (w,h) agar sisi terpanjang ≤ `maxDimension` (tidak memperbesar). Hasil dibulatkan ≥ 1 px. */
export function fitWithin(width: number, height: number, maxDimension: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) throw new RangeError("Ukuran gambar tidak valid.");
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxDimension / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function resolveOptions(options: CompressOptions) {
  const initialQuality = options.initialQuality ?? 0.82;
  return {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_PHOTO_BYTES,
    maxDimension: options.maxDimension ?? 1600,
    minDimension: options.minDimension ?? 480,
    initialQuality,
    minQuality: Math.min(options.minQuality ?? 0.45, initialQuality),
    qualityStep: options.qualityStep ?? 0.1,
    scaleStep: options.scaleStep ?? 0.8,
    mimeType: options.mimeType ?? "image/jpeg",
  };
}

/**
 * Inti algoritme (murni): mencari kombinasi dimensi/kualitas pertama yang menghasilkan blob ≤ `maxBytes`.
 * `encode` disuntikkan sehingga dapat diuji tanpa canvas.
 */
export async function compressWithEncoder(
  sourceWidth: number,
  sourceHeight: number,
  encode: ImageEncoder,
  options: CompressOptions = {},
  originalBytes = 0,
): Promise<CompressResult> {
  const o = resolveOptions(options);
  let { width, height } = fitWithin(sourceWidth, sourceHeight, o.maxDimension);
  let attempts = 0;
  let best: CompressResult | null = null;

  for (;;) {
    for (let q = o.initialQuality; q >= o.minQuality - 1e-9; q = Math.round((q - o.qualityStep) * 100) / 100) {
      const blob = await encode(width, height, q);
      attempts++;
      const result: CompressResult = {
        blob,
        width,
        height,
        quality: q,
        attempts,
        withinLimit: blob.size <= o.maxBytes,
        originalBytes,
      };
      if (result.withinLimit) return result;
      if (!best || blob.size < best.blob.size) best = result;
    }
    const nextLongest = Math.floor(Math.max(width, height) * o.scaleStep);
    if (nextLongest < o.minDimension) break;
    ({ width, height } = fitWithin(width, height, nextLongest));
  }
  return { ...best!, attempts };
}

/** Sumber gambar yang dapat digambar ke canvas beserta ukurannya. */
export type LoadedImage = { source: CanvasImageSource; width: number; height: number; close?: () => void };

/** Muat berkas gambar (hormati orientasi EXIF bila peramban mendukung). */
export async function loadImage(file: Blob): Promise<LoadedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Jatuh ke <img> (mis. format tidak didukung createImageBitmap).
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Foto tidak dapat dibaca. Ambil ulang foto."));
      el.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export type CompressDeps = {
  loadImage?: (file: Blob) => Promise<LoadedImage>;
  createCanvas?: () => HTMLCanvasElement;
};

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Foto gagal diproses. Ambil ulang foto."))), type, quality);
  });
}

/**
 * Kompres berkas foto menjadi JPEG ≤ `maxBytes` (bawaan 300 KB) memakai canvas.
 * Galat dilempar dengan pesan tindakan berbahasa Indonesia.
 */
export async function compressImage(file: Blob, options: CompressOptions = {}, deps: CompressDeps = {}): Promise<CompressResult> {
  const o = resolveOptions(options);
  const image = await (deps.loadImage ?? loadImage)(file);
  try {
    const canvas = deps.createCanvas ? deps.createCanvas() : document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Perangkat tidak dapat memproses foto. Coba lagi atau hubungi admin sistem.");
    const encode: ImageEncoder = (width, height, quality) => {
      canvas.width = width;
      canvas.height = height;
      // Latar putih agar PNG transparan tidak menjadi hitam di JPEG.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(image.source, 0, 0, width, height);
      return canvasToBlob(canvas, o.mimeType, quality);
    };
    return await compressWithEncoder(image.width, image.height, encode, o, file.size);
  } finally {
    image.close?.();
  }
}

/** `312345` → `"305 KB"`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}
