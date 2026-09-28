import type { Metadata } from "next";
import Link from "next/link";

import { CashActionButton, CashReasonButton } from "@/components/m4-cash/action-buttons";
import { CashActionForm } from "@/components/m4-cash/action-form";
import { ContactLinks, DateFilterInput, Field, FilterForm, MoneyField, SelectField, hrefWith } from "@/components/m4-cash/fields";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KeyValueList } from "@/components/shared/key-value-list";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge, type StatusTone } from "@/components/shared/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions, label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, formatTanggal, formatTanggalJam, isBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { can } from "@/server/core/rbac";
import { normalizeWaNumber } from "@/server/core/wa";
import * as m4 from "@/server/modules/m4-cash";

import { closeCashDayAction, requestExceptionAction, startCloseAction } from "../actions";

export const metadata: Metadata = { title: "Tutup kas" };

const EXCEPTION_TONE: Record<string, StatusTone> = { submitted: "warning", approved: "info", rejected: "danger", resolved: "success", expired: "danger" };

/**
 * Tutup kas harian (US-M4-06): tombol aktif hanya bila tidak ada penghalang (setoran sopir belum diterima, shift
 * depot/toko terbuka atau setorannya belum diterima, rit Berangkat/Tiba, hari sebelumnya belum ditutup) — penghalang
 * tampil dengan tombol hubungi & pengajuan pengecualian per kejadian (PTB-21); layar memuat seluruh selisih hari itu,
 * transfer belum dicocokkan, kas kantor sistem vs hitung fisik (selisih wajib alasan), waktu KPI-02; riwayat hari kas.
 */
