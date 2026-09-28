import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { OfficeShell } from "@/components/shared/office-shell";

import { getOfficeShellData } from "./_shell-data";

/**
 * Layout web kantor: kerangka OfficeShell (sidebar dari registri nav, topbar, breadcrumb).
 * TODO(auth): `getOfficeShellData()` masih placeholder (pengguna demo hanya di luar produksi). Agen auth menghubungkan
 * sesi nyata + Server Action keluar (`signOutAction`).
 */
export default async function OfficeLayout({ children }: { children: ReactNode }) {
  const data = await getOfficeShellData();
  if (!data) redirect("/masuk");
  return (
    <OfficeShell user={data.user} permissions={data.permissions} counts={data.counts} environmentLabel={data.environmentLabel}>
      {children}
    </OfficeShell>
  );
}
