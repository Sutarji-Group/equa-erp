"use client";

import { ShieldCheck } from "lucide-react";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

import { verifyChainAction, type ChainCheck } from "./actions";

export function VerifyChainButton() {
  const [result, setResult] = useState<ChainCheck | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" disabled={pending} onClick={() => start(async () => setResult(await verifyChainAction()))}>
        <ShieldCheck aria-hidden />
        {pending ? "Memeriksa…" : "Verifikasi keutuhan"}
      </Button>
      {result ? (
        <p role="status" className={result.ok ? "text-sm text-success" : "text-sm text-destructive"}>
          {result.message}
        </p>
      ) : null}
    </div>
  );
}
