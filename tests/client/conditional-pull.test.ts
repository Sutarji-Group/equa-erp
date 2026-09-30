import "fake-indexeddb/auto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as activateRoute } from "@/app/api/device/activate/route";
import { POST as pinLoginRoute } from "@/app/api/device/pin-login/route";
import { GET as usersRoute } from "@/app/api/device/users/route";
import { GET as pullRoute } from "@/app/api/sync/pull/route";
import { POST as pushRoute } from "@/app/api/sync/push/route";
import type { PosReference } from "@/client/m6-pos/contract";
import { activateWithCode, activeSession, deviceFetch, enqueue, fieldDb, getSyncState, loginWithPin, syncNow } from "@/client/offline";
import { setFetchForTests } from "@/client/offline/api";
import { setFieldDbNameForTests, setMeta } from "@/client/offline/db";
import { applyPullResponse, pullQueryString } from "@/client/offline/pull";
import type { PullResponse } from "@/client/offline/types";
import { deviceId, SEED_DEMO_PIN, userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";
import { toBusinessDate } from "@/lib/time";
import { issueActivationCode } from "@/server/core/auth";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb as withTestDb } from "../helpers/db";
import { isi, localNumber } from "../m6-pos/helpers";

withTestDb({ seed: true });

type Handler = (req: Request) => Promise<Response>;
const ROUTES: Record<string, Handler> = {
  "POST /api/device/activate": activateRoute,
  "POST /api/device/pin-login": pinLoginRoute,
  "GET /api/device/users": usersRoute,
  "POST /api/sync/push": pushRoute,
  "GET /api/sync/pull": pullRoute,
};

/** Respons pull yang diterima klien (urut) — untuk memeriksa isi kawat. */
const pulls: { url: string; body: PullResponse; bytes: number }[] = [];

async function routeFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input, "http://localhost");
  const handler = ROUTES[`${init?.method ?? "GET"} ${url.pathname}`];
  if (!handler) return new Response("not found", { status: 404 });
  const res = await handler(new Request(url, init));
  if (url.pathname === "/api/sync/pull") {
    const text = await res.clone().text();
    pulls.push({ url: url.search, body: JSON.parse(text) as PullResponse, bytes: text.length });
  }
  return res;
}

const OPERATOR = userIdByUsername("depot04");
const POS = { outletCode: "D04", deviceCode: "POS-D04" };
let shiftId = "";
let seq = 0;

function saleCommand() {
  seq++;
  return { type: "m6.pos_sale.create", payload: { saleId: newId(), shiftId, localNumber: localNumber(POS, seq, toBusinessDate(new Date())), deviceSeq: seq, lines: [isi(1)], paymentMethod: "cash" } };
}

const strip = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (k === "generatedAt" ? undefined : x)));

async function stored(key: string) {
  return fieldDb().refs.get([OPERATOR, key]);
}

async function serverFull(key: string): Promise<unknown> {
  const session = await activeSession();
  const res = await deviceFetch<PullResponse>(`/api/sync/pull?keys=${key}`, { session });
  return res.data[key];
}

beforeAll(async () => {
  bootstrapForTests();
  setFetchForTests(routeFetch);
  setFieldDbNameForTests(`equa-field-pull-v2-${Date.now()}`);
  const issued = await issueActivationCode(seededContext("admin1"), deviceId("POS-D04"));
  await activateWithCode(issued.displayCode);
  await loginWithPin(OPERATOR, SEED_DEMO_PIN, { online: true });
});

afterAll(() => {
  setFetchForTests(null);
});

