import type { Metadata } from "next";

import { Phase3Disabled } from "@/components/p3-partner/phase3-disabled";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { EmptyState } from "@/components/shared/empty-state";
import { KeyValueList } from "@/components/shared/key-value-list";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { label } from "@/lib/labels";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import * as p3 from "@/server/modules/p3-partner";

import { requirePortalSession } from "../../_session";

export const metadata: Metadata = { title: "Sanksi & status kemitraan" };

/**
 * Sanksi dari sudut pandang mitra (Tahap 3 US-P3-07; US-P3-02 KP-4): teguran tertulis (surat), penghentian pasokan
 * sementara dengan alasan & syarat pemulihan, pemutusan (ekspor data outlet ≤ 30 hari, PTB-58), mode baca-saja karena
 * tunggakan, dan riwayat pencabutan.
 */
export default async function PortalSanctionsPage() {
  const { ctx } = await requirePortalSession();
  const s = await p3.portalSanctions(ctx);
  if (!s.enabled && !s.sanctions.length) {
    return (
      <>
        <PageHeader title="Sanksi & status kemitraan" />
        <Phase3Disabled what="Riwayat sanksi kemitraan" />
      </>
    );
  }
  const detailOf = (x: (typeof s.sanctions)[number]) => x.detail as { recoveryConditions?: string; letterText?: string; proposalReason?: string; summary?: string };

  return (
    <>
      <PageHeader title="Sanksi & status kemitraan" description="Sanksi bertingkat: teguran tertulis → penghentian pasokan sementara → pemutusan. Setiap tahap diputuskan pemilik EQUA dengan alasan." />
      {s.readOnly ? (
        <Alert variant="destructive">
          <AlertTitle>Mode baca-saja</AlertTitle>
          <AlertDescription>POS tidak dapat membuka shift baru dan pengaturan tidak dapat diubah karena tunggakan tagihan lewat batas setelah teguran. Status pulih otomatis setelah tunggakan lunas.</AlertDescription>
        </Alert>
      ) : null}
      {s.suspension ? (
        <Alert variant="destructive" data-testid="penghentian-pasokan">
          <AlertTitle>Pasokan air dihentikan sementara</AlertTitle>
          <AlertDescription>
            <p>Alasan: {((s.suspension.triggerDetail ?? {}) as { proposalReason?: string }).proposalReason ?? s.suspension.decisionReason ?? "-"}</p>
            <p>Syarat pemulihan: {((s.suspension.triggerDetail ?? {}) as { recoveryConditions?: string }).recoveryConditions ?? "-"}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {s.contract && (s.contract.status === "terminated" || s.contract.status === "ended") ? (
        <SectionCard title="Kemitraan berakhir">
          <KeyValueList
            columns={2}
            items={[
              { label: "Kontrak", value: s.contract.number },
              { label: "Status", value: <StatusBadge enumName="partner_contract_status" value={s.contract.status} /> },
              { label: "Tanggal berakhir", value: formatTanggal(s.contract.endDate) },
              { label: "Ekspor data outlet untuk Anda", value: s.contract.dataExportedAt ? `diserahkan ${formatTanggalJam(s.contract.dataExportedAt)}` : s.contract.dataExportDueDate ? `paling lambat ${formatTanggal(s.contract.dataExportDueDate)}` : "—" },
            ]}
          />
          <p className="mt-2 text-xs text-muted-foreground">Data outlet tetap disimpan EQUA sesuai ketentuan retensi; peralatan tetap milik mitra.</p>
        </SectionCard>
      ) : null}
      <SectionCard title="Riwayat sanksi">
        {s.sanctions.length === 0 ? (
          <EmptyState title="Tidak ada sanksi" description="Pertahankan pembayaran tepat waktu, neraca air wajar, dan skor mutu di atas ambang." compact />
        ) : (
          <ul className="grid gap-3" data-testid="riwayat-sanksi-mitra">
            {s.sanctions.map((x) => {
              const d = detailOf(x);
              return (
                <li key={x.id} className="rounded-md border bg-background p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <ToneBadge tone={x.level === "termination" ? "danger" : x.level === "supply_suspension" ? "warning" : "info"}>{label("sanction_level", x.level)}</ToneBadge>
                    <StatusBadge enumName="sanction_status" value={x.status} />
                    {x.effectiveFrom ? <span className="text-muted-foreground">berlaku {formatTanggal(x.effectiveFrom)}</span> : null}
                    {x.liftedAt ? <span className="text-muted-foreground">dicabut {formatTanggalJam(x.liftedAt)}</span> : null}
                  </div>
                  {x.decisionReason ? <p className="mt-1">Alasan: {x.decisionReason}</p> : null}
                  {d.recoveryConditions ? <p className="mt-1">Syarat pemulihan: {d.recoveryConditions}</p> : null}
                  {x.liftReason ? <p className="mt-1 text-xs">Alasan pencabutan: {x.liftReason}</p> : null}
                  {d.letterText ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-medium text-primary">Surat teguran tertulis</summary>
                      <pre className="mt-1 whitespace-pre-wrap rounded bg-muted p-2 font-sans text-xs">{d.letterText}</pre>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </>
  );
}
