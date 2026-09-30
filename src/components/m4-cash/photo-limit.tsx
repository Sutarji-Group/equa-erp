"use client";

/**
 * Batas foto PAR-38 untuk formulir kas kantor (/kas/*): nilai dibaca server (`src/app/(office)/kas/layout.tsx`) lalu
 * diteruskan lewat konteks ke `CashActionForm`/`ReceiveDepositForm`, sehingga kompresi foto slip/bukti di peramban
 * mengikuti parameter — bukan konstanta (D-14 butir 2). Tanpa penyedia → bawaan PAR-38.
 */
import { createContext, type ReactNode, useContext } from "react";

import { photoMaxBytes } from "@/client/media/compress-image";

const CashPhotoLimitContext = createContext<number | null>(null);

export function CashPhotoLimitProvider({ maxKb, children }: { maxKb: number | null; children: ReactNode }) {
  return <CashPhotoLimitContext.Provider value={maxKb}>{children}</CashPhotoLimitContext.Provider>;
}

/** Batas byte foto formulir kas (PAR-38 dari server; bawaan 150 KB). */
export function useCashPhotoMaxBytes(): number {
  return photoMaxBytes(useContext(CashPhotoLimitContext));
}
