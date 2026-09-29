/**
 * M3 — skema Zod payload perintah sinkron & input kantor (pesan Indonesia). Bentuk payload = kontrak
 * `src/client/m3-driver/contract.ts` (perangkat).
 */
import { z } from "zod";

import { isBusinessDate } from "@/lib/time";

const uuid = z.uuid({ error: "ID tidak valid." });
const text = (max: number) => z.string().trim().max(max, { error: `Maksimal ${max} karakter.` });
const optText = (max: number) => text(max).nullable().optional();
const rupiah = z.number({ error: "Jumlah harus angka." }).int({ error: "Jumlah harus rupiah bulat." }).min(0, { error: "Jumlah tidak boleh negatif." }).max(1_000_000_000);

export const locationSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracyM: z.number().min(0).max(100_000).nullable().optional().transform((v) => (v === undefined ? null : v)),
  })
  .nullable();

export const departSchema = z.object({
  tripId: uuid,
  location: locationSchema,
  outOfOrderConfirmed: z.boolean().optional(),
});

export const arriveSchema = z.object({
  tripId: uuid,
  location: locationSchema,
  clientDistanceM: z.number().int().min(0).nullable().optional(),
});

const reasonCode = z.string().trim().max(40).nullable().optional();

export const paymentSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("none") }),
  z.object({ method: z.literal("cash"), cashReceived: rupiah, underpaymentReasonCode: reasonCode, underpaymentReasonText: optText(300) }),
  z.object({ method: z.literal("transfer"), transferAmount: rupiah, underpaymentReasonCode: reasonCode, underpaymentReasonText: optText(300) }),
  z.object({ method: z.literal("credit"), creditApprovalId: uuid.nullable().optional(), cashReceivedIfRejected: rupiah.optional() }),
  // B-65 (US-P2-04 KP-4, D-11 butir 4): rit sudah dibayar di muka lewat aplikasi pelanggan — sopir tidak menagih.
  z.object({ method: z.literal("prepaid") }),
]);

export const completeSchema = z.object({
  tripId: uuid,
  recipientName: optText(120),
  signatureSkipReason: reasonCode,
  deliveredVolumeL: z.number({ error: "Volume harus angka." }).int({ error: "Volume harus liter bulat." }).min(0).max(100_000),
  partialVolumeReason: z.enum(["customer_tank_full", "leakage", "customer_request", "other"]).nullable().optional(),
  partialVolumeNote: optText(300),
  location: locationSchema,
  clientDistanceM: z.number().int().min(0).nullable().optional(),
  locationReason: z.enum(["wrong_master_address", "customer_other_point", "gps_inaccurate", "other"]).nullable().optional(),
  locationReasonNote: optText(300),
  payment: paymentSchema,
});

export const failSchema = z.object({
  tripId: uuid,
  reason: z.enum(["customer_absent", "customer_refused", "location_inaccessible", "truck_broken", "other"], { error: "Pilih alasan rit gagal." }),
  note: optText(300),
  loadedWaterDisposition: z.enum(["carried_to_next", "returned_to_source", "unloaded_at_depot"], { error: "Pilih tindak lanjut air yang sudah dimuat." }),
  location: locationSchema,
});

export const fieldCreditSchema = z.object({
  tripId: uuid,
  reason: text(300).min(3, { error: "Alasan wajib diisi (minimal 3 karakter)." }),
});

export const collectionSchema = z.object({
  paymentId: uuid,
  customerId: uuid,
  tripId: uuid,
  method: z.enum(["cash", "transfer"], { error: "Pilih tunai atau transfer." }),
  amount: rupiah.min(1, { error: "Jumlah pelunasan harus lebih dari 0." }),
  invoiceIds: z.array(uuid).min(1, { error: "Pilih minimal satu faktur." }).max(50),
});

export const incidentSchema = z.object({
  incidentId: uuid,
  tripId: uuid.nullable().optional(),
  kind: z.enum(["truck_broken", "road_blocked", "accident", "other"], { error: "Pilih jenis kendala." }),
  description: text(500).min(3, { error: "Tulis catatan kendala (minimal 3 karakter)." }),
  location: locationSchema,
});

export const explanationSchema = z.object({
  fleetEventId: uuid,
  explanation: text(500).min(5, { error: "Tulis keterangan perjalanan (minimal 5 karakter)." }),
});

export const expenseSchema = z.object({
  expenseId: uuid,
  tripId: uuid.nullable().optional(),
  kind: z.enum(["fuel", "toll", "parking", "other"], { error: "Pilih jenis pengeluaran." }),
  amount: rupiah.min(1, { error: "Jumlah pengeluaran harus lebih dari 0." }),
  fundingSource: z.enum(["cash_on_hand", "personal"], { error: "Pilih sumber dana." }),
  note: optText(300),
});

