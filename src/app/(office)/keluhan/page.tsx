import type { Metadata } from "next";
import Link from "next/link";

import { P2OfficeTabs } from "@/components/p2-customer/office-tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import * as p2 from "@/server/modules/p2-customer";

import { p2Tabs } from "./_tabs";

export const metadata: Metadata = { title: "Kotak keluhan" };

const BOXES = [
  { key: "all", label: "Semua" },
  { key: "dispatcher", label: "Operasional (Dispatcher)" },
  { key: "finance_admin", label: "Tagihan (Admin Keuangan)" },
] as const;

/**
 * Kotak keluhan pelanggan (US-P2-06 KP-2/KP-3): operasional → Dispatcher, tagihan → Admin Keuangan; tenggat tanggapan
 * pertama ≤ PAR-75 (24 jam layanan) — yang lewat ditandai; keluhan tidak dapat dihapus.
 */
export default async function KeluhanKantorPage({ searchParams }: PageProps<"/keluhan">) {
  const { ctx } = await requirePermission("p2.complaint.read");
  const sp = await searchParams;
  const box = BOXES.find((b) => b.key === sp.kotak)?.key ?? p2.defaultBox(ctx);
  const status = sp.status === "semua" ? null : sp.status === "selesai" ? "done" : "open";
  const rows = await p2.listComplaints(ctx, { box, status });
  const q = (extra: Record<string, string>) => `/keluhan?${new URLSearchParams({ kotak: box, status: sp.status === "semua" ? "semua" : sp.status === "selesai" ? "selesai" : "terbuka", ...extra }).toString()}`;
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Kotak keluhan"
        description="Keluhan dari aplikasi pelanggan. Tanggapan pertama paling lambat 24 jam layanan (PAR-75); status & tanggapan tampil ke pelanggan."
        actions={<ExportButtons excelHref={`/api/export/p2.complaints?format=xlsx&box=${box}`} pdfHref={`/api/export/p2.complaints?format=pdf&box=${box}`} />}
      />
      <P2OfficeTabs tabs={p2Tabs(ctx)} current="/keluhan" />
      <div className="flex flex-wrap gap-2">
        {BOXES.map((b) => (
          <Button key={b.key} asChild size="sm" variant={b.key === box ? "secondary" : "ghost"}>
            <Link href={q({ kotak: b.key })}>{b.label}</Link>
          </Button>
        ))}
        <span className="mx-2 border-l" />
        {[
          ["terbuka", "Belum selesai"],
          ["selesai", "Selesai"],
          ["semua", "Semua"],
        ].map(([k, l]) => (
          <Button key={k} asChild size="sm" variant={(sp.status ?? "terbuka") === k ? "secondary" : "ghost"}>
            <Link href={q({ status: k! })}>{l}</Link>
          </Button>
        ))}
      </div>
      <SectionCard flush>
        {rows.length === 0 ? (
          <EmptyState title="Tidak ada keluhan" description="Keluhan baru dari aplikasi pelanggan akan muncul di sini." compact />
        ) : (
          <Table data-testid="complaint-table">
            <TableHeader>
              <TableRow>
                <TableHead>Diajukan</TableHead>
                <TableHead>Pelanggan</TableHead>
                <TableHead>Jenis</TableHead>
                <TableHead className="hidden md:table-cell">Pesanan / truk</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Tenggat</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap">
                    <Link href={`/keluhan/${r.id}`} className="text-primary underline-offset-2 hover:underline">
                      {formatTanggalJam(r.createdAt)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {r.customerName}
                    <span className="block max-w-72 truncate text-xs text-muted-foreground">{r.description}</span>
                  </TableCell>
                  <TableCell>
                    {label("complaint_kind", r.kind)}
                    <span className="block text-xs text-muted-foreground">{label("complaint_box", r.box)}</span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {r.orderNumber ?? "—"}
                    {r.truck ? <span className="block text-xs text-muted-foreground">{r.truck}</span> : null}
                  </TableCell>
                  <TableCell>
                    <StatusBadge enumName="complaint_status" value={r.status} tone={r.status === "done" ? "success" : r.status === "responded" ? "info" : "warning"} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {r.overdue ? <ToneBadge tone="danger">Lewat tenggat</ToneBadge> : r.firstResponseAt ? "Sudah ditanggapi" : r.dueAt ? formatTanggalJam(r.dueAt) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}