describe("Klien: pull bersyarat v2 & jadwal pull (B-89, B-88)", () => {
  it("B-89 pull pertama v2 menyimpan kursor per penyedia bersama datanya; pull berikutnya tanpa perubahan → 'tidak berubah' tanpa isi, generatedAt disegarkan", async () => {
    await setMeta(`pullCursor:${OPERATOR}`, "2026-09-30T00:00:00.000Z"); // sisa protokol v1
    shiftId = newId();
    await enqueue({ type: "m6.shift.open", payload: { shiftId, openingCashCounted: 200_000 } });
    for (let i = 0; i < 25; i++) await enqueue(saleCommand());
    const first = await syncNow({ force: true });
    expect(first).toMatchObject({ sent: 26, rejected: 0, pulled: true });
    const firstPull = pulls.at(-1)!;
    expect(firstPull.url).toBe("?v=2");
    expect(firstPull.body.protocol).toBe(2);
    const ref = await stored("m6.pos");
    expect(ref?.cursor).toBe(firstPull.body.cursors!["m6.pos"]);
    expect((ref?.data as PosReference).openShift!.sales).toHaveLength(25);
    expect(await fieldDb().meta.get(`pullCursor:${OPERATOR}`)).toBeUndefined();

    const second = await syncNow({ force: true });
    expect(second.pulled).toBe(true);
    const p2 = pulls.at(-1)!;
    expect(p2.url).toContain("c.m6.pos=");
    expect(p2.body.data).toEqual({});
    expect(p2.body.unchanged).toEqual(expect.arrayContaining(["m6.pos", "m1.catalog", "core.me"]));
    expect(p2.bytes).toBeLessThan(firstPull.bytes / 2);
    const after = await stored("m6.pos");
    expect((after?.data as PosReference).generatedAt).toBe(p2.body.serverTime);
    expect(strip(after?.data)).toEqual(strip(ref?.data));
  });

  it("B-89 penjualan baru → push lalu pull segera (delta), data lokal = data penuh server; muatan kecil", async () => {
    await enqueue(saleCommand());
    const before = pulls.length;
    const res = await syncNow({ pull: "auto" });
    expect(res).toMatchObject({ sent: 1, pulled: true });
    expect(pulls.length).toBe(before + 1);
    const p = pulls.at(-1)!;
    expect(p.body.data["m6.pos"]).toBeUndefined();
    expect(p.body.patches!["m6.pos"]).toBeTruthy();
    const local = (await stored("m6.pos"))!;
    expect(local.cursor).toBe(p.body.cursors!["m6.pos"]);
    expect((local.data as PosReference).openShift!.sales).toHaveLength(26);
    expect(strip(local.data)).toEqual(strip(await serverFull("m6.pos")));
  });

  it("B-89 data lokal tidak cocok dengan kursor (mis. rusak) → delta ditolak di perangkat, kunci itu ditarik penuh otomatis", async () => {
    const row = (await stored("m6.pos"))!;
    const data = row.data as PosReference;
    await fieldDb().refs.put({ ...row, data: { ...data, openShift: { ...data.openShift!, sales: data.openShift!.sales.slice(3) } } });
    await enqueue(saleCommand());
    const before = pulls.length;
    await syncNow({ pull: "auto" });
    expect(pulls.length).toBe(before + 2);
    expect(pulls.at(-1)!.url).toContain("keys=m6.pos");
    expect(pulls.at(-1)!.url).not.toContain("c.m6.pos");
    const local = (await stored("m6.pos"))!;
    expect((local.data as PosReference).openShift!.sales).toHaveLength(27);
    expect(strip(local.data)).toEqual(strip(await serverFull("m6.pos")));
    expect(local.cursor).toBeTruthy();
  });

  it("B-88 D-14 butir 2 pull 'auto': tanpa kiriman & belum jatuh tempo → tidak menarik; lewat jeda idle (5 menit, ≤ PAR-30) → menarik", async () => {
    const before = pulls.length;
    const idle = await syncNow({ pull: "auto" });
    expect(idle.pulled).toBe(false);
    expect(pulls.length).toBe(before);
    const state = await getSyncState();
    await fieldDb().meta.put({ key: "syncState", value: { ...state, lastPullAt: Date.now() - 5 * 60_000 - 1_000 } });
    const due = await syncNow({ pull: "auto" });
    expect(due.pulled).toBe(true);
    expect(pulls.length).toBe(before + 1);
    expect((await getSyncState()).lastPullAt).toBeGreaterThan(Date.now() - 10_000);
    // Parameter PAR-30 & PAR-38 dari pull tersimpan di perangkat (dibaca penjadwal & kamera).
    const device = await fieldDb().device.get("device");
    expect(device?.params).toMatchObject({ queue: { syncMaxMinutes: 5 }, photoMaxKb: 150 });
  });

  it("B-89 kompatibel dengan server lama: respons tanpa protokol v2 disimpan penuh tanpa kursor → pull berikutnya penuh untuk kunci itu", async () => {
    const session = await activeSession();
    const legacy = await deviceFetch<PullResponse>("/api/sync/pull?keys=core.me", { session });
    expect(legacy.protocol).toBeUndefined();
    const applied = await applyPullResponse(OPERATOR, legacy);
    expect(applied.replaced).toEqual(["core.me"]);
    expect((await stored("core.me"))?.cursor).toBeNull();
    const rows = await fieldDb().refs.where("userId").equals(OPERATOR).toArray();
    const qs = pullQueryString(rows);
    expect(qs.startsWith("v=2&")).toBe(true);
    expect(qs).not.toContain("c.core.me=");
    expect(qs).toContain("c.m6.pos=");
  });
});
