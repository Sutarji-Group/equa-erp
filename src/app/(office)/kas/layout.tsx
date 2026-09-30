import type { ReactNode } from "react";

import { CashPhotoLimitProvider } from "@/components/m4-cash/photo-limit";
import { requireOfficeSession } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { getDb } from "@/server/core/db";
import * as params from "@/server/core/params";

/**
 * Layout /kas/*: batas foto PAR-38 (tenant pengguna, tanggal bisnis hari ini) untuk kompresi foto slip/bukti di peramban
 * (D-14 butir 2). Izin halaman tetap diperiksa tiap halaman (`requirePermission`).
 */
export default async function CashLayout({ children }: { children: ReactNode }) {
  const { ctx } = await requireOfficeSession();
  const photo = await params.get(getDb(), "PAR-38", ctxBusinessDate(ctx), { tenantId: ctx.tenantId }).catch(() => null);
  return <CashPhotoLimitProvider maxKb={photo?.max_kb ?? null}>{children}</CashPhotoLimitProvider>;
}
