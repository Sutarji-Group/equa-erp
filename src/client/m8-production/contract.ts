/**
 * M8 — KONTRAK data offline aplikasi operator produksi (isomorfik, tanpa API peramban): bentuk data referensi pull
 * `m8.today`, payload perintah sinkron `m8.*`, dan aturan murni yang SAMA di perangkat dan server (fase pembacaan yang
 * disarankan, pembacaan terlambat → wajib alasan, volume ≠ PAR-15 → wajib alasan, batas angka meter).
 *
 * Aturan PRD 7.8 / Bab 6.1: operator memasukkan kenyataan (angka meter, volume, level tandon, alasan) — produksi harian,
 * susut, dan utilisasi dihitung sistem. Pembacaan & pengisian yang sudah tercatat tidak dapat diubah operator
 * (koreksi oleh Admin Keuangan, BR-38). Server hanya mengimpor TIPE dan fungsi murni dari berkas ini.
 */

// =====================================================================================================================
// Perintah sinkron & data referensi
// =====================================================================================================================

export const M8_COMMANDS = {
  meterReading: "m8.meter_reading.create",
  truckFill: "m8.truck_fill.create",
  tankLevel: "m8.tank_level.create",
  lossInvestigation: "m8.loss_investigation.submit",
  qualityTest: "m8.quality_test.create",
} as const;

export type M8CommandType = (typeof M8_COMMANDS)[keyof typeof M8_COMMANDS];

/** Kunci data referensi (penyedia pull). */
export const M8_REFS = { today: "m8.today" } as const;

/** Jenis lampiran perangkat (kolom `attachments.kind`). */
export const M8_ATTACHMENT_KINDS = {
  meterPhoto: "meter_photo",
  fillPhoto: "truck_fill_photo",
  tankPhoto: "tank_level_photo",
  investigationPhoto: "loss_investigation_photo",
  certificate: "quality_certificate",
} as const;

export type MeterPhase = "morning" | "evening";
export type LossReason = "leakage" | "washing_disposal" | "meter_problem" | "unrecorded_fill" | "other";

export type MeterReadingPayload = {
  /** UUID v7 dibuat perangkat (kunci idempoten). */
  readingId: string;
  waterMeterId: string;
  phase: MeterPhase;
  readingL: number;
  /** Wajib bila dicatat setelah jam batas fasenya (US-M8-01 KP-3). */
  lateReason?: string | null;
};

export type TruckFillPayload = {
  fillId: string;
  truckId: string;
  /** Rit tujuan (bawaan: rit berikutnya truk itu yang belum Berangkat); `null` = "pengisian tanpa rit". */
  tripId: string | null;
  volumeL: number;
  /** Wajib bila volume ≠ volume standar rit (PAR-15), mis. "Sisa muatan". */
  volumeReason?: string | null;
  /** Operator mengonfirmasi truk di luar daftar yang dijadwalkan di sumber ini (7.8.6). */
  unplannedConfirmed?: boolean;
};

export type TankLevelPayload = {
  tankLevelId: string;
  levelL?: number | null;
  levelPct?: number | null;
  notes?: string | null;
};

export type LossInvestigationPayload = {
  waterBalanceId: string;
  reason: LossReason;
  note: string | null;
};

export type QualityResultLine = { parameter: string; value: string; unit?: string | null; limit?: string | null; passed: boolean };

export type QualityTestPayload = {
  qualityTestId: string;
  scheduleId?: string | null;
  testDate: string;
  laboratory: string;
  results: QualityResultLine[];
  passed: boolean;
  /** Wajib bila tidak lulus (US-M8-06 KP-2): deskripsi, penanggung jawab, tenggat. */
  action?: { description: string; ownerEmployeeId: string; dueDate: string } | null;
  notes?: string | null;
};

// =====================================================================================================================
// Data referensi `m8.today`
// =====================================================================================================================

export type M8ReadingRef = {
  id: string;
  readingL: number;
  readAt: string;
  status: string;
  lateReason?: string | null;
  /** Belum tersinkron (optimistis). */
  local?: boolean;
};

export type M8MeterRef = {
  id: string;
  code: string;
  name: string | null;
  /** Angka awal cut-over (batas bawah bila belum ada pembacaan). */
  initialReadingL: number;
  /** Pembacaan terakhir yang berlaku — angka baru tidak boleh lebih kecil (kecuali putaran tercatat). */
  last: { businessDate: string; phase: MeterPhase; readingL: number; readAt: string } | null;
  /** Angka berlaku terakhir SEBELUM hari ini (atau angka awal cut-over) — batas bawah pembacaan pagi. */
  previousDayL: number;
  today: { morning: M8ReadingRef | null; evening: M8ReadingRef | null };
  /** Putaran meter yang dicatat admin & belum dipakai: angka lebih kecil dari sebelumnya diterima (KP-2). */
  rollover: { rolloverAtL: number; businessDate: string } | null;
};

