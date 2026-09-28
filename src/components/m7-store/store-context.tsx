"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { StoreReference } from "@/client/m7-store/contract";
import { registerStoreOptimistic } from "@/client/m7-store/optimistic";
import { formatLocalNumber, nextDeviceSeq } from "@/client/offline";
import { useReference } from "@/client/offline/hooks";
import { usePos } from "@/components/m6-pos/pos-context";
import { toBusinessDate } from "@/lib/time";

registerStoreOptimistic();

export type StoreContextValue = {
  /** Data `m7.store` (undefined = belum terunduh; null = perangkat bukan POS toko). */
  store: StoreReference | null | undefined;
  /** Nomor lokal dokumen perangkat (nota, transfer) — nomor resmi terbentuk saat sinkron. */
  nextDocNumber: (scope: "purchase_receipt" | "internal_transfer", prefix: string) => Promise<{ localNumber: string; deviceSeq: number }>;
};

const StoreContext = createContext<StoreContextValue | null>(null);

export function useStore(): StoreContextValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore harus di dalam <StoreProvider>.");
  return ctx;
}

/** Data offline POS toko (M7) di atas konteks kerangka POS M6. */
export function StoreProvider({ children }: { children: ReactNode }) {
  const { session, ref } = usePos();
  const store = useReference<StoreReference | null>("m7.store", session.user.id);
  const value = useMemo<StoreContextValue>(
    () => ({
      store,
      nextDocNumber: async (scope, prefix) => {
        const seq = await nextDeviceSeq(scope);
        return {
          deviceSeq: seq,
          localNumber: formatLocalNumber({ prefix: `${ref?.outlet?.code ?? "TK"}-${prefix}`, businessDate: toBusinessDate(new Date()), deviceTag: session.device.code, seq }),
        };
      },
    }),
    [store, ref, session],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}
