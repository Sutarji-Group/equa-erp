import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireOfficeSession } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { getDb } from "@/server/core/db";
import * as notifications from "@/server/core/notifications";
import * as params from "@/server/core/params";

import { PreferenceSelect, QuietHoursForm } from "./preference-controls";

export const metadata: Metadata = { title: "Pengaturan notifikasi" };

/** Preferensi notifikasi per jenis (US-M9-04 KP-3): seketika / ringkasan harian / mati; kritis terkunci; jam tenang. */
export default async function NotificationSettingsPage() {
  const { ctx } = await requireOfficeSession();
  const prefs = await notifications.getPreferences(ctx);
  const quietDefault = await params.get(getDb(), "PAR-56", ctxBusinessDate(ctx));
  const defaultText = `${quietDefault.start.replace(":", ".")}–${quietDefault.end.replace(":", ".")}`;

  return (
    <>
      <PageHeader
        title="Pengaturan notifikasi"
        description="Atur cara Anda menerima tiap jenis notifikasi. Notifikasi kritis selalu dikirim seketika dan tidak dapat dimatikan."
      />
      <SectionCard title="Jam tenang" description={`Push notifikasi non-kritis ditahan pada jam ini. Bawaan: ${defaultText} (PAR-56).`} className="mb-6">
        <QuietHoursForm start={prefs.quietHours?.start ?? ""} end={prefs.quietHours?.end ?? ""} defaultText={defaultText} />
      </SectionCard>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Jenis</TableHead>
            <TableHead className="hidden sm:table-cell">Tingkat</TableHead>
            <TableHead>Cara menerima</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {prefs.items.map((p) => (
            <TableRow key={p.event}>
              <TableCell className="whitespace-normal">{p.label}</TableCell>
              <TableCell className="hidden sm:table-cell">
                <StatusBadge enumName="notification_severity" value={p.severity} />
              </TableCell>
              <TableCell>
                <PreferenceSelect event={p.event} mode={p.mode} canDisable={p.canDisable} label={p.label} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
