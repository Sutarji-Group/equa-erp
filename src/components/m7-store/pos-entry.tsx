"use client";

import { FieldGate } from "@/components/field/field-gate";
import { PosScreen } from "@/components/m6-pos/pos-app";
import { PosProvider, usePos } from "@/components/m6-pos/pos-context";

import { StorePosScreen } from "./store-pos-screen";

/** Pilih layar menurut jenis outlet perangkat: toko → POS toko (M7), selain itu → POS depot (M6). */
function PosModeSwitch() {
  const { ref } = usePos();
  if (ref?.outlet?.kind === "store") return <StorePosScreen />;
  return <PosScreen />;
}

/** Aplikasi POS satu basis kode untuk depot & toko (PRD 7.7.2, D-07): gerbang perangkat + PIN, lalu mode outlet. */
export function PosEntry() {
  return (
    <FieldGate home="/pos">
      <PosProvider>
        <PosModeSwitch />
      </PosProvider>
    </FieldGate>
  );
}
