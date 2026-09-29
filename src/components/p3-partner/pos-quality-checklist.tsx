"use client";

import { ClipboardCheck } from "lucide-react";
import { useState } from "react";

import { enqueue } from "@/client/offline";
import { useReference } from "@/client/offline/hooks";
import { BigButton } from "@/components/field/big-button";
import { useFieldSession } from "@/components/field/field-gate";
import { PhotoCapture } from "@/components/field/photo-capture";
import { newId } from "@/lib/ids";
import { cn } from "@/lib/utils";

import { buildChecklistCommand, type ChecklistItemState as ItemState } from "./checklist-command";

/** Data pull `p3.partner_pos` (src/server/modules/p3-partner/sync.ts). */
export type PartnerPosReference = {
  date: string;
  readOnly: boolean;
  phase3: boolean;
  supplySuspended: boolean;
  checklist: { filled: boolean; passedAll: boolean | null; items: { key: string; label: string; photoRequired: boolean }[] } | null;
} | null;

/**
 * Daftar periksa mutu harian outlet mitra di POS saat buka shift (Tahap 3 US-P3-05 KP-1, S) + penanda status tenant
 * mitra (mode baca-saja US-P3-02 KP-4, penghentian pasokan US-P3-07). Offline: dicatat ke antrean perangkat lalu
 * dikirim sinkron (idempoten per perintah; outlet-hari yang sudah terisi → konflik). Tidak tampil untuk outlet EQUA
 * atau bila portal Tahap 3 mati. Dipasang M6 di aplikasi POS (menu Shift) — lihat docs/dev/modules/p3-partner.md.
 */
export function PosQualityChecklist({ shiftId, className }: { shiftId?: string | null; className?: string }) {
  const session = useFieldSession();
  const ref = useReference<PartnerPosReference>("p3.partner_pos", session.user.id);
  const [state, setState] = useState<Record<string, ItemState>>({});
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!ref) return null;

  const banners = (
    <>
      {ref.readOnly ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-base text-destructive">
          Mode baca-saja: shift baru tidak dapat dibuka karena tunggakan tagihan EQUA. Hubungi pemilik mitra.
        </p>
      ) : null}
      {ref.supplySuspended ? (
        <p role="status" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-base">
          Pasokan air dari EQUA sedang dihentikan sementara. Lihat syaratnya di portal mitra.
        </p>
      ) : null}
    </>
  );
  const list = ref.checklist;
  if (!ref.phase3 || !list) return ref.readOnly || ref.supplySuspended ? <div className={cn("grid gap-2", className)}>{banners}</div> : null;
  if (list.filled || sent) {
    return (
      <div className={cn("grid gap-2", className)} data-testid="daftar-periksa-mutu">
        {banners}
        <p role="status" className="flex items-center gap-2 rounded-md border border-success/40 bg-success/10 p-3 text-base">
          <ClipboardCheck aria-hidden className="size-5" /> Daftar periksa mutu hari ini sudah {sent && !list.filled ? "dicatat (menunggu terkirim)" : "diisi"}.
        </p>
      </div>
    );
  }

  const EMPTY: ItemState = { result: null, actionNote: "", photo: null };
  const set = (key: string, patch: Partial<ItemState>) => setState((s) => ({ ...s, [key]: { ...EMPTY, ...s[key], ...patch } }));

  async function submit() {
    setError(null);
    const built = buildChecklistCommand(list!.items, state, { checklistId: newId(), shiftId });
    if ("error" in built) return setError(built.error);
    setBusy(true);
    try {
      await enqueue({ type: "p3.quality_checklist.submit", payload: built.payload, label: "Daftar periksa mutu harian" }, built.attachments);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Daftar periksa gagal dicatat. Coba lagi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={cn("grid gap-3 rounded-lg border p-4", className)} data-testid="daftar-periksa-mutu" aria-label="Daftar periksa mutu harian">
      {banners}
      <h2 className="text-lg font-semibold">Daftar periksa mutu harian</h2>
      <p className="text-base text-muted-foreground">Isi sebelum melayani pembeli. Butir bertanda kamera wajib foto.</p>
      <ol className="grid gap-3">
        {list.items.map((it) => {
          const s = state[it.key];
          return (
            <li key={it.key} className="grid gap-2 rounded-md border p-3">
              <p className="text-base font-medium">
                {it.label} {it.photoRequired ? <span aria-label="wajib foto">📷</span> : null}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <BigButton variant={s?.result === "pass" ? "success" : "outline"} onClick={() => set(it.key, { result: "pass" })} aria-pressed={s?.result === "pass"}>
                  Lulus
                </BigButton>
                <BigButton variant={s?.result === "fail" ? "danger" : "outline"} onClick={() => set(it.key, { result: "fail" })} aria-pressed={s?.result === "fail"}>
                  Tidak lulus
                </BigButton>
              </div>
              {s?.result === "fail" ? (
                <label className="grid gap-1 text-base">
                  Tindakan yang dilakukan
                  <textarea value={s.actionNote} onChange={(e) => set(it.key, { actionNote: e.target.value })} rows={2} className="rounded-md border border-input bg-background px-3 py-2 text-base" />
                </label>
              ) : null}
              {it.photoRequired ? <PhotoCapture label={`Foto ${it.label}`} onCapture={(photo) => set(it.key, { photo })} onClear={() => set(it.key, { photo: null })} /> : null}
            </li>
          );
        })}
      </ol>
      {error ? (
        <p role="alert" className="text-base text-destructive">
          {error}
        </p>
      ) : null}
      <BigButton variant="primary" loading={busy} onClick={() => void submit()} icon={<ClipboardCheck aria-hidden />}>
        Simpan daftar periksa
      </BigButton>
    </section>
  );
}
