import type { Metadata } from "next";

import { ReasonActionButton } from "@/components/m1-master/action-buttons";
import { ActionForm } from "@/components/m1-master/action-form";
import { FormGrid, SelectField, TextField, type Option } from "@/components/m1-master/fields";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTanggal } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m1 from "@/server/modules/m1-master";

import { createEmployeeAction, setEmployeeActiveAction, updateEmployeeAction } from "./actions";

export const metadata: Metadata = { title: "Karyawan" };

type Emp = Awaited<ReturnType<typeof m1.listEmployees>>[number];

function EmployeeFields({ outlets, roles, e }: { outlets: Option[]; roles: Option[]; e?: Emp }) {
  return (
    <div className="grid gap-3">
      <FormGrid>
        <TextField label="Nomor karyawan" name="employeeNo" defaultValue={e?.employeeNo ?? ""} required readOnly={!!e} placeholder="EQ-050" />
        <TextField label="Nama lengkap" name="fullName" defaultValue={e?.fullName ?? ""} required />
        <TextField label="Nama panggilan" name="nickname" defaultValue={e?.nickname ?? ""} />
        <TextField label="Jabatan" name="position" defaultValue={e?.position ?? ""} required />
        <TextField label="Telepon" name="phone" defaultValue={e?.phone ?? ""} inputMode="tel" />
        <TextField label="Lokasi tugas" name="workLocation" defaultValue={e?.workLocation ?? ""} />
        <SelectField label="Outlet utama" name="primaryOutletId" defaultValue={e?.primaryOutletId ?? ""} options={outlets} placeholder="— Tidak ada —" />
        <TextField label="Tanggal masuk" name="hireDate" type="date" defaultValue={e?.hireDate ?? ""} />
        <TextField label="Tanggal keluar" name="exitDate" type="date" defaultValue={e?.exitDate ?? ""} hint="Akses dicabut pada tanggal ini (BR-37)." />
      </FormGrid>
      <fieldset className="grid gap-1">
        <legend className="text-sm font-medium">Peran sistem (rencana; peran efektif diatur di Akses &gt; Pengguna)</legend>
        <div className="flex flex-wrap gap-3">
          {roles.map((r) => (
            <label key={r.value} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" name="intendedRoles" value={r.value} defaultChecked={e?.intendedRoles?.includes(r.value as never)} className="size-4 accent-primary" />
              {r.label}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

/** Karyawan (US-M1-04 KP-3): nama, jabatan, lokasi tugas, peran, tanggal masuk/keluar; nonaktif, bukan dihapus. */
export default async function KaryawanPage() {
  const { ctx } = await requirePermission("m1.employee.read");
  const [employees, opts] = await Promise.all([m1.listEmployees(ctx), m1.employeeFormOptions(ctx)]);
  const canCreate = can(ctx, "m1.employee.create");
  const canUpdate = can(ctx, "m1.employee.update");
  const canDeactivate = can(ctx, "m1.employee.deactivate");

  return (
    <div className="grid gap-6">
      <PageHeader title="Karyawan" description="Data karyawan (akun, PIN, dan peran efektif di modul Akses)." actions={<ExportButtons excelHref="/api/export/m1.employees?format=xlsx" />} />
      <SectionCard flush>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Karyawan</TableHead>
                <TableHead className="hidden md:table-cell">Jabatan & peran</TableHead>
                <TableHead className="hidden lg:table-cell">Lokasi</TableHead>
                <TableHead>Masuk / keluar</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {employees.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    <div className="font-medium">{e.fullName}</div>
                    <div className="text-xs text-muted-foreground">{e.employeeNo}</div>
                    {canUpdate || canDeactivate ? (
                      <details className="mt-1 text-sm">
                        <summary className="cursor-pointer text-primary">Ubah</summary>
                        <div className="mt-2 grid gap-3">
                          {canUpdate ? (
                            <ActionForm action={updateEmployeeAction.bind(null, e.id)} submitLabel="Simpan" resetOnSuccess={false}>
                              <EmployeeFields outlets={opts.outlets} roles={opts.roles} e={e} />
                            </ActionForm>
                          ) : null}
                          {canDeactivate ? (
                            e.isActive ? (
                              <ReasonActionButton label="Nonaktifkan" title={`Nonaktifkan ${e.fullName}?`} action={setEmployeeActiveAction.bind(null, e.id, false)} destructive />
                            ) : (
                              <ReasonActionButton label="Aktifkan" title={`Aktifkan ${e.fullName}?`} action={setEmployeeActiveAction.bind(null, e.id, true)} />
                            )
                          ) : null}
                        </div>
                      </details>
                    ) : null}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <div>{e.position}</div>
                    <div className="text-xs text-muted-foreground">{e.rolesText || "—"}</div>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">{e.outletName ?? e.workLocation ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm">
                    {e.hireDate ? formatTanggal(e.hireDate, { weekday: false }) : "—"}
                    {e.exitDate ? <div className="text-destructive">Keluar {formatTanggal(e.exitDate, { weekday: false })}</div> : null}
                  </TableCell>
                  <TableCell>{e.isActive ? <ToneBadge tone="success">Aktif</ToneBadge> : <ToneBadge tone="muted">Nonaktif</ToneBadge>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
      {canCreate ? (
        <SectionCard title="Karyawan baru" description="Pengaitan ke akun pengguna & PIN dilakukan di Akses > Pengguna (M10).">
          <ActionForm action={createEmployeeAction} submitLabel="Tambah karyawan">
            <EmployeeFields outlets={opts.outlets} roles={opts.roles} />
          </ActionForm>
        </SectionCard>
      ) : null}
    </div>
  );
}
