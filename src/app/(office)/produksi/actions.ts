"use server";

/**
 * Server Action layar kantor M8 (/produksi/*): setiap aksi memanggil layanan modul (yang memanggil `authorize`),
 * lampiran (foto pembanding, sertifikat, foto meter) diunggah dulu lewat `storage.put`, lalu halaman divalidasi ulang.
 */
import { revalidatePath } from "next/cache";

import type { M8ActionState } from "@/components/m8-production/office-action-state";
import { requireOfficeSession } from "@/server/core/auth/office";
import { withTx } from "@/server/core/db";
import { DomainError, toUserMessage } from "@/server/core/errors";
import { put } from "@/server/core/storage";
import * as m8 from "@/server/modules/m8-production";

const PATHS = ["/produksi/neraca-air", "/produksi/neraca-air/rincian", "/produksi/pengisian", "/produksi/utilisasi", "/produksi/mutu", "/produksi/kelola-meter"];

function str(fd: FormData, name: string): string | null {
  const v = fd.get(name);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** Angka bulat dari isian (titik ribuan & spasi diabaikan). `NaN` bila kosong/tidak valid → pesan Zod layanan. */
function int(fd: FormData, name: string): number {
  const v = str(fd, name);
  if (v === null) return Number.NaN;
  const n = Number(v.replace(/[.\s]/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n) : Number.NaN;
}

async function attempt(fn: () => Promise<unknown>, message: string): Promise<M8ActionState> {
  try {
    await fn();
    for (const p of PATHS) revalidatePath(p);
    return { ok: true, message };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}

const IMAGE_OR_PDF = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

/** Unggah berkas formulir → id lampiran (dikaitkan ke objek oleh layanan). */
async function upload(fd: FormData, name: string, kind: string, opts: { required?: string } = {}): Promise<string | null> {
  const file = fd.get(name);
  if (!(file instanceof File) || file.size === 0) {
    if (opts.required) throw new DomainError("FILE_REQUIRED", opts.required);
    return null;
  }
  const type = (file.type || "image/jpeg").toLowerCase();
  if (!IMAGE_OR_PDF.has(type)) throw new DomainError("FILE_TYPE", "Jenis berkas tidak didukung. Lampirkan foto JPEG/PNG/WEBP atau PDF.");
  const { ctx } = await requireOfficeSession();
  const buf = Buffer.from(await file.arrayBuffer());
  const att = await withTx((tx) => put(tx, ctx, { blob: buf, contentType: type, kind, originalName: file.name }));
  return att.id;
}

// --- Produksi & pembacaan (US-M8-01) ------------------------------------------------------------------------------------

/** Admin Keuangan: verifikasi produksi menyimpang > PAR-68 (foto meter dibandingkan). */
export async function verifyProductionAction(productionId: string, _prev: M8ActionState, fd: FormData): Promise<M8ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => m8.verifyProduction(ctx, { productionId, note: str(fd, "note") ?? "" }), "Produksi diverifikasi.");
}

/** Admin Keuangan: koreksi pembacaan meter (alasan + foto pembanding) → baris baru, baris lama "Dikoreksi". */
export async function correctReadingAction(readingId: string, _prev: M8ActionState, fd: FormData): Promise<M8ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const photo = await upload(fd, "photo", "meter_photo", { required: "Lampirkan foto pembanding angka meter." });
    await m8.correctMeterReading(ctx, { readingId, readingL: int(fd, "readingL"), reason: str(fd, "reason") ?? "", photoAttachmentId: photo! });
  }, "Pembacaan dikoreksi; produksi & neraca dihitung ulang.");
}

// --- Pengisian (US-M8-02) -----------------------------------------------------------------------------------------------

/** Admin Keuangan: pembalik pengisian (volume negatif, beralasan). */
export async function reverseFillAction(fillId: string, _prev: M8ActionState, fd: FormData): Promise<M8ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => m8.reverseTruckFill(ctx, { fillId, reason: str(fd, "reason") ?? "" }), "Pengisian dibalik; neraca dihitung ulang.");
}

