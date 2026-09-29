"use server";

/**
 * Server Action layar Akuntansi (/akuntansi/*, M11). Tipis: sesi kantor → layanan M11 (authorize → validasi Zod →
 * aturan & pemisahan tugas → transaksi → audit → event) → revalidasi. Galat tampil sebagai pesan tindakan berbahasa
 * Indonesia (tanpa kode teknis). Izin diperiksa layanan — akuntan baca-saja ditolak di sana.
 */
import { revalidatePath } from "next/cache";

import type { M11ActionState } from "@/components/m11-accounting/action-state";
import { isEnumValue, type ProfitCenter } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { requireOfficeSession } from "@/server/core/auth/office";
import { withTx } from "@/server/core/db";
import { toUserMessage } from "@/server/core/errors";
import { put } from "@/server/core/storage";
import * as m11 from "@/server/modules/m11-accounting";

// =====================================================================================================================
// Pembantu formulir
// =====================================================================================================================

function str(fd: FormData, name: string): string | null {
  const v = fd.get(name);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** Bilangan bulat rupiah (titik ribuan & awalan Rp dibuang). `null` bila kosong, NaN bila tidak valid. */
function int(fd: FormData, name: string): number | null {
  const s = str(fd, name);
  if (s === null) return null;
  const neg = s.startsWith("-");
  const n = Number(s.replace(/^-/, "").replace(/[.\s]/g, "").replace(/^Rp/i, "").replace(",", "."));
  return Number.isFinite(n) ? (neg ? -n : n) : Number.NaN;
}

function bool(fd: FormData, name: string): boolean {
  return fd.get(name) === "1" || fd.get(name) === "on";
}

function pc(value: string | null): ProfitCenter {
  return value && isEnumValue("profit_center", value) ? value : "SHARED";
}

type LineIn = { accountId: string; profitCenter: ProfitCenter; outletId: string | null; debit: number; credit: number; memo: string | null; waterSourceId?: string | null; waterSourceShared?: boolean };

/** Baris jurnal dari editor baris tetap (`line_*_<i>`); baris tanpa akun diabaikan. */
function linesFrom(fd: FormData, max = 20): LineIn[] {
  const out: LineIn[] = [];
  for (let i = 0; i < max; i++) {
    const accountId = str(fd, `line_account_${i}`);
    if (!accountId) continue;
    out.push({
      accountId,
      profitCenter: pc(str(fd, `line_pc_${i}`)),
      outletId: str(fd, `line_outlet_${i}`),
      debit: int(fd, `line_debit_${i}`) ?? 0,
      credit: int(fd, `line_credit_${i}`) ?? 0,
      memo: str(fd, `line_memo_${i}`),
      ...sourceOf(str(fd, `line_source_${i}`)),
    });
  }
  return out;
}

/** Pilihan "Sumber air (L1)" baris jurnal: id sumber, "shared" = gabungan semua sumber, kosong = tidak diisi. */
function sourceOf(value: string | null): { waterSourceId?: string | null; waterSourceShared?: boolean } {
  if (!value) return {};
  if (value === "shared") return { waterSourceShared: true };
  return { waterSourceId: value };
}

async function uploadFile(fd: FormData, name: string, kind: string): Promise<string | null> {
  const file = fd.get(name);
  if (!(file instanceof File) || file.size === 0) return null;
  const { ctx } = await requireOfficeSession();
  const buf = Buffer.from(await file.arrayBuffer());
  const att = await withTx((tx) => put(tx, ctx, { blob: buf, contentType: file.type, kind, originalName: file.name }));
  return att.id;
}

async function fileContent(fd: FormData, name: string): Promise<{ fileName: string; content: Buffer } | null> {
  const file = fd.get(name);
  if (!(file instanceof File) || file.size === 0) return null;
  return { fileName: file.name, content: Buffer.from(await file.arrayBuffer()) };
}

async function attempt(fn: () => Promise<string | Partial<M11ActionState> | void>, message: string): Promise<M11ActionState> {
  try {
    const res = await fn();
    revalidatePath("/akuntansi", "layout");
    if (typeof res === "string") return { ok: true, message: res };
    return { ok: true, message, ...(res ?? {}) };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}

// =====================================================================================================================
// Bagan akun & pemetaan (US-M11-01)
// =====================================================================================================================

export async function createAccountAction(_: M11ActionState, fd: FormData): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const a = await m11.createAccount(ctx, {
      code: str(fd, "code") ?? "",
      name: str(fd, "name") ?? "",
      type: (str(fd, "type") ?? "") as never,
      profitCenter: (str(fd, "profitCenter") as ProfitCenter | null) ?? null,
      parentCode: str(fd, "parentCode"),
      isPostable: !bool(fd, "isHeader"),
      isInternalTransfer: bool(fd, "isInternalTransfer"),
      isCash: bool(fd, "isCash"),
      description: str(fd, "description"),
    });
    return `Akun ${a.code} ${a.name} ditambahkan.`;
  }, "Akun ditambahkan.");
}

