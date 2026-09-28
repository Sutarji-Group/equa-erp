/**
 * M12 — skema Zod masukan layanan armada (pesan galat Bahasa Indonesia lewat `parseInput`).
 */
import { z } from "zod";

import { enumValues } from "@/lib/labels";
import { isBusinessDate } from "@/lib/time";

const date = z.string().refine(isBusinessDate, { error: "Tanggal harus berformat YYYY-MM-DD." });
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: "Bulan harus berformat YYYY-MM." });

export const phoneTrackingSchema = z.object({
  truckId: z.uuid({ error: "Pilih truk." }),
  enabled: z.boolean(),
  reason: z.string().trim().min(5, { error: "Alasan wajib diisi (minimal 5 karakter)." }).max(500),
});

export const reviewSchema = z
  .object({
    fleetEventId: z.uuid({ error: "Kejadian tidak valid." }),
    decision: z.enum(enumValues("fleet_review_decision"), { error: "Pilih keputusan: terima alasan, minta keterangan, atau tindak lanjut." }),
    note: z.string().trim().max(1000).optional().nullable(),
  })
  .refine((v) => v.decision === "accepted" || (v.note?.length ?? 0) >= 3, {
    error: "Tulis catatan (minimal 3 karakter) untuk permintaan keterangan atau tindak lanjut.",
    path: ["note"],
  });

export const closeEventSchema = z.object({
  fleetEventId: z.uuid({ error: "Kejadian tidak valid." }),
  note: z.string().trim().min(3, { error: "Tulis hasil tindak lanjut (minimal 3 karakter)." }).max(1000),
});

export const eventFilterSchema = z.object({
  from: date.optional(),
  to: date.optional(),
  kind: z.enum(enumValues("fleet_event_kind")).optional(),
  status: z.enum(enumValues("fleet_event_status")).optional(),
  group: z.enum(enumValues("fleet_event_group")).optional(),
  truckId: z.uuid().optional(),
  /** `review` = daftar tinjauan pemilik; `open` = belum Selesai; `all`. */
  view: z.enum(["review", "open", "all"]).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});

export const historyFilterSchema = z.object({
  date: date.optional(),
  truckId: z.uuid().optional(),
});

export const truckDaySchema = z.object({
  truckId: z.uuid({ error: "Pilih truk." }),
  date,
});

export const replaySchema = z.object({
  truckId: z.uuid({ error: "Pilih truk." }),
  /** Akhir jendela putar ulang (ISO). Bawaan: sekarang. */
  to: z.iso.datetime({ offset: true }).optional(),
});

export const monthSchema = z.object({ month });

export const rangeSchema = z.object({ from: date, to: date });
