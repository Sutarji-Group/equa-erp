"use client";

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";

import {
  deviceShiftFigures,
  gridProducts,
  type CatalogRef,
  type DeviceShiftFigures,
  type PosReference,
  type PosShiftRef,
} from "@/client/m6-pos/contract";
import { registerPosOptimistic, setPosGallonSizes } from "@/client/m6-pos/optimistic";
import { enqueue, nextDeviceSeq, formatLocalNumber, type EnqueueAttachment } from "@/client/offline";
import { useReference } from "@/client/offline/hooks";
import { useFieldSession, type FieldSession } from "@/components/field/field-gate";
import { toBusinessDate } from "@/lib/time";

registerPosOptimistic();

export type PosGridProduct = ReturnType<typeof gridProducts>[number];

export type PosContextValue = {
  session: FieldSession;
  ref: PosReference | null | undefined;
  catalog: CatalogRef | undefined;
  grid: PosGridProduct[];
  shift: PosShiftRef | null;
  figures: DeviceShiftFigures | null;
  /** Tanggal bisnis perangkat sekarang. */
  today: string;
  productName: (id: string) => string;
  /** Catat perintah POS ke antrean perangkat (≤ 1 detik, tanpa jaringan). */
  send: (type: string, payload: unknown, label: string, attachments?: EnqueueAttachment[]) => Promise<string>;
  /** Nomor lokal transaksi berikutnya di perangkat. */
  nextLocalNumber: () => Promise<{ localNumber: string; deviceSeq: number }>;
};

const PosContext = createContext<PosContextValue | null>(null);

function subscribeMinute(callback: () => void): () => void {
  const timer = setInterval(callback, 60_000);
  return () => clearInterval(timer);
}

/** Tanggal bisnis WIB perangkat (diperbarui tiap menit). */
export function useBusinessDate(): string {
  return useSyncExternalStore(
    subscribeMinute,
    () => toBusinessDate(new Date()),
    () => "",
  );
}

export function usePos(): PosContextValue {
  const ctx = useContext(PosContext);
  if (!ctx) throw new Error("usePos harus di dalam <PosProvider>.");
  return ctx;
}

export function PosProvider({ children }: { children: ReactNode }) {
  const session = useFieldSession();
  const ref = useReference<PosReference | null>("m6.pos", session.user.id);
  const catalog = useReference<CatalogRef>("m1.catalog", session.user.id);
  const today = useBusinessDate();

  useEffect(() => {
    if (catalog) setPosGallonSizes(catalog.products.map((p) => [p.id, p.gallonSizeL]));
  }, [catalog]);

  const value = useMemo<PosContextValue>(() => {
    const shift = ref?.openShift ?? null;
    const priceKind = ref?.outlet?.kind === "store" ? "general" : "standard";
    const names = new Map((catalog?.products ?? []).map((p) => [p.id, p.name]));
    for (const m of ref?.materials ?? []) names.set(m.id, m.name);
    return {
      session,
      ref,
      catalog,
      grid: gridProducts(catalog, priceKind, ref?.settings.gridMax ?? 12),
      shift,
      figures: shift && ref ? deviceShiftFigures(shift, ref.recipes) : null,
      today,
      productName: (id) => names.get(id) ?? "Produk",
      send: async (type, payload, label, attachments = []) => (await enqueue({ type, payload, label }, attachments)).id,
      nextLocalNumber: async () => {
        const seq = await nextDeviceSeq("pos_sale");
        return {
          deviceSeq: seq,
          localNumber: formatLocalNumber({ prefix: ref?.outlet?.code ?? "POS", businessDate: toBusinessDate(new Date()), deviceTag: session.device.code, seq }),
        };
      },
    };
  }, [session, ref, catalog, today]);

  return <PosContext.Provider value={value}>{children}</PosContext.Provider>;
}