export async function updateAccountAction(_: M11ActionState, fd: FormData): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const a = await m11.updateAccount(ctx, {
      accountId: str(fd, "accountId") ?? "",
      name: str(fd, "name") ?? undefined,
      profitCenter: (str(fd, "profitCenter") as ProfitCenter | null) ?? null,
      reason: str(fd, "reason") ?? "",
    });
    return `Akun ${a.code} diperbarui.`;
  }, "Akun diperbarui.");
}

export async function deactivateAccountAction(accountId: string, reason: string): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const a = await m11.deactivateAccount(ctx, { accountId, reason });
    return `Akun ${a.code} dinonaktifkan (tidak dihapus).`;
  }, "Akun dinonaktifkan.");
}

export async function reactivateAccountAction(accountId: string, reason: string): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const a = await m11.reactivateAccount(ctx, { accountId, reason });
    return `Akun ${a.code} aktif kembali.`;
  }, "Akun aktif kembali.");
}

export async function importAccountsAction(_: M11ActionState, fd: FormData): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  const file = await fileContent(fd, "file");
  if (!file) return { error: "Pilih berkas template bagan akun (CSV/Excel)." };
  const commit = str(fd, "mode") === "commit";
  return attempt(async () => {
    const r = await m11.importChartOfAccounts(ctx, { ...file, commit, reason: str(fd, "reason") ?? undefined });
    const preview = {
      rows: r.rows.map((x) => ({ line: x.line, code: x.code, name: x.name, action: x.action === "create" ? "Baru" : x.action === "update" ? "Diperbarui" : "Bermasalah", errors: x.errors })),
      summary: `${r.created} akun baru · ${r.updated} diperbarui · ${r.errors} bermasalah${r.committed ? " — tersimpan" : " — pratinjau (belum disimpan)"}`,
    };
    return { preview, message: r.committed ? "Bagan akun diimpor." : "Pratinjau impor siap. Periksa lalu simpan." };
  }, "Impor diproses.");
}

export async function saveMappingAction(_: M11ActionState, fd: FormData): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const [eventKey, entryKey] = (str(fd, "mappingKey") ?? `${str(fd, "eventKey") ?? ""}|${str(fd, "entryKey") ?? ""}`).split("|");
    const r = await m11.saveMapping(ctx, {
      eventKey: eventKey ?? "",
      entryKey: entryKey ?? "",
      description: str(fd, "description") ?? "",
      debitAccountId: str(fd, "debitAccountId") ?? "",
      creditAccountId: str(fd, "creditAccountId") ?? "",
      debitProfitCenter: (str(fd, "debitProfitCenter") as ProfitCenter | null) ?? null,
      creditProfitCenter: (str(fd, "creditProfitCenter") as ProfitCenter | null) ?? null,
      profitCenterRule: (str(fd, "profitCenterRule") ?? "fixed") as never,
      effectiveFrom: str(fd, "effectiveFrom") ?? "",
      reason: str(fd, "reason") ?? "",
    });
    return `Pemetaan disimpan.${r.retried.tried ? ` Daftar tunggu diproses ulang: ${r.retried.posted} terposting, ${r.retried.stillQueued} masih menunggu.` : ""}`;
  }, "Pemetaan disimpan.");
}

export async function setAccountingActiveAction(enabled: boolean, reason: string): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    await m11.setAccountingActive(ctx, { enabled, reason });
    return enabled ? "Jurnal otomatis M11 aktif." : "Jurnal otomatis M11 dinonaktifkan — peristiwa dibangkitkan retroaktif saat diaktifkan kembali.";
  }, "Tersimpan.");
}

// =====================================================================================================================
// Jurnal (US-M11-02, US-M11-03)
// =====================================================================================================================

