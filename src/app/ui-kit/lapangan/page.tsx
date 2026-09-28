import type { Metadata } from "next";

import { FieldDemo } from "../_demos/field-demo";

export const metadata: Metadata = { title: "Aplikasi lapangan" };

export default function UiKitFieldPage() {
  return (
    <div data-theme="field" className="flex min-h-dvh flex-1 flex-col">
      <FieldDemo />
    </div>
  );
}
