"use server";

/**
 * Server Action layar Laporan & Dashboard (/laporan/*). Tipis: sesi kantor → layanan M9 (authorize → validasi →
 * aturan → transaksi → audit) → revalidasi. Galat tampil sebagai pesan tindakan berbahasa Indonesia.
 */
import { revalidatePath } from "next/cache";

import type { ReportActionState } from "@/components/m9-reports/action-state";
import { requireOfficeSession } from "@/server/core/auth/office";
import { toUserMessage } from "@/server/core/errors";
import * as m9 from "@/server/modules/m9-reports";

const PATHS = ["/laporan/hari-ini", "/laporan/kpi", "/laporan/periode-paralel", "/kotak-masuk", "/beranda"];

function str(fd: FormData, name: string): string | null {
  const v = fd.get(name);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** Bilangan (titik ribuan & "Rp" dibuang; koma desimal diterima). `null` bila kosong, NaN bila tidak valid. */
function num(fd: FormData, name: string, decimal = false): number | null {
  const s = str(fd, name);
  if (s === null) return null;
  const clean = decimal ? s.replace(/^Rp/i, "").replace(/\s/g, "").replace(",", ".") : s.replace(/^Rp/i, "").replace(/[.\s]/g, "");
  const n = Number(clean);
  return Number.isFinite(n) ? (decimal ? n : Math.round(n)) : Number.NaN;
}

async function attempt(fn: () => Promise<string | void>, message: string): Promise<ReportActionState> {
  try {
    const custom = await fn();
    for (const p of PATHS) revalidatePath(p);
    return { ok: true, message: custom || message };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}

// --- H+0 (US-M9-01) -----------------------------------------------------------------------------------------------------

export async function markReviewedAction(date: string): Promise<ReportActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => void (await m9.markSummaryReviewed(ctx, { date })), "Ringkasan H+0 ditandai sudah ditinjau.");
}

/** Setujui / tolak penjelasan selisih langsung dari H+0 (satu ketuk; alasan wajib bila menolak — KP-4). */
export async function decideDiscrepancyAction(discrepancyId: string, decision: "approve" | "reject", reason?: string): Promise<ReportActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => void (await m9.decideDiscrepancyFromDashboard(ctx, { discrepancyId, decision, reason: reason ?? null })),
    decision === "approve" ? "Selisih disetujui." : "Selisih ditolak — dikembalikan ke Admin Keuangan.",
  );
}

// --- KPI (US-M9-07 KP-2) --------------------------------------------------------------------------------------------------

export async function setOwnerHoursAction(_prev: ReportActionState, fd: FormData): Promise<ReportActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => void (await m9.setOwnerHours(ctx, { month: str(fd, "month"), hoursPerWeek: num(fd, "hoursPerWeek", true), note: str(fd, "note") })), "Jam pemilik (KPI-10) tersimpan.");
}

// --- Periode paralel (NFR-35) ------------------------------------------------------------------------------------------

function unitOf(fd: FormData): { unitType: string | null; truckId: string | null; outletId: string | null } {
  const unit = str(fd, "unit");
  if (!unit) return { unitType: null, truckId: null, outletId: null };
  const [type, id] = unit.split(":");
  return { unitType: type ?? null, truckId: type === "truck" ? (id ?? null) : null, outletId: type === "outlet" ? (id ?? null) : null };
}

export async function startParallelAction(_prev: ReportActionState, fd: FormData): Promise<ReportActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => void (await m9.startParallelPeriod(ctx, { ...unitOf(fd), parallelStartDate: str(fd, "parallelStartDate"), notes: str(fd, "notes") })), "Periode paralel unit dimulai.");
}

export async function recordParallelCheckAction(_prev: ReportActionState, fd: FormData): Promise<ReportActionState> {
  const { ctx } = await requireOfficeSession();
  const explained = str(fd, "explained");
  return attempt(async () => {
    const row = await m9.recordParallelCheck(ctx, {
      ...unitOf(fd),
      businessDate: str(fd, "businessDate"),
      paperCount: num(fd, "paperCount"),
      paperAmount: num(fd, "paperAmount"),
      explained: explained === null ? undefined : explained === "yes",
      cause: str(fd, "cause"),
    });
    return row.differenceCount === 0 && row.differenceAmount === 0 ? "Lembar pencocokan tersimpan — cocok dengan sistem." : "Lembar pencocokan tersimpan dengan selisih.";
  }, "Lembar pencocokan tersimpan.");
}

export async function withdrawPaperAction(withdrawalId: string, _prev: ReportActionState, fd: FormData): Promise<ReportActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const r = await m9.withdrawPaper(ctx, { withdrawalId, withdrawnDate: str(fd, "withdrawnDate"), reason: str(fd, "reason") });
    return r.status === "pending_approval" ? "Penarikan lebih awal diajukan ke pemilik (syarat PAR-84 terpenuhi)." : "Tanggal nota kertas ditarik tercatat.";
  }, "Tersimpan.");
}

export async function extendParallelAction(withdrawalId: string, _prev: ReportActionState, fd: FormData): Promise<ReportActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => void (await m9.extendParallelPeriod(ctx, { withdrawalId, extensionDays: num(fd, "extensionDays"), reason: str(fd, "reason") })), "Perpanjangan periode paralel tercatat.");
}
