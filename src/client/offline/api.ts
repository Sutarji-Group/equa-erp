/**
 * Klien API lapangan: setiap permintaan membawa token perangkat JWT HS256 (`Authorization: Bearer`), ditandatangani
 * kunci perangkat non-extractable, dengan jam server terkoreksi (selisih dari `serverTime` respons). Respons
 * `wipe: true` (perintah hapus jarak jauh) → seluruh data lokal dihapus.
 */
import { fieldDb, wipeLocalData, type DeviceItem } from "./db";
import { importDeviceKey, signDeviceJwt } from "./crypto";
import type { ActivationResponse, ApiErrorBody } from "./types";

/** Versi aplikasi lapangan (NFR-32; dibandingkan dengan `app.min_supported_version`). */
export const APP_VERSION: string = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.1.0";

export class FieldApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** Tidak ada koneksi / server tidak terjangkau. */
  readonly network: boolean;
  readonly wipe: boolean;
  readonly lockedUntil: string | null;
  readonly attemptsLeft: number | null;

  constructor(message: string, info: { code: string; status?: number; network?: boolean; wipe?: boolean; lockedUntil?: string | null; attemptsLeft?: number | null }) {
    super(message);
    this.name = "FieldApiError";
    this.code = info.code;
    this.status = info.status ?? 0;
    this.network = info.network ?? false;
    this.wipe = info.wipe ?? false;
    this.lockedUntil = info.lockedUntil ?? null;
    this.attemptsLeft = info.attemptsLeft ?? null;
  }
}

/** Status jaringan peramban (`navigator.onLine`; tanpa navigator dianggap daring). */
export function isOnline(): boolean {
  return typeof navigator === "undefined" || (navigator as Navigator & { onLine?: boolean }).onLine !== false;
}

export const OFFLINE_MESSAGE = "Sinyal hilang — data tersimpan di ponsel. Lanjutkan; data terkirim otomatis saat ada sinyal.";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (input, init) => fetch(input, init);
let baseUrl = "";

/** Ganti `fetch` & alamat dasar (uji). */
export function setFetchForTests(fn: FetchLike | null, base = ""): void {
  fetchImpl = fn ?? ((input, init) => fetch(input, init));
  baseUrl = base;
}

let wipeHandler: (() => void) | null = null;

/** Dipanggil setelah data lokal dihapus karena perintah admin sistem (mis. arahkan ke halaman aktivasi). */
export function setWipeHandler(fn: (() => void) | null): void {
  wipeHandler = fn;
}

export async function loadDevice(): Promise<DeviceItem | undefined> {
  return fieldDb().device.get("device");
}

/** Simpan hasil aktivasi: kunci perangkat sebagai CryptoKey non-extractable bila peramban mendukung. */
export async function saveActivation(res: ActivationResponse, now = Date.now()): Promise<DeviceItem> {
  const base: Omit<DeviceItem, "secretKey" | "secretRaw"> = {
    key: "device",
    deviceId: res.deviceId,
    device: res.device,
    activatedAt: now,
    serverOffsetMs: Date.parse(res.serverTime) - now,
  };
  const db = fieldDb();
  try {
    const item: DeviceItem = { ...base, secretKey: await importDeviceKey(res.deviceSecret), secretRaw: null };
    await db.device.put(item);
    return item;
  } catch {
    // Peramban tidak dapat menyimpan CryptoKey di IndexedDB → cadangan (ditandai).
    const item: DeviceItem = { ...base, secretKey: null, secretRaw: res.deviceSecret };
    await db.device.put(item);
    return item;
  }
}

/** Jam server terkoreksi (ms). */
export function serverNow(device: Pick<DeviceItem, "serverOffsetMs"> | undefined, now = Date.now()): number {
  return now + (device?.serverOffsetMs ?? 0);
}

async function deviceKey(dev: DeviceItem): Promise<CryptoKey> {
  if (dev.secretKey) return dev.secretKey;
  if (dev.secretRaw) return importDeviceKey(dev.secretRaw);
  throw new FieldApiError("Perangkat belum diaktifkan. Masukkan kode aktivasi dari admin sistem.", { code: "DEVICE_UNKNOWN" });
}

async function handleWipe(): Promise<void> {
  await wipeLocalData();
  wipeHandler?.();
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function updateOffset(dev: DeviceItem, serverTime: unknown, t0: number, t1: number): Promise<void> {
  if (typeof serverTime !== "string") return;
  const offset = Date.parse(serverTime) - (t0 + t1) / 2;
  if (!Number.isFinite(offset) || Math.abs(offset - dev.serverOffsetMs) < 2_000) return;
  await fieldDb().device.update("device", { serverOffsetMs: Math.round(offset) });
}

export type DeviceFetchOptions = {
  method?: "GET" | "POST";
  json?: unknown;
  form?: FormData;
  /** Sesi pengguna yang dibawa dalam token (wajib untuk pull). */
  session?: { userId: string; sessionId: string } | null;
  signal?: AbortSignal;
};

/** Panggil API lapangan dengan token perangkat. Melempar `FieldApiError`. */
export async function deviceFetch<T>(path: string, opts: DeviceFetchOptions = {}): Promise<T> {
  const dev = await loadDevice();
  if (!dev) throw new FieldApiError("Perangkat belum diaktifkan. Masukkan kode aktivasi dari admin sistem.", { code: "DEVICE_UNKNOWN" });
  const token = await signDeviceJwt(await deviceKey(dev), { deviceId: dev.deviceId, userId: opts.session?.userId, sessionId: opts.session?.sessionId }, serverNow(dev));
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "X-App-Version": APP_VERSION };
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}${path}`, { method: opts.method ?? (body ? "POST" : "GET"), headers, body, signal: opts.signal, cache: "no-store" });
  } catch {
    throw new FieldApiError(OFFLINE_MESSAGE, { code: "NETWORK", network: true });
  }
  const t1 = Date.now();
  const data = (await parseBody(res)) as Record<string, unknown>;
  if (res.status >= 500 && !("code" in data)) {
    throw new FieldApiError("Server sedang bermasalah. Data tetap tersimpan di ponsel dan akan dikirim ulang.", { code: "SERVER_ERROR", status: res.status, network: true });
  }
  await updateOffset(dev, data.serverTime, t0, t1);
  if (!res.ok || data.ok === false) {
    const err = data as Partial<ApiErrorBody>;
    if (err.wipe) await handleWipe();
    throw new FieldApiError(err.message ?? "Permintaan ditolak server.", {
      code: err.code ?? "ERROR",
      status: res.status,
      wipe: !!err.wipe,
      lockedUntil: err.lockedUntil ?? null,
      attemptsLeft: err.attemptsLeft ?? null,
    });
  }
  return data as T;
}

/** Aktivasi perangkat dengan kode admin sistem (tanpa token). */
export async function activateWithCode(code: string): Promise<DeviceItem> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/api/device/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, appVersion: APP_VERSION }),
      cache: "no-store",
    });
  } catch {
    throw new FieldApiError("Aktivasi perlu sinyal internet. Periksa sinyal lalu coba lagi.", { code: "NETWORK", network: true });
  }
  const data = (await parseBody(res)) as Partial<Omit<ActivationResponse, "ok"> & Omit<ApiErrorBody, "ok">> & { ok?: boolean };
  if (!res.ok || !data.ok || !data.deviceSecret) {
    throw new FieldApiError(data.message ?? "Aktivasi gagal. Coba lagi.", { code: data.code ?? "ERROR", status: res.status });
  }
  return saveActivation(data as ActivationResponse);
}
