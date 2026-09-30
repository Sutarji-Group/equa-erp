import { describe, expect, it, vi } from "vitest";

import {
  compressImage,
  compressWithEncoder,
  DEFAULT_INITIAL_QUALITY,
  DEFAULT_MAX_PHOTO_BYTES,
  DEFAULT_MAX_PHOTO_DIMENSION,
  DEFAULT_PHOTO_MAX_KB,
  fitWithin,
  formatBytes,
  photoMaxBytes,
  type ImageEncoder,
} from "@/client/media/compress-image";

/** Encoder tiruan: ukuran ≈ piksel × kualitas × faktor (meniru perilaku JPEG secara kasar). */
function fakeEncoder(bytesPerPixelAtQ1: number): ImageEncoder & { calls: Array<[number, number, number]> } {
  const calls: Array<[number, number, number]> = [];
  const fn = (async (w: number, h: number, q: number) => {
    calls.push([w, h, q]);
    const size = Math.round(w * h * q * bytesPerPixelAtQ1);
    return new Blob([new Uint8Array(size)], { type: "image/jpeg" });
  }) as ImageEncoder & { calls: Array<[number, number, number]> };
  fn.calls = calls;
  return fn;
}

/**
 * Encoder tiruan "mirip JPEG nyata": bit per piksel naik dengan kualitas (foto luar ruang ±1,2 bpp pada q 0,7). Dipakai
 * untuk memastikan ukuran TARGET (bukan sekadar batas): foto kamera 12 MP → ±100–150 KB pada 1.280 px.
 */
function realisticEncoder(): ImageEncoder & { calls: Array<[number, number, number]> } {
  const calls: Array<[number, number, number]> = [];
  const fn = (async (w: number, h: number, q: number) => {
    calls.push([w, h, q]);
    const bitsPerPixel = 0.25 + 1.35 * q; // q 0,7 → 1,2 bpp; q 0,5 → 0,93 bpp
    return new Blob([new Uint8Array(Math.round((w * h * bitsPerPixel) / 8))], { type: "image/jpeg" });
  }) as ImageEncoder & { calls: Array<[number, number, number]> };
  fn.calls = calls;
  return fn;
}

