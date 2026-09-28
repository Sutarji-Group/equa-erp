import type { Metadata } from "next";
import Link from "next/link";

import { hrefWith } from "@/components/m9-reports/fields";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { firstDayOfMonth } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { can } from "@/server/core/rbac";
import * as m9 from "@/server/modules/m9-reports";

export const metadata: Metadata = { title: "Katalog laporan" };

/**
 * Katalog laporan PRD 7.9.4 (US-M9-03): setiap baris punya layar sumber & ekspor Excel (Data + Ringkasan) / PDF
 * (identitas usaha, cap waktu, pembuat, filter). Laporan ber-data pribadi: pemilik/Admin Keuangan wajib menulis tujuan
 * (BR-39); peran lain menerima versi tanpa nomor WA & alamat lengkap. Setiap ekspor tercatat di log ekspor.
 */
export default async function CatalogPage() {
  const { ctx } = await requirePermission("m9.report.read");
  const catalog = await m9.getReportCatalog(ctx);
  const today = ctxBusinessDate(ctx);
  const defaults: Record<string, string> = { month: today.slice(0, 7), date: today, from: firstDayOfMonth(today), to: today };
  const canExport = can(ctx, "m9.report.export");

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6" data-testid="catalog-page">
      <PageHeader
        title="Katalog laporan"
        description="Semua laporan turunan modul (PRD 7.9.4) — buka layarnya atau unduh Excel/PDF. Setiap unduhan tercatat (siapa, kapan, laporan, filter)."
        actions={
          can(ctx, "m10.audit_log.read") ? (
            <Link href="/audit" className="text-sm font-medium text-primary hover:underline">
              Log akses & ekspor
            </Link>
          ) : null
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {catalog.map((e) => (
          <SectionCard
            key={e.id}
            title={
              <span id={e.id} className="scroll-mt-20">
                {e.title}
              </span>
            }
            description={e.content}
          >
            <div className="grid gap-3 text-sm" data-testid={`catalog-${e.id}`}>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-muted-foreground">Sumber</dt>
                <dd>{e.source}</dd>
                <dt className="text-muted-foreground">Ketersediaan</dt>
                <dd>{e.availability}</dd>
                <dt className="text-muted-foreground">Pembaca</dt>
                <dd>{e.readers}</dd>
                <dt className="text-muted-foreground">Rujukan</dt>
                <dd>
                  {e.ref} · <ToneBadge tone={e.priority.startsWith("M") ? "info" : "muted"}>{e.priority}</ToneBadge>
                </dd>
              </dl>
              <div className="flex flex-wrap gap-2">
                {e.canOpenScreen ? (
                  <Link href={e.screen} className="inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium hover:bg-accent">
                    Buka layar
                  </Link>
                ) : null}
                {e.customExport && e.canOpenScreen && canExport ? (
                  <>
                    <a href={hrefWith(e.customExport, { bulan: defaults.month, format: "xlsx" })} className="inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium hover:bg-accent">
                      Excel (Final identik)
                    </a>
                    <a href={hrefWith(e.customExport, { bulan: defaults.month, format: "pdf" })} className="inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium hover:bg-accent">
                      PDF (Final identik)
                    </a>
                  </>
                ) : null}
              </div>
              {e.reports.length ? (
                <ul className="grid gap-2">
                  {e.reports.map((r) => {
                    const filters: Record<string, string> = {};
                    for (const f of r.needsFilters) if (defaults[f]) filters[f] = defaults[f]!;
                    const missing = r.needsFilters.filter((f) => !defaults[f]);
                    return (
                      <li key={r.key} className="flex flex-wrap items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5" data-testid={`catalog-report-${r.key}`}>
                        <span className="min-w-0 flex-1">
                          {r.title}
                          {r.containsPii ? (
                            <span className="block text-xs text-muted-foreground">
                              {r.piiFull ? "Memuat data pribadi — tulis tujuan ekspor (BR-39)." : "Versi tanpa nomor WA & alamat lengkap (BR-39)."}
                            </span>
                          ) : null}
                        </span>
                        {!r.registered ? (
                          <ToneBadge tone="muted">Menyusul</ToneBadge>
                        ) : !r.allowed ? (
                          <ToneBadge tone="muted">Tidak ada izin</ToneBadge>
                        ) : missing.length ? (
                          <span className="text-xs text-muted-foreground">Ekspor dari layar sumber (butuh filter)</span>
                        ) : r.piiFull ? (
                          <form method="post" action={`/api/export/${r.key}`} className="flex flex-wrap items-center gap-1">
                            {Object.entries(filters).map(([k, v]) => (
                              <input key={k} type="hidden" name={k} value={v} />
                            ))}
                            <input name="purpose" required minLength={5} placeholder="Tujuan ekspor" aria-label={`Tujuan ekspor ${r.title}`} className="h-8 w-40 rounded-md border bg-background px-2 text-xs" />
                            <select name="format" defaultValue="xlsx" aria-label="Format" className="h-8 rounded-md border bg-background px-1 text-xs">
                              <option value="xlsx">Excel</option>
                              <option value="pdf">PDF</option>
                            </select>
                            <button type="submit" className="h-8 rounded-md border px-2 text-xs font-medium hover:bg-accent">
                              Unduh
                            </button>
                          </form>
                        ) : (
                          <span className="flex gap-1">
                            <a href={hrefWith(`/api/export/${r.key}`, { format: "xlsx", ...filters })} className="inline-flex h-8 items-center rounded-md border px-2 text-xs font-medium hover:bg-accent">
                              Excel
                            </a>
                            <a href={hrefWith(`/api/export/${r.key}`, { format: "pdf", ...filters })} className="inline-flex h-8 items-center rounded-md border px-2 text-xs font-medium hover:bg-accent">
                              PDF
                            </a>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">Laporan modul {e.source} menyusul ({(e.pendingKeys ?? []).join(", ")}).</p>
              )}
            </div>
          </SectionCard>
        ))}
      </div>
    </div>
  );
}
