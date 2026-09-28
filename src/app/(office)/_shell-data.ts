import "server-only";

import type { OfficeShellCounts, OfficeShellUser } from "@/components/shared/office-shell";

export type OfficeShellData = {
  user: OfficeShellUser;
  /** String izin `<modul>.<sumberdaya>.<aksi>`; wildcard `*` = semua. */
  permissions: string[];
  counts: OfficeShellCounts;
  /** Lencana lingkungan di samping logo (mis. "Demo"). */
  environmentLabel?: string;
};

/** Pengguna demo khusus pengembangan (BUKAN untuk produksi). */
const DEV_DEMO_SHELL: OfficeShellData = {
  user: { name: "Pengguna Demo", roleLabels: ["Pemilik"] },
  permissions: ["*"],
  counts: { approvals: 3, approvalsOverdue: 1, notifications: 5, inbox: 2 },
  environmentLabel: "Demo",
};

/**
 * Data kerangka web kantor (pengguna, izin, hitungan lencana).
 *
 * TODO(auth): agen auth (M10) mengganti isi fungsi ini dengan sesi nyata — baca cookie `equa_session`, muat pengguna,
 * peran aktif (`label("role", code)`), izin dari matriks RBAC, hitungan persetujuan/notifikasi/kotak masuk — dan
 * mengembalikan `null` bila belum masuk (layout lalu mengarahkan ke `/masuk`).
 *
 * Sementara itu: pengguna demo HANYA bila `NODE_ENV !== "production"`; di produksi selalu `null`.
 */
export async function getOfficeShellData(): Promise<OfficeShellData | null> {
  if (process.env.NODE_ENV === "production") return null;
  return DEV_DEMO_SHELL;
}
