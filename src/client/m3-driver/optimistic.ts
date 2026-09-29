/**
 * M3 — pembaruan OPTIMISTIS data `m3.today` / `m3.deposits` di ponsel (hanya peramban untuk pendaftaran; reducer
 * murni `applyM3Command` dapat diuji tanpa IndexedDB). Perintah sopir yang masih di antrean diterapkan ulang di atas
 * hasil pull terakhir sehingga layar selalu menampilkan keadaan terbaru walau tanpa sinyal (US-M3-09 KP-1/KP-2):
 * rit Berangkat/Tiba/Selesai/Gagal, kas di tangan (pembayaran, pelunasan, pengeluaran), setoran Diajukan, tugas
 * keterangan yang sudah diisi, status struk.
 */
import { registerOptimistic, type OutboxItem } from "@/client/offline";

import {
  allocateOldestFirst,
  M3_COMMANDS,
  M3_REFS,
  type CollectionPayload,
  type CompletePayload,
  type DepartPayload,
  type DepositNotePayload,
  type DepositSubmitPayload,
  type ExpensePayload,
  type ExplanationPayload,
  type FailPayload,
  type FieldCreditPayload,
  type M3DepositHistory,
  type M3PaymentRef,
  type M3Today,
  type M3TripRef,
  type ReceiptPayload,
} from "./contract";

type ItemMeta = Pick<OutboxItem, "userId" | "deviceTime" | "businessDate" | "id">;

function withTrip(data: M3Today, tripId: string, fn: (t: M3TripRef) => M3TripRef): M3Today {
  return { ...data, trips: data.trips.map((t) => (t.id === tripId ? { ...fn(t), local: true } : t)) };
}

/** Pembayaran yang akan dicatat server untuk perintah Selesai (cermin `resolvePayment`, tanpa validasi). */
export function paymentFromComplete(trip: M3TripRef, p: CompletePayload, recordedAt: string): M3PaymentRef | null {
  if (trip.isInternal || p.payment.method === "none") return null;
  const base = { id: null, tripId: trip.id, tripNumber: trip.number, customerId: trip.customerId, customerName: trip.customerName, expectedAmount: trip.price, recordedAt, local: true } as const;
  if (p.payment.method === "cash") {
    const received = Math.min(trip.price, p.payment.cashReceived);
    return { ...base, method: "cash", receivedAmount: received, underpaymentAmount: trip.price - received, originalMethod: trip.paymentMethod !== "cash" ? trip.paymentMethod : null };
  }
  if (p.payment.method === "transfer") {
    const received = Math.min(trip.price, p.payment.transferAmount);
    return { ...base, method: "transfer", receivedAmount: received, underpaymentAmount: trip.price - received, originalMethod: trip.paymentMethod !== "transfer" ? trip.paymentMethod : null };
  }
  // B-65: dibayar di muka (aplikasi pelanggan) — tidak ada uang diterima sopir; server menghitung uang muka yang diakui.
  if (p.payment.method === "prepaid") return { ...base, method: "digital", receivedAmount: trip.price, underpaymentAmount: 0, originalMethod: null };
  const approved = trip.paymentMethod === "credit" || trip.creditRequest?.status === "approved";
  if (approved) return { ...base, method: "credit", receivedAmount: 0, underpaymentAmount: 0, originalMethod: trip.paymentMethod === "credit" ? null : trip.paymentMethod };
  const received = Math.min(trip.price, p.payment.cashReceivedIfRejected ?? 0);
  return { ...base, method: "cash", receivedAmount: received, underpaymentAmount: trip.price - received, originalMethod: null };
}

