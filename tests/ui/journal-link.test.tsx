// @vitest-environment happy-dom
/**
 * B-55 — ketertelusuran dua arah: layar rincian transaksi menautkan jurnalnya (`/akuntansi/jurnal?sumberTipe=&sumberId=`),
 * hanya untuk peran yang berhak membaca jurnal (`m11.journal.read`: pemilik, Admin Keuangan, akuntan).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { canSeeJournalLink, journalHref, JournalLink } from "@/components/shared/journal-link";

import { testContext } from "../helpers/context";

describe("B-55 tautan 'Lihat jurnal'", () => {
  afterEach(() => cleanup());

  it("B-55 US-M11-04 KP-3 tautan menuju jurnal sumber (tipe & id) untuk pemilik/Admin Keuangan/akuntan", () => {
    expect(journalHref("trip", "01a0-x")).toBe("/akuntansi/jurnal?sumberTipe=trip&sumberId=01a0-x");
    for (const role of ["owner", "finance_admin", "accountant"] as const) {
      expect(canSeeJournalLink(testContext({ role }))).toBe(true);
    }
    render(<JournalLink ctx={testContext({ role: "accountant" })} sourceType="deposit" sourceId="dep-1" />);
    const link = screen.getByRole("link", { name: /Lihat jurnal/ });
    expect(link.getAttribute("href")).toBe("/akuntansi/jurnal?sumberTipe=deposit&sumberId=dep-1");
  });

  it("B-55 peran tanpa izin jurnal (Dispatcher, operator depot) tidak melihat tautan; tanpa sumber → tidak tampil", () => {
    for (const role of ["dispatcher", "depot_operator"] as const) {
      expect(canSeeJournalLink(testContext({ role }))).toBe(false);
    }
    const { container } = render(
      <>
        <JournalLink ctx={testContext({ role: "dispatcher" })} sourceType="trip" sourceId="t-1" />
        <JournalLink ctx={testContext({ role: "owner" })} sourceType="invoice" sourceId={null} />
      </>,
    );
    expect(container.querySelector("a")).toBeNull();
  });
});
