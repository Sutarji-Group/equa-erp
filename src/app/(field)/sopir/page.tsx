"use client";

import { SopirApp } from "@/components/m3-driver/sopir-app";

/**
 * Aplikasi Sopir/Kernet (M3, PRD 7.3): rit hari ini, Berangkat/Tiba/Selesai + pembayaran, pelunasan, gagal & kendala,
 * keterangan perjalanan, pengeluaran, kas di tangan & Setor — offline-first (outbox sinkron).
 */
export default function SopirPage() {
  return <SopirApp />;
}