/** Terapkan satu perintah M3 ke `m3.today` (murni). Perintah yang tidak dikenal dikembalikan apa adanya. */
export function applyM3Command(data: M3Today, type: string, payload: unknown, item: ItemMeta): M3Today {
  switch (type) {
    case M3_COMMANDS.depart: {
      const p = payload as DepartPayload;
      return withTrip(data, p.tripId, (t) => (t.status === "assigned" ? { ...t, status: "departed", departedAt: item.deviceTime, driverUserId: item.userId, noLocation: !p.location } : t));
    }
    case M3_COMMANDS.arrive: {
      const p = payload as DepartPayload;
      return withTrip(data, p.tripId, (t) => (t.status === "departed" ? { ...t, status: "arrived", arrivedAt: item.deviceTime } : t));
    }
    case M3_COMMANDS.complete: {
      const p = payload as CompletePayload;
      const trip = data.trips.find((t) => t.id === p.tripId);
      if (!trip || trip.status === "completed" || trip.status === "failed") return data;
      const pay = paymentFromComplete(trip, p, item.deviceTime);
      const next = withTrip(data, p.tripId, (t) => ({ ...t, status: "completed", completedAt: item.deviceTime, deliveredVolumeL: p.deliveredVolumeL, recipientName: p.recipientName, driverUserId: t.driverUserId ?? item.userId }));
      return pay ? { ...next, payments: [...next.payments.filter((x) => x.tripId !== trip.id), pay] } : next;
    }
    case M3_COMMANDS.fail: {
      const p = payload as FailPayload;
      return withTrip(data, p.tripId, (t) => (t.status === "departed" || t.status === "arrived" ? { ...t, status: "failed", failedAt: item.deviceTime, failReason: p.reason } : t));
    }
    case M3_COMMANDS.fieldCredit: {
      const p = payload as FieldCreditPayload;
      return withTrip(data, p.tripId, (t) =>
        t.creditRequest && ["submitted", "approved"].includes(t.creditRequest.status) ? t : { ...t, creditRequest: { approvalId: null, number: null, status: "queued", decisionReason: null } },
      );
    }
    case M3_COMMANDS.collection: {
      const p = payload as CollectionPayload;
      if (data.collections.some((c) => c.id === p.paymentId)) return data;
      const invoices = data.invoicesByCustomer[p.customerId] ?? [];
      const selected = invoices.filter((i) => p.invoiceIds.includes(i.id));
      const { allocations, excess } = allocateOldestFirst(selected, p.amount);
      const byId = new Map(allocations.map((a) => [a.invoiceId, a.amount]));
      const trip = data.trips.find((t) => t.id === p.tripId);
      return {
        ...data,
        invoicesByCustomer: {
          ...data.invoicesByCustomer,
          [p.customerId]: invoices.map((i) => ({ ...i, outstanding: i.outstanding - (byId.get(i.id) ?? 0) })).filter((i) => i.outstanding > 0),
        },
        collections: [
          ...data.collections,
          {
            id: p.paymentId,
            customerId: p.customerId,
            customerName: trip?.customerName ?? "",
            tripId: p.tripId,
            method: p.method,
            amount: p.amount,
            allocations: allocations.map((a) => ({ ...a, invoiceNumber: invoices.find((i) => i.id === a.invoiceId)?.number ?? null })),
            advanceAmount: excess,
            recordedAt: item.deviceTime,
            local: true,
          },
        ],
      };
    }
    case M3_COMMANDS.expense: {
      const p = payload as ExpensePayload;
      if (data.expenses.some((e) => e.id === p.expenseId)) return data;
      return {
        ...data,
        expenses: [...data.expenses, { id: p.expenseId, tripId: p.tripId ?? null, kind: p.kind, amount: p.amount, fundingSource: p.fundingSource, status: "pending_verification", recordedAt: item.deviceTime, local: true }],
      };
    }
    case M3_COMMANDS.depositSubmit: {
      const p = payload as DepositSubmitPayload;
      if (data.deposit && data.deposit.status !== "running") return data;
      return {
        ...data,
        deposit: {
          id: data.deposit?.id ?? null,
          number: data.deposit?.number ?? null,
          status: "submitted",
          businessDate: item.businessDate,
          submittedAt: item.deviceTime,
          submittedLate: false,
          method: p.method,
          expectedCash: data.deposit?.expectedCash ?? 0,
          expectedNet: p.deviceExpectedNet ?? data.deposit?.expectedNet ?? 0,
          reopenReason: null,
          local: true,
        },
      };
    }
    case M3_COMMANDS.explanation: {
      const p = payload as ExplanationPayload;
      return { ...data, explanationTasks: data.explanationTasks.filter((x) => x.fleetEventId !== p.fleetEventId) };
    }
    case M3_COMMANDS.receipt: {
      const p = payload as ReceiptPayload;
      if (p.kind !== "trip_receipt" || !p.tripId) return data;
      return withTrip(data, p.tripId, (t) => ({ ...t, receiptStatus: p.action === "opened" ? "sent" : "skipped" }));
    }
    default:
      return data;
  }
}

/** Terapkan keterangan sopir atas selisih ke riwayat setoran (murni). */
export function applyDepositNote(data: M3DepositHistory, payload: DepositNotePayload): M3DepositHistory {
  return { ...data, rows: data.rows.map((r) => (r.id === payload.depositId ? { ...r, depositorNote: payload.note, local: true } : r)) };
}

let registered = false;

/** Daftarkan reducer optimistis M3 (sekali per halaman). */
export function registerM3Optimistic(): void {
  if (registered) return;
  registered = true;
  for (const type of [
    M3_COMMANDS.depart,
    M3_COMMANDS.arrive,
    M3_COMMANDS.complete,
    M3_COMMANDS.fail,
    M3_COMMANDS.fieldCredit,
    M3_COMMANDS.collection,
    M3_COMMANDS.expense,
    M3_COMMANDS.depositSubmit,
    M3_COMMANDS.explanation,
    M3_COMMANDS.receipt,
  ]) {
    registerOptimistic<M3Today | null, unknown>(type, {
      refKey: M3_REFS.today,
      apply: (data, payload, item) => (data ? applyM3Command(data, type, payload, item) : data),
    });
  }
  registerOptimistic<M3DepositHistory | null, DepositNotePayload>(M3_COMMANDS.depositNote, {
    refKey: M3_REFS.deposits,
    apply: (data, payload) => (data ? applyDepositNote(data, payload) : data),
  });
}
