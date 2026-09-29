"use client";

/**
 * Konteks aplikasi sopir: data referensi offline (`m3.today`, `m3.deposits`) dengan perintah antrean yang diterapkan
 * optimistis, angka kas di tangan (dihitung sama dengan server), navigasi layar, dan pengirim perintah ke outbox.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import {
  computeDayFigures,
  M3_EXTERNAL_REFS,
  M3_REFS,
  prepaidInfo,
  type DayFigures,
  type DriverCustomerCreditPull,
  type DriverCustomerCreditRef,
  type DriverPrepaidTripsPull,
  type M3DepositHistory,
  type M3Today,
  type M3TripRef,
} from "@/client/m3-driver/contract";
import { registerM3Optimistic } from "@/client/m3-driver/optimistic";
import { enqueue, useReference, type EnqueueAttachment } from "@/client/offline";
import { useFieldSession, type FieldSession } from "@/components/field/field-gate";

registerM3Optimistic();

export type DriverView =
  | { name: "list" }
  | { name: "trip"; tripId: string }
  | { name: "complete"; tripId: string }
  | { name: "fail"; tripId: string }
  | { name: "incident"; tripId: string | null }
  | { name: "collect"; tripId: string }
  | { name: "receipt"; tripId: string }
  | { name: "setor" }
  | { name: "expense"; tripId: string | null }
  | { name: "tasks" }
  | { name: "history" }
  | { name: "help" };

export type DriverContextValue = {
  session: FieldSession;
  today: M3Today | null | undefined;
  history: M3DepositHistory | undefined;
  /** Angka hari ini pengguna ini (kas di tangan, ringkasan setor). */
  figures: DayFigures | null;
  /** Rit yang dikerjakan pengguna ini (untuk manifest Setor). */
  myTrips: M3TripRef[];
  canAct: boolean;
  depositSubmitted: boolean;
  view: DriverView;
  go: (view: DriverView) => void;
  /** Catat perintah ke antrean ponsel (≤ 1 detik, tanpa jaringan). */
  send: (type: string, payload: unknown, label: string, attachments?: EnqueueAttachment[]) => Promise<string>;
  trip: (id: string) => M3TripRef | undefined;
  /** B-33 (US-M5-01 KP-3): status kredit, saldo & eksposur pelanggan rit hari ini (pull `m5.customer_credit`). */
  customerCredit: (customerId: string) => DriverCustomerCreditRef | null;
  /** Waktu data kredit disiapkan server (untuk label "data sinkron"). */
  creditGeneratedAt: string | null;
  /** B-65 (US-P2-04 KP-4): rit sudah dibayar di muka lewat aplikasi pelanggan (pull `p2.prepaid_trips` / cara bayar digital). */
  prepaid: (trip: M3TripRef) => { paidAmount: number | null; paidAt: string | null } | null;
};

const DriverContext = createContext<DriverContextValue | null>(null);

export function useDriver(): DriverContextValue {
  const ctx = useContext(DriverContext);
  if (!ctx) throw new Error("useDriver harus di dalam <DriverProvider>.");
  return ctx;
}

export function DriverProvider({ children }: { children: ReactNode }) {
  const session = useFieldSession();
  const today = useReference<M3Today | null>(M3_REFS.today, session.user.id);
  const history = useReference<M3DepositHistory>(M3_REFS.deposits, session.user.id);
  const credit = useReference<DriverCustomerCreditPull | null>(M3_EXTERNAL_REFS.customerCredit, session.user.id);
  const prepaidTrips = useReference<DriverPrepaidTripsPull | null>(M3_EXTERNAL_REFS.prepaidTrips, session.user.id);
  const [view, setView] = useState<DriverView>({ name: "list" });

  const value = useMemo<DriverContextValue>(() => {
    const myTrips = (today?.trips ?? []).filter((t) => t.driverUserId === session.user.id);
    const figures = today ? computeDayFigures({ trips: myTrips, payments: today.payments, collections: today.collections, expenses: today.expenses }) : null;
    return {
      session,
      today,
      history,
      figures,
      myTrips,
      canAct: !!today && today.actingRole !== "readonly",
      depositSubmitted: !!today?.deposit && today.deposit.status !== "running",
      view,
      go: (v) => {
        setView(v);
        if (typeof window !== "undefined") window.scrollTo({ top: 0 });
      },
      send: async (type, payload, label, attachments = []) => (await enqueue({ type, payload, label }, attachments)).id,
      trip: (id) => today?.trips.find((t) => t.id === id),
      customerCredit: (customerId) => credit?.customers.find((c) => c.customerId === customerId) ?? null,
      creditGeneratedAt: credit?.generatedAt ?? null,
      prepaid: (t) => prepaidInfo(t, prepaidTrips),
    };
  }, [session, today, history, view, credit, prepaidTrips]);

  return <DriverContext.Provider value={value}>{children}</DriverContext.Provider>;
}