/** Admin Keuangan: tautkan pengisian tanpa rit ke rit truk yang sama. */
export async function linkFillAction(fillId: string, _prev: M8ActionState, fd: FormData): Promise<M8ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => m8.linkTruckFill(ctx, { fillId, tripId: str(fd, "tripId") ?? "", reason: str(fd, "reason") ?? "" }), "Pengisian ditautkan ke rit.");
}

// --- Neraca air (US-M8-04) ----------------------------------------------------------------------------------------------

/** Pemilik: terima penjelasan susut → Selesai. */
export async function acceptInvestigationAction(waterBalanceId: string, _prev: M8ActionState, fd: FormData): Promise<M8ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => m8.acceptLossInvestigation(ctx, { waterBalanceId, note: str(fd, "note") }), "Penjelasan susut diterima — neraca Selesai.");
}

/** Pemilik: kembalikan penjelasan susut ke operator. */
export async function returnInvestigationAction(waterBalanceId: string, _prev: M8ActionState, fd: FormData): Promise<M8ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => m8.returnLossInvestigation(ctx, { waterBalanceId, note: str(fd, "note") ?? "" }), "Penjelasan dikembalikan ke operator.");
}

/** Admin Keuangan: verifikasi susut negatif (anomali pencatatan). */
export async function verifyNegativeAction(waterBalanceId: string, _prev: M8ActionState, fd: FormData): Promise<M8ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => m8.verifyNegativeBalance(ctx, { waterBalanceId, note: str(fd, "note") ?? "" }), "Susut negatif diverifikasi.");
}

// --- Mutu air (US-M8-06) ------------------------------------------------------------------------------------------------

function locationFrom(fd: FormData): { locationType: "water_source" | "outlet"; waterSourceId: string | null; outletId: string | null } {
  const loc = str(fd, "location") ?? "";
  const [kind, id] = loc.split(":");
  if (kind === "outlet") return { locationType: "outlet", waterSourceId: null, outletId: id ?? null };
  return { locationType: "water_source", waterSourceId: id ?? null, outletId: null };
}

/** Pemilik: jadwal uji per lokasi (frekuensi PAR-70 bila ditetapkan). */
export async function upsertScheduleAction(scheduleId: string | null, _prev: M8ActionState, fd: FormData): Promise<M8ActionState> {
  const { ctx } = await requireOfficeSession();
  const freq = str(fd, "frequencyDays");
  return attempt(
    () =>
      m8.upsertQualitySchedule(ctx, {
        scheduleId,
        ...locationFrom(fd),
        frequencyDays: freq === null ? null : int(fd, "frequencyDays"),
        nextDueDate: str(fd, "nextDueDate") ?? "",
        laboratory: str(fd, "laboratory"),
        parameters: (str(fd, "parameters") ?? "")
          .split(/[,;\n]/)
          .map((x) => x.trim())
          .filter(Boolean),
      }),
    "Jadwal uji mutu disimpan.",
  );
}

/** Pemilik: nonaktifkan jadwal uji (beralasan). */
export async function deactivateScheduleAction(scheduleId: string, _prev: M8ActionState, fd: FormData): Promise<M8ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => m8.deactivateQualitySchedule(ctx, { scheduleId, reason: str(fd, "reason") ?? "" }), "Jadwal uji dinonaktifkan.");
}

/**
 * Baris hasil uji dari area teks: satu parameter per baris `parameter; nilai; satuan; batas; lulus|tidak`.
 * Contoh: `E. coli; 0; CFU/100 mL; 0; lulus`.
 */
function parseResults(text: string): { parameter: string; value: string; unit: string | null; limit: string | null; passed: boolean }[] {
  return text
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [parameter = "", value = "", unit = "", limit = "", verdict = "lulus"] = line.split(";").map((x) => x.trim());
      return { parameter, value, unit: unit || null, limit: limit || null, passed: !/^(tidak|gagal|tl|x|no|fail)/i.test(verdict) };
    });
}

