import type { ReactNode } from "react";

import { OfficeShell } from "@/components/shared/office-shell";
import { requireOfficeSession } from "@/server/core/auth/office";

import { getOfficeShellData } from "./_shell-data";

/**
 * Layout web kantor: sesi nyata (`requireOfficeSession` → /masuk bila belum masuk / sesi habis, /masuk/2fa bila
 * menunggu 2FA), menu disaring izin RBAC, lencana persetujuan & notifikasi, aksi keluar (`POST /keluar`).
 */
export default async function OfficeLayout({ children }: { children: ReactNode }) {
  const session = await requireOfficeSession();
  const data = await getOfficeShellData(session);
  return (
    <OfficeShell
      user={data.user}
      permissions={data.permissions}
      counts={data.counts}
      enabledFlags={data.enabledFlags}
      notifications={data.notifications}
      environmentLabel={data.environmentLabel}
      signOutAction="/keluar"
    >
      {children}
    </OfficeShell>
  );
}