export async function createManualJournalAction(_: M11ActionState, fd: FormData): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const attachmentId = await uploadFile(fd, "evidence", "journal_evidence");
    const payeeName = str(fd, "payeeName");
    const j = await m11.createManualJournal(ctx, {
      date: str(fd, "date") ?? "",
      description: str(fd, "description") ?? "",
      template: (str(fd, "template") as never) ?? null,
      isAccrual: bool(fd, "isAccrual"),
      originPeriod: str(fd, "originPeriod"),
      attachmentId,
      lines: linesFrom(fd),
      payable: payeeName ? { payeeName, dueDate: str(fd, "payableDueDate") ?? "", supplierId: str(fd, "payableSupplierId") } : null,
      settlesPayableId: str(fd, "settlesPayableId"),
    });
    if (bool(fd, "submitNow")) {
      const r = await m11.submitManualJournal(ctx, { journalId: j.id });
      return {
        message: r.status === "posted" ? `Jurnal ${j.number} terposting dan masuk daftar tinjauan pemilik.` : `Jurnal ${j.number} diajukan ke pemilik (di atas ambang persetujuan).`,
        redirectTo: `/akuntansi/jurnal/${j.id}`,
      };
    }
    return { message: `Draf jurnal ${j.number} tersimpan (${formatRupiah(j.totalDebit)}).`, redirectTo: `/akuntansi/jurnal/${j.id}` };
  }, "Jurnal tersimpan.");
}

export async function attachEvidenceAction(_: M11ActionState, fd: FormData): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const attachmentId = await uploadFile(fd, "evidence", "journal_evidence");
    if (!attachmentId) throw new Error("Pilih foto/PDF bukti.");
    await m11.attachJournalEvidence(ctx, { journalId: str(fd, "journalId") ?? "", attachmentId });
    return "Lampiran bukti tersimpan.";
  }, "Lampiran tersimpan.");
}

export async function submitJournalAction(journalId: string): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const r = await m11.submitManualJournal(ctx, { journalId });
    return r.status === "posted" ? "Jurnal terposting dan masuk daftar tinjauan pemilik." : "Jurnal diajukan ke pemilik untuk disetujui.";
  }, "Jurnal diproses.");
}

export async function cancelJournalAction(journalId: string, reason: string): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    await m11.cancelManualJournal(ctx, { journalId, reason });
    return "Draf/pengajuan jurnal dibatalkan (tidak dihapus).";
  }, "Dibatalkan.");
}

export async function reverseJournalAction(journalId: string, reason: string): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const r = await m11.reverseManualJournal(ctx, { journalId, reason });
    return r.status === "reversed"
      ? { message: `Jurnal pembalik ${r.reversal.number} terposting.`, redirectTo: `/akuntansi/jurnal/${r.reversal.id}` }
      : { message: "Pembalik di atas ambang — diajukan ke pemilik (BR-38)." };
  }, "Pembalik diproses.");
}

export async function markReviewedAction(periodId: string): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const r = await m11.markManualJournalsReviewed(ctx, { periodId });
    return `Daftar tinjauan ${r.period} ditandai "ditinjau" (${r.reviewed} jurnal).`;
  }, "Ditinjau.");
}

export async function retryQueueAction(queueId: string): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const r = await m11.retryJournalQueueItem(ctx, { queueId });
    if (r.status === "queued") return `Masih di daftar tunggu: ${r.message}`;
    return r.status === "skipped" ? "Peristiwa tidak memerlukan jurnal — antrean selesai." : "Jurnal terposting dari daftar tunggu.";
  }, "Diproses.");
}

export async function retryAllQueueAction(): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const r = await m11.retryAllJournalQueue(ctx);
    return `${r.tried} diproses: ${r.posted} terposting, ${r.stillQueued} masih menunggu${r.errors.length ? `, ${r.errors.length} galat` : ""}.`;
  }, "Diproses.");
}

export async function generateRetroactiveAction(): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const r = await m11.generateRetroactiveJournals(ctx);
    return `Jurnal retroaktif: ${r.posted} baru, ${r.duplicates} sudah ada, ${r.queued} masuk daftar tunggu. Minta akuntan memverifikasi.`;
  }, "Selesai.");
}

export async function verifyRetroactiveAction(runId: string, note: string): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    await m11.verifyRetroactiveRun(ctx, { runId, note });
    return "Jurnal retroaktif diverifikasi.";
  }, "Diverifikasi.");
}

export async function saveRecurringAction(_: M11ActionState, fd: FormData): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const r = await m11.saveRecurringJournal(ctx, {
      id: str(fd, "id"),
      name: str(fd, "name") ?? "",
      template: (str(fd, "template") ?? "other") as never,
      description: str(fd, "description") ?? "",
      lines: linesFrom(fd),
      dayOfMonth: int(fd, "dayOfMonth") ?? 1,
      isAccrual: bool(fd, "isAccrual"),
      isActive: str(fd, "isActive") !== "0",
    });
    return `Jurnal berulang "${r.name}" tersimpan.`;
  }, "Tersimpan.");
}

