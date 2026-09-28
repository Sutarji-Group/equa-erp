/**
 * M2 — skema Zod masukan layanan (pesan berbahasa Indonesia). Dipakai layanan & Server Action.
 */
import { z } from "zod";

import { enumValues } from "@/lib/labels";
import { isBusinessDate } from "@/lib/time";

export const businessDateSchema = z.string({ error: "Tanggal wajib diisi." }).refine(isBusinessDate, { error: "Tanggal harus berformat YYYY-MM-DD." });
export const hhmmSchema = z
  .string()
  .trim()
  .transform((v) => v.slice(0, 5))
  .pipe(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: "Jam harus berformat HH:mm (mis. 07:00)." }));
export const reasonSchema = (what: string) => z.string({ error: `Alasan ${what} wajib diisi.` }).trim().min(3, { error: `Alasan ${what} wajib diisi (minimal 3 karakter).` }).max(500);
export const optionalText = (max = 1000) =>
  z
    .string()
    .trim()
    .max(max, { error: `Maksimal ${max} karakter.` })
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

/** Cara bayar yang dapat dipilih Dispatcher (internal hanya untuk pelanggan internal depot, PTB-01). */
export const orderPaymentMethodSchema = z.enum(["cash", "transfer", "credit", "internal"], { error: "Cara bayar tidak dikenal. Pilih tunai, transfer, atau tempo." });

export const createOrderSchema = z.object({
  customerId: z.uuid({ error: "Pilih pelanggan." }),
  addressId: z.uuid({ error: "Pilih alamat kirim." }),
  tankCount: z.coerce.number({ error: "Jumlah tangki wajib diisi." }).int({ error: "Jumlah tangki harus bilangan bulat." }).min(1, { error: "Jumlah tangki minimal 1." }).max(50, { error: "Jumlah tangki maksimal 50 per pesanan; pecah menjadi beberapa pesanan." }).default(1),
  requestedDate: businessDateSchema.nullable().optional(),
  requestedTime: hhmmSchema.nullable().optional(),
  paymentMethod: orderPaymentMethodSchema.default("cash"),
  notes: optionalText(1000),
  /** BR-20 / 6.2c: paksa H+0 setelah PAR-05 dengan alasan. */
  forceSameDayReason: optionalText(500),
  /** US-M2-04 KP-1: "Ini pesanan tambahan" (alasan) atau "Batalkan yang ini". */
  duplicateDecision: z.enum(["additional", "cancel"]).nullable().optional(),
  duplicateReason: optionalText(500),
  /** US-M2-05 KP-3: ajukan persetujuan pemilik saat tempo ditolak kontrol kredit. */
  creditApprovalReason: optionalText(500),
  /** PTB-18: ajukan persetujuan pemilik saat kurang bayar kedua belum lunas. */
  underpaymentApprovalReason: optionalText(500),
});
export type CreateOrderInput = z.input<typeof createOrderSchema>;

export const cancelOrderSchema = z.object({
  reason: z.enum(enumValues("order_cancel_reason"), { error: "Pilih alasan pembatalan dari daftar." }),
  note: optionalText(500),
});
export type CancelOrderInput = z.input<typeof cancelOrderSchema>;

export const rescheduleOrderSchema = z.object({
  requestedDate: businessDateSchema,
  requestedTime: hhmmSchema.nullable().optional(),
  reason: reasonSchema("penjadwalan ulang"),
});
export type RescheduleOrderInput = z.input<typeof rescheduleOrderSchema>;

export const changePaymentSchema = z.object({
  paymentMethod: z.enum(["cash", "transfer", "credit"], { error: "Pilih tunai, transfer, atau tempo." }),
  reason: optionalText(500),
});
export type ChangePaymentInput = z.input<typeof changePaymentSchema>;

export const reconfirmSchema = z.object({
  confirmedAt: z.coerce.date({ error: "Waktu konfirmasi ulang wajib diisi." }),
  method: z.string({ error: "Cara konfirmasi ulang wajib diisi." }).trim().min(3, { error: "Cara konfirmasi ulang wajib diisi (mis. Telepon, WhatsApp)." }).max(100),
  note: optionalText(300),
});
export type ReconfirmInput = z.input<typeof reconfirmSchema>;

