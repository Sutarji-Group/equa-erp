import { describe, expect, it } from "vitest";

import {
  addBusinessDays,
  addDays,
  businessDateToUtcRange,
  daysBetween,
  firstDayOfMonth,
  formatJam,
  formatTanggal,
  formatTanggalJam,
  isBusinessDate,
  isBusinessDay,
  isWithinWindow,
  lastDayOfMonth,
  monthOf,
  nowWib,
  parseHourMinute,
  toBusinessDate,
  toWibParts,
  wibToUtc,
} from "@/lib/time";

describe("lib/time — tanggal bisnis WIB", () => {
  it("toBusinessDate memakai kalender WIB (UTC+7), bukan UTC", () => {
    expect(toBusinessDate(new Date("2026-09-26T16:59:59Z"))).toBe("2026-09-26");
    expect(toBusinessDate(new Date("2026-09-26T17:00:00Z"))).toBe("2026-09-27");
    expect(toBusinessDate("2026-12-31T17:30:00Z")).toBe("2027-01-01");
  });

  it("nowWib/toWibParts memecah komponen WIB", () => {
    const p = nowWib(new Date("2026-09-27T07:30:15Z"));
    expect(p).toMatchObject({
      businessDate: "2026-09-27",
      year: 2026,
      month: 9,
      day: 27,
      hour: 14,
      minute: 30,
      second: 15,
      weekday: 0,
      time: "14:30",
    });
    expect(toWibParts("2026-09-26T20:00:00Z").weekday).toBe(0); // Minggu 27 Sep 03.00 WIB
  });

  it("businessDateToUtcRange mengembalikan rentang setengah terbuka [start, end)", () => {
    const { start, end } = businessDateToUtcRange("2026-09-27");
    expect(start.toISOString()).toBe("2026-09-26T17:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-27T17:00:00.000Z");
    expect(toBusinessDate(start)).toBe("2026-09-27");
    expect(toBusinessDate(new Date(end.getTime() - 1))).toBe("2026-09-27");
    expect(toBusinessDate(end)).toBe("2026-09-28");
  });

  it("wibToUtc menggabungkan tanggal bisnis + jam WIB", () => {
    expect(wibToUtc("2026-09-27", "05:00").toISOString()).toBe("2026-09-26T22:00:00.000Z");
    expect(wibToUtc("2026-09-27").toISOString()).toBe("2026-09-26T17:00:00.000Z");
  });

  it("isBusinessDate memvalidasi format dan tanggal kalender", () => {
    expect(isBusinessDate("2026-09-27")).toBe(true);
    expect(isBusinessDate("2028-02-29")).toBe(true);
    expect(isBusinessDate("2026-02-29")).toBe(false);
    expect(isBusinessDate("2026-9-27")).toBe(false);
    expect(isBusinessDate(20260927)).toBe(false);
  });

  it("addDays, daysBetween, dan fungsi bulan", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-09-01", "2026-09-27")).toBe(26);
    expect(daysBetween("2026-09-27", "2026-09-01")).toBe(-26);
    expect(monthOf("2026-09-27")).toBe("2026-09");
    expect(firstDayOfMonth("2026-09-27")).toBe("2026-09-01");
    expect(lastDayOfMonth("2028-02-10")).toBe("2028-02-29");
    expect(lastDayOfMonth("2026-12-05")).toBe("2026-12-31");
    expect(() => addDays("2026-13-01", 1)).toThrow(RangeError);
  });

  it("addBusinessDays melewati Sabtu, Minggu, dan libur", () => {
    // Jumat 25 Sep 2026 + 2 hari kerja = Selasa 29 Sep 2026
    expect(addBusinessDays("2026-09-25", 2)).toBe("2026-09-29");
    // Sabtu 26 Sep + 1 hari kerja = Senin 28 Sep
    expect(addBusinessDays("2026-09-26", 1)).toBe("2026-09-28");
    expect(addBusinessDays("2026-09-25", 2, { holidays: ["2026-09-28"] })).toBe("2026-09-30");
    expect(addBusinessDays("2026-09-29", -2)).toBe("2026-09-25");
    expect(addBusinessDays("2026-09-27", 0)).toBe("2026-09-27");
    // Hanya Minggu libur
    expect(addBusinessDays("2026-09-25", 1, { weekendDays: [0] })).toBe("2026-09-26");
    expect(isBusinessDay("2026-09-27")).toBe(false);
    expect(isBusinessDay("2026-09-28")).toBe(true);
  });

  it("isWithinWindow memakai jam WIB, kedua ujung inklusif, dan mendukung lewat tengah malam", () => {
    const at = (hhmm: string) => wibToUtc("2026-09-27", hhmm);
    expect(isWithinWindow("05:00", "22:00", at("04:59"))).toBe(false);
    expect(isWithinWindow("05:00", "22:00", at("05:00"))).toBe(true);
    expect(isWithinWindow("05:00", "22:00", at("22:00"))).toBe(true);
    expect(isWithinWindow("05:00", "22:00", at("22:01"))).toBe(false);
    expect(isWithinWindow("22:00", "05:00", at("23:30"))).toBe(true);
    expect(isWithinWindow("22:00", "05:00", at("04:00"))).toBe(true);
    expect(isWithinWindow("22:00", "05:00", at("12:00"))).toBe(false);
    expect(() => parseHourMinute("24:00")).toThrow(RangeError);
  });

  it("formatTanggal & formatJam berformat Indonesia", () => {
    expect(formatTanggal("2026-09-26")).toBe("Sabtu, 26 Sep 2026");
    expect(formatTanggal(new Date("2026-09-27T03:00:00Z"))).toBe("Minggu, 27 Sep 2026");
    expect(formatTanggal("2026-08-17", { month: "long" })).toBe("Senin, 17 Agustus 2026");
    expect(formatTanggal("2026-08-17", { weekday: false })).toBe("17 Agu 2026");
    expect(formatJam(new Date("2026-09-27T07:30:05Z"))).toBe("14.30");
    expect(formatJam(new Date("2026-09-27T07:30:05Z"), { seconds: true })).toBe("14.30.05");
    expect(formatTanggalJam(new Date("2026-09-26T17:05:00Z"))).toBe("Minggu, 27 Sep 2026 00.05");
  });
});