export async function generateRecurringAction(): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const ids = await m11.generateRecurringDraftsNow(ctx);
    return ids.length ? `${ids.length} draf jurnal berulang dibuat. Lengkapi lampiran lalu ajukan.` : "Draf bulan ini sudah dibuat sebelumnya.";
  }, "Selesai.");
}

// =====================================================================================================================
// Periode, alokasi, penyusutan (US-M11-10, US-M11-01 KP-3/5, US-M11-05)
// =====================================================================================================================

export async function closePeriodAction(periodId: string): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const r = await m11.closePeriod(ctx, { periodId });
    return `Periode ${r.period.period} Ditutup${r.late ? " (terlambat)" : ""}. Permintaan kunci dikirim ke pemilik.`;
  }, "Ditutup.");
}

export async function lockPeriodAction(periodId: string): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const p = await m11.lockPeriod(ctx, { periodId });
    return `Periode ${p.period} Dikunci — laporan Final revisi ${p.revision} tersimpan.`;
  }, "Dikunci.");
}

export async function reopenPeriodAction(periodId: string, reason: string): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const p = await m11.reopenPeriod(ctx, { periodId, reason });
    return `Periode ${p.period} dibuka kembali (revisi ${p.revision}). Akuntan diberi tahu.`;
  }, "Dibuka kembali.");
}

export async function addReviewNoteAction(_: M11ActionState, fd: FormData): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    await m11.addPeriodReviewNote(ctx, { periodId: str(fd, "periodId") ?? "", note: str(fd, "note") ?? "", kind: (str(fd, "kind") ?? "review") as never });
    return "Catatan tinjauan akuntan tersimpan.";
  }, "Tersimpan.");
}

export async function runAllocationAction(periodId: string, kind: "l1_allocation" | "shared_costs"): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const r = await m11.runCostAllocation(ctx, { periodId, kind });
    return `Jurnal alokasi ${r.journal.number} terposting (${formatRupiah(r.run.totalAmount)}).`;
  }, "Terposting.");
}

export async function setSharedKeyAction(_: M11ActionState, fd: FormData): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  const basis = (str(fd, "basis") ?? "none") as "none" | "revenue" | "fixed";
  return attempt(async () => {
    await m11.setSharedCostKey(ctx, {
      basis,
      fixedPercents: basis === "fixed" ? { L2: int(fd, "pct_L2") ?? 0, L3: int(fd, "pct_L3") ?? 0, L4: int(fd, "pct_L4") ?? 0, L5: int(fd, "pct_L5") ?? 0 } : null,
      reason: str(fd, "reason") ?? "",
    });
    return "Kunci alokasi biaya bersama tersimpan.";
  }, "Tersimpan.");
}

export async function runDepreciationAction(periodId: string): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const r = await m11.runDepreciation(ctx, { periodId });
    return r.entries ? `Penyusutan ${r.entries} aset terposting (${formatRupiah(r.total)}).` : "Tidak ada penyusutan yang perlu diposting.";
  }, "Selesai.");
}

// =====================================================================================================================
// Aset tetap (US-M11-05)
// =====================================================================================================================

export async function createAssetAction(_: M11ActionState, fd: FormData): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const a = await m11.createAsset(ctx, {
      code: str(fd, "code") ?? "",
      name: str(fd, "name") ?? "",
      category: (str(fd, "category") ?? "") as never,
      acquisitionDate: str(fd, "acquisitionDate") ?? "",
      acquisitionCost: int(fd, "acquisitionCost") ?? 0,
      residualValue: int(fd, "residualValue") ?? 0,
      usefulLifeMonths: int(fd, "usefulLifeMonths"),
      profitCenter: (str(fd, "profitCenter") as ProfitCenter | null) ?? null,
      outletId: str(fd, "outletId"),
      truckId: str(fd, "truckId"),
      waterSourceId: str(fd, "waterSourceId"),
      ownedByCompany: str(fd, "ownership") !== "leased",
      source: str(fd, "acquisitionJournalId") ? "manual_journal" : "purchase",
      acquisitionJournalId: str(fd, "acquisitionJournalId"),
      notes: str(fd, "notes"),
    });
    return { message: `Aset ${a.code} ditambahkan.`, redirectTo: `/akuntansi/aset/${a.id}` };
  }, "Aset ditambahkan.");
}

