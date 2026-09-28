import type { Metadata } from "next";

import { AuthDemo } from "../_demos/auth-demo";

export const metadata: Metadata = { title: "Masuk & perangkat" };

export default function UiKitAuthPage() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-8">
      <h1 className="text-3xl font-bold tracking-tight">Komponen masuk & perangkat</h1>
      <AuthDemo />
    </div>
  );
}
