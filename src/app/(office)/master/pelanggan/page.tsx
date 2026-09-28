import { MapPinned, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ActionButton, ReasonActionButton } from "@/components/m1-master/action-buttons";
import { CustomerTable } from "@/components/m1-master/customer-table";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import { enumOptions, type CustomerSegment } from "@/lib/labels";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m1 from "@/server/modules/m1-master";

import { confirmProposalAction, rejectProposalAction, reviewSpecialPriceAction } from "./actions";

export const metadata: Metadata = { title: "Pelanggan" };

/**
 * Pelanggan & alamat kirim (US-M1-01): daftar + filter, kemajuan kunci koordinat (US-M1-06 KP-5), usulan koordinat dari
 * rit Selesai yang menunggu konfirmasi (KP-2), dan daftar tinjauan harga khusus pemilik (KP-5, BR-16).
 */
export default async function PelangganPage({ searchParams }: PageProps<"/master/pelanggan">) {
  const { ctx } = await requirePermission("m1.customer.read");
  const sp = await searchParams;
  const segment = typeof sp.segmen === "string" && sp.segmen ? (sp.segmen as CustomerSegment) : undefined;
  const status = sp.status === "nonaktif" ? "inactive" : sp.status === "semua" ? "all" : "active";
  const [rows, progress, proposals] = await Promise.all([m1.listCustomers(ctx, { segment, status }), m1.coordinateLockProgress(ctx), m1.listCoordinateProposals(ctx)]);
  const canCreate = can(ctx, "m1.customer.create");
  const canLock = can(ctx, "m1.customer.lock_coordinate");
  const reviews = can(ctx, "m1.special_price.read") ? await m1.listSpecialPriceReviews(ctx) : [];
  const canReview = can(ctx, "m1.special_price.review");

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Pelanggan"
        description="Pelanggan, alamat kirim berkoordinat, status kredit, dan harga khusus."
        actions={
          <>
            {canCreate ? (
              <Button asChild>
                <Link href="/master/pelanggan/baru">
                  <Plus aria-hidden />
                  Pelanggan baru
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile label="Pelanggan aktif" value={String(rows.filter((r) => r.isActive).length)} />
        <KpiTile label="Alamat terkunci" value={`${progress.percentLocked}%`} hint={`${progress.locked} dari ${progress.total} alamat`} icon={MapPinned} />
        <KpiTile label="Usulan koordinat menunggu" value={String(proposals.length)} tone={proposals.length ? "warning" : undefined} />
      </div>

      {proposals.length ? (
        <SectionCard title="Usulan koordinat dari rit Selesai" description="Lokasi Selesai rit pertama diusulkan sebagai koordinat alamat Belum dikunci. Konfirmasi atau tolak (US-M1-01 KP-2).">
          <ul className="grid gap-2">
            {proposals.map((p) => (
              <li key={p.addressId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
                <div className="min-w-0">
                  <Link href={`/master/pelanggan/${p.customerId}`} className="font-medium text-primary underline-offset-4 hover:underline">
                    {p.customerName}
                  </Link>{" "}
                  · {p.label} — {p.addressText}
                  <div className="text-xs text-muted-foreground">
                    Titik {p.proposedLat?.toFixed(5)}, {p.proposedLng?.toFixed(5)} {p.tripNumber ? `dari rit ${p.tripNumber}` : ""} {p.proposedAt ? `· ${formatTanggalJam(p.proposedAt)}` : ""}
                  </div>
                </div>
                {canLock ? (
                  <div className="flex gap-2">
                    <ActionButton label="Konfirmasi" action={confirmProposalAction.bind(null, p.customerId, p.addressId)} />
                    <ReasonActionButton label="Tolak" title="Tolak usulan koordinat?" action={rejectProposalAction.bind(null, p.customerId, p.addressId)} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {reviews.length ? (
        <SectionCard
          title="Tinjauan harga khusus"
          description="Harga khusus yang lewat tanggal tinjauan tetap berlaku sampai pemilik memutuskan (BR-16)."
          actions={<ExportButtons excelHref="/api/export/m1.special_price_reviews?format=xlsx" pdfHref="/api/export/m1.special_price_reviews?format=pdf" />}
        >
          <ul className="grid gap-2" id="tinjauan-harga">
            {reviews.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
                <div>
                  <Link href={`/master/pelanggan/${r.customerId}`} className="font-medium text-primary underline-offset-4 hover:underline">
                    {r.customerName}
                  </Link>{" "}
                  · {r.productName} · <MoneyText value={r.price} />
                  <div className="text-xs text-muted-foreground">
                    Tinjauan {formatTanggal(r.reviewDate, { weekday: false })} (lewat {r.daysOverdue} hari)
                  </div>
                </div>
                {canReview ? (
                  <div className="flex gap-2">
                    <ReasonActionButton label="Tetap berlaku" title="Harga khusus tetap berlaku?" description="Tanggal tinjauan berikutnya dijadwalkan otomatis (PAR-24)." action={reviewSpecialPriceAction.bind(null, r.id, "keep")} variant="default" />
                    <ReasonActionButton label="Akhiri" title="Akhiri harga khusus hari ini?" description="Setelahnya harga master berlaku." action={reviewSpecialPriceAction.bind(null, r.id, "end")} destructive />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Daftar pelanggan"
        actions={
          can(ctx, "m1.customer.export") ? (
            <form method="post" action="/api/export/m1.customers" className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="format" value="xlsx" />
              <input name="purpose" required minLength={5} placeholder="Tujuan ekspor (wajib, BR-39)" className="h-8 w-56 rounded-md border border-input bg-transparent px-2 text-sm" aria-label="Tujuan ekspor" />
              <Button type="submit" variant="outline" size="sm">
                Ekspor Excel
              </Button>
            </form>
          ) : null
        }
      >
        <form method="get" className="mb-3 flex flex-wrap items-end gap-2" aria-label="Saring pelanggan">
          <label className="grid gap-1 text-sm">
            Segmen
            <select name="segmen" defaultValue={segment ?? ""} className="h-9 rounded-md border border-input bg-transparent px-2 text-sm">
              <option value="">Semua segmen</option>
              {enumOptions("customer_segment").map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Status
            <select name="status" defaultValue={sp.status === "nonaktif" ? "nonaktif" : sp.status === "semua" ? "semua" : "aktif"} className="h-9 rounded-md border border-input bg-transparent px-2 text-sm">
              <option value="aktif">Aktif</option>
              <option value="nonaktif">Nonaktif</option>
              <option value="semua">Semua</option>
            </select>
          </label>
          <Button type="submit" variant="outline" size="sm">
            Terapkan
          </Button>
        </form>
        <CustomerTable rows={rows} />
      </SectionCard>
    </div>
  );
}
