/**
 * M2 — registrasi jejak audit milik modul ini (label objek & kolom, objek keuangan). Setiap transisi status pesanan
 * berjejak (US-M2-02 KP-2), penetapan pengemudi berjejak (US-M2-11 KP-5), perubahan jadwal setelah terbit tercatat
 * (US-M2-03 KP-5). M2 tidak menyimpan lampiran sendiri (foto rit gagal milik M3).
 */
import "server-only";

import { registerAuditFieldLabel, registerAuditObjectLabel } from "@/server/core/audit";

export function registerAudit(): void {
  registerAuditObjectLabel("order", "pesanan");
  registerAuditObjectLabel("trip", "rit");
  registerAuditObjectLabel("trip_incident", "kejadian rit");
  registerAuditObjectLabel("daily_schedule", "jadwal harian truk");
  registerAuditObjectLabel("crew_assignment", "penetapan pengemudi harian");
  registerAuditObjectLabel("crew_roster", "jadwal kru");
  registerAuditObjectLabel("truck_day_status", "status truk harian");
  registerAuditObjectLabel("recurring_order", "pesanan berulang");
  registerAuditObjectLabel("recurring_order_failure", "pesanan langganan gagal dibuat");
  registerAuditObjectLabel("wa_template", "template WhatsApp");

  registerAuditFieldLabel("order", "status", { label: "status", format: "enum:order_status" });
  registerAuditFieldLabel("order", "paymentMethod", { label: "cara bayar", format: "enum:payment_method" });
  registerAuditFieldLabel("order", "requestedDate", { label: "tanggal diminta", format: "date" });
  registerAuditFieldLabel("order", "requestedTime", { label: "jam diminta" });
  registerAuditFieldLabel("order", "pricePerTrip", { label: "harga per rit", format: "rupiah" });
  registerAuditFieldLabel("order", "totalAmount", { label: "total", format: "rupiah" });
  registerAuditFieldLabel("order", "notes", { label: "catatan" });
  registerAuditFieldLabel("order", "possibleDuplicate", { label: "kemungkinan dobel", format: "boolean" });
  registerAuditFieldLabel("order", "priceIsProvisional", { label: "harga sementara", format: "boolean" });
  registerAuditFieldLabel("trip", "truckId", { label: "truk" });
  registerAuditFieldLabel("trip", "routeOrder", { label: "urutan" });
  registerAuditFieldLabel("trip", "scheduledDate", { label: "tanggal jadwal", format: "date" });
  registerAuditFieldLabel("recurring_order", "status", { label: "status", format: "enum:recurring_status" });
  registerAuditFieldLabel("truck_day_status", "status", { label: "status truk", format: "enum:truck_day_status" });
  // Pesanan & rit adalah objek operasional (bukan objek keuangan US-M10-06 KP-1): harga terkunci dicatat, tetapi
  // dampak keuangannya (faktur, pembayaran, jurnal) dicatat modul M3/M5/M11 pada objek keuangan masing-masing.
}
