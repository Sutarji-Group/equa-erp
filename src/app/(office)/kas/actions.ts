"use server";

/**
 * Server Action layar Kas & Setoran (/kas/*). Tipis: sesi kantor → layanan M4 (authorize → validasi → aturan +
 * pemisahan tugas → transaksi → audit → event) → revalidasi. Galat tampil sebagai pesan tindakan berbahasa Indonesia.
 */
import { revalidatePath } from "next/cache";

import type { CashActionState } from "@/components/m4-cash/action-state";
import { requireOfficeSession } from "@/server/core/auth/office";
import { withTx } from "@/server/core/db";
import { DomainError, toUserMessage } from "@/server/core/errors";
import { put } from "@/server/core/storage";
import * as m4 from "@/server/modules/m4-cash";

const KAS_PATHS = ["/kas", "/kas/setoran", "/kas/selisih", "/kas/transfer", "/kas/kantor", "/kas/kas-kecil", "/kas/tutup", "/kas/ganti-rugi"];

function str(fd: FormData, name: string): string | null {
  const v = fd.get(name);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** Rupiah bulat ("Rp" & titik ribuan dibuang). `null` bila kosong, NaN bila tidak valid (ditolak skema layanan). */
function int(fd: FormData, name: string): number | null {
  const s = str(fd, name);
  if (s === null) return null;
  const n = Number(s.replace(/^Rp/i, "").replace(/[.\s]/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n) : Number.NaN;
}

async function attempt(fn: () => Promise<string | void>, message: string, extraPaths: string[] = []): Promise<CashActionState> {
  try {
    const custom = await fn();
    for (const p of [...KAS_PATHS, ...extraPaths]) revalidatePath(p);
    return { ok: true, message: custom || message };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}

const IMAGE_OR_PDF = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

/** Unggah lampiran formulir (foto slip/bukti) → id lampiran (dikaitkan ke objek oleh layanan). */
async function uploadFile(fd: FormData, name: string, kind: string, allowed: ReadonlySet<string> = IMAGE_OR_PDF): Promise<string | null> {
  const file = fd.get(name);
  if (!(file instanceof File) || file.size === 0) return null;
  const type = (file.type || "image/jpeg").toLowerCase();
  if (!allowed.has(type)) throw new DomainError("FILE_TYPE", "Jenis berkas tidak didukung. Lampirkan foto JPEG/PNG/WEBP atau PDF.");
  const { ctx } = await requireOfficeSession();
  const buf = Buffer.from(await file.arrayBuffer());
  const att = await withTx((tx) => put(tx, ctx, { blob: buf, contentType: type, kind, originalName: file.name }));
  return att.id;
}

// --- Setoran (US-M4-02) -------------------------------------------------------------------------------------------------

export async function receiveDepositAction(depositId: string, _prev: CashActionState, fd: FormData): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const expenseDecisions: { expenseId: string; accept: boolean; reason: string | null }[] = [];
      for (const [key, value] of fd.entries()) {
        if (!key.startsWith("exp_") || typeof value !== "string") continue;
        const expenseId = key.slice(4);
        expenseDecisions.push({ expenseId, accept: value === "accept", reason: str(fd, `expreason_${expenseId}`) });
      }
      const denominations: Record<string, number> = {};
      for (const [key] of fd.entries()) {
        if (!key.startsWith("den_")) continue;
        const n = int(fd, key);
        if (n && n > 0) denominations[key.slice(4)] = n;
      }
      const evidenceAttachmentId = await uploadFile(fd, "evidence", "discrepancy_evidence");
      const res = await m4.receiveDeposit(ctx, {
        depositId,
        receivedAmount: int(fd, "receivedAmount") ?? Number.NaN,
        denominations: Object.keys(denominations).length ? denominations : null,
        expenseDecisions,
        discrepancyReason: str(fd, "discrepancyReason"),
        discrepancyNote: str(fd, "discrepancyNote"),
        lateReason: str(fd, "lateReason"),
        evidenceAttachmentId,
        close: fd.get("close") === "on",
      });
      const head = `Setoran ${res.deposit.number} diterima${res.closed ? " & ditutup" : ""}.`;
      if (res.discrepancy?.requiresOwnerDecision) return `${head} Selisih diteruskan ke pemilik untuk diputuskan (setoran tidak menunggu keputusan).`;
      if (res.discrepancy) return `${head} Selisih tercatat dengan alasan.`;
      return `${head} Tanpa selisih.`;
    },
    "Setoran diterima.",
    [`/kas/setoran/${depositId}`],
  );
}