export const listOrdersSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum([...enumValues("order_status"), "active"]).optional(),
  from: businessDateSchema.optional(),
  to: businessDateSchema.optional(),
  truckId: z.uuid().optional(),
  customerId: z.uuid().optional(),
  paymentMethod: z.enum(enumValues("payment_method")).optional(),
  flag: z.enum(["duplicate", "reschedule", "reconfirm", "after_cutoff", "provisional"]).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});
export type ListOrdersFilter = z.input<typeof listOrdersSchema>;

export const assignTripSchema = z.object({
  tripId: z.uuid({ error: "Pilih rit." }),
  truckId: z.uuid({ error: "Pilih truk." }),
  date: businessDateSchema,
  /** Posisi urutan (1 = pertama). Kosong = urutan usulan BR-21. */
  position: z.coerce.number().int().min(1).nullable().optional(),
  reason: optionalText(300),
});
export type AssignTripInput = z.input<typeof assignTripSchema>;

export const reorderSchema = z.object({
  truckId: z.uuid(),
  date: businessDateSchema,
  tripIds: z.array(z.uuid()).min(1, { error: "Tidak ada rit untuk diurutkan." }),
  reason: optionalText(300),
});
export type ReorderInput = z.input<typeof reorderSchema>;

export const setDriverSchema = z.object({
  truckId: z.uuid({ error: "Pilih truk." }),
  date: businessDateSchema,
  employeeId: z.uuid({ error: "Pilih pengemudi." }),
  reason: optionalText(300),
});
export type SetDriverInput = z.input<typeof setDriverSchema>;

export const rosterEntrySchema = z.object({
  employeeId: z.uuid({ error: "Pilih karyawan." }),
  date: businessDateSchema,
  status: z.enum(enumValues("crew_roster_status")),
  truckId: z.uuid().nullable().optional(),
  role: z.enum(enumValues("crew_role")).nullable().optional(),
  notes: optionalText(300),
});
export type RosterEntryInput = z.input<typeof rosterEntrySchema>;

export const truckDaySchema = z.object({
  truckId: z.uuid({ error: "Pilih truk." }),
  date: businessDateSchema,
  status: z.enum(enumValues("truck_day_status")),
  tripCapacity: z.coerce.number().int().min(0, { error: "Kapasitas tidak boleh negatif." }).max(50).nullable().optional(),
  reason: optionalText(300),
});
export type TruckDayInput = z.input<typeof truckDaySchema>;

export const recurringSchema = z
  .object({
    customerId: z.uuid({ error: "Pilih pelanggan." }),
    addressId: z.uuid({ error: "Pilih alamat kirim." }),
    pattern: z.enum(enumValues("recurring_pattern"), { error: "Pilih pola: hari tertentu setiap minggu atau setiap sekian hari." }),
    daysOfWeek: z.array(z.coerce.number().int().min(1).max(7)).nullable().optional(),
    intervalDays: z.coerce.number().int().min(1, { error: "Interval minimal 1 hari." }).max(90).nullable().optional(),
    tankCount: z.coerce.number().int().min(1, { error: "Jumlah tangki minimal 1." }).max(50).default(1),
    requestedTime: hhmmSchema.nullable().optional(),
    paymentMethod: z.enum(["cash", "transfer", "credit"]).default("cash"),
    startDate: businessDateSchema,
    endDate: businessDateSchema.nullable().optional(),
    notes: optionalText(500),
  })
  .superRefine((v, c) => {
    if (v.pattern === "weekly" && !(v.daysOfWeek && v.daysOfWeek.length)) c.addIssue({ code: "custom", path: ["daysOfWeek"], message: "Pilih minimal satu hari dalam minggu." });
    if (v.pattern === "interval" && !v.intervalDays) c.addIssue({ code: "custom", path: ["intervalDays"], message: "Isi interval hari (mis. setiap 3 hari)." });
    if (v.endDate && v.endDate < v.startDate) c.addIssue({ code: "custom", path: ["endDate"], message: "Tanggal berakhir tidak boleh sebelum tanggal mulai." });
  });
export type RecurringInput = z.input<typeof recurringSchema>;
