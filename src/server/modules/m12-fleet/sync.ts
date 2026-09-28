/**
 * M12 — sinkron lapangan.
 *
 * M12 tidak memiliki perintah lapangan sendiri. Posisi GPS ponsel cadangan dikirim aplikasi sopir lewat perintah
 * `gps.phone_positions` (didaftarkan M3, menulis `gps_positions` sumber `phone`, idempoten per truk + sumber + waktu),
 * hanya selama rit aktif dan hanya bila M12 menandai pelacakan ponsel untuk truk itu (`phone_tracking_flags`, dibaca pull
 * `m3.today` → `gpsTracking.enabled`). Keterangan perjalanan BR-25 dikirim lewat `m3.travel_explanation.create` (M3)
 * ke `fleet_events.explanation`. Posisi perangkat GPS masuk lewat penghubung vendor `/api/gps/ingest/[vendor]`
 * (token `GPS_INGEST_TOKEN`), bukan lewat sinkron perangkat lapangan.
 */
import "server-only";

export function registerSync(): void {
  // Tidak ada handler/pull milik M12 (lihat keterangan berkas).
}