export type M8TripRef = {
  id: string;
  number: string;
  customerName: string;
  isInternal: boolean;
  destinationName: string | null;
  routeOrder: number | null;
  status: "assigned" | "departed" | "arrived" | "completed" | "failed";
  plannedVolumeL: number;
  /** Sudah punya pengisian (satu pengisian satu rit, PTB-09). */
  filled: boolean;
};

export type M8TruckRef = {
  id: string;
  code: string;
  plateNumber: string;
  capacityL: number;
  /** Dijadwalkan mengisi di sumber ini hari ini (rit berikutnya dari sumber acuan alamatnya). */
  planned: boolean;
  /** Sumber rencana bila bukan sumber ini. */
  plannedSourceName: string | null;
  /** Rit disarankan: rit berikutnya truk itu yang belum Berangkat dan belum diisi. */
  nextTripId: string | null;
  trips: M8TripRef[];
  /** Air rit gagal yang dibawa ke rit berikutnya (US-M3-06 KP-2) → volume isi sebenarnya dengan alasan "sisa muatan". */
  carriedWater: { tripNumber: string; volumeL: number } | null;
  filledTodayL: number;
};

export type M8FillRef = {
  id: string;
  truckId: string;
  truckCode: string;
  tripId: string | null;
  tripNumber: string | null;
  volumeL: number;
  volumeReason: string | null;
  filledAt: string;
  status: string;
  isDepotSupply: boolean;
  unplannedTruck: boolean;
  reversed?: boolean;
  local?: boolean;
};

export type M8InvestigationRef = {
  waterBalanceId: string;
  businessDate: string;
  producedL: number | null;
  filledTotalL: number;
  lossL: number | null;
  lossPct: number | null;
  status: "over_threshold" | "investigating";
  reason: LossReason | null;
  note: string | null;
  /** Catatan pemilik saat mengembalikan penjelasan. */
  reviewNote: string | null;
  local?: boolean;
};

export type M8QualityScheduleRef = {
  id: string;
  nextDueDate: string | null;
  frequencyDays: number | null;
  laboratory: string | null;
  parameters: string[];
  /** Jatuh tempo dalam H-N (pengingat) atau sudah lewat. */
  dueSoon: boolean;
  overdue: boolean;
};

export type M8Today = {
  date: string;
  generatedAt: string;
  source: { id: string; code: string; name: string; dailyCapacityL: number } | null;
  /** Alasan aplikasi tidak dapat dipakai (perangkat tanpa sumber / operator tidak ditugaskan di sumber ini). */
  blockedReason: string | null;
  rules: {
    standardVolumeL: number;
    maxPhotoKb: number;
    morningDeadline: string;
    eveningDeadline: string;
    lossMaxPct: number;
    supplyTolerancePct: number;
  };
  meters: M8MeterRef[];
  production: {
    today: { producedL: number | null; status: string } | null;
    yesterday: { producedL: number | null; status: string } | null;
  };
  trucks: M8TruckRef[];
  fills: M8FillRef[];
  tankLevels: { id: string; levelL: number | null; levelPct: number | null; readAt: string; local?: boolean }[];
  investigations: M8InvestigationRef[];
  lastBalance: {
    businessDate: string;
    producedL: number | null;
    filledTotalL: number;
    lossL: number | null;
    lossPct: number | null;
    avgLossPct: number | null;
    status: string;
    utilizationPct: number | null;
  } | null;
  quality: {
    schedules: M8QualityScheduleRef[];
    recent: { id: string; testDate: string; laboratory: string | null; passed: boolean; local?: boolean }[];
    employees: { id: string; name: string }[];
  };
  history: { businessDate: string; producedL: number | null; productionStatus: string | null; fillsL: number; fillCount: number; lossPct: number | null }[];
};

// =====================================================================================================================
// Aturan murni (dipakai perangkat & server)
// =====================================================================================================================

export const PHASE_LABEL: Record<MeterPhase, string> = { morning: "Pagi (awal)", evening: "Malam (akhir)" };

/** Pilihan alasan volume ≠ standar (7.8.6: "sisa muatan" dari rit gagal). Nilai disimpan sebagai teks. */
export const FILL_VOLUME_REASONS = [
  "Sisa muatan (air rit gagal masih di tangki)",
  "Tangki tidak diisi penuh atas permintaan Dispatcher",
  "Pengisian terhenti (pompa/listrik)",
] as const;

