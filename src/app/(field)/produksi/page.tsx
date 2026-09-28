"use client";

import { ProduksiApp } from "@/components/m8-production/produksi-app";

/**
 * Aplikasi Operator Produksi (M8, PRD 7.8): angka meter pagi/malam + foto, pengisian truk per rit, level tandon,
 * investigasi susut, hasil uji mutu — offline-first (outbox sinkron), data referensi `m8.today` diunduh saat login.
 */
export default function ProduksiPage() {
  return <ProduksiApp />;
}