export default async function CashClosePage({ searchParams }: { searchParams: Promise<{ tanggal?: string }> }) {
  const { ctx } = await requirePermission("m4.cash_day.read");
  const sp = await searchParams;
  const today = ctxBusinessDate(ctx);
  const date = sp.tanggal && isBusinessDate(sp.tanggal) && sp.tanggal <= today ? sp.tanggal : today;
  const s = await m4.getCashDayScreen(ctx, { date });
  const history = await m4.listCashDays(ctx, { to: today, from: addDays(today, -13) });
  const canClose = can(ctx, "m4.cash_day.close");
  const canException = can(ctx, "m4.cash_close_exception.request");
  const closed = s.day?.status === "closed";
  const kpi02 = s.day?.closedAt && s.day.lastDepositReceivedAt ? Math.max(0, Math.round((s.day.closedAt.getTime() - s.day.lastDepositReceivedAt.getTime()) / 60_000)) : null;
  const discTotal = s.discrepancies.reduce((sum, x) => sum + x.amount, 0);
  const unmatchedTotal = s.unmatchedTransfers.reduce((sum, x) => sum + x.amount, 0);

  return (
    <div className="grid grid-cols-1 gap-6">
      <PageHeader
        title="Tutup kas"
        description={`${formatTanggal(date)} — batas tutup kas pukul ${s.cutoff.replace(":", ".")} WIB. Ringkasan H+0 terbit untuk pemilik setelah kas ditutup.`}
        meta={closed ? <ToneBadge tone="success">Kas ditutup</ToneBadge> : <ToneBadge tone="warning">Kas terbuka</ToneBadge>}
        actions={
          !closed && canClose ? <CashActionButton label={s.day?.closeStartedAt ? "Mulai tutup kas (tercatat)" : "Mulai tutup kas"} variant="outline" action={startCloseAction.bind(null, date)} disabled={!!s.day?.closeStartedAt} testId="mulai-tutup-kas" /> : null
        }
      />
      <FilterForm action="/kas/tutup">
        <DateFilterInput name="tanggal" value={date} label="Tanggal kas" />
      </FilterForm>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Penghalang" value={closed ? "—" : `${s.openBlockers.length} sumber`} tone={closed ? "success" : s.openBlockers.length ? "danger" : "success"} />
        <KpiTile label="Selisih hari ini" value={<MoneyText value={discTotal} signed />} hint={`${s.discrepancies.length} selisih`} tone={s.discrepancies.length ? "warning" : "success"} />
        <KpiTile label="Transfer belum dicocokkan" value={<MoneyText value={unmatchedTotal} />} hint={`${s.unmatchedTransfers.length} transfer`} href="/kas/transfer" hrefLabel="Cocokkan" />
        <KpiTile label="Kas kantor (sistem)" value={<MoneyText value={closed ? (s.day?.officeCashSystem ?? s.officeCashSystem) : s.officeCashSystem} />} />
      </div>

      <SectionCard title="Waktu (KPI-02)">
        <KeyValueList
          columns={3}
          items={[
            { label: "Setoran terakhir diterima", value: s.day?.lastDepositReceivedAt ? formatTanggalJam(s.day.lastDepositReceivedAt) : s.lastDepositReceivedAt ? formatTanggalJam(s.lastDepositReceivedAt) : "—" },
            { label: "Mulai tutup kas", value: s.day?.closeStartedAt ? formatTanggalJam(s.day.closeStartedAt) : "—" },
            { label: "Kas ditutup", value: s.day?.closedAt ? formatTanggalJam(s.day.closedAt) : "—", hint: s.day?.closedLate ? `Terlambat (setelah ${s.cutoff.replace(":", ".")})` : undefined },
            { label: "KPI-02 (setoran terakhir → kas ditutup)", value: kpi02 === null ? "—" : `${kpi02} menit` },
            { label: "Transaksi terlambat sinkron", value: `${s.lateSyncCount}`, hint: "Masuk hari ini bertanda; kasnya ke setoran hari berikutnya" },
            { label: "Pengecualian setoran tertunda", value: `${s.exceptions.length}`, hint: `Maks. ${s.pendingDepositMaxDays} hari, persetujuan pemilik per kejadian` },
          ]}
        />
      </SectionCard>

      {!closed ? (
        <SectionCard title={s.openBlockers.length ? `Penghalang tutup kas (${s.openBlockers.length})` : "Tidak ada penghalang"} description="Semua setoran sopir diterima, shift depot & toko ditutup dan setorannya diterima/setor bank, tidak ada rit berjalan, dan hari sebelumnya ditutup." flush>
          {s.blockers.length ? (
            <div className="overflow-x-auto">
              <Table data-testid="penghalang-tutup-kas">
                <TableHeader>
                  <TableRow>
                    <TableHead>Penghalang</TableHead>
                    <TableHead>Sumber</TableHead>
                    <TableHead>Hubungi</TableHead>
                    <TableHead className="min-w-48">Pengecualian</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.blockers.map((b, i) => (
                    <TableRow key={`${b.kind}-${b.depositId ?? b.shiftId ?? b.tripId ?? i}`} className={b.covered ? "opacity-70" : "bg-destructive/5"}>
                      <TableCell className="text-sm font-medium">{b.kindLabel}</TableCell>
                      <TableCell className="text-sm">
                        {b.depositId ? (
                          <Link href={`/kas/setoran/${b.depositId}`} className="font-medium text-primary hover:underline">
                            {b.label}
                          </Link>
                        ) : b.kind === "previous_day" ? (
                          <Link href={hrefWith("/kas/tutup", { tanggal: b.businessDate })} className="font-medium text-primary hover:underline">
                            {b.label}
                          </Link>
                        ) : (
                          <span className="font-medium">{b.label}</span>
                        )}
                        {b.detail ? <span className="block text-xs text-muted-foreground">{b.detail}</span> : null}
                      </TableCell>
                      <TableCell>{b.kind === "previous_day" ? "—" : <ContactLinks phone={b.phone} waNumber={b.phone ? normalizeWaNumber(b.phone) : null} />}</TableCell>
                      <TableCell>
                        {b.exception ? (
                          <ToneBadge tone={EXCEPTION_TONE[b.exception.status] ?? "neutral"}>{label("cash_close_exception_status", b.exception.status)}</ToneBadge>
                        ) : b.canRequestException && canException ? (
                          <CashReasonButton
                            label="Ajukan pengecualian"
                            title="Tutup kas dengan setoran tertunda"
                            description={`Per kejadian, persetujuan pemilik. Setoran tertunda maks. ${s.pendingDepositMaxDays} hari, rit sopir tetap terkunci, kas wajib diterima ≤ 24 jam — lewat itu menjadi selisih.`}
                            action={requestExceptionAction.bind(null, date, b.depositId, b.depositId ? null : b.shiftId)}
                            testId={`pengecualian-${b.depositId ?? b.shiftId}`}
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">{b.kind === "trip_active" || b.kind === "previous_day" ? "Selesaikan dulu" : "—"}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState title="Semua sumber sudah beres — kas dapat ditutup" compact />
          )}
        </SectionCard>
      ) : null}

      {s.exceptions.length ? (
        <SectionCard title="Pengecualian setoran tertunda (PTB-21)" flush>
          <div className="overflow-x-auto">
            <Table data-testid="pengecualian-tutup-kas">
              <TableHeader>
                <TableRow>
                  <TableHead>Sumber</TableHead>
                  <TableHead>Alasan</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Kas wajib diterima sebelum</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.exceptions.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-sm">{e.sourceLabel}</TableCell>
                    <TableCell className="max-w-72 whitespace-normal text-sm">{e.reason}</TableCell>
                    <TableCell>
                      <ToneBadge tone={EXCEPTION_TONE[e.status] ?? "neutral"}>{label("cash_close_exception_status", e.status)}</ToneBadge>
                      {e.convertedDiscrepancyId ? (
                        <Link href={`/kas/selisih?id=${e.convertedDiscrepancyId}`} className="block text-xs text-primary hover:underline">
                          Menjadi selisih
                        </Link>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">{e.dueAt ? formatTanggalJam(e.dueAt) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SectionCard title={`Selisih hari ini (${s.discrepancies.length})`} actions={<Link href="/kas/selisih" className="text-sm font-medium text-primary hover:underline">Buka selisih</Link>} flush>
          {s.discrepancies.length ? (
            <Table data-testid="selisih-hari-ini">
              <TableHeader>
                <TableRow>
                  <TableHead>Sumber</TableHead>
                  <TableHead className="text-right">Selisih</TableHead>
                  <TableHead>Alasan & status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.discrepancies.map((x) => (
                  <TableRow key={x.id}>
                    <TableCell className="text-sm">
                      <Link href={`/kas/selisih?id=${x.id}`} className="text-primary hover:underline">
                        {label("discrepancy_source", x.source)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right font-medium">{formatRupiah(x.amount, { signed: true })}</TableCell>
                    <TableCell className="text-sm">
                      {x.reason ? label("discrepancy_reason", x.reason) : <span className="text-destructive">Belum dijelaskan</span>}
                      <span className="mt-1 block">
                        <StatusBadge enumName="discrepancy_status" value={x.status} />
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState title="Tidak ada selisih hari ini" compact />
          )}
        </SectionCard>
        <SectionCard title={`Transfer belum dicocokkan (${s.unmatchedTransfers.length})`} actions={<Link href="/kas/transfer" className="text-sm font-medium text-primary hover:underline">Cocokkan</Link>} flush>
          {s.unmatchedTransfers.length ? (
            <Table data-testid="transfer-belum-cocok">
              <TableHeader>
                <TableRow>
                  <TableHead>Tanggal</TableHead>
                  <TableHead>Asal</TableHead>
                  <TableHead className="text-right">Jumlah</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.unmatchedTransfers.slice(0, 20).map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="text-sm">{formatTanggal(t.transferDate, { weekday: false })}</TableCell>
                    <TableCell className="text-sm">
                      {label("transfer_source_kind", t.sourceKind)}
                      {t.status === "not_found" ? <ToneBadge tone="danger">Tidak ditemukan</ToneBadge> : null}
                    </TableCell>
                    <TableCell className="text-right">{formatRupiah(t.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState title="Semua transfer sudah dicocokkan" compact />
          )}
        </SectionCard>
      </div>

      {closed ? (
        <SectionCard title="Kas kantor saat tutup">
          <KeyValueList
            columns={3}
            items={[
              { label: "Saldo sistem", value: formatRupiah(s.day?.officeCashSystem ?? 0) },
              { label: "Hitung fisik", value: formatRupiah(s.day?.officeCashPhysical ?? 0) },
              { label: "Selisih", value: formatRupiah(s.day?.officeCashDifference ?? 0, { signed: true }), hint: s.day?.officeCashReason ?? undefined },
            ]}
          />
        </SectionCard>
      ) : canClose ? (
        <SectionCard title="Hitung fisik kas kantor & tutup kas" description={`Saldo kas kantor menurut sistem ${formatRupiah(s.officeCashSystem)}. Selisih hitung fisik wajib alasan dan masuk alur Selisih.`}>
          {!s.canClose ? (
            <Alert variant="destructive" className="mb-3">
              <AlertTitle>Kas belum dapat ditutup</AlertTitle>
              <AlertDescription>Selesaikan atau ajukan pengecualian untuk setiap penghalang di atas.</AlertDescription>
            </Alert>
          ) : null}
          <CashActionForm action={closeCashDayAction.bind(null, date)} submitLabel="Tutup kas" disabled={!s.canClose} testId="form-tutup-kas">
            <div className="grid gap-3 sm:grid-cols-3">
              <MoneyField label="Hitung fisik kas kantor (Rp)" name="officeCashPhysical" required />
              <SelectField label="Alasan selisih (bila ada)" name="officeCashReason" options={enumOptions("discrepancy_reason")} emptyLabel="Tidak ada selisih" />
              <Field label="Keterangan" name="officeCashNote" />
            </div>
          </CashActionForm>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Riwayat tutup kas 14 hari"
        actions={
          <ExportButtons
            excelHref={hrefWith("/api/export/m4.cash_days", { format: "xlsx", from: addDays(today, -29), to: today })}
            pdfHref={hrefWith("/api/export/m4.cash_days", { format: "pdf", from: addDays(today, -29), to: today })}
          />
        }
        flush
      >
        {history.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="riwayat-hari-kas">
              <TableHeader>
                <TableRow>
                  <TableHead>Tanggal</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Kas ditutup</TableHead>
                  <TableHead className="text-right">KPI-02</TableHead>
                  <TableHead className="text-right">Selisih kas kantor</TableHead>
                  <TableHead>Oleh</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell className="text-sm">
                      <Link href={hrefWith("/kas/tutup", { tanggal: h.businessDate })} className="text-primary hover:underline">
                        {formatTanggal(h.businessDate, { weekday: false })}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {h.status === "closed" ? <ToneBadge tone="success">Ditutup</ToneBadge> : <ToneBadge tone="warning">Terbuka</ToneBadge>}
                      {h.closedLate ? <ToneBadge tone="warning">Terlambat</ToneBadge> : null}
                    </TableCell>
                    <TableCell className="text-sm">{h.closedAt ? formatTanggalJam(h.closedAt) : "—"}</TableCell>
                    <TableCell className="text-right text-sm">{h.kpi02Minutes === null ? "—" : `${h.kpi02Minutes} menit`}</TableCell>
                    <TableCell className="text-right text-sm">{h.officeCashDifference === null ? "—" : formatRupiah(h.officeCashDifference, { signed: true })}</TableCell>
                    <TableCell className="text-sm">{h.closedByName ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada riwayat hari kas" compact />
        )}
      </SectionCard>
    </div>
  );
}
