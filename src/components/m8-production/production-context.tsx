"use client";

/**
 * Konteks aplikasi operator produksi: data referensi offline `m8.today` (diunduh saat login, diperbarui di latar) dengan
 * perintah antrean yang diterapkan optimistis, navigasi layar, dan pengirim perintah ke outbox (US-M8-07).
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import { M8_REFS, type M8Today, type MeterPhase } from "@/client/m8-production/contract";
import { registerM8Optimistic } from "@/client/m8-production/optimistic";
import { enqueue, useReference, type EnqueueAttachment } from "@/client/offline";
import { useFieldSession, type FieldSession } from "@/components/field/field-gate";

registerM8Optimistic();

export type ProductionView =
  | { name: "today" }
  | { name: "meter"; meterId?: string; phase?: MeterPhase }
  | { name: "fill"; truckId?: string }
  | { name: "tank" }
  | { name: "investigation"; waterBalanceId: string }
  | { name: "quality"; scheduleId?: string | null }
  | { name: "history" }
  | { name: "help" };

export type ProductionContextValue = {
  session: FieldSession;
  today: M8Today | undefined;
  view: ProductionView;
  /** Bertambah setiap pindah layar (formulir dimulai ulang walau jenis layarnya sama). */
  viewKey: number;
  go: (view: ProductionView) => void;
  /** Catat perintah ke antrean ponsel (≤ 1 detik, tanpa jaringan). */
  send: (type: string, payload: unknown, label: string, attachments?: EnqueueAttachment[]) => Promise<string>;
  /** Aplikasi dapat dipakai (ponsel terdaftar di sumber air yang ditugaskan). */
  ready: boolean;
};

const ProductionContext = createContext<ProductionContextValue | null>(null);

export function useProduction(): ProductionContextValue {
  const ctx = useContext(ProductionContext);
  if (!ctx) throw new Error("useProduction harus di dalam <ProductionProvider>.");
  return ctx;
}

export function ProductionProvider({ children }: { children: ReactNode }) {
  const session = useFieldSession();
  const today = useReference<M8Today>(M8_REFS.today, session.user.id);
  const [nav, setNav] = useState<{ view: ProductionView; key: number }>({ view: { name: "today" }, key: 0 });

  const value = useMemo<ProductionContextValue>(
    () => ({
      session,
      today,
      view: nav.view,
      viewKey: nav.key,
      ready: !!today?.source && !today.blockedReason,
      go: (v) => {
        setNav((n) => ({ view: v, key: n.key + 1 }));
        if (typeof window !== "undefined") window.scrollTo({ top: 0 });
      },
      send: async (type, payload, label, attachments = []) => (await enqueue({ type, payload, label }, attachments)).id,
    }),
    [session, today, nav],
  );

  return <ProductionContext.Provider value={value}>{children}</ProductionContext.Provider>;
}
