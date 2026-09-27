// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/button";

describe("components/ui — lingkungan happy-dom + Testing Library", () => {
  afterEach(() => cleanup());

  it("Button merender teks Indonesia dan menerima klik", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Simpan</Button>);
    const button = screen.getByRole("button", { name: "Simpan" });
    expect(button.getAttribute("data-slot")).toBe("button");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
