"use client";

/**
 * Menu "Bantuan" aplikasi POS depot & toko (B-03, B-28; US-M10-07 KP-3, US-M4-03 KP-3): laporan kendala aplikasi
 * (bekerja offline lewat antrean, `<FieldSupportPanel />` M10) dan status sinkron + tombol kirim sekarang. Hasil
 * setoran & saldo ganti rugi (`<MyCashCard />` M4) serta daftar antrean data lengkap ada di menu Riwayat.
 */
import { RefreshCw } from "lucide-react";

import { BigButton } from "@/components/field/big-button";
import { FieldSupportPanel } from "@/components/m10-access/field-support-panel";
import { formatJam } from "@/lib/time";

import { usePos } from "./pos-context";
import { PosSection } from "./ui";

export function PosHelpView() {
  const { session } = usePos();
  const sync = session.sync;
  return (
    <div className="grid gap-4 lg:grid-cols-2 lg:items-start" data-testid="bantuan-pos">
      <div className="flex flex-col gap-4">
        <FieldSupportPanel />
      </div>
      <div className="flex flex-col gap-4">
        <PosSection title="Data di perangkat">
          <p className="text-base text-muted-foreground">
            {sync.pendingCount ? `${sync.pendingCount} data menunggu terkirim.` : "Semua data sudah terkirim."}
            {sync.lastSyncAt ? ` Sinkron terakhir pukul ${formatJam(new Date(sync.lastSyncAt))}.` : ""} Rincian antrean ada di menu Riwayat.
          </p>
          <BigButton variant="secondary" icon={<RefreshCw aria-hidden />} onClick={sync.syncNow} disabled={!sync.online}>
            Kirim sekarang
          </BigButton>
        </PosSection>
      </div>
    </div>
  );
}