export async function closeDepositAction(depositId: string): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => void (await m4.closeDeposit(ctx, { depositId })), "Setoran ditutup — hasilnya tampil di aplikasi penyetor.", [`/kas/setoran/${depositId}`]);
}

export async function verifyExpenseAction(depositId: string, expenseId: string, accept: boolean, reason: string | null = null): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => void (await m4.verifyExpense(ctx, { expenseId, accept, reason })), accept ? "Pengeluaran diterima." : "Pengeluaran ditolak.", [`/kas/setoran/${depositId}`]);
}

export async function reopenDepositAction(depositId: string, reason: string): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => void (await m4.reopenDeposit(ctx, { depositId, reason })), "Setoran dibuka kembali — sopir dapat melanjutkan rit lalu Setor lagi.", [`/kas/setoran/${depositId}`]);
}

// --- Selisih (US-M4-03, US-M4-06 KP-6) -------------------------------------------------------------------------------------

export async function approveDiscrepancyAction(discrepancyId: string): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => void (await m4.decideDiscrepancy(ctx, discrepancyId, { decision: "approve" })), "Selisih disetujui — dibebankan ke pusat laba sumbernya.", ["/persetujuan"]);
}

export async function rejectDiscrepancyAction(discrepancyId: string, reason: string): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => void (await m4.decideDiscrepancy(ctx, discrepancyId, { decision: "reject", reason })), "Selisih ditolak — dikembalikan ke Admin Keuangan untuk ditindaklanjuti.", ["/persetujuan"]);
}

export async function explainDiscrepancyAction(discrepancyId: string, _prev: CashActionState, fd: FormData): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => void (await m4.explainDiscrepancy(ctx, { discrepancyId, reason: str(fd, "reason"), explanation: str(fd, "explanation") ?? "" })),
    "Penjelasan selisih tersimpan.",
    ["/persetujuan"],
  );
}

export async function completeFollowUpAction(discrepancyId: string, note: string): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => void (await m4.completeDiscrepancyFollowUp(ctx, { discrepancyId, note })), "Tindak lanjut selesai — selisih berstatus Selesai.");
}

export async function reopenDiscrepancyAction(discrepancyId: string, reason: string): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => void (await m4.reopenDiscrepancy(ctx, { discrepancyId, reason })), "Selisih dibuka kembali — putuskan setujui atau tolak.");
}

// --- Ganti rugi (US-M4-03 KP-3/KP-4) -------------------------------------------------------------------------------------------

export async function settleRestitutionAction(restitutionId: string, _prev: CashActionState, fd: FormData): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const r = await m4.settleRestitution(ctx, {
        restitutionId,
        amount: int(fd, "amount") ?? Number.NaN,
        method: str(fd, "method") === "payroll_deduction" ? "payroll_deduction" : "cash",
        settledOn: str(fd, "settledOn"),
        reference: str(fd, "reference"),
      });
      return r.restitution.status === "settled" ? "Ganti rugi lunas." : "Pelunasan sebagian tercatat.";
    },
    "Pelunasan ganti rugi tercatat.",
  );
}

export async function reverseSettlementAction(settlementId: string, reason: string): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const r = await m4.reverseRestitutionSettlement(ctx, { settlementId, reason });
    if (r.status === "pending_approval") return "Pembalik di atas batas koreksi — menunggu persetujuan pemilik.";
  }, "Pelunasan dibalik.", ["/persetujuan"]);
}

export async function setRestitutionActiveAction(_prev: CashActionState, fd: FormData): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  const enabled = str(fd, "enabled") === "true";
  return attempt(async () => void (await m4.setRestitutionActive(ctx, { enabled, reason: str(fd, "reason") ?? "" })), enabled ? "Ganti rugi karyawan diaktifkan." : "Ganti rugi karyawan dinonaktifkan.");
}

