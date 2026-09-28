/**
 * `pnpm tsx scripts/gen-pwa-icons.ts` — bangkitkan ikon PWA "EQUA Lapangan" (PNG, tanpa dependensi): latar biru tema
 * lapangan + tetes air putih. Keluaran: public/icons/icon-192.png, icon-512.png, maskable-512.png (zona aman 80%),
 * apple-touch-icon.png (180). Hasil di-commit; jalankan ulang hanya bila desain ikon berubah.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

const BG: [number, number, number] = [0x1e, 0x40, 0xaf]; // biru tema lapangan
const FG: [number, number, number] = [0xff, 0xff, 0xff];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // kedalaman bit
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Tetes air dalam koordinat ternormalisasi (0..1), skala `s` terhadap pusat. */
function insideDrop(x: number, y: number, s: number): boolean {
  const cx = 0.5;
  const nx = (x - cx) / s + cx;
  const ny = (y - 0.5) / s + 0.5;
  const circleY = 0.6;
  const r = 0.23;
  const top = 0.14;
  if ((nx - cx) ** 2 + (ny - circleY) ** 2 <= r * r) return true;
  if (ny < top || ny > circleY) return false;
  const t = (ny - top) / (circleY - top);
  return Math.abs(nx - cx) <= r * Math.pow(t, 0.75);
}

function renderIcon(size: number, opts: { rounded: boolean; scale: number }): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const ss = 4;
  const radius = opts.rounded ? 0.18 : 0;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let fg = 0;
      let covered = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          // Sudut membulat (ikon biasa); maskable penuh.
          if (radius > 0) {
            const dx = Math.max(radius - x, 0, x - (1 - radius));
            const dy = Math.max(radius - y, 0, y - (1 - radius));
            if (dx * dx + dy * dy > radius * radius) continue;
          }
          covered++;
          if (insideDrop(x, y, opts.scale)) fg++;
        }
      }
      const total = ss * ss;
      const alpha = covered / total;
      const mix = covered ? fg / covered : 0;
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) out[i + c] = Math.round(BG[c]! * (1 - mix) + FG[c]! * mix);
      out[i + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

function main(): void {
  const dir = path.join(process.cwd(), "public", "icons");
  mkdirSync(dir, { recursive: true });
  const targets = [
    { file: "icon-192.png", size: 192, rounded: true, scale: 1 },
    { file: "icon-512.png", size: 512, rounded: true, scale: 1 },
    { file: "maskable-512.png", size: 512, rounded: false, scale: 0.72 },
    { file: "apple-touch-icon.png", size: 180, rounded: false, scale: 0.85 },
  ];
  for (const t of targets) {
    const png = encodePng(t.size, renderIcon(t.size, { rounded: t.rounded, scale: t.scale }));
    writeFileSync(path.join(dir, t.file), png);
    console.log(`public/icons/${t.file} (${t.size}×${t.size}, ${png.length} B)`);
  }
}

main();
