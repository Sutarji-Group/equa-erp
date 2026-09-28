import type { Metadata } from "next";
import Link from "next/link";

import { ActionForm } from "@/components/m10-access/action-form";
import { FormRow, M10Badge, TableScroll, TextArea } from "@/components/m10-access/fields";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import { accessReviewList, quarterOf } from "@/server/modules/m10-access";

import { markReviewedAction } from "./actions";

export const metadata: Metadata = { title: "Tinjauan hak akses" };

function previousQuarters(current: string, n: number): string[] {
  const [y, q] = current.split("-Q").map(Number) as [number, number];
  const out: string[] = [];
  let yy = y;
  let qq = q;
  for (let i = 0; i < n; i++) {
    out.push(`${yy}-Q${qq}`);
    qq--;
    if (qq === 0) {
      qq = 4;
      yy--;
    }
  }
  return out;
}

/**
 * Tinjauan hak akses kuartalan (US-M10-01 KP-6; R09; PAR-47): daftar pengguna, peran, lingkup, terakhir login;
 * penanda tanpa login lama & multi-peran lewat masa berlaku; pemilik menandai "ditinjau" per kuartal.
 */
export default async function TinjauanPage({ searchParams }: PageProps<"/akses/tinjauan">) {
  const { ctx } = await requirePermission("m10.access_review.read");
  const sp = await searchParams;
  const current = quarterOf(ctx.now);
  const quarter = typeof sp.kuartal === "string" && /^\d{4}-Q[1-4]$/.test(sp.kuartal) ? sp.kuartal : current;
  const view = await accessReviewList(ctx, quarter);
  const canMark = can(ctx, "m10.access_review.mark") && view.review?.status !== "reviewed";
  const flagText: Record<string, string> = {
    no_login: `Tanpa login > ${view.inactiveDays} hari`,
    multi_role: "Multi-peran",
    multi_role_expired: "Multi-peran lewat masa berlaku",
  };

  return (
    <>
      <PageHeader
        title="Tinjauan hak akses"
        description={`Kuartal ${view.quarter} (${formatTanggal(view.range.start, { weekday: false })} – ${formatTanggal(view.range.end, { weekday: false })}). Pemilik meninjau daftar ini sekali per kuartal.`}
        meta={<M10Badge enumName="access_review_status" value={view.review?.status ?? "draft"} />}
        actions={<ExportButtons excelHref={`/api/export/m10.access_review?format=xlsx&quarter=${view.quarter}`} pdfHref={`/api/export/m10.access_review?format=pdf&quarter=${view.quarter}`} />}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <KpiTile label="Pengguna ditinjau" value={view.items.length} />
        <KpiTile label="Ditandai" value={view.flaggedCount} tone={view.flaggedCount ? "warning" : "success"} />
        <KpiTile
          label="Status kuartal"
          value={view.review?.status === "reviewed" ? "Ditinjau" : "Belum ditinjau"}
          hint={view.review?.reviewedAt ? formatTanggalJam(view.review.reviewedAt) : undefined}
          tone={view.review?.status === "reviewed" ? "success" : "warning"}
        />
      </div>

      <SectionCard
        className="mb-6"
        actions={
          <form method="get" className="flex items-center gap-2">
            <label htmlFor="pilih-kuartal" className="sr-only">
              Kuartal
            </label>
            <select id="pilih-kuartal" name="kuartal" defaultValue={view.quarter} className="h-8 rounded-md border bg-background px-2 text-sm">
              {previousQuarters(current, 6).map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
            <button type="submit" className="h-8 rounded-md border px-3 text-sm">
              Tampilkan
            </button>
          </form>
        }
        title="Daftar pengguna, peran, lingkup, login terakhir"
        flush
      >
        <TableScroll>
          <Table data-testid="tabel-tinjauan">
            <TableHeader>
              <TableRow>
                <TableHead>Pengguna</TableHead>
                <TableHead>Peran</TableHead>
                <TableHead className="hidden md:table-cell">Lingkup</TableHead>
                <TableHead>Login terakhir</TableHead>
                <TableHead>Penanda</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.items.map((i) => (
                <TableRow key={i.userId}>
                  <TableCell className="whitespace-normal">
                    <Link href={`/akses/pengguna/${i.userId}`} className="font-medium text-primary underline-offset-4 hover:underline">
                      {i.fullName}
                    </Link>
                    <p className="text-xs text-muted-foreground">{i.username}</p>
                  </TableCell>
                  <TableCell className="whitespace-normal text-sm">
                    {i.roles.map((r) => `${r.label}${r.validUntil ? ` s.d. ${r.validUntil}` : ""}`).join(", ") || "—"}
                  </TableCell>
                  <TableCell className="hidden max-w-xs whitespace-normal text-sm md:table-cell">{i.scopes.join(", ") || "—"}</TableCell>
                  <TableCell>{i.lastLoginAt ? formatTanggalJam(i.lastLoginAt) : "Belum pernah"}</TableCell>
                  <TableCell className="whitespace-normal">
                    <div className="flex flex-wrap gap-1">
                      {i.flags.map((f) => (
                        <ToneBadge key={f} tone={f === "multi_role" ? "info" : "danger"}>
                          {flagText[f]}
                        </ToneBadge>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableScroll>
      </SectionCard>

      {canMark ? (
        <SectionCard title="Tandai kuartal ini sudah ditinjau" description="Daftar & penanda saat ini disimpan sebagai bukti tinjauan (R09).">
          <ActionForm action={markReviewedAction} submitLabel={`Tandai ${view.quarter} ditinjau`} testId="form-tinjauan">
            <input type="hidden" name="quarter" value={view.quarter} />
            <FormRow label="Catatan (tindak lanjut, akun yang diminta dicabut)" htmlFor="tinjauan-catatan">
              <TextArea id="tinjauan-catatan" name="notes" />
            </FormRow>
          </ActionForm>
        </SectionCard>
      ) : view.review?.status === "reviewed" ? (
        <SectionCard title="Hasil tinjauan">
          <p className="text-sm">
            Ditinjau {view.review.reviewedAt ? formatTanggalJam(view.review.reviewedAt) : ""}. {view.review.notes ?? ""}
          </p>
        </SectionCard>
      ) : null}

      {view.history.length ? (
        <SectionCard title="Riwayat tinjauan" className="mt-6">
          <ul className="grid gap-1 text-sm">
            {view.history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {h.quarter} · {h.reviewedAt ? formatTanggalJam(h.reviewedAt) : "—"} · ditandai {(h.flagged as { count?: number } | null)?.count ?? 0}
                </span>
                <M10Badge enumName="access_review_status" value={h.status} />
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </>
  );
}
