// @vitest-environment happy-dom
import "fake-indexeddb/auto";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fieldDb, setFieldDbNameForTests, type DeviceItem } from "@/client/offline/db";
import { fieldPhotoMaxBytes, fieldPhotoMaxKb, syncMaxMinutesOf } from "@/client/offline/params";
import type { OfflineParams } from "@/client/offline/types";

const compressImage = vi.fn(async (_file: Blob, opts: { maxBytes?: number } = {}) => ({
  blob: new Blob([new Uint8Array(Math.min(opts.maxBytes ?? 1000, 1000))], { type: "image/jpeg" }),
  width: 1280,
  height: 960,
  quality: 0.7,
  attempts: 1,
  withinLimit: true,
  originalBytes: 4_000_000,
}));

vi.mock("@/client/media/compress-image", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/media/compress-image")>()),
  compressImage: (file: Blob, opts: { maxBytes?: number }) => compressImage(file, opts),
}));

const { PhotoCapture } = await import("@/components/field/photo-capture");

const PARAMS: OfflineParams = {
  queue: { minQueueDays: 1, syncMaxMinutes: 5 },
  pinLock: { maxAttempts: 5, lockMinutes: 15 },
  screenLockMinutes: 5,
  photoMaxKb: 120,
  clockSkewMinutes: 10,
};

async function saveDeviceParams(params: OfflineParams | null) {
  const row = {
    key: "device",
    deviceId: "dev-1",
    secretKey: null,
    secretRaw: "rahasia",
    device: { id: "dev-1", code: "HP-T1", name: "HP T1", kind: "phone", status: "active", isSpare: false, truckId: null, outletId: null, waterSourceId: null, unitLabel: null, home: "/sopir", source: "field" },
    activatedAt: Date.now(),
    serverOffsetMs: 0,
    params,
  } satisfies DeviceItem;
  await fieldDb().device.put(row);
}

let dbCounter = 0;

describe("Batas foto PAR-38 dari data pull (B-88, D-14 butir 2)", () => {
  beforeEach(() => {
    setFieldDbNameForTests(`equa-field-photo-${++dbCounter}`);
    compressImage.mockClear();
    globalThis.URL.createObjectURL ??= () => "blob:pratinjau";
    globalThis.URL.revokeObjectURL ??= () => undefined;
  });
  afterEach(() => cleanup());

  it("B-88 perangkat belum pernah pull → bawaan PAR-38 150 KB; sesudah pull → nilai server (bukan konstanta)", async () => {
    expect(await fieldPhotoMaxKb()).toBe(150);
    expect(await fieldPhotoMaxBytes()).toBe(150 * 1024);
    await saveDeviceParams(PARAMS);
    expect(await fieldPhotoMaxKb()).toBe(120);
    expect(await fieldPhotoMaxBytes()).toBe(120 * 1024);
    expect(syncMaxMinutesOf(PARAMS)).toBe(5);
    expect(syncMaxMinutesOf(null)).toBe(5);
    expect(syncMaxMinutesOf({ queue: { minQueueDays: 1, syncMaxMinutes: 3 } })).toBe(3);
  });

  it("B-88 US-M3-03 KP-6 PhotoCapture (POS, toko, produksi tanpa aturan modul) mengompres ke PAR-38 hasil pull", async () => {
    await saveDeviceParams(PARAMS);
    const onCapture = vi.fn();
    render(<PhotoCapture label="Foto nota pemasok" onCapture={onCapture} />);
    const input = screen.getByLabelText("Foto nota pemasok", { selector: "input" }) as HTMLInputElement;
    const file = new File([new Uint8Array(4_000)], "kamera.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(1));
    expect(compressImage).toHaveBeenCalledWith(file, expect.objectContaining({ maxBytes: 120 * 1024 }));
  });

  it("B-88 aturan modul dari data referensi (mis. rules.maxPhotoKb M3/M8) tetap dihormati bila diberikan", async () => {
    await saveDeviceParams(PARAMS);
    const onCapture = vi.fn();
    render(<PhotoCapture label="Foto bukti kirim" compress={{ maxBytes: 90 * 1024 }} onCapture={onCapture} />);
    const input = screen.getByLabelText("Foto bukti kirim", { selector: "input" }) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(10)], "a.jpg", { type: "image/jpeg" })] } });
    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(1));
    expect(compressImage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ maxBytes: 90 * 1024 }));
  });
});
