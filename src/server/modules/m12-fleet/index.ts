/**
 * M12 — Pelacakan Armada / GPS: API PUBLIK modul. Posisi GPS, peta, riwayat perjalanan, kejadian armada, geofence (PRD 7.12).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 *
 * Kontrak untuk modul lain (rincian: docs/dev/modules/m12-fleet.md):
 * - Penghubung vendor (NFR-21): `GPS_VENDOR_ADAPTERS`, `getGpsVendorAdapter`, `ingestGpsFixes` (rute `/api/gps/ingest/[vendor]`).
 * - M2 papan jadwal: `getFleetSnapshot` + komponen `@/components/m12-fleet/fleet-live-map` (US-M12-02 KP-4).
 * - M9 H+0: `fleetDaySummary(tx, tenantId, date, now)`; laporan ekspor `m12.*`.
 * - M8 neraca air: `geofenceFlagsFor(tx, { tenantId, date, waterSourceId? })` + event `fleet_event.detected`.
 * - M10 halaman perangkat: `getGpsDeviceHealth(ctx, deviceId)` + komponen `@/components/m12-fleet/gps-health-card`.
 * - M11: `fuelMonthly` / tabel `fuel_estimates` (informasi biaya BBM per rit L2, tidak dijurnal).
 */
import "server-only";

export const MODULE_KEY = "m12-fleet" as const;
export const MODULE_NAME = "Pelacakan Armada / GPS" as const;

// --- Penghubung vendor & penerima posisi (US-M12-01) -----------------------------------------------------------------
export { GPS_VENDOR_ADAPTERS, getGpsVendorAdapter, listGpsVendorAdapters, parseFixTime, MAX_FIXES_PER_REQUEST } from "./domain/adapters";
export type { AdapterInput, AdapterResult, GpsFix, GpsVendorAdapter } from "./domain/adapters";
export { ingestGpsFixes, isValidFix, resolveGpsDevice } from "./service/ingest";
export type { IngestItemResult, IngestResult } from "./service/ingest";

// --- Peta real-time & putar ulang (US-M12-02) ------------------------------------------------------------------------
export { getFleetSnapshot } from "./service/live";
export type { FleetLayers, FleetSnapshot, LiveTrip, LiveTruck } from "./service/live";
export { deriveLiveStatus, LIVE_STATUS_TONE } from "./domain/status";
export type { FleetLiveStatus, LiveStatus, LiveStatusInput } from "./domain/status";

// --- Riwayat per rit & per hari (US-M12-03) --------------------------------------------------------------------------
export {
  computeTripTrackData,
  computeTruckDayData,
  getReplay,
  getTripHistory,
  getTruckDay,
  listTripHistory,
  listTruckDays,
  purgeExpiredPositions,
  runDailySummaries,
  stopsReport,
  tripSummaryReport,
  truckDayReport,
  upsertTripTrack,
  upsertTruckDaySummary,
} from "./service/history";
export type { ReplayData, StopView, TripHistoryDetail, TripHistoryRow, TripTrackData, TruckDayData, TruckDayDetail, TruckDayRow } from "./service/history";

// --- Lokasi Selesai & titik status (US-M12-04, US-M12-01 KP-4) --------------------------------------------------------
export { checkCompletionDeviation, checkSourceConsistency, devicePositionAt, handleTripCompleted, handleTripStatus, recordStatusPoint, recheckRecentCompletions } from "./service/completion";

// --- Deteksi perjalanan & berhenti (US-M12-05) -----------------------------------------------------------------------
export { detectTruckTravel, detectionEnabledFor, runTravelDetection } from "./service/detection";
export type { DetectionTruckResult } from "./service/detection";

// --- Geofence (US-M12-06) --------------------------------------------------------------------------------------------
export { checkFillGeofence, geofenceFlagsFor, geofenceFlagsForSourceDay, processTruckGeofences, runGeofenceProcessing } from "./service/geofence";
export type { SourceDayGeofenceFlag } from "./service/geofence";

// --- BBM & zona (US-M12-07) ------------------------------------------------------------------------------------------
export { fuelMonthly, runZoneCheckMonthly, upsertFuelEstimate, zoneCheck, zoneCheckRows } from "./service/fuel";
export type { FuelMonthly, FuelTripRow, FuelTruckRow, FuelZoneRow, ZoneCheckRow } from "./service/fuel";

// --- Perangkat GPS mati/dicabut & GPS ponsel cadangan (US-M12-08) -----------------------------------------------------
export {
  checkOutagePattern,
  deviceOutageMinutesOn,
  deviceOutageReport,
  getGpsDeviceHealth,
  listGpsDevices,
  markDeviceOutage,
  restoreDevice,
  runDeviceHealthCheck,
  setPhoneTracking,
  startPhoneTracking,
  stopPhoneTracking,
} from "./service/devices";
export type { DeviceHealthRunResult, GpsDeviceHealth, OutageReportRow } from "./service/devices";

// --- Kejadian armada, tinjauan, H+0 ----------------------------------------------------------------------------------
export {
  closeFleetEvent,
  fleetDaySummary,
  getFleetDaySummary,
  getFleetEvent,
  groupOf,
  listFleetEvents,
  locationDeviationPatterns,
  markUnexplainedAtCashClose,
  reviewFleetEvent,
} from "./service/review";
export type { FleetDaySummary, FleetEventDetail, FleetEventFilter, FleetEventView, PatternRow } from "./service/review";
export { createFleetEvent, EVENT_GROUPS, REVIEW_KINDS } from "./service/fleet-events";
export type { FleetEventRow } from "./service/fleet-events";

// --- Aturan & lokasi sah ---------------------------------------------------------------------------------------------
export { legalLocations, m12Rules } from "./service/common";
export type { LegalLocation, M12Rules } from "./service/common";