/** Menit sejak tengah malam untuk "HH:mm". */
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((x) => Number(x));
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Jam WIB "HH:mm" dari instan (tanpa Intl — aman di perangkat & server). */
export function wibClock(at: Date | string): string {
  const d = typeof at === "string" ? new Date(at) : at;
  const shifted = new Date(d.getTime() + 7 * 60 * 60_000);
  return `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * Pembacaan terlambat (US-M8-01 KP-3): jam WIB waktu perangkat melewati jam batas fasenya (pagi 08.00 / malam 23.00,
 * `m8.production_rules`). Pembacaan terlambat wajib beralasan ("dilengkapi dengan alasan").
 */
export function isLateReading(phase: MeterPhase, deviceTime: Date | string, rules: { morningDeadline: string; eveningDeadline: string }): boolean {
  const deadline = phase === "morning" ? rules.morningDeadline : rules.eveningDeadline;
  return minutesOf(wibClock(deviceTime)) > minutesOf(deadline);
}

/** Fase yang disarankan: pagi bila pembacaan pagi hari ini belum ada, selain itu malam. */
export function suggestedPhase(meter: Pick<M8MeterRef, "today">): MeterPhase {
  return meter.today.morning ? "evening" : "morning";
}

/** Volume ≠ volume standar rit (PAR-15) wajib alasan (US-M8-02 KP-1). */
export function volumeNeedsReason(volumeL: number, standardVolumeL: number): boolean {
  return volumeL !== standardVolumeL;
}

/**
 * Batas angka meter (US-M8-01 KP-2): angka baru tidak boleh lebih kecil dari pembacaan sebelumnya (kecuali putaran
 * tercatat admin), dan angka pagi tidak boleh lebih besar dari angka malam yang sudah tercatat. Mengembalikan pesan
 * tindakan Bahasa Indonesia, atau `null` bila sah.
 */
export function meterReadingProblem(
  input: { value: number; previousL: number | null; nextL?: number | null; rolloverPending: boolean; meterCode: string },
): string | null {
  if (!Number.isInteger(input.value) || input.value < 0) return "Angka meter harus liter bulat (tanpa koma).";
  if (input.previousL !== null && input.value < input.previousL && !input.rolloverPending) {
    return `Angka meter ${input.meterCode} lebih kecil dari pembacaan sebelumnya (${input.previousL.toLocaleString("id-ID")} L). Periksa angka di meter; bila meter berputar kembali ke nol atau diganti, minta admin sistem/Admin Keuangan mencatatnya dulu.`;
  }
  if (input.nextL !== null && input.nextL !== undefined && input.value > input.nextL) {
    return `Angka pagi tidak boleh lebih besar dari angka malam yang sudah tercatat (${input.nextL.toLocaleString("id-ID")} L).`;
  }
  return null;
}

/**
 * Batas angka meter per fase di perangkat (cermin server `previousReading`/`nextReading`): pagi ≥ angka terakhir
 * sebelum hari ini dan ≤ angka malam hari ini (bila sudah ada); malam ≥ angka pagi hari ini (atau angka sebelum hari ini).
 */
export function readingLimits(meter: Pick<M8MeterRef, "previousDayL" | "today">, phase: MeterPhase): { previousL: number; nextL: number | null } {
  if (phase === "morning") return { previousL: meter.previousDayL, nextL: meter.today.evening?.readingL ?? null };
  return { previousL: meter.today.morning?.readingL ?? meter.previousDayL, nextL: null };
}

/** Status kirim per data di layar (NFR-08): masih di antrean ponsel atau sudah diterima server. */
export function itemSyncText(local: boolean | undefined): string {
  return local ? "Tersimpan di ponsel" : "Terkirim";
}

/** Truk yang tampil pertama di layar pengisian: dijadwalkan di sumber ini, lalu kode truk. */
export function sortTrucksForSource(trucks: readonly M8TruckRef[]): M8TruckRef[] {
  return [...trucks].sort((a, b) => Number(b.planned) - Number(a.planned) || a.code.localeCompare(b.code, "id"));
}

/** Rit yang boleh dituju pengisian: rit truk hari ini yang belum diisi dan belum Selesai/Gagal. */
export function fillableTrips(truck: Pick<M8TruckRef, "trips">): M8TripRef[] {
  return truck.trips.filter((t) => !t.filled && (t.status === "assigned" || t.status === "departed" || t.status === "arrived"));
}

/** Persen dengan satu desimal gaya Indonesia (mis. "5,2%"). */
export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toLocaleString("id-ID", { maximumFractionDigits: 1 })}%`;
}

/** Liter gaya Indonesia (mis. "5.000 L"). */
export function formatLiter(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${Math.round(value).toLocaleString("id-ID")} L`;
}