const idList = z.array(uuid).max(500);

export const depositSubmitSchema = z.object({
  method: z.enum(["physical", "bank_slip"]).default("physical"),
  note: optText(300),
  manifest: z
    .object({ completedTripIds: idList, failedTripIds: idList, collectionIds: idList, expenseIds: idList })
    .default({ completedTripIds: [], failedTripIds: [], collectionIds: [], expenseIds: [] }),
  deviceExpectedNet: z.number().int().nullable().optional(),
});

export const depositNoteSchema = z.object({
  depositId: uuid,
  note: text(500).min(3, { error: "Tulis keterangan (minimal 3 karakter)." }),
});

export const receiptSchema = z
  .object({
    kind: z.enum(["trip_receipt", "payment_receipt"]),
    tripId: uuid.nullable().optional(),
    customerPaymentId: uuid.nullable().optional(),
    action: z.enum(["opened", "skipped"]),
    reasonCode: reasonCode,
    reasonText: optText(200),
    toPhone: optText(30),
    renderedText: optText(2000),
  })
  .refine((v) => (v.kind === "trip_receipt" ? !!v.tripId : !!v.customerPaymentId), { error: "Rit/pelunasan wajib dipilih." });

export const phonePositionsSchema = z.object({
  truckId: uuid,
  positions: z
    .array(
      z.object({
        deviceTime: z.iso.datetime({ offset: true, error: "Waktu posisi tidak valid." }),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        accuracyM: z.number().min(0).nullable().optional(),
        speedKmh: z.number().min(0).max(300).nullable().optional(),
        heading: z.number().int().min(0).max(360).nullable().optional(),
        tripId: uuid.nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});

// --- Kantor ---------------------------------------------------------------------------------------------------------

export const reopenDepositSchema = z.object({
  depositId: uuid,
  reason: text(300).min(5, { error: "Alasan membuka kembali setoran wajib diisi (minimal 5 karakter)." }),
});

const officeBase = {
  tripId: uuid,
  reason: text(500).min(10, { error: "Alasan pencatatan kantor wajib diisi (minimal 10 karakter): perangkat rusak/hilang & bukti yang dipakai." }),
  /** Jam kejadian menurut bukti (HH:mm WIB) pada tanggal rit. */
  occurredTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: "Jam kejadian harus HH:mm." }),
  evidenceAttachmentId: uuid.nullable().optional(),
};

export const officeCompleteSchema = z.object({
  ...officeBase,
  recipientName: text(120).min(2, { error: "Nama penerima wajib diisi." }),
  deliveredVolumeL: z.number().int().min(0).max(100_000),
  partialVolumeReason: z.enum(["customer_tank_full", "leakage", "customer_request", "other"]).nullable().optional(),
  partialVolumeNote: optText(300),
  payment: paymentSchema,
});

export const officeFailSchema = z.object({
  ...officeBase,
  failReason: z.enum(["customer_absent", "customer_refused", "location_inaccessible", "truck_broken", "other"]),
  note: optText(300),
  loadedWaterDisposition: z.enum(["carried_to_next", "returned_to_source", "unloaded_at_depot"]),
});

export const confirmIncidentSchema = z.object({
  incidentId: uuid,
  setTruckMaintenance: z.boolean(),
  note: text(300).min(3, { error: "Catatan konfirmasi wajib diisi." }),
});

export const dateFilterSchema = z.object({
  date: z.string().refine(isBusinessDate, { error: "Tanggal harus YYYY-MM-DD." }),
});

// --- Koreksi Admin Keuangan (tambahan S5, B-34; FR-M3-07, BR-38) ------------------------------------------------------

export const correctTripSchema = z
  .object({
    tripId: uuid,
    /** Harga rit baru (rupiah bulat). Kosong = tidak diubah. */
    price: rupiah.nullable().optional(),
    /** Volume terkirim baru (liter bulat). Kosong = tidak diubah. */
    deliveredVolumeL: z.number({ error: "Volume harus angka." }).int({ error: "Volume harus liter bulat." }).min(0).max(100_000).nullable().optional(),
    reason: text(500).min(10, { error: "Tulis alasan koreksi (minimal 10 karakter)." }),
  })
  .refine((v) => v.price != null || v.deliveredVolumeL != null, { error: "Isi harga atau volume yang dikoreksi.", path: ["price"] });

export const reverseTripPaymentSchema = z.object({
  tripPaymentId: uuid,
  reason: text(500).min(10, { error: "Tulis alasan pembalik (minimal 10 karakter)." }),
});
