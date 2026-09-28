import type { Metadata } from "next";
import Link from "next/link";

import { ActionForm } from "@/components/m10-access/action-form";
import { Disclosure, FormRow, M10Badge, NativeSelect, TableScroll, TextArea, TextInput } from "@/components/m10-access/fields";
import { ScopePicker } from "@/components/m10-access/scope-picker";
import { KeyValueList } from "@/components/shared/key-value-list";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { OfficeBreadcrumbLabel } from "@/components/shared/office-shell";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions, label } from "@/lib/labels";
import { formatTanggal, formatTanggalJam, toBusinessDate } from "@/lib/time";
import { describeAudit, queryForActor } from "@/server/core/audit";
import { requirePermission } from "@/server/core/auth/office";
import { can, ROLE_CATALOG } from "@/server/core/rbac";
import { getUserDetail, listScopeOptions } from "@/server/modules/m10-access";

import {
  deactivateUserAction,
  initialPinAction,
  reactivateUserAction,
  requestRoleChangeAction,
  requestScopeAction,
  resetPasswordAction,
  resetPinAction,
  resetTotpAction,
  revokeRoleAction,
  revokeScopeAction,
} from "../actions";

export const metadata: Metadata = { title: "Rincian pengguna" };

/** Rincian pengguna: peran & lingkup (riwayat), sesi, perangkat dipegang, log akses, persetujuan, jejak audit. */
export default async function PenggunaDetailPage({ params }: PageProps<"/akses/pengguna/[id]">) {
  const { ctx } = await requirePermission("m10.user.read");
  const { id } = await params;
  const u = await getUserDetail(ctx, id);
  const isSelf = ctx.userId === u.id;
  const admin = !isSelf;
  const canRequestRole = admin && can(ctx, "m10.role.request") && u.status === "active";
  const canScope = admin && can(ctx, "m10.scope.request") && u.status === "active";
  const canDeactivate = admin && can(ctx, "m10.user.deactivate") && u.status !== "inactive";
  const canReactivate = admin && can(ctx, "m10.user.create") && u.status === "inactive";
  const canPin = admin && can(ctx, "m10.user.reset_pin");
  const canPassword = admin && can(ctx, "m10.user.reset_password");
  const canTotp = admin && can(ctx, "m10.user.reset_totp");
  const options = canRequestRole || canScope || canReactivate ? await listScopeOptions(ctx) : null;
  const isField = u.roles.some((r) => r.status === "active" && ROLE_CATALOG[r.role].isFieldRole);
  const trail = can(ctx, "m10.audit_log.read") ? await queryForActor(ctx, { objectType: ["user", "user_role", "user_scope"], limit: 200 }) : [];
  const roleIds = new Set(u.history.roles.map((r) => r.id));
  const scopeIds = new Set(u.history.scopes.map((s) => s.id));
  const myTrail = trail.filter((r) => r.objectId === u.id || roleIds.has(r.objectId) || scopeIds.has(r.objectId)).slice(0, 30);
  const roleOptions = enumOptions("role").filter((r) => ROLE_CATALOG[r.value].phase === 1);
  const today = toBusinessDate(ctx.now);

  return (
    <>
      <OfficeBreadcrumbLabel label={u.fullName} />
      <PageHeader
        title={u.fullName}
        description={`${u.username} · ${u.employeeNo} · ${u.position}`}
        backHref="/akses/pengguna"
        meta={u.lockedUntil ? <M10Badge enumName="user_status" value="locked" /> : <M10Badge enumName="user_status" value={u.status} />}
      />

      <SectionCard className="mb-6">
        <KeyValueList
          columns={3}
          items={[
            { label: "Login terakhir", value: u.lastLoginAt ? formatTanggalJam(u.lastLoginAt) : "Belum pernah" },
            { label: "2FA", value: u.totpEnabled ? "Terdaftar" : "Belum terdaftar" },
            { label: "PIN lapangan", value: u.hasPin ? "Sudah ditetapkan" : "Belum ditetapkan" },
            { label: "Tanggal keluar (M1)", value: u.exitDate ? formatTanggal(u.exitDate) : "—" },
            { label: "Dinonaktifkan", value: u.deactivatedAt ? `${formatTanggalJam(u.deactivatedAt)} oleh ${u.deactivatedByName ?? "Sistem"}` : "—" },
            { label: "Alasan nonaktif", value: u.deactivationReason ?? "—" },
          ]}
        />
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Peran" description="Hak hanya lewat peran. Pencabutan seketika; pemberian lewat persetujuan pemilik.">
          <ul className="grid gap-2">
            {u.history.roles.map((r) => (
              <li key={r.id} className="rounded-md border p-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{label("role", r.role)}</span>
                  <M10Badge enumName="grant_status" value={r.status} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {r.validFrom ? `Mulai ${formatTanggal(r.validFrom)}` : ""}
                  {r.validUntil ? ` · s.d. ${formatTanggal(r.validUntil)}${r.validUntil < today ? " (lewat masa berlaku)" : ""}` : ""}
                  {r.reason ? ` · ${r.reason}` : ""}
                  {r.revokeReason ? ` · dicabut: ${r.revokeReason}` : ""}
                </p>
                {r.status === "active" && admin && can(ctx, "m10.role.revoke") ? (
                  <Disclosure summary="Cabut peran seketika" className="mt-2">
                    <ActionForm action={revokeRoleAction} submitLabel="Cabut peran" variant="destructive" confirmText="Cabut peran ini sekarang?">
                      <input type="hidden" name="userId" value={u.id} />
                      <input type="hidden" name="roleId" value={r.id} />
                      <FormRow label="Alasan" htmlFor={`cabut-${r.id}`}>
                        <TextInput id={`cabut-${r.id}`} name="reason" required />
                      </FormRow>
                    </ActionForm>
                  </Disclosure>
                ) : null}
              </li>
            ))}
          </ul>
        </SectionCard>

        <SectionCard title="Lingkup" description="Data yang terlihat terikat lingkup (US-M10-01 KP-3). Pengurangan seketika.">
          <ul className="grid gap-2">
            {u.history.scopes.map((s) => (
              <li key={s.id} className="rounded-md border p-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <span className="text-muted-foreground">{label("scope_type", s.scopeType)}:</span> {s.label}
                  </span>
                  <M10Badge enumName="grant_status" value={s.status} />
                </div>
                {s.status === "active" && admin && can(ctx, "m10.scope.revoke") ? (
                  <Disclosure summary="Kurangi lingkup" className="mt-2">
                    <ActionForm action={revokeScopeAction} submitLabel="Kurangi lingkup" variant="destructive">
                      <input type="hidden" name="userId" value={u.id} />
                      <input type="hidden" name="scopeId" value={s.id} />
                      <FormRow label="Alasan" htmlFor={`kurangi-${s.id}`}>
                        <TextInput id={`kurangi-${s.id}`} name="reason" required />
                      </FormRow>
                    </ActionForm>
                  </Disclosure>
                ) : null}
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>

      {canRequestRole || canScope || canDeactivate || canReactivate || canPin || canPassword || canTotp ? (
        <SectionCard title="Tindakan admin sistem" description="Setiap tindakan berjejak; reset kredensial diberitahukan ke pemilik." className="mt-6">
          <div className="grid gap-3">
            {canRequestRole && options ? (
              <Disclosure summary="Ajukan pindah peran / peran tambahan">
                <ActionForm action={requestRoleChangeAction} submitLabel="Ajukan ke pemilik" testId="form-peran">
                  <input type="hidden" name="userId" value={u.id} />
                  <div className="grid gap-3 sm:grid-cols-3">
                    <FormRow label="Jenis permintaan" htmlFor="peran-mode">
                      <NativeSelect id="peran-mode" name="mode" defaultValue="replace">
                        <option value="replace">Pindah/ubah peran (peran lama dicabut)</option>
                        <option value="add">Peran tambahan (multi-peran)</option>
                      </NativeSelect>
                    </FormRow>
                    <FormRow label="Peran" htmlFor="peran-baru">
                      <NativeSelect id="peran-baru" name="role" required defaultValue="">
                        <option value="" disabled>
                          Pilih peran…
                        </option>
                        {roleOptions.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </NativeSelect>
                    </FormRow>
                    <FormRow label="Masa berlaku (wajib untuk peran tambahan)" htmlFor="peran-sampai">
                      <TextInput id="peran-sampai" name="validUntil" type="date" min={today} />
                    </FormRow>
                  </div>
                  <ScopePicker options={options} idPrefix="peran-lingkup" />
                  <FormRow label="Alasan" htmlFor="peran-alasan">
                    <TextArea id="peran-alasan" name="reason" required />
                  </FormRow>
                </ActionForm>
              </Disclosure>
            ) : null}
            {canScope && options ? (
              <Disclosure summary="Ajukan perluasan lingkup">
                <ActionForm action={requestScopeAction} submitLabel="Ajukan ke pemilik">
                  <input type="hidden" name="userId" value={u.id} />
                  <ScopePicker options={options} idPrefix="perluas" />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormRow label="Berlaku sampai (opsional)" htmlFor="perluas-sampai">
                      <TextInput id="perluas-sampai" name="validUntil" type="date" min={today} />
                    </FormRow>
                    <FormRow label="Alasan" htmlFor="perluas-alasan">
                      <TextInput id="perluas-alasan" name="reason" required />
                    </FormRow>
                  </div>
                </ActionForm>
              </Disclosure>
            ) : null}
            {canReactivate && options ? (
              <Disclosure summary="Ajukan aktif kembali">
                <ActionForm action={reactivateUserAction} submitLabel="Ajukan ke pemilik">
                  <input type="hidden" name="userId" value={u.id} />
                  <FormRow label="Peran" htmlFor="aktif-peran">
                    <NativeSelect id="aktif-peran" name="role" required defaultValue="">
                      <option value="" disabled>
                        Pilih peran…
                      </option>
                      {roleOptions.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </NativeSelect>
                  </FormRow>
                  <ScopePicker options={options} idPrefix="aktif-lingkup" />
                  <FormRow label="Alasan" htmlFor="aktif-alasan">
                    <TextInput id="aktif-alasan" name="reason" required />
                  </FormRow>
                </ActionForm>
              </Disclosure>
            ) : null}
            {canPin && isField && u.status === "active" ? (
              <Disclosure summary={u.hasPin ? "Reset PIN" : "Kode aktivasi akun lapangan (PIN pertama)"}>
                {u.hasPin ? (
                  <ActionForm action={resetPinAction} submitLabel="Reset PIN" variant="destructive">
                    <input type="hidden" name="userId" value={u.id} />
                    <FormRow label="Alasan" htmlFor="pin-alasan">
                      <TextInput id="pin-alasan" name="reason" required placeholder="mis. Lupa PIN, diverifikasi tatap muka" />
                    </FormRow>
                  </ActionForm>
                ) : (
                  <ActionForm action={initialPinAction} submitLabel="Terbitkan kode aktivasi">
                    <input type="hidden" name="userId" value={u.id} />
                  </ActionForm>
                )}
              </Disclosure>
            ) : null}
            {canPassword && !isField && u.status === "active" ? (
              <Disclosure summary="Reset kata sandi">
                <ActionForm action={resetPasswordAction} submitLabel="Buat kata sandi sementara" variant="destructive">
                  <input type="hidden" name="userId" value={u.id} />
                  <FormRow label="Alasan & cara verifikasi di luar sistem" htmlFor="sandi-alasan">
                    <TextInput id="sandi-alasan" name="reason" required />
                  </FormRow>
                </ActionForm>
              </Disclosure>
            ) : null}
            {canTotp && u.totpEnabled ? (
              <Disclosure summary="Reset 2FA">
                <ActionForm action={resetTotpAction} submitLabel="Reset 2FA" variant="destructive">
                  <input type="hidden" name="userId" value={u.id} />
                  <FormRow label="Alasan & cara verifikasi di luar sistem" htmlFor="totp-alasan">
                    <TextInput id="totp-alasan" name="reason" required />
                  </FormRow>
                </ActionForm>
              </Disclosure>
            ) : null}
            {canDeactivate ? (
              <Disclosure summary="Nonaktifkan akun seketika">
                <p className="mb-2 text-sm text-muted-foreground">Sesi aktif diputus, perangkat yang dipegangnya diblokir. Data yang pernah dibuat tetap utuh dan merujuk namanya.</p>
                <ActionForm action={deactivateUserAction} submitLabel="Nonaktifkan" variant="destructive" confirmText="Nonaktifkan akun ini sekarang?">
                  <input type="hidden" name="userId" value={u.id} />
                  <FormRow label="Alasan" htmlFor="nonaktif-alasan">
                    <TextInput id="nonaktif-alasan" name="reason" required placeholder="mis. Keluar per hari ini" />
                  </FormRow>
                </ActionForm>
              </Disclosure>
            ) : null}
          </div>
        </SectionCard>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <SectionCard title="Sesi" description="Sesi web & perangkat terbaru.">
          {u.sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada sesi.</p>
          ) : (
            <ul className="grid gap-1 text-sm">
              {u.sessions.map((s) => (
                <li key={s.id} className="flex flex-wrap justify-between gap-2 border-b py-1">
                  <span>
                    {s.kind === "web" ? "Web kantor" : `Perangkat ${s.deviceCode ?? ""}`} · {formatTanggalJam(s.createdAt)}
                  </span>
                  <span className="text-muted-foreground">{s.revokedAt ? `berakhir (${s.revokeReason ?? "-"})` : "aktif"}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        <SectionCard title="Perangkat yang dipegang">
          {u.devicesHeld.length === 0 ? (
            <p className="text-sm text-muted-foreground">Tidak ada.</p>
          ) : (
            <ul className="grid gap-1 text-sm">
              {u.devicesHeld.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-2">
                  <Link href={`/akses/perangkat/${d.id}`} className="text-primary underline-offset-4 hover:underline">
                    {d.code} — {d.name}
                  </Link>
                  <StatusBadge enumName="device_status" value={d.status} />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <SectionCard title="Permintaan persetujuan terkait" className="mt-6">
        {u.approvals.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada.</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {u.approvals.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-1">
                <span>
                  <span className="tabular font-medium">{a.number}</span> · {label("approval_type", a.type)} · {u.names.get(a.requesterUserId) ?? "—"}
                  {a.decidedBy ? ` → ${u.names.get(a.decidedBy) ?? "—"}` : ""}
                  {a.overdueAt ? " · lewat tenggat" : ""}
                </span>
                <StatusBadge enumName="approval_status" value={a.status} />
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <SectionCard title="Log akses terbaru">
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Waktu</TableHead>
                  <TableHead>Kejadian</TableHead>
                  <TableHead>Keterangan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {u.recentAccess.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>{formatTanggalJam(l.occurredAt)}</TableCell>
                    <TableCell>
                      <ToneBadge tone={l.success ? "neutral" : "danger"}>{label("access_event", l.event)}</ToneBadge>
                    </TableCell>
                    <TableCell className="max-w-xs whitespace-normal text-xs">{l.reason ?? ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </SectionCard>
        <SectionCard title="Riwayat perubahan akses (jejak audit)">
          {myTrail.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada catatan.</p>
          ) : (
            <ol className="grid gap-2 text-sm">
              {myTrail.map((r) => (
                <li key={r.id}>
                  <p>{describeAudit(r, { actorName: r.actorUserId ? u.names.get(r.actorUserId) : null })}</p>
                  <p className="text-xs text-muted-foreground">{formatTanggalJam(r.serverTime)}</p>
                </li>
              ))}
            </ol>
          )}
        </SectionCard>
      </div>
    </>
  );
}
