import type { Metadata } from "next";

import { ActionForm } from "@/components/m10-access/action-form";
import { Disclosure, FormRow, TextArea } from "@/components/m10-access/fields";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { label } from "@/lib/labels";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import { listMySupportTickets } from "@/server/core/support";
import { listSupportTickets } from "@/server/modules/m10-access";

import { answerTicketAction, closeTicketAction } from "./actions";
import { TicketForm } from "./ticket-form";

export const metadata: Metadata = { title: "Bantuan" };

const GUIDE = [
  { title: "Masuk & keamanan", body: "Masuk dengan nama pengguna dan kata sandi. Pemilik, Admin Keuangan, dan admin sistem memakai kode 6 angka dari aplikasi autentikator. Sesi berakhir otomatis setelah tidak aktif." },
  { title: "Persetujuan", body: "Permintaan yang menunggu keputusan Anda ada di menu Persetujuan; yang lewat tenggat tampil paling atas. Penolakan wajib disertai alasan. Permintaan Anda sendiri tidak dapat Anda putuskan." },
  { title: "Notifikasi", body: "Lonceng di atas menampilkan peristiwa yang perlu ditindaklanjuti. Atur cara menerimanya di Pengaturan notifikasi; notifikasi kritis tidak dapat dimatikan." },
  { title: "Koreksi data", body: "Tidak ada tombol hapus. Kesalahan diperbaiki dengan transaksi pembalik beralasan; semua perubahan tercatat di jejak audit." },
  { title: "Aplikasi lapangan", body: "Sopir, kernet, operator, dan kasir memakai aplikasi lapangan di perangkat terdaftar dengan PIN. Data tersimpan di ponsel saat tanpa sinyal dan terkirim otomatis." },
  { title: "Akun & akses", body: "Akun baru, perubahan peran, dan perluasan lingkup diajukan admin sistem dan aktif setelah disetujui pemilik. Lupa PIN/kata sandi: hubungi admin sistem (reset diberitahukan ke pemilik)." },
];

/**
 * Bantuan: panduan singkat + formulir laporan kendala (US-M10-07 KP-3, NFR-33) dengan status Diterima → Dijawab →
 * Selesai yang terlihat pelapor; kotak helpdesk tim IT (admin sistem) dengan tenggat jawaban PAR-87.
 */
export default async function BantuanPage() {
  const { ctx } = await requirePermission("m10.support_ticket.create");
  const tickets = await listMySupportTickets(ctx);
  const helpdesk = can(ctx, "m10.support_ticket.read") ? await listSupportTickets(ctx, { status: "open" }) : null;
  const canAnswer = can(ctx, "m10.support_ticket.answer");
  return (
    <>
      <PageHeader title="Bantuan" description="Panduan singkat dan laporan kendala aplikasi ke tim IT (dijawab paling lambat 1 minggu)." />
      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Panduan singkat">
          <dl className="grid gap-4 text-sm">
            {GUIDE.map((g) => (
              <div key={g.title}>
                <dt className="font-semibold">{g.title}</dt>
                <dd className="text-muted-foreground">{g.body}</dd>
              </div>
            ))}
          </dl>
        </SectionCard>
        <SectionCard title="Laporkan kendala / beri masukan" description="Versi aplikasi dicatat otomatis.">
          <TicketForm />
        </SectionCard>
      </div>
      <SectionCard title="Laporan saya" className="mt-6">
        {tickets.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada laporan.</p>
        ) : (
          <ul className="grid gap-2">
            {tickets.map((t) => (
              <li key={t.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{t.subject}</span>
                  <StatusBadge enumName="ticket_status" value={t.status} />
                </div>
                <p className="text-xs text-muted-foreground">
                  Dikirim {formatTanggalJam(t.createdAt)}
                  {t.dueAt ? ` · dijawab paling lambat ${formatTanggalJam(t.dueAt)}` : ""}
                </p>
                {t.answer ? <p className="mt-2 rounded bg-muted p-2">Jawaban: {t.answer}</p> : null}
                {t.status === "answered" ? (
                  <div className="mt-2">
                    <ActionForm action={closeTicketAction} submitLabel="Sudah beres — tandai selesai" variant="outline">
                      <input type="hidden" name="ticketId" value={t.id} />
                    </ActionForm>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {helpdesk ? (
        <SectionCard
          title="Kotak helpdesk tim IT"
          description="Laporan kendala & masukan lapangan yang belum selesai. Tenggat jawaban PAR-87; yang terlambat diberitahukan ke admin sistem."
          actions={<ExportButtons excelHref="/api/export/m10.support_tickets?format=xlsx" pdfHref="/api/export/m10.support_tickets?format=pdf" />}
          className="mt-6"
        >
          <div id="helpdesk" className="grid gap-2">
            {helpdesk.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada laporan terbuka.</p> : null}
            {helpdesk.map((t) => (
              <div key={t.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{t.subject}</span>
                  <div className="flex flex-wrap gap-1">
                    {t.overdue ? <ToneBadge tone="danger">Lewat tenggat</ToneBadge> : null}
                    <StatusBadge enumName="ticket_status" value={t.status} />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {label("ticket_category", t.category)} · {t.reporterName} · {formatTanggalJam(t.createdAt)}
                  {t.appVersion ? ` · versi ${t.appVersion}` : ""}
                  {t.dueAt ? ` · tenggat ${formatTanggalJam(t.dueAt)}` : ""}
                </p>
                <p className="mt-1 whitespace-pre-line">{t.description}</p>
                {t.syncStatus ? <p className="mt-1 font-mono text-xs text-muted-foreground">{JSON.stringify(t.syncStatus)}</p> : null}
                {t.answer ? <p className="mt-2 rounded bg-muted p-2">Jawaban: {t.answer}</p> : null}
                {canAnswer ? (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {t.status === "received" ? (
                      <Disclosure summary="Jawab">
                        <ActionForm action={answerTicketAction} submitLabel="Kirim jawaban">
                          <input type="hidden" name="ticketId" value={t.id} />
                          <FormRow label="Jawaban" htmlFor={`jawab-${t.id}`}>
                            <TextArea id={`jawab-${t.id}`} name="answer" required />
                          </FormRow>
                        </ActionForm>
                      </Disclosure>
                    ) : null}
                    <ActionForm action={closeTicketAction} submitLabel="Tandai selesai" variant="outline">
                      <input type="hidden" name="ticketId" value={t.id} />
                    </ActionForm>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </SectionCard>
      ) : null}
    </>
  );
}
