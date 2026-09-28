"use server";

import { revalidatePath } from "next/cache";

import type { ActionState } from "@/components/m1-master/action-state";
import type { RoleCode } from "@/lib/labels";
import { requireOfficeSession } from "@/server/core/auth/office";
import * as m1 from "@/server/modules/m1-master";

import { attempt, str } from "../_lib/form";

const base = "/master/karyawan";

function employeeInput(fd: FormData): m1.EmployeeInput {
  return {
    employeeNo: str(fd, "employeeNo") ?? "",
    fullName: str(fd, "fullName") ?? "",
    nickname: str(fd, "nickname"),
    position: str(fd, "position") ?? "",
    phone: str(fd, "phone"),
    workLocation: str(fd, "workLocation"),
    primaryOutletId: str(fd, "primaryOutletId"),
    intendedRoles: fd.getAll("intendedRoles").filter((v): v is string => typeof v === "string" && v !== "") as RoleCode[],
    hireDate: str(fd, "hireDate"),
    exitDate: str(fd, "exitDate"),
  };
}

export async function createEmployeeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.createEmployee(ctx, employeeInput(fd)).then(() => undefined), "Karyawan ditambahkan. Akun & PIN dibuat di Akses > Pengguna.");
  revalidatePath(base);
  return res;
}

export async function updateEmployeeAction(employeeId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.updateEmployee(ctx, employeeId, employeeInput(fd)).then(() => undefined), "Data karyawan disimpan.");
  revalidatePath(base);
  return res;
}

export async function setEmployeeActiveAction(employeeId: string, active: boolean, reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.setEmployeeActive(ctx, employeeId, { active, reason }).then(() => undefined), active ? "Karyawan diaktifkan." : "Karyawan dinonaktifkan.");
  revalidatePath(base);
  return res;
}