// --- Transfer masuk & mutasi (US-M4-04) -------------------------------------------------------------------------------------

export async function matchTransferAction(transferId: string, _prev: CashActionState, fd: FormData): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () =>
      void (await m4.matchTransfer(ctx, {
        transferId,
        refDate: str(fd, "refDate") ?? "",
        refAmount: int(fd, "refAmount") ?? Number.NaN,
        refNote: str(fd, "refNote") ?? "",
        discrepancyReason: str(fd, "discrepancyReason"),
        discrepancyNote: str(fd, "discrepancyNote"),
      })),
    "Transfer cocok dengan mutasi.",
  );
}

const STATEMENT_TYPES = new Set(["text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);

export async function importStatementAction(_prev: CashActionState, fd: FormData): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new DomainError("FILE_REQUIRED", "Pilih berkas mutasi (CSV atau Excel .xlsx) dari internet banking.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const isXlsx = file.name.toLowerCase().endsWith(".xlsx");
    const contentType = isXlsx ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv";
    // Berkas asli disimpan sebagai lampiran impor (jejak NFR-22); gagal simpan tidak menghalangi impor.
    let fileAttachmentId: string | null = null;
    if (STATEMENT_TYPES.has(contentType)) {
      try {
        fileAttachmentId = (await withTx((tx) => put(tx, ctx, { blob: Buffer.from(bytes), contentType, kind: "bank_statement", originalName: file.name }))).id;
      } catch {
        fileAttachmentId = null;
      }
    }
    const res = await m4.importBankStatement(ctx, {
      bankAccountId: str(fd, "bankAccountId") ?? "",
      fileName: file.name,
      content: isXlsx ? bytes : new TextDecoder("utf-8").decode(bytes),
      fileAttachmentId,
    });
    return `${res.inserted} mutasi baru dibaca (${res.duplicates} sudah pernah diimpor${res.skipped ? `, ${res.skipped} baris dilewati` : ""}). ${res.proposals.length} usulan pasangan, ${res.unpaired.length} mutasi tanpa pasangan.`;
  }, "Mutasi diimpor.");
}

export async function confirmMatchesAction(_prev: CashActionState, fd: FormData): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const pairs = fd
      .getAll("pair")
      .filter((v): v is string => typeof v === "string")
      .map((v) => {
        const [lineId, transferId] = v.split(":");
        return { lineId: lineId ?? "", transferId: transferId ?? "" };
      });
    const res = await m4.confirmStatementMatches(ctx, { pairs });
    return `${res.matched} transfer dicocokkan dengan mutasi.`;
  }, "Pasangan dikonfirmasi.");
}

export async function markStatementLineAction(lineId: string, _prev: CashActionState, fd: FormData): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  const status = str(fd, "status") === "ignored" ? "ignored" : "follow_up";
  return attempt(async () => void (await m4.markStatementLine(ctx, { lineId, status, note: str(fd, "note") ?? "" })), status === "ignored" ? "Mutasi ditandai diabaikan." : "Mutasi masuk daftar tindak lanjut.");
}

// --- Kas kantor & setor bank (US-M4-05 KP-1) -----------------------------------------------------------------------------------

export async function bankDepositAction(_prev: CashActionState, fd: FormData): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const slipAttachmentId = await uploadFile(fd, "slip", "bank_slip");
    if (!slipAttachmentId) throw new DomainError("SLIP_REQUIRED", "Foto slip setoran bank wajib dilampirkan.");
    await m4.recordBankDeposit(ctx, { bankAccountId: str(fd, "bankAccountId") ?? "", amount: int(fd, "amount") ?? Number.NaN, businessDate: str(fd, "businessDate"), slipAttachmentId, notes: str(fd, "notes") });
  }, "Setor ke bank tercatat — cocokkan dengan mutasi di menu Transfer masuk.");
}

export async function reverseBankDepositAction(bankDepositId: string, reason: string): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const r = await m4.reverseBankDeposit(ctx, { bankDepositId, reason });
    if (r.status === "pending_approval") return "Pembalik di atas batas koreksi — menunggu persetujuan pemilik.";
  }, "Setor bank dibalik; kas kantor dikembalikan.", ["/persetujuan"]);
}

