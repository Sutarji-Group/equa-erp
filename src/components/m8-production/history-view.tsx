"use client";

/**
 * Riwayat operator produksi: pengisian hari ini dengan status kirim per data (tersimpan di ponsel / terkirim, NFR-08),
 * ringkasan harian beberapa hari terakhir (produksi, pengisian, susut), dan hasil uji mutu terakhir. Data pengguna lain
 * di antrean ponsel tidak ditampilkan.
 */
import { formatLiter, formatPct, itemSyncText, wibClock } from "@/client/m8-production/contract";
import { label } from "@/lib/labels";
import { formatTanggal } from "@/lib/time";
import { cn } from "@/lib/utils";

import { useProduction } from "./production-context";
import { Pill, Section } from "./ui";

export function HistoryView() {
  const { today } = useProduction();
  if (!today) return null;
  return (
    <div className="flex flex-col gap-4">
      <Section title="Pengisian hari ini" testId="riwayat-isi">
        {today.fills.length === 0 ? (
          <p className="text-base text-muted-foreground">Belum ada pengisian hari ini.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Pengisian hari ini">
            {today.fills.map((f) => (
              <li key={f.id} className={cn("flex flex-col gap-1 rounded-xl border-2 p-3", f.reversed && "opacity-60")} data-testid="baris-isi">
                <p className="flex items-center justify-between gap-2 text-lg font-semibold">
                  <span>
                    {f.truckCode} · {formatLiter(f.volumeL)}
                  </span>
                  <span className="text-base font-normal text-muted-foreground">{wibClock(f.filledAt)}</span>
                </p>
                <p className="text-base">{f.tripNumber ? `Rit ${f.tripNumber}` : "Tanpa rit"}</p>
                <p className="flex flex-wrap gap-2">
                  <Pill tone={f.local ? "warning" : "success"}>{itemSyncText(f.local)}</Pill>
                  {!f.tripId ? <Pill tone="warning">Tanpa rit</Pill> : null}
                  {f.isDepotSupply ? <Pill tone="info">Pasokan depot</Pill> : null}
                  {f.unplannedTruck ? <Pill tone="warning">Di luar rencana</Pill> : null}
                  {f.reversed ? <Pill tone="danger">Dibalik Admin Keuangan</Pill> : null}
                </p>
                {f.volumeReason ? <p className="text-base text-muted-foreground">Alasan volume: {f.volumeReason}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Beberapa hari terakhir" testId="riwayat-harian">
        {today.history.length === 0 ? (
          <p className="text-base text-muted-foreground">Belum ada riwayat.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Riwayat harian">
            {today.history.map((h) => (
              <li key={h.businessDate} className="flex flex-col gap-1 rounded-xl border-2 p-3">
                <p className="text-lg font-semibold">{formatTanggal(h.businessDate)}</p>
                <p className="text-base">
                  Produksi {formatLiter(h.producedL)}
                  {h.productionStatus ? ` (${label("production_status", h.productionStatus).toLowerCase()})` : ""} · isi {h.fillCount}× {formatLiter(h.fillsL)}
                </p>
                <p className="text-base">Susut {formatPct(h.lossPct)}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {today.quality.recent.length ? (
        <Section title="Uji mutu terakhir">
          <ul className="flex flex-col gap-2">
            {today.quality.recent.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border-2 p-3 text-base">
                <span>
                  {formatTanggal(q.testDate)} · {q.laboratory ?? "—"}
                </span>
                <span className="flex gap-2">
                  <Pill tone={q.passed ? "success" : "danger"}>{q.passed ? "Lulus" : "Tidak lulus"}</Pill>
                  {q.local ? <Pill tone="warning">{itemSyncText(true)}</Pill> : null}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}