/** Admin Keuangan: catat hasil uji + sertifikat; tidak lulus → tindakan wajib. */
export async function recordQualityTestAction(_prev: M8ActionState, fd: FormData): Promise<M8ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const results = parseResults(str(fd, "results") ?? "");
    const passed = results.length > 0 && results.every((r) => r.passed);
    const cert = await upload(fd, "certificate", "quality_certificate", { required: "Lampirkan foto/PDF sertifikat hasil uji." });
    const actionText = str(fd, "actionDescription");
    await m8.recordQualityTest(ctx, {
      scheduleId: str(fd, "scheduleId"),
      ...locationFrom(fd),
      testDate: str(fd, "testDate") ?? "",
      laboratory: str(fd, "laboratory") ?? "",
      results,
      passed,
      certificateAttachmentId: cert!,
      action: passed ? null : actionText || str(fd, "actionOwnerEmployeeId") || str(fd, "actionDueDate") ? { description: actionText ?? "", ownerEmployeeId: str(fd, "actionOwnerEmployeeId") ?? "", dueDate: str(fd, "actionDueDate") ?? "" } : null,
      notes: str(fd, "notes"),
    });
  }, "Hasil uji mutu dicatat.");
}

/** Admin Keuangan/pemilik: tandai tindakan hasil tidak lulus selesai. */
export async function completeQualityActionAction(qualityTestId: string, _prev: M8ActionState, fd: FormData): Promise<M8ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => m8.completeQualityAction(ctx, { qualityTestId, note: str(fd, "note") ?? "" }), "Tindakan ditandai selesai.");
}

// --- Meter: putaran & penggantian (US-M8-01 KP-2, 7.8.6) -----------------------------------------------------------------

/** Admin sistem / Admin Keuangan: catat putaran meter (angka kembali ke nol). */
export async function recordRolloverAction(meterId: string, _prev: M8ActionState, fd: FormData): Promise<M8ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const photo = await upload(fd, "photo", "meter_photo");
    await m8.recordMeterRollover(ctx, { meterId, rolloverAtL: int(fd, "rolloverAtL"), businessDate: str(fd, "businessDate"), reason: str(fd, "reason") ?? "", photoAttachmentId: photo });
  }, "Putaran meter dicatat — pembacaan berikutnya yang lebih kecil diterima sekali.");
}

/** Admin sistem / Admin Keuangan: catat penggantian meter (meter lama ditutup, meter baru + angka awal). */
export async function recordReplacementAction(meterId: string, _prev: M8ActionState, fd: FormData): Promise<M8ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const photo = await upload(fd, "photo", "meter_photo");
    await m8.recordMeterReplacement(ctx, {
      meterId,
      finalReadingL: int(fd, "finalReadingL"),
      newMeterCode: str(fd, "newMeterCode") ?? "",
      newMeterName: str(fd, "newMeterName"),
      newInitialReadingL: int(fd, "newInitialReadingL"),
      businessDate: str(fd, "businessDate"),
      reason: str(fd, "reason") ?? "",
      photoAttachmentId: photo,
    });
  }, "Penggantian meter dicatat — produksi hari itu diestimasi & ditandai.");
}

// --- Stok air awal depot (B-10) -----------------------------------------------------------------------------------------

/** Admin Keuangan: stok air awal depot saat cut-over (sekali per depot). */
export async function recordDepotOpeningAction(_prev: M8ActionState, fd: FormData): Promise<M8ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    () => m8.recordDepotOpeningWater(ctx, { outletId: str(fd, "outletId") ?? "", volumeL: int(fd, "volumeL"), businessDate: str(fd, "businessDate"), reason: str(fd, "reason") ?? "" }),
    "Stok air awal depot dicatat.",
  );
}
