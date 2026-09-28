"use client";

/**
 * Panel "Bantuan" untuk aplikasi lapangan/POS (US-M10-07 KP-3) — dipasang modul lapangan (M3 sopir, M6 POS, M8 produksi)
 * di dalam `<FieldGate>`: `import { FieldSupportPanel } from "@/components/m10-access/field-support-panel"`.
 *
 * - Laporkan kendala aplikasi (bukan kendala rit) — bekerja OFFLINE lewat antrean (`core.support.report`); versi
 *   aplikasi & status sinkron (antrean, sinkron terakhir) dilampirkan otomatis.
 * - Laporan saya dengan status Diterima → Dijawab → Selesai (data pull `m10.support_tickets`); pelapor menandai
 *   selesai (`m10.support_ticket.close`, optimistis & idempoten).
 */
import { CircleCheckBig, LifeBuoy } from "lucide-react";
import { useState } from "react";

import { APP_VERSION, enqueue, registerOptimistic, useReference, useSyncStatus } from "@/client/offline";
import { useFieldSession } from "@/components/field/field-gate";
import { Button } from "@/components/ui/button";
import { label } from "@/lib/labels";

export type FieldTicket = {
  id: string;
  subject: string;
  category: "app_issue" | "feedback";
  status: "received" | "answered" | "done";
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
  dueAt: string | null;
};

// Laporan yang ditandai selesai di ponsel langsung tampil "Selesai" walau perintahnya belum terkirim.
registerOptimistic<FieldTicket[], { ticketId: string }>("m10.support_ticket.close", {
  refKey: "m10.support_tickets",
  apply: (data, payload) => data.map((t) => (t.id === payload.ticketId ? { ...t, status: "done" } : t)),
});

export function FieldSupportPanel() {
  const { user } = useFieldSession();
  const tickets = useReference<FieldTicket[]>("m10.support_tickets", user.id) ?? [];
  const sync = useSyncStatus(user.id);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      await enqueue({
        type: "core.support.report",
        label: `Laporan kendala: ${subject}`,
        payload: {
          category: "app_issue",
          subject,
          description,
          appVersion: APP_VERSION,
          syncStatus: { pending: sync.pendingCount, lastSyncAt: sync.lastSyncAt, online: sync.online, lastError: sync.lastError },
        },
      });
      setSubject("");
      setDescription("");
      setMessage("Laporan tersimpan di ponsel dan terkirim otomatis saat ada sinyal.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Laporan gagal disimpan. Coba lagi.");
    } finally {
      setBusy(false);
    }
  }

  async function close(ticketId: string) {
    try {
      await enqueue({ type: "m10.support_ticket.close", payload: { ticketId }, label: "Laporan kendala selesai" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menandai selesai.");
    }
  }

  return (
    <section className="grid gap-4" aria-labelledby="bantuan-lapangan">
      <h2 id="bantuan-lapangan" className="flex items-center gap-2 text-xl font-semibold">
        <LifeBuoy className="size-6" aria-hidden /> Bantuan
      </h2>
      <form onSubmit={submit} className="grid gap-3 rounded-lg border p-4">
        <p className="text-base text-muted-foreground">Laporkan kendala aplikasi (bukan kendala rit). Versi {APP_VERSION} & status sinkron ikut terkirim.</p>
        <label className="grid gap-1 text-base" htmlFor="bantuan-judul">
          Judul
          <input id="bantuan-judul" className="h-12 rounded-md border px-3 text-lg" value={subject} onChange={(e) => setSubject(e.target.value)} minLength={5} required />
        </label>
        <label className="grid gap-1 text-base" htmlFor="bantuan-uraian">
          Ceritakan kendalanya
          <textarea id="bantuan-uraian" className="min-h-28 rounded-md border px-3 py-2 text-lg" value={description} onChange={(e) => setDescription(e.target.value)} minLength={10} required />
        </label>
        {error ? <p role="alert" className="text-base text-destructive">{error}</p> : null}
        {message ? <p role="status" className="text-base text-success">{message}</p> : null}
        <Button type="submit" size="lg" disabled={busy} className="h-14 text-lg">
          Kirim laporan
        </Button>
      </form>
      <div className="grid gap-2">
        <h3 className="text-lg font-semibold">Laporan saya</h3>
        {tickets.length === 0 ? <p className="text-base text-muted-foreground">Belum ada laporan.</p> : null}
        {tickets.map((t) => (
          <div key={t.id} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-lg font-medium">{t.subject}</span>
              <span className="rounded-full border px-3 py-1 text-base">{label("ticket_status", t.status)}</span>
            </div>
            {t.answer ? <p className="mt-2 rounded bg-muted p-2 text-base">Jawaban: {t.answer}</p> : null}
            {t.status === "answered" ? (
              <Button type="button" variant="outline" className="mt-2 h-12 text-base" onClick={() => void close(t.id)}>
                <CircleCheckBig aria-hidden /> Sudah beres — tandai selesai
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