export async function openingBalanceAction(_prev: CashActionState, fd: FormData): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => void (await m4.recordOfficeCashOpening(ctx, { amount: int(fd, "amount") ?? Number.NaN, businessDate: str(fd, "businessDate"), note: str(fd, "note") ?? "" })), "Saldo awal kas kantor tercatat.");
}

export async function createBankAccountAction(_prev: CashActionState, fd: FormData): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () =>
      void (await m4.createBankAccount(ctx, {
        bankName: str(fd, "bankName") ?? "",
        accountNumber: str(fd, "accountNumber") ?? "",
        accountName: str(fd, "accountName") ?? "",
        branch: str(fd, "branch"),
        isCustomerFacing: fd.get("isCustomerFacing") === "on",
        glAccountId: str(fd, "glAccountId"),
      })),
    "Rekening bank ditambahkan.",
  );
}

/** B-53: tetapkan akun buku sendiri untuk rekening lama (kosong = akun baru dibuat otomatis). */
export async function setBankGlAccountAction(bankAccountId: string, _prev: CashActionState, fd: FormData): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => void (await m4.setBankAccountGlAccount(ctx, { bankAccountId, glAccountId: str(fd, "glAccountId"), reason: str(fd, "reason") ?? "" })), "Akun buku rekening ditetapkan.");
}

export async function deactivateBankAccountAction(bankAccountId: string, reason: string): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => void (await m4.deactivateBankAccount(ctx, { bankAccountId, reason })), "Rekening dinonaktifkan.");
}

// --- Kas kecil (US-M4-05 KP-2) ---------------------------------------------------------------------------------------------------

export async function pettyCashAction(_prev: CashActionState, fd: FormData): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const kind = str(fd, "kind") === "expense" ? "expense" : "topup";
    const receiptAttachmentId = kind === "expense" ? await uploadFile(fd, "receipt", "receipt_note") : null;
    const row = await m4.recordPettyCash(ctx, {
      kind,
      amount: int(fd, "amount") ?? Number.NaN,
      businessDate: str(fd, "businessDate"),
      category: kind === "expense" ? str(fd, "category") : null,
      profitCenter: kind === "expense" ? str(fd, "profitCenter") : null,
      outletId: kind === "expense" ? str(fd, "outletId") : null,
      description: str(fd, "description") ?? "",
      receiptAttachmentId,
    });
    if (row.status === "pending_approval") return "Di atas batas kas kecil — menunggu persetujuan pemilik (belum berlaku).";
  }, "Kas kecil tercatat.", ["/persetujuan"]);
}

export async function pettyCashCountAction(_prev: CashActionState, fd: FormData): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const r = await m4.countPettyCash(ctx, { physicalAmount: int(fd, "physicalAmount") ?? Number.NaN, reason: str(fd, "reason") });
    if (r.difference !== 0) return "Hitung fisik tercatat — selisih masuk alur Selisih dan saldo disesuaikan.";
  }, "Hitung fisik cocok dengan saldo sistem.");
}

// --- Tutup kas (US-M4-06) --------------------------------------------------------------------------------------------------------

export async function startCloseAction(date: string): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const r = await m4.startCashClose(ctx, { date });
    if (r.blockers.length) return `Mulai tutup kas dicatat. ${r.blockers.length} sumber masih menghalangi — hubungi atau ajukan pengecualian.`;
  }, "Mulai tutup kas dicatat.");
}

export async function requestExceptionAction(date: string, depositId: string | null, shiftId: string | null, reason: string): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => void (await m4.requestCloseException(ctx, { date, depositId, shiftId, reason })), "Pengecualian diajukan ke pemilik (per kejadian).", ["/persetujuan"]);
}

export async function closeCashDayAction(date: string, _prev: CashActionState, fd: FormData): Promise<CashActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const day = await m4.closeCashDay(ctx, {
        date,
        officeCashPhysical: int(fd, "officeCashPhysical") ?? Number.NaN,
        officeCashReason: str(fd, "officeCashReason"),
        officeCashNote: str(fd, "officeCashNote"),
      });
      return `Kas ditutup${day.closedLate ? " (terlambat)" : ""} — ringkasan H+0 terbit untuk pemilik.`;
    },
    "Kas harian ditutup.",
  );
}
