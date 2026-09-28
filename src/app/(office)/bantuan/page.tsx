import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { listMySupportTickets } from "@/server/core/support";

import { TicketForm } from "./ticket-form";

export const metadata: Metadata = { title: "Bantuan" };

const GUIDE = [
  { title: "Masuk & keamanan", body: "Masuk dengan nama pengguna dan kata sandi. Pemilik, Admin Keuangan, dan admin sistem memakai kode 6 angka dari aplikasi autentikator. Sesi berakhir otomatis setelah tidak aktif." },
  { title: "Persetujuan", body: "Permintaan yang menunggu keputusan Anda ada di menu Persetujuan; yang lewat tenggat tampil paling atas. Penolakan wajib disertai alasan. Permintaan Anda sendiri tidak dapat Anda putuskan." },
  { title: "Notifikasi", body: "Lonceng di atas menampilkan peristiwa yang perlu ditindaklanjuti. Atur cara menerimanya di Pengaturan notifikasi; notifikasi kritis tidak dapat dimatikan." },
  { title: "Koreksi data", body: "Tidak ada tombol hapus. Kesalahan diperbaiki dengan transaksi pembalik beralasan; semua perubahan tercatat di jejak audit." },
  { title: "Aplikasi lapangan", body: "Sopir, kernet, operator, dan kasir memakai aplikasi lapangan di perangkat terdaftar dengan PIN. Data tersimpan di ponsel saat tanpa sinyal dan terkirim otomatis." },
];

/** Bantuan: panduan singkat + formulir laporan kendala (US-M10-07 KP-3, NFR-33) dengan status terlihat pelapor. */
export default async function BantuanPage() {
  const { ctx } = await requirePermission("m10.support_ticket.create");
  const tickets = await listMySupportTickets(ctx);
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
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </>
  );
}