describe("Kompresi foto di perangkat (US-M3-03 KP-6, PAR-38 bawaan 150 KB, sisi 1.280 px — D-14 butir 2)", () => {
  it("B-88 bawaan = PAR-38 Lampiran B (150 KB), sisi panjang 1.280 px, kualitas awal 0,7; batas byte dari nilai parameter", () => {
    expect(DEFAULT_PHOTO_MAX_KB).toBe(150);
    expect(DEFAULT_MAX_PHOTO_BYTES).toBe(150 * 1024);
    expect(DEFAULT_MAX_PHOTO_DIMENSION).toBe(1280);
    expect(DEFAULT_INITIAL_QUALITY).toBe(0.7);
    expect(photoMaxBytes(120)).toBe(120 * 1024);
    expect(photoMaxBytes(300)).toBe(300 * 1024);
    expect(photoMaxBytes(null)).toBe(DEFAULT_MAX_PHOTO_BYTES);
    expect(photoMaxBytes(undefined)).toBe(DEFAULT_MAX_PHOTO_BYTES);
    expect(photoMaxBytes(0)).toBe(DEFAULT_MAX_PHOTO_BYTES);
    expect(photoMaxBytes(Number.NaN)).toBe(DEFAULT_MAX_PHOTO_BYTES);
  });

  it("B-88 NFR-17 ukuran target: foto kamera 12 MP (4:3 & potret) → JPEG 1.280 px, ±100–150 KB (≤ PAR-38)", async () => {
    for (const [w, h] of [
      [4000, 3000],
      [3000, 4000],
      [4032, 2268],
    ] as const) {
      const encode = realisticEncoder();
      const result = await compressWithEncoder(w, h, encode, { maxBytes: photoMaxBytes(150) }, 4_500_000);
      expect(result.withinLimit).toBe(true);
      expect(result.blob.size).toBeLessThanOrEqual(150 * 1024);
      expect(result.blob.size).toBeGreaterThan(90 * 1024); // tetap terbaca: tidak dikecilkan berlebihan
      expect(Math.max(result.width, result.height)).toBe(1280);
      expect(encode.calls[0]![2]).toBe(0.7);
    }
  });

  it("B-88 PAR-38 yang lebih kecil dari server (mis. 100 KB) dipatuhi — kualitas diturunkan dulu, lalu dimensi", async () => {
    const encode = realisticEncoder();
    const result = await compressWithEncoder(4000, 3000, encode, { maxBytes: photoMaxBytes(100) });
    expect(result.withinLimit).toBe(true);
    expect(result.blob.size).toBeLessThanOrEqual(100 * 1024);
    expect(encode.calls.filter(([wd]) => wd === 1280).map(([, , q]) => q)).toEqual([0.7, 0.6, 0.5]);
  });

  it("fitWithin mengecilkan sisi terpanjang tanpa memperbesar", () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(() => fitWithin(0, 10, 100)).toThrow(RangeError);
  });

  it("US-M3-03 KP-6 foto kamera 12 MP dikompres ≤ PAR-38 (bawaan 150 KB) JPEG", async () => {
    const encode = fakeEncoder(0.3);
    const result = await compressWithEncoder(4000, 3000, encode, {}, 4_500_000);
    expect(result.withinLimit).toBe(true);
    expect(result.blob.size).toBeLessThanOrEqual(DEFAULT_MAX_PHOTO_BYTES);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(1280);
    expect(result.originalBytes).toBe(4_500_000);
    // Kualitas diturunkan dulu sebelum dimensi dikecilkan.
    expect(encode.calls[0]).toEqual([1280, 960, 0.7]);
    expect(encode.calls[1]![2]).toBeCloseTo(0.6);
  });

  it("berhenti di percobaan pertama bila sudah ≤ batas", async () => {
    const encode = fakeEncoder(0.05);
    const result = await compressWithEncoder(1200, 900, encode);
    expect(result.attempts).toBe(1);
    expect(result.quality).toBe(0.7);
    expect(result.width).toBe(1200);
  });

  it("mengecilkan dimensi bila kualitas minimum belum cukup", async () => {
    const encode = fakeEncoder(1.2);
    const result = await compressWithEncoder(4000, 3000, encode, { maxBytes: 150 * 1024 });
    expect(result.withinLimit).toBe(true);
    expect(result.width).toBeLessThan(1280);
    // Semua tingkat kualitas (0,7 → 0,5) dicoba pada 1.280 px sebelum dimensi dikecilkan.
    expect(encode.calls.filter(([w]) => w === 1280).map(([, , q]) => q)).toEqual([0.7, 0.6, 0.5]);
  });

  it("menghormati batas kustom dari parameter dan mengembalikan hasil terkecil bila mustahil", async () => {
    const encode = fakeEncoder(10);
    const result = await compressWithEncoder(4000, 3000, encode, { maxBytes: 1000, minDimension: 480 });
    expect(result.withinLimit).toBe(false);
    const smallest = Math.min(...encode.calls.map(([w, h, q]) => Math.round(w * h * q * 10)));
    expect(result.blob.size).toBe(smallest);
    expect(Math.max(result.width, result.height)).toBeGreaterThanOrEqual(480);
  });

  it("compressImage menggambar ke canvas (tiruan) dan mengembalikan JPEG", async () => {
    const drawImage = vi.fn();
    const fillRect = vi.fn();
    const fake = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage, fillRect, fillStyle: "" }),
      toBlob: (cb: (b: Blob | null) => void, type: string, quality: number) => {
        cb(new Blob([new Uint8Array(Math.round(fake.width * fake.height * quality * 0.2))], { type }));
      },
    };
    const canvas = fake as unknown as HTMLCanvasElement;
    const close = vi.fn();
    const file = new Blob([new Uint8Array(3_000_000)], { type: "image/jpeg" });

    const result = await compressImage(file, {}, {
      loadImage: async () => ({ source: {} as CanvasImageSource, width: 4032, height: 3024, close }),
      createCanvas: () => canvas,
    });

    expect(result.blob.type).toBe("image/jpeg");
    expect(result.blob.size).toBeLessThanOrEqual(DEFAULT_MAX_PHOTO_BYTES);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, result.width, result.height);
    expect(fillRect).toHaveBeenCalled(); // latar putih
    expect(close).toHaveBeenCalledTimes(1); // bitmap dilepas
  });

  it("formatBytes berbahasa Indonesia", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(300 * 1024)).toBe("300 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1,5 MB");
  });
});
