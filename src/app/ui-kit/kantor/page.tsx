import type { Metadata } from "next";

import { OfficeDemo } from "../_demos/office-demo";

export const metadata: Metadata = { title: "Kerangka kantor" };

export default function UiKitOfficePage() {
  return <OfficeDemo />;
}
