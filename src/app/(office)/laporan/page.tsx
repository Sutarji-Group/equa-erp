import { redirect } from "next/navigation";

import { requireOfficeSession } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";

/** /laporan → layar laporan pertama yang boleh dibuka pelaku (H+0 → bulanan → katalog). */
export default async function LaporanIndex() {
  const { ctx } = await requireOfficeSession();
  if (can(ctx, "m9.daily_summary.read")) redirect("/laporan/hari-ini");
  if (can(ctx, "m9.monthly_report.read")) redirect("/laporan/bulanan");
  if (can(ctx, "m9.report.read")) redirect("/laporan/katalog");
  redirect("/beranda?ditolak=1");
}
