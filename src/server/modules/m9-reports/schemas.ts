/**
 * M9 — skema Zod masukan layanan (pesan galat Bahasa Indonesia lewat `parseInput`).
 */
import { z } from "zod";

import { isBusinessDate } from "@/lib/time";

export const businessDateSchema = z.string().refine(isBusinessDate, { error: "Tanggal harus berformat YYYY-MM-DD." });
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: "Bulan harus berformat YYYY-MM." });
export const uuidSchema = z.uuid({ error: "ID tidak valid." });

export const dashboardSchema = z
  .object({
    range: z.enum(["today", "yesterday", "last7", "month"]).optional(),
    date: businessDateSchema.nullish(),
  })
  .strict();

export const drilldownSchema = z
  .object({
    kind: z.enum(["truck", "depot", "discrepancy", "receivable"]),
    from: businessDateSchema,
    to: businessDateSchema,
    id: uuidSchema.nullish(),
  })
  .strict();

export const decideDiscrepancySchema = z
  .object({
    discrepancyId: uuidSchema,
    decision: z.enum(["approve", "reject"]),
    reason: z.string().trim().nullish(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.decision === "reject" && (!v.reason || v.reason.length < 3)) {
      c.addIssue({ code: "custom", path: ["reason"], message: "Alasan wajib diisi (minimal 3 huruf) bila menolak penjelasan selisih." });
    }
  });

export const reviewSummarySchema = z.object({ date: businessDateSchema, note: z.string().trim().max(500).nullish() }).strict();

export const monthlyReportSchema = z.object({ month: monthSchema }).strict();

export const monthlyDrilldownSchema = z
  .object({
    month: monthSchema,
    profitCenter: z.enum(["L1", "L2", "L3", "L4", "L5", "SHARED"]).nullish(),
    accountId: uuidSchema.nullish(),
  })
  .strict();

export const exportMonthlySchema = z.object({ month: monthSchema, format: z.enum(["xlsx", "pdf"]) }).strict();

export const performanceSchema = z.object({ month: monthSchema }).strict();

export const trendSchema = z.object({ granularity: z.enum(["week", "month"]), to: businessDateSchema.nullish() }).strict();

export const kpiSchema = z.object({ month: monthSchema.nullish() }).strict();

export const ownerHoursSchema = z
  .object({
    month: monthSchema,
    hoursPerWeek: z.number({ error: "Jam per minggu harus angka." }).min(0, { error: "Jam tidak boleh negatif." }).max(168, { error: "Jam per minggu maksimal 168." }),
    note: z.string().trim().max(500).nullish(),
  })
  .strict();

export const unitRefSchema = z
  .object({
    unitType: z.enum(["truck", "outlet"]),
    truckId: uuidSchema.nullish(),
    outletId: uuidSchema.nullish(),
  })
  .superRefine((v, c) => {
    if (v.unitType === "truck" && !v.truckId) c.addIssue({ code: "custom", path: ["truckId"], message: "Pilih truk." });
    if (v.unitType === "outlet" && !v.outletId) c.addIssue({ code: "custom", path: ["outletId"], message: "Pilih outlet." });
  });

export const startParallelSchema = z
  .object({
    unitType: z.enum(["truck", "outlet"]),
    truckId: uuidSchema.nullish(),
    outletId: uuidSchema.nullish(),
    parallelStartDate: businessDateSchema,
    notes: z.string().trim().max(500).nullish(),
  })
  .strict();

export const withdrawPaperSchema = z
  .object({
    withdrawalId: uuidSchema,
    withdrawnDate: businessDateSchema,
    reason: z.string().trim().min(5, { error: "Alasan wajib diisi (minimal 5 huruf)." }).nullish(),
  })
  .strict();

export const extendParallelSchema = z
  .object({
    withdrawalId: uuidSchema,
    extensionDays: z.number().int({ error: "Jumlah hari harus bilangan bulat." }).min(1, { error: "Perpanjangan minimal 1 hari." }),
    reason: z.string().trim().min(10, { error: "Keputusan komite pengarah wajib dicatat (minimal 10 huruf)." }),
  })
  .strict();

export const parallelCheckSchema = z
  .object({
    unitType: z.enum(["truck", "outlet"]),
    truckId: uuidSchema.nullish(),
    outletId: uuidSchema.nullish(),
    businessDate: businessDateSchema,
    paperCount: z.number().int({ error: "Jumlah nota harus bilangan bulat." }).min(0, { error: "Jumlah nota tidak boleh negatif." }),
    paperAmount: z.number().int({ error: "Nilai nota harus rupiah bulat." }).min(0, { error: "Nilai nota tidak boleh negatif." }),
    explained: z.boolean().optional(),
    cause: z.string().trim().max(500).nullish(),
  })
  .strict();

export const inboxActionSchema = z
  .object({
    itemKind: z.enum(["approval", "discrepancy", "failed_trip", "gps", "water_loss", "info"]),
    itemId: z.string().min(1, { error: "Butir kotak masuk tidak valid." }),
    action: z.enum(["approve", "reject", "request_explanation", "done"]),
    note: z.string().trim().max(1000).nullish(),
  })
  .strict()
  .superRefine((v, c) => {
    if ((v.action === "reject" || v.action === "request_explanation") && (!v.note || v.note.length < 3)) {
      c.addIssue({
        code: "custom",
        path: ["note"],
        message: v.action === "reject" ? "Alasan wajib diisi bila menolak (minimal 3 huruf)." : "Tulis keterangan yang diminta (minimal 3 huruf).",
      });
    }
  });
