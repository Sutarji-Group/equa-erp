import { UserCog } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ActionForm } from "@/components/m10-access/action-form";
import { FormRow, M10Badge, NativeSelect, TableScroll, TextArea, TextInput } from "@/components/m10-access/fields";
import { ScopePicker } from "@/components/m10-access/scope-picker";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions, label, type UserStatus } from "@/lib/labels";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can, ROLE_CATALOG } from "@/server/core/rbac";
import { initialAccountsStatus, listEmployeesWithoutAccount, listScopeOptions, listUsers } from "@/server/modules/m10-access";

import { createUserAction, prepareInitialAccountsAction, signInitialAccountsAction } from "./actions";

export const metadata: Metadata = { title: "Pengguna" };

const STATUS_FILTERS = [
  { value: "all", label: "Semua" },
  { value: "pending", label: "Menunggu persetujuan" },
  { value: "active", label: "Aktif" },
  { value: "inactive", label: "Nonaktif" },
] as const;

/**
 * Pengguna (US-M10-01): akun dari karyawan M1 (satu orang satu akun, BR-36), peran dari katalog tetap, lingkup; akun
 * baru aktif setelah disetujui pemilik (6.2a); akun awal go-live disetujui sekaligus (NFR-34).
 */
export default async function PenggunaPage({ searchParams }: PageProps<"/akses/pengguna">) {
  const { ctx } = await requirePermission("m10.user.read");
  const sp = await searchParams;
  const status = (typeof sp.status === "string" ? sp.status : "all") as UserStatus | "pending" | "all";
  const q = typeof sp.q === "string" ? sp.q : "";
  const users = await listUsers(ctx, { status, q });
  const canCreate = can(ctx, "m10.user.create");
  const canSign = can(ctx, "m10.initial_accounts.sign");
  const initial = await initialAccountsStatus(ctx);
  const [employees, options] = canCreate ? await Promise.all([listEmployeesWithoutAccount(ctx), listScopeOptions(ctx)]) : [[], null];
  const roleOptions = enumOptions("role").filter((r) => ROLE_CATALOG[r.value as keyof typeof ROLE_CATALOG]?.phase === 1);

  return (
    <>
      <PageHeader
        title="Pengguna"
        description="Satu orang satu akun, terikat karyawan. Hak hanya lewat peran. Akun, peran, dan perluasan lingkup aktif setelah disetujui pemilik; pencabutan berlaku seketika."
        actions={<ExportButtons excelHref="/api/export/m10.users?format=xlsx" pdfHref="/api/export/m10.users?format=pdf" />}
      />

      <SectionCard className="mb-6">
        <form method="get" className="grid gap-3 sm:grid-cols-[1fr_220px_auto] sm:items-end">
          <FormRow label="Cari nama / nama pengguna / no. karyawan" htmlFor="cari-pengguna">
            <TextInput id="cari-pengguna" name="q" defaultValue={q} placeholder="mis. sopir1 atau Asep" />
          </FormRow>
          <FormRow label="Status" htmlFor="status-pengguna">
            <NativeSelect id="status-pengguna" name="status" defaultValue={status}>
              {STATUS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </NativeSelect>
          </FormRow>
          <Button type="submit" variant="outline">
            Tampilkan
          </Button>
        </form>
      </SectionCard>

      {users.length === 0 ? (
        <EmptyState icon={UserCog} title="Tidak ada pengguna" description="Ubah pencarian atau buat akun dari data karyawan." />
      ) : (
        <SectionCard title={`${users.length} pengguna`} flush>
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nama</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Peran</TableHead>
                  <TableHead className="hidden md:table-cell">Lingkup</TableHead>
                  <TableHead className="hidden sm:table-cell">Login terakhir</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="whitespace-normal">
                      <Link href={`/akses/pengguna/${u.id}`} className="font-medium text-primary underline-offset-4 hover:underline">
                        {u.fullName}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {u.username} · {u.employeeNo}
                      </p>
                    </TableCell>
                    <TableCell>
                      {u.lockedUntil ? <M10Badge enumName="user_status" value="locked" /> : <M10Badge enumName="user_status" value={u.status} />}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="flex flex-wrap gap-1">
                        {u.roles.map((r) => (
                          <ToneBadge key={r.id} tone={r.status === "pending" ? "warning" : r.expired ? "danger" : "neutral"}>
                            {label("role", r.role)}
                            {r.status === "pending" ? " (menunggu)" : r.validUntil ? ` s.d. ${r.validUntil}` : ""}
                          </ToneBadge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="hidden max-w-xs whitespace-normal text-sm md:table-cell">{u.scopes.map((s) => s.label).join(", ") || "—"}</TableCell>
                    <TableCell className="hidden sm:table-cell">{u.lastLoginAt ? formatTanggalJam(u.lastLoginAt) : "Belum pernah"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </SectionCard>
      )}

      {canCreate && options ? (
        <SectionCard title="Buat akun dari karyawan" description="Pilih karyawan dari master M1 (hanya yang belum punya akun), satu peran, dan lingkupnya." className="mt-6">
          <ActionForm action={createUserAction} submitLabel="Ajukan akun" testId="form-buat-akun">
            <div className="grid gap-3 sm:grid-cols-3">
              <FormRow label="Karyawan" htmlFor="akun-karyawan">
                <NativeSelect id="akun-karyawan" name="employeeId" required defaultValue="">
                  <option value="" disabled>
                    Pilih karyawan…
                  </option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.fullName} ({e.employeeNo}) — {e.position}
                    </option>
                  ))}
                </NativeSelect>
              </FormRow>
              <FormRow label="Nama pengguna" htmlFor="akun-username" hint="Huruf kecil/angka; tidak boleh dipakai bersama.">
                <TextInput id="akun-username" name="username" required autoComplete="off" placeholder="mis. sopir8" />
              </FormRow>
              <FormRow label="Peran" htmlFor="akun-peran">
                <NativeSelect id="akun-peran" name="role" required defaultValue="">
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
            </div>
            <ScopePicker options={options} idPrefix="akun-lingkup" />
            <FormRow label="Alasan / dasar permintaan" htmlFor="akun-alasan">
              <TextArea id="akun-alasan" name="reason" required placeholder="mis. Sopir baru truk T8 mulai 1 Oktober" />
            </FormRow>
            {!initial.signed ? (
              <label className="flex items-center gap-2 text-sm" htmlFor="akun-awal">
                <input type="checkbox" id="akun-awal" name="initialLoad" className="size-4" />
                Akun awal go-live (disetujui sekaligus lewat tanda tangan daftar akun awal, NFR-34)
              </label>
            ) : null}
          </ActionForm>
        </SectionCard>
      ) : null}

      {!initial.signed && (canCreate || canSign) ? (
        <SectionCard
          title="Akun awal go-live"
          description="Saat go-live, akun awal disetujui pemilik sekaligus per daftar bersama tanda tangan data awal (US-M10-01 KP-8), bukan satu per satu."
          className="mt-6"
        >
          <p className="mb-3 text-sm">
            Akun awal menunggu: <strong>{initial.pending.length}</strong>
            {initial.draft ? ` · Daftar siap ditandatangani: ${initial.draft.title}` : ""}
          </p>
          {initial.draft ? (
            <ul className="mb-3 grid gap-1 text-sm">
              {((initial.draft.summary as { accounts?: { userId: string; name: string; username: string; roles: string[] }[] }).accounts ?? []).slice(0, 30).map((a) => (
                <li key={a.userId}>
                  {a.name} ({a.username}) — {a.roles.map((r) => label("role", r as never)).join(", ")}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap gap-3">
            {canCreate && initial.pending.length > 0 ? <ActionForm action={prepareInitialAccountsAction} submitLabel="Susun daftar untuk ditandatangani" variant="outline" /> : null}
            {canSign && initial.draft ? (
              <ActionForm action={signInitialAccountsAction} submitLabel="Tanda tangani & aktifkan semua" confirmText="Aktifkan seluruh akun awal di daftar ini?">
                <input type="hidden" name="signoffId" value={initial.draft.id} />
              </ActionForm>
            ) : null}
          </div>
        </SectionCard>
      ) : initial.signed ? (
        <p className="mt-6 text-sm text-muted-foreground">
          Daftar akun awal ditandatangani {initial.signed.signedAt ? formatTanggalJam(initial.signed.signedAt) : ""}. Akun baru lewat persetujuan pemilik.
        </p>
      ) : null}
    </>
  );
}
