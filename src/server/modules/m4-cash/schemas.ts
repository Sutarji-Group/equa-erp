/**
 * M4 — skema Zod input layanan kantor Kas & Setoran (pesan Indonesia). Semua uang = rupiah bulat.
 */
import { z } from "zod";

import { enumValues } from "@/lib/labels";
import { isBusinessDate } from "@/lib/time";

const uuid = z.uuid({ error: "ID tidak valid." });
const text = (max: number) => z.string().trim().max(max, { error: `Maksimal ${max} karakter.` });
const optText = (max: number) =>
  text(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));
const rupiah = z.number({ error: "Jumlah harus angka." }).int({ error: "Jumlah harus rupiah bulat." }).min(0, { error: "Jumlah tidak boleh negatif." }).max(10_000_000_000);
const rupiahPositive = rupiah.refine((v) => v > 0, { error: "Jumlah harus lebih dari nol." });
const businessDate = z.string().refine(isBusinessDate, { error: "Tanggal harus berformat YYYY-MM-DD." });
const optDate = businessDate.nullable().optional();
const reasonText = (min = 3) => z.string().trim().min(min, { error: `Alasan wajib diisi (minimal ${min} karakter).` }).max(500);

export const discrepancyReasonSchema = z.enum(enumValues("discrepancy_reason"), { error: "Pilih alasan selisih dari daftar." });

/** Rincian pecahan uang (opsional, US-M4-02 KP-2): nilai pecahan (rupiah) → jumlah lembar/keping. */
export const denominationsSchema = z
  .record(z.string().regex(/^\d+$/, { error: "Pecahan harus angka rupiah." }), z.number().int().min(0).max(100_000))
  .nullable()
  .optional();

export const expenseDecisionSchema = z
  .object({
    expenseId: uuid,
    accept: z.boolean({ error: "Pilih terima atau tolak pengeluaran." }),
    reason: optText(300),
  })
  .strict();

/** US-M4-02 KP-2/3/6: terima setoran (angka seharusnya TIDAK dapat dikirim — dihitung sistem). */
export const receiveDepositSchema = z
  .object({
    depositId: uuid,
    receivedAmount: rupiah,
    denominations: denominationsSchema,
    expenseDecisions: z.array(expenseDecisionSchema).max(100).optional().default([]),
    discrepancyReason: discrepancyReasonSchema.nullable().optional(),
    discrepancyNote: optText(500),
    lateReason: optText(300),
    evidenceAttachmentId: uuid.nullable().optional(),
    /** Tutup setoran sekaligus setelah diterima (bawaan ya — US-M4-02 KP-4). */
    close: z.boolean().optional().default(true),
  })
  .strict();

export const closeDepositSchema = z.object({ depositId: uuid }).strict();

export const verifyExpenseSchema = z
  .object({
    expenseId: uuid,
    accept: z.boolean({ error: "Pilih terima atau tolak pengeluaran." }),
    reason: optText(300),
  })
  .strict();

export const reopenDepositSchema = z.object({ depositId: uuid, reason: reasonText() }).strict();

// --- Selisih ---------------------------------------------------------------------------------------------------------

export const explainDiscrepancySchema = z
  .object({
    discrepancyId: uuid,
    reason: discrepancyReasonSchema,
    explanation: z.string().trim().min(3, { error: "Penjelasan wajib diisi (minimal 3 karakter)." }).max(1000),
  })
  .strict();

export const decideDiscrepancySchema = z
  .object({
    decision: z.enum(["approve", "reject"], { error: "Pilih setujui atau tolak." }),
    reason: optText(500),
  })
  .strict();

export const reopenDiscrepancySchema = z.object({ discrepancyId: uuid, reason: reasonText() }).strict();

export const completeFollowUpSchema = z
  .object({
    discrepancyId: uuid,
    note: z.string().trim().min(3, { error: "Catatan tindak lanjut wajib diisi (minimal 3 karakter)." }).max(500),
  })
  .strict();

// --- Ganti rugi ------------------------------------------------------------------------------------------------------

export const settleRestitutionSchema = z
  .object({
    restitutionId: uuid,
    amount: rupiahPositive,
    method: z.enum(["cash", "payroll_deduction"], { error: "Pilih cara pelunasan: setor tunai atau potongan penggajian." }),
    settledOn: optDate,
    reference: optText(120),
  })
  .strict();

export const reverseSettlementSchema = z.object({ settlementId: uuid, reason: reasonText() }).strict();

/** Parameter "ganti rugi aktif" (US-M4-03 KP-4) — pemilik, setelah Peraturan Perusahaan berlaku. */
export const restitutionActiveSchema = z
  .object({
    enabled: z.boolean({ error: "Pilih aktif atau nonaktif." }),
    reason: z.string().trim().min(5, { error: "Alasan wajib diisi (minimal 5 karakter), mis. nomor Peraturan Perusahaan." }).max(300),
  })
  .strict();

// --- Transfer masuk & mutasi -------------------------------------------------------------------------------------------

export const matchTransferSchema = z
  .object({
    transferId: uuid,
    refDate: businessDate,
    refAmount: rupiahPositive,
    refNote: z.string().trim().min(3, { error: "Keterangan mutasi wajib diisi (minimal 3 karakter)." }).max(300),
    statementLineId: uuid.nullable().optional(),
    /** Setor bank dengan slip yang jumlah mutasinya berbeda dari setoran: alasan selisih (US-M4-02 KP-3). */
    discrepancyReason: discrepancyReasonSchema.nullable().optional(),
    discrepancyNote: optText(500),
  })
  .strict();

