import type { Metadata } from "next";

import { P2ActionForm } from "@/components/p2-customer/action-form";
import { P2OfficeTabs } from "@/components/p2-customer/office-tabs";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { hasRole } from "@/server/core/context";
import { can } from "@/server/core/rbac";
import { formatWaNumber } from "@/server/core/wa";
import * as p2 from "@/server/modules/p2-customer";

import { p2Tabs } from "../_tabs";
import { officeChangePhoneAction, setAppEnabledAction, verifyAccountAction } from "../actions";

export const metadata: Metadata = { title: "Akun pelanggan" };

/**
 * Akun aplikasi pelanggan (US-P2-01 KP-2/KP-4/KP-5, 8.7): aktivasi aplikasi oleh pemilik setelah prasyarat TG-9 (D-02),
 * verifikasi nama yang tidak cocok (tautkan / pelanggan baru / tolak), ganti nomor lewat Dispatcher, permintaan hapus
 * akun (diteruskan ke anonimisasi M10), daftar akun.
 */
export default async function AkunPelangganPage() {
  const { ctx } = await requirePermission("p2.customer_account.read");
  const [status, requests, accounts] = await Promise.all([p2.customerAppStatus(ctx), p2.listAccountRequests(ctx), p2.listAccounts(ctx)]);
  const canVerify = can(ctx, "p2.customer_account.verify");
  const isOwner = hasRole(ctx, "owner");
  const open = requests.filter((r) => r.status === "open");
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Akun pelanggan"
        description="Akun aplikasi pelanggan (nomor WhatsApp + OTP). Data pelanggan & alamat tetap di Data master."
        actions={<ExportButtons excelHref="/api/export/p2.customer_accounts?format=xlsx" />}
      />
      <P2OfficeTabs tabs={p2Tabs(ctx)} current="/keluhan/akun" />

      <SectionCard
        title="Status aplikasi pelanggan"
        description="Aktifkan setelah prasyarat masuk Tahap 2 (8.1: Tahap 1 stabil, koordinat alamat terkunci, WhatsApp Business API, gerbang pembayaran, kapasitas rit) terpenuhi."
        actions={<ToneBadge tone={status.enabled ? "success" : "muted"} dot>{status.enabled ? "Aktif" : "Belum aktif"}</ToneBadge>}
      >
        {isOwner ? (
          <P2ActionForm action={setAppEnabledAction.bind(null, !status.enabled)} submitLabel={status.enabled ? "Nonaktifkan aplikasi" : "Aktifkan aplikasi pelanggan"} variant={status.enabled ? "destructive" : "default"} testId="toggle-app">
            <input name="reason" required minLength={5} placeholder="Alasan / rujukan keputusan TG-9" className="h-9 rounded-md border border-input bg-background px-2 text-sm" />
          </P2ActionForm>
        ) : (
          <p className="text-sm text-muted-foreground">Hanya pemilik yang dapat mengaktifkan/menonaktifkan aplikasi.</p>
        )}
      </SectionCard>

      <SectionCard title={`Permintaan menunggu (${open.length})`} description="Verifikasi nama tidak cocok (nomor berganti pemilik, 8.7) & permintaan hapus akun (UU PDP).">
        {open.length === 0 ? (
          <p className="text-sm text-muted-foreground">Tidak ada permintaan menunggu.</p>
        ) : (
          <ul className="grid gap-4" data-testid="account-requests">
            {open.map((r) => (
              <li key={r.id} className="rounded-lg border p-4">
                <p className="font-medium">
                  {label("customer_account_request_kind", r.kind)} · {formatWaNumber(r.account.phone)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {r.reason} · {formatTanggalJam(r.createdAt)}
                </p>
                {r.kind === "review" ? (
                  <>
                    <p className="mt-1 text-sm">
                      Nama diisi: <strong>{r.detail}</strong>
                      {r.candidate ? (
                        <>
                          {" "}
                          · data pelanggan nomor ini: <strong>{r.candidate.name}</strong> ({r.candidate.code})
                        </>
                      ) : null}
                    </p>
                    {canVerify ? (
                      <div className="mt-3 grid gap-3 md:grid-cols-3">
                        {r.candidate ? (
                          <P2ActionForm action={verifyAccountAction.bind(null, r.id)} submitLabel="Tautkan ke pelanggan ini" size="sm">
                            <input type="hidden" name="decision" value="link" />
                            <input type="hidden" name="customerId" value={r.candidate.id} />
                            <input name="note" required minLength={3} placeholder="Catatan (mis. sudah ditelepon)" className="h-9 rounded-md border border-input bg-background px-2 text-sm" />
                          </P2ActionForm>
                        ) : null}
                        <P2ActionForm action={verifyAccountAction.bind(null, r.id)} submitLabel="Buat pelanggan baru (Tunai)" size="sm" variant="secondary">
                          <input type="hidden" name="decision" value="new_customer" />
                          <input name="addressText" required minLength={5} placeholder="Alamat pelanggan baru" className="h-9 rounded-md border border-input bg-background px-2 text-sm" />
                          <input name="note" required minLength={3} placeholder="Catatan verifikasi" className="h-9 rounded-md border border-input bg-background px-2 text-sm" />
                        </P2ActionForm>
                        <P2ActionForm action={verifyAccountAction.bind(null, r.id)} submitLabel="Tolak akun" size="sm" variant="destructive">
                          <input type="hidden" name="decision" value="reject" />
                          <input name="note" required minLength={3} placeholder="Alasan penolakan" className="h-9 rounded-md border border-input bg-background px-2 text-sm" />
                        </P2ActionForm>
                      </div>
                    ) : null}
                  </>
                ) : r.kind === "deletion" ? (
                  <p className="mt-1 text-sm">
                    Akun sudah dinonaktifkan. Admin sistem mencatat permintaan anonimisasi di <a className="text-primary underline" href="/akses/data-pribadi">Akses &gt; Data pribadi</a>; pemilik menyetujui.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title={`Akun (${accounts.length})`} flush>
        <Table data-testid="accounts">
          <TableHeader>
            <TableRow>
              <TableHead>Nomor WA</TableHead>
              <TableHead>Nama / pelanggan</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden md:table-cell">Masuk terakhir</TableHead>
              {canVerify ? <TableHead>Ganti nomor</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="whitespace-nowrap">{a.phone.startsWith("anon-") ? "(dianonimkan)" : formatWaNumber(a.phone)}</TableCell>
                <TableCell>
                  {a.displayName ?? "—"}
                  <span className="block text-xs text-muted-foreground">{a.customerName ? `${a.customerName} (${a.customerCode})` : "Belum terhubung"}</span>
                </TableCell>
                <TableCell>
                  <StatusBadge enumName="customer_account_status" value={a.status} tone={a.status === "linked" ? "success" : a.status === "pending_review" ? "warning" : a.status === "inactive" ? "muted" : "info"} />
                </TableCell>
                <TableCell className="hidden md:table-cell">{a.lastLoginAt ? formatTanggalJam(a.lastLoginAt) : "—"}</TableCell>
                {canVerify ? (
                  <TableCell>
                    {a.status !== "inactive" ? (
                      <details>
                        <summary className="cursor-pointer text-xs text-primary">Ganti</summary>
                        <P2ActionForm action={officeChangePhoneAction.bind(null, a.id)} submitLabel="Ganti nomor" size="sm" className="mt-2">
                          <input name="newPhone" required placeholder="Nomor baru" className="h-8 rounded-md border border-input bg-background px-2 text-xs" />
                          <input name="reason" required minLength={5} placeholder="Alasan (pelanggan diverifikasi)" className="h-8 rounded-md border border-input bg-background px-2 text-xs" />
                        </P2ActionForm>
                      </details>
                    ) : null}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SectionCard>
    </div>
  );
}
