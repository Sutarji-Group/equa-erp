import "server-only";

import type { NotificationPreview } from "@/components/shared/notification-bell";
import type { OfficeShellCounts, OfficeShellUser } from "@/components/shared/office-shell";
import { serverEnv } from "@/lib/env";
import * as approvals from "@/server/core/approvals";
import type { ActiveOfficeSession } from "@/server/core/auth/office";
import { getDb } from "@/server/core/db";
import { enabledFlags } from "@/server/core/flags";
import * as notifications from "@/server/core/notifications";
import { can } from "@/server/core/rbac";
import * as m9 from "@/server/modules/m9-reports";

export type OfficeShellData = {
  user: OfficeShellUser;
  /** String izin `<modul>.<sumberdaya>.<aksi>` dari matriks RBAC untuk peran aktif. */
  permissions: string[];
  counts: OfficeShellCounts;
  enabledFlags: string[];
  notifications: NotificationPreview[];
  /** Lencana lingkungan di samping logo (bukan produksi → "Demo"). */
  environmentLabel?: string;
};

/**
 * Data kerangka web kantor dari sesi nyata (F3c): pengguna & label peran, izin RBAC (menu disaring
 * `filterNavByPermissions`), hitungan persetujuan menunggu (+ lewat tenggat) & notifikasi belum dibaca, pratinjau
 * notifikasi, feature flag aktif. Sesi diperiksa oleh `requireOfficeSession()` di layout.
 */
export async function getOfficeShellData(session: ActiveOfficeSession): Promise<OfficeShellData> {
  const { ctx, user, permissions } = session;
  const db = getDb();

  let approvalsCount = 0;
  let approvalsOverdue = 0;
  let approvalItems: Awaited<ReturnType<typeof approvals.listInbox>> | undefined;
  if (can(ctx, "m10.approval.read")) {
    approvalItems = await approvals.listInbox(ctx, { limit: 500 });
    const decidable = approvalItems.filter((i) => i.canDecide);
    approvalsCount = decidable.length;
    approvalsOverdue = decidable.filter((i) => i.isOverdue).length;
  }
  // Lencana "Kotak masuk" (B-58): hitungan COUNT terindeks + cache singkat per pengguna — bukan membangun kotak masuk
  // penuh di setiap render. Galat tidak menggagalkan kerangka kantor.
  let inbox: number | undefined;
  if (can(ctx, "m9.inbox.read")) {
    inbox = await m9.inboxBadgeCount(ctx, { approvalItems }).then(
      (r) => r.count,
      () => undefined,
    );
  }
  const [unread, recent, flags] = await Promise.all([
    notifications.unreadCount(ctx),
    notifications.list(ctx, { limit: 5 }),
    enabledFlags(db, { tenantId: ctx.tenantId }),
  ]);
  const env = serverEnv();
  return {
    user: { name: user.name, roleLabels: user.roleLabels },
    permissions,
    counts: { approvals: approvalsCount, approvalsOverdue, notifications: unread, inbox },
    enabledFlags: flags,
    notifications: recent.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body ?? undefined,
      at: n.createdAt,
      href: n.link ?? "/notifikasi",
      severity: n.severity === "critical" ? "critical" : n.severity === "high" ? "warning" : "info",
      unread: n.status === "new",
    })),
    environmentLabel: env.VERCEL_ENV === "production" ? undefined : "Demo",
  };
}
