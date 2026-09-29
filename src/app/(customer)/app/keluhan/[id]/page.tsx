import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CustomerCard, CustomerShell } from "@/components/p2-customer/customer-shell";
import { formatTanggalJam } from "@/lib/time";
import { NotFoundError } from "@/server/core/errors";
import * as p2 from "@/server/modules/p2-customer";
import { requireCustomer } from "@/server/modules/p2-customer/web";

export const metadata: Metadata = { title: "Keluhan" };

/** Rincian keluhan + status & tanggapan yang tampil ke pelanggan (US-P2-06 KP-2/KP-3). */
export default async function KeluhanDetailPage({ params, searchParams }: PageProps<"/app/keluhan/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const cctx = await requireCustomer({ next: `/app/keluhan/${id}` });
  let c: p2.CustomerComplaintView;
  try {
    c = await p2.getMyComplaint(cctx, id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  return (
    <CustomerShell title="Keluhan" active="home" backHref="/app/keluhan">
      {sp.baru ? (
        <p role="status" className="mb-3 rounded-md border border-success bg-success/10 p-3 text-sm">
          Keluhan terkirim. Kami akan menanggapi paling lambat 24 jam layanan.
        </p>
      ) : null}
      <CustomerCard title={`${c.kindLabel}${c.orderNumber ? ` · ${c.orderNumber}` : ""}`} testId="complaint-detail">
        <p className="mb-2 text-sm">
          Status: <strong data-testid="complaint-status">{c.statusLabel}</strong> · diajukan {formatTanggalJam(c.createdAt)}
        </p>
        <p className="whitespace-pre-line text-sm">{c.description}</p>
        {c.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- berkas privat lewat route berotorisasi
          <img src={c.photoUrl} alt="Foto keluhan" className="mt-3 w-full rounded-md border" />
        ) : null}
      </CustomerCard>
      <CustomerCard title="Tanggapan EQUA">
        {c.updates.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada tanggapan.</p>
        ) : (
          <ul className="grid gap-2 text-sm">
            {c.updates.map((u, i) => (
              <li key={i} className="rounded-md border p-2">
                <p className="text-xs text-muted-foreground">
                  {u.kind} · {formatTanggalJam(u.at)}
                </p>
                <p className="whitespace-pre-line">{u.note}</p>
              </li>
            ))}
          </ul>
        )}
      </CustomerCard>
    </CustomerShell>
  );
}
