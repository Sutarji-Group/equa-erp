import type { Metadata } from "next";

import { PosDemo } from "../_demos/pos-demo";

export const metadata: Metadata = { title: "POS" };

export default function UiKitPosPage() {
  return (
    <div data-theme="field" className="flex min-h-dvh flex-1 flex-col">
      <PosDemo />
    </div>
  );
}