export const importStatementSchema = z
  .object({
    bankAccountId: uuid,
    fileName: z.string().trim().min(1).max(200),
    /** Isi berkas (CSV teks atau XLSX biner). */
    content: z.union([z.string(), z.instanceof(Uint8Array)]),
    fileAttachmentId: uuid.nullable().optional(),
  })
  .strict();

export const confirmMatchesSchema = z
  .object({
    pairs: z.array(z.object({ lineId: uuid, transferId: uuid }).strict()).min(1, { error: "Pilih minimal satu pasangan." }).max(500),
  })
  .strict();

export const markStatementLineSchema = z
  .object({
    lineId: uuid,
    status: z.enum(["follow_up", "ignored"], { error: "Pilih tindak lanjut atau abaikan." }),
    note: z.string().trim().min(3, { error: "Catatan wajib diisi (minimal 3 karakter)." }).max(300),
  })
  .strict();

// --- Kas kantor, setor bank, rekening -----------------------------------------------------------------------------------

export const bankAccountSchema = z
  .object({
    bankName: z.string().trim().min(2, { error: "Nama bank wajib diisi." }).max(80),
    accountNumber: z
      .string()
      .trim()
      .regex(/^[0-9-]{5,30}$/, { error: "Nomor rekening hanya angka (boleh tanda hubung), 5–30 karakter." }),
    accountName: z.string().trim().min(3, { error: "Nama pemilik rekening wajib diisi." }).max(120),
    branch: optText(80),
    isCustomerFacing: z.boolean().optional().default(false),
    /**
     * B-53: akun buku rekening (bagan akun M11, kas/bank detail) yang BELUM dipakai rekening lain. Kosong = akun buku
     * baru dibuat otomatis (`1-12NN`).
     */
    glAccountId: z.uuid({ error: "Akun buku tidak valid. Pilih dari daftar atau biarkan kosong untuk akun baru." }).nullable().optional(),
  })
  .strict();

/** B-53: tetapkan/ganti akun buku rekening lama yang kosong atau dipakai bersama. */
export const setBankGlAccountSchema = z
  .object({
    bankAccountId: z.uuid(),
    glAccountId: z.uuid({ error: "Akun buku tidak valid." }).nullable().optional(),
    reason: z.string().trim().min(5, { error: "Alasan wajib diisi (minimal 5 karakter)." }).max(300),
  })
  .strict();

export const deactivateBankAccountSchema = z.object({ bankAccountId: uuid, reason: reasonText() }).strict();

export const openingBalanceSchema = z
  .object({
    amount: rupiah,
    businessDate: optDate,
    note: z.string().trim().min(3, { error: "Keterangan wajib diisi (mis. hasil hitung fisik cut-over)." }).max(300),
  })
  .strict();

export const bankDepositSchema = z
  .object({
    bankAccountId: uuid,
    amount: rupiahPositive,
    businessDate: optDate,
    slipAttachmentId: uuid,
    notes: optText(300),
  })
  .strict();

export const reverseBankDepositSchema = z.object({ bankDepositId: uuid, reason: reasonText() }).strict();

// --- Kas kecil ------------------------------------------------------------------------------------------------------

export const pettyCashSchema = z
  .object({
    kind: z.enum(["topup", "expense"], { error: "Pilih pengisian atau pengeluaran." }),
    amount: rupiahPositive,
    businessDate: optDate,
    category: z.enum(enumValues("petty_cash_category"), { error: "Pilih kategori pengeluaran." }).nullable().optional(),
    profitCenter: z.enum(enumValues("profit_center"), { error: "Pilih pusat laba." }).nullable().optional(),
    outletId: uuid.nullable().optional(),
    description: z.string().trim().min(3, { error: "Uraian wajib diisi (minimal 3 karakter)." }).max(300),
    receiptAttachmentId: uuid.nullable().optional(),
  })
  .strict();

export const pettyCashCountSchema = z
  .object({
    physicalAmount: rupiah,
    countDate: optDate,
    reason: optText(500),
  })
  .strict();

// --- Tutup kas -----------------------------------------------------------------------------------------------------

export const cashDateSchema = z.object({ date: optDate }).strict();

export const closeExceptionSchema = z
  .object({
    date: optDate,
    depositId: uuid.nullable().optional(),
    shiftId: uuid.nullable().optional(),
    reason: reasonText(5),
  })
  .strict()
  .refine((v) => !!v.depositId || !!v.shiftId, { error: "Pilih setoran/sumber yang berhalangan." });

export const closeCashDaySchema = z
  .object({
    date: optDate,
    officeCashPhysical: rupiah,
    officeCashReason: discrepancyReasonSchema.nullable().optional(),
    officeCashNote: optText(500),
  })
  .strict();

export type ReceiveDepositInput = z.input<typeof receiveDepositSchema>;
export type MatchTransferInput = z.input<typeof matchTransferSchema>;
export type PettyCashInput = z.input<typeof pettyCashSchema>;
export type CloseCashDayInput = z.input<typeof closeCashDaySchema>;
