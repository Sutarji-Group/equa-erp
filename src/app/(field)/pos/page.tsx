"use client";

import { PosEntry } from "@/components/m7-store/pos-entry";

/**
 * POS depot & toko (satu aplikasi, PRD 7.6/7.7): mode dipilih dari jenis outlet perangkat — depot memakai layar M6,
 * toko memakai layar M7 (harga mitra/umum, tempo mitra, diskon, terima barang, opname, pesan ulang, transfer, usulan)
 * di atas kerangka POS yang sama (shift, void, setoran, sinkron offline).
 */
export default function PosPage() {
  return <PosEntry />;
}