export async function importAssetsAction(_: M11ActionState, fd: FormData): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  const file = await fileContent(fd, "file");
  if (!file) return { error: "Pilih berkas template daftar aset (CSV/Excel)." };
  const commit = str(fd, "mode") === "commit";
  return attempt(async () => {
    const r = await m11.importAssets(ctx, { ...file, commit });
    const preview = {
      rows: r.rows.map((x) => ({ line: x.line, code: x.code, name: x.name, action: `${formatRupiah(x.acquisitionCost)} · ${x.acquisitionDate}`, errors: x.errors })),
      summary: `${r.count} aset · nilai ${formatRupiah(r.totalCost)} · akumulasi ${formatRupiah(r.totalAccumulated)} · ${r.errors} bermasalah${r.committed ? " — tersimpan, menunggu tanda tangan pemilik" : " — pratinjau"}`,
    };
    return { preview, message: r.committed ? "Daftar aset diimpor — menunggu tanda tangan pemilik." : "Pratinjau impor siap." };
  }, "Impor diproses.");
}

export async function signAssetsAction(signoffId: string): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    await m11.signAssetRegister(ctx, { signoffId });
    return "Daftar aset ditandatangani — aset mulai disusutkan.";
  }, "Ditandatangani.");
}

export async function updateEstimateAction(_: M11ActionState, fd: FormData): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const attachmentId = await uploadFile(fd, "evidence", "journal_evidence");
    const r = await m11.updateAssetEstimate(ctx, {
      assetId: str(fd, "assetId") ?? "",
      usefulLifeMonths: int(fd, "usefulLifeMonths"),
      residualValue: int(fd, "residualValue"),
      acquisitionCost: int(fd, "acquisitionCost"),
      reason: str(fd, "reason") ?? "",
      accountantNote: str(fd, "accountantNote"),
      attachmentId,
    });
    const pending = r.pendingApprovalId ? " Perubahan nilai perolehan diajukan ke pemilik sebagai penyesuaian saldo awal." : "";
    return (r.adjustment ? `Umur/nilai diperbarui; jurnal penyesuaian ${r.journalNumber} (${formatRupiah(r.adjustment)}).` : "Umur/nilai diperbarui; tidak ada penyesuaian penyusutan.") + pending;
  }, "Diperbarui.");
}

export async function disposeAssetAction(_: M11ActionState, fd: FormData): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const attachmentId = await uploadFile(fd, "evidence", "journal_evidence");
    const r = await m11.disposeAsset(ctx, {
      assetId: str(fd, "assetId") ?? "",
      date: str(fd, "date") ?? "",
      proceeds: int(fd, "proceeds") ?? 0,
      proceedsAccountId: str(fd, "proceedsAccountId"),
      reason: str(fd, "reason") ?? "",
      attachmentId: attachmentId ?? "",
    });
    const gl = `${r.gainLoss >= 0 ? "laba" : "rugi"} pelepasan ${formatRupiah(Math.abs(r.gainLoss))}`;
    return r.status === "submitted"
      ? `Pelepasan diajukan ke pemilik (jurnal ${r.journal.number}, ${gl}); aset dilepas setelah disetujui.`
      : `Aset dilepas; ${gl} (jurnal ${r.journal.number}) — masuk daftar tinjauan pemilik.`;
  }, "Aset dilepas.");
}

// =====================================================================================================================
// Rekonsiliasi (US-M11-06)
// =====================================================================================================================

export async function saveBankRecAction(_: M11ActionState, fd: FormData): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  const manualItems: { kind: "bank_fee" | "interest" | "other"; description: string; amount: number }[] = [];
  for (const kind of ["bank_fee", "interest", "other"] as const) {
    const amount = int(fd, `item_${kind}`);
    if (amount !== null && !Number.isNaN(amount) && amount !== 0) manualItems.push({ kind, description: str(fd, `item_${kind}_desc`) ?? (kind === "bank_fee" ? "Biaya bank" : kind === "interest" ? "Bunga bank" : "Lainnya"), amount });
  }
  return attempt(async () => {
    const r = await m11.saveBankReconciliation(ctx, {
      periodId: str(fd, "periodId") ?? "",
      bankAccountId: str(fd, "bankAccountId") ?? "",
      statementBalance: int(fd, "statementBalance") ?? Number.NaN,
      manualItems,
      notes: str(fd, "notes"),
    });
    return r.zero ? "Rekonsiliasi bank nol selisih — tersimpan." : `Tersimpan; selisih ${formatRupiah(r.difference)}${r.blocking ? " dan masih ada transfer tidak ditemukan" : ""}.`;
  }, "Tersimpan.");
}

