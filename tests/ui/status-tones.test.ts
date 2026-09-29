import { describe, expect, it } from "vitest";

import { STATUS_TONES, statusTone } from "@/components/shared/status-badge";
import { enumValues, type EnumName } from "@/lib/labels";

describe("STATUS_TONES bersama", () => {
  it("B-38 US-M4-04 transfer masuk Dibatalkan bernada 'muted' (M4 memakai StatusBadge)", () => {
    expect(statusTone("incoming_transfer_status", "cancelled")).toBe("muted");
  });

  it("B-38 setiap nilai enum yang terdaftar di STATUS_TONES punya nada (tidak jatuh ke bawaan)", () => {
    const missing: string[] = [];
    for (const [name, tones] of Object.entries(STATUS_TONES) as [EnumName, Record<string, string>][]) {
      for (const value of enumValues(name)) if (!tones[value]) missing.push(`${name}.${value}`);
    }
    expect(missing).toEqual([]);
  });
});
