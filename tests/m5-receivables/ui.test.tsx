// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BucketBadge, dueText, hrefWith, PiiExportForm, ReminderBadge } from "@/components/m5-receivables/ui";

describe("Komponen layar Piutang (src/components/m5-receivables)", () => {
  afterEach(() => cleanup());

  it("US-M5-04 KP-4 ekspor ber-data pelanggan lewat POST dengan tujuan wajib (BR-39) dan saringan ikut terkirim", () => {
    render(<PiiExportForm reportKey="m5.aging" filters={{ asOf: "2026-09-28", segment: null }} testId="ekspor" />);
    const form = screen.getByTestId("ekspor") as HTMLFormElement;
    expect(form.method.toLowerCase()).toBe("post");
    expect(form.getAttribute("action")).toBe("/api/export/m5.aging");
    const purpose = screen.getByLabelText("Tujuan ekspor") as HTMLInputElement;
    expect(purpose.required).toBe(true);
    expect(purpose.minLength).toBe(5);
    expect((form.querySelector('input[name="asOf"]') as HTMLInputElement).value).toBe("2026-09-28");
    expect(form.querySelector('input[name="segment"]')).toBeNull();
    expect(screen.getByRole("button", { name: /Excel/ }).getAttribute("value")).toBe("xlsx");
    expect(screen.getByRole("button", { name: /PDF/ }).getAttribute("value")).toBe("pdf");
  });

  it("US-M5-04 KP-1 lencana kelompok umur & status pengingat berlabel Bahasa Indonesia", () => {
    render(
      <div>
        <BucketBadge bucket="over_30" />
        <ReminderBadge status="opened" />
      </div>,
    );
    expect(screen.getByText("> 30 hari")).toBeTruthy();
    expect(screen.getByText("Dibuka")).toBeTruthy();
  });

  it("US-M5-04 KP-3 teks jatuh tempo & URL saringan", () => {
    expect(dueText(3)).toBe("3 hari lewat");
    expect(dueText(0)).toBe("jatuh tempo hari ini");
    expect(dueText(-2)).toBe("jatuh tempo 2 hari lagi");
    expect(hrefWith("/piutang/faktur", { status: "unpaid", q: "", lewat: true, x: null })).toBe("/piutang/faktur?status=unpaid&lewat=1");
  });
});
