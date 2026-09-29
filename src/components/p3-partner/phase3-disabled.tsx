import { Lock } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";

/** Tampilan halaman Tahap 3 saat flag `phase3.partner_portal` masih mati (bawaan, D-02). */
export function Phase3Disabled({ what }: { what: string }) {
  return (
    <EmptyState
      icon={Lock}
      title="Portal kemitraan lengkap belum diaktifkan"
      description={`${what} adalah bagian portal kemitraan Tahap 3. Pemilik mengaktifkan flag "Portal kemitraan lengkap" (Pengaturan) setelah prasyarat Bab 9.1 terpenuhi. Paket Minimum Mitra Fase 1 tetap berjalan.`}
    />
  );
}