export async function saveCashRecAction(_: M11ActionState, fd: FormData): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const r = await m11.saveCashReconciliation(ctx, {
      periodId: str(fd, "periodId") ?? "",
      kind: (str(fd, "kind") ?? "") as never,
      outletId: str(fd, "outletId"),
      physicalBalance: int(fd, "physicalBalance") ?? Number.NaN,
      reason: str(fd, "reason"),
    });
    return r.zero ? "Rekonsiliasi kas nol selisih — tersimpan." : `Tersimpan; selisih ${formatRupiah(r.difference)} diselesaikan lewat alur Selisih (Kas & Setoran).`;
  }, "Tersimpan.");
}

// =====================================================================================================================
// Pajak (US-M11-08)
// =====================================================================================================================

export async function setTaxSchemeAction(_: M11ActionState, fd: FormData): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  const rate = str(fd, "ratePercent");
  return attempt(async () => {
    await m11.setTaxScheme(ctx, {
      scheme: (str(fd, "scheme") ?? "") as never,
      effectiveFrom: str(fd, "effectiveFrom") ?? "",
      ratePercent: rate ? Number(rate.replace(",", ".")) : null,
      notes: str(fd, "notes") ?? "",
    });
    return "Skema pajak tersimpan.";
  }, "Tersimpan.");
}

export async function saveExportTemplateAction(_: M11ActionState, fd: FormData): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  const columns = (str(fd, "columns") ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [header, field] = l.split("=").map((s) => s.trim());
      return { header: header ?? "", field: field ?? "" };
    });
  return attempt(async () => {
    const t = await m11.saveExportTemplate(ctx, {
      key: str(fd, "key") ?? "",
      name: str(fd, "name") ?? "",
      target: (str(fd, "target") ?? "journals") as never,
      format: (str(fd, "format") ?? "xlsx") as never,
      columns,
      reason: str(fd, "reason") ?? "",
    });
    return `Template ${t.key} versi ${t.version} aktif.`;
  }, "Tersimpan.");
}

// =====================================================================================================================
// Saldo awal & cut-over (US-M11-09)
// =====================================================================================================================

export async function setCutoverAction(_: M11ActionState, fd: FormData): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    await m11.setCutoverDate(ctx, { date: str(fd, "date") ?? "", reason: str(fd, "reason") ?? "" });
    return "Tanggal cut-over akuntansi tersimpan.";
  }, "Tersimpan.");
}

export async function saveOpeningBatchAction(_: M11ActionState, fd: FormData): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const lines = linesFrom(fd, 60).map((l) => ({ accountId: l.accountId, profitCenter: l.profitCenter, outletId: l.outletId, debit: l.debit, credit: l.credit, description: l.memo }));
    await m11.saveOpeningBatch(ctx, { group: (str(fd, "group") ?? "") as never, lines, notes: str(fd, "notes") });
    return "Draf saldo awal tersimpan — menunggu tanda tangan pemilik.";
  }, "Tersimpan.");
}

export async function signOpeningBatchAction(batchId: string): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    await m11.signOpeningBatch(ctx, { batchId });
    return "Saldo awal kelompok ini ditandatangani.";
  }, "Ditandatangani.");
}

export async function attestOpeningAction(_: M11ActionState, fd: FormData): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const r = await m11.attestOpeningBalances(ctx, { note: str(fd, "note") ?? "" });
    return `${r.attested} kelompok saldo awal disahkan akuntan.`;
  }, "Disahkan.");
}

export async function postOpeningAction(): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const r = await m11.postOpeningBalances(ctx);
    return `${r.posted} jurnal saldo awal terposting.`;
  }, "Terposting.");
}

export async function requestAdjustmentAction(_: M11ActionState, fd: FormData): Promise<M11ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const attachmentId = await uploadFile(fd, "evidence", "journal_evidence");
    const r = await m11.requestOpeningAdjustment(ctx, { lines: linesFrom(fd), reason: str(fd, "reason") ?? "", accountantNote: str(fd, "accountantNote") ?? "", attachmentId });
    return { message: `Penyesuaian saldo awal ${r.journal.number} diajukan ke pemilik.`, redirectTo: `/akuntansi/jurnal/${r.journal.id}` };
  }, "Diajukan.");
}
