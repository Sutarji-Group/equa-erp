"use client";

import { M4_MY_CASH_KEY, type MyCashReference } from "@/client/m4-cash/contract";
import { useReference } from "@/client/offline";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal } from "@/lib/time";

/**
 * Kartu "Setoran & ganti rugi saya" untuk aplikasi lapangan (sopir/kernet, operator depot, kasir toko): hasil penerimaan
 * setoran oleh Admin Keuangan beserta selisih & keputusan pemilik (US-M4-02 KP-8) dan saldo ganti rugi karyawan
 * bersangkutan (US-M4-03 KP-3). Data dari pull `m4.my_cash` (tersimpan di perangkat, tampil walau offline).
 *
 * Pemasangan (modul pemilik aplikasi — M3 /sopir, M6/M7 /pos): `<MyCashCard userId={session.user.id} />` di layar riwayat
 * setoran/bantuan. Tidak menampilkan apa pun bila belum ada data.
 */
export function MyCashCard({ userId, limit = 5 }: { userId: string | null | undefined; limit?: number }) {
  const data = useReference<MyCashReference>(M4_MY_CASH_KEY, userId);
  if (!data) return null;
  const recent = data.deposits.filter((d) => d.status === "received" || d.status === "closed").slice(0, limit);
  const r = data.restitution;
  if (!recent.length && !r.recorded) return null;
  return (
    <section className="grid gap-3 rounded-lg border bg-card p-4 text-base" aria-label="Setoran dan ganti rugi saya" data-testid="kas-saya">
      <h2 className="text-lg font-semibold">Setoran & ganti rugi saya</h2>
      {recent.length ? (
        <ul className="grid gap-2">
          {recent.map((d) => (
            <li key={d.id} className="rounded-md bg-muted/50 p-3">
              <div className="flex justify-between gap-2">
                <span className="font-medium">
                  {d.number} · {formatTanggal(d.businessDate, { weekday: false })}
                </span>
                <span>{label("deposit_status", d.status)}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span>Diterima Admin Keuangan</span>
                <span className="font-medium">{formatRupiah(d.receivedAmount ?? 0)}</span>
              </div>
              {d.discrepancyAmount ? (
                <div className="flex justify-between gap-2">
                  <span>Selisih{d.discrepancyReason ? ` (${label("discrepancy_reason", d.discrepancyReason)})` : ""}</span>
                  <span className={d.discrepancyAmount < 0 ? "font-semibold text-destructive" : "font-semibold"}>{formatRupiah(d.discrepancyAmount, { signed: true })}</span>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">Tanpa selisih</div>
              )}
              {d.decision ? (
                <div className="text-sm">
                  Keputusan pemilik: {label("discrepancy_decision", d.decision)}
                  {d.decisionReason ? ` — ${d.decisionReason}` : ""}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {r.recorded ? (
        <div className="grid gap-1 rounded-md border p-3">
          <div className="flex justify-between gap-2">
            <span className="font-medium">Sisa ganti rugi</span>
            <span className={r.outstanding ? "font-semibold text-destructive" : "font-semibold"}>{formatRupiah(r.outstanding)}</span>
          </div>
          <div className="text-sm text-muted-foreground">
            Tercatat {formatRupiah(r.recorded)} · dilunasi {formatRupiah(r.settled)}. Pelunasan dicatat Admin Keuangan (setor tunai atau potongan penggajian).
          </div>
        </div>
      ) : null}
    </section>
  );
}
