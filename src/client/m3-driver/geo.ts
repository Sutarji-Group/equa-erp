/**
 * M3 — lokasi ponsel (hanya peramban): posisi sekali untuk Berangkat/Tiba/Selesai/Gagal (US-M3-02 KP-1/KP-4) dan
 * perekam GPS ponsel CADANGAN (US-M3-02 KP-5) yang hanya berjalan bila server menandai pelacakan ponsel untuk truk
 * dan ada rit aktif. Tanpa izin/sinyal GPS → `null` (status tetap tercatat dengan penanda "tanpa lokasi").
 */
import { enqueue } from "@/client/offline";

import { M3_COMMANDS, type FieldLocation, type PhonePosition } from "./contract";

export type GeoFailure = "denied" | "unavailable" | "timeout" | "unsupported";

/** Posisi saat ini (≤ `timeoutMs`); `null` + alasan bila tidak tersedia. */
export function currentPosition(timeoutMs = 8_000): Promise<{ location: FieldLocation; failure: GeoFailure | null }> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve({ location: null, failure: "unsupported" });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ location: { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: Math.round(pos.coords.accuracy) }, failure: null }),
      (err) => resolve({ location: null, failure: err.code === err.PERMISSION_DENIED ? "denied" : err.code === err.TIMEOUT ? "timeout" : "unavailable" }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

export function geoFailureText(f: GeoFailure | null): string | null {
  switch (f) {
    case "denied":
      return "GPS ponsel tidak diizinkan. Aktifkan lokasi untuk aplikasi ini di pengaturan ponsel. Data tetap tercatat dengan penanda \"tanpa lokasi\".";
    case "unavailable":
    case "timeout":
      return "Lokasi belum didapat (GPS lemah). Aktifkan GPS ponsel. Data tetap tercatat dengan penanda \"tanpa lokasi\".";
    case "unsupported":
      return "Ponsel ini tidak mendukung GPS. Data tercatat dengan penanda \"tanpa lokasi\".";
    default:
      return null;
  }
}

/**
 * Perekam GPS ponsel cadangan: rekam posisi tiap `intervalS` detik, kirim batch (`gps.phone_positions`) tiap 10
 * posisi atau saat dihentikan. Mengembalikan fungsi penghenti.
 */
export function startBackupGps(opts: { truckId: string; tripId: string | null; intervalS: number }): () => void {
  if (typeof navigator === "undefined" || !navigator.geolocation) return () => {};
  let buffer: PhonePosition[] = [];
  const flush = async () => {
    if (buffer.length === 0) return;
    const positions = buffer;
    buffer = [];
    try {
      await enqueue({ type: M3_COMMANDS.phonePositions, payload: { truckId: opts.truckId, positions }, label: `Posisi GPS ponsel (${positions.length})` });
    } catch {
      // Layar terkunci/PIN diperlukan — posisi berikutnya dikirim saat aktif kembali.
    }
  };
  const tick = () =>
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        buffer.push({
          deviceTime: new Date().toISOString(),
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: Math.round(pos.coords.accuracy),
          speedKmh: pos.coords.speed !== null ? Math.round(pos.coords.speed * 3.6) : null,
          heading: pos.coords.heading !== null && Number.isFinite(pos.coords.heading) ? Math.round(pos.coords.heading) : null,
          tripId: opts.tripId,
        });
        if (buffer.length >= 10) void flush();
      },
      () => {},
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 10_000 },
    );
  tick();
  const timer = setInterval(tick, Math.max(10, opts.intervalS) * 1000);
  return () => {
    clearInterval(timer);
    void flush();
  };
}
