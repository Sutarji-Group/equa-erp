/**
 * Pembantu uji lapangan (perangkat + login PIN + perintah sinkron BERTANDA TANGAN) untuk modul yang punya aksi
 * lapangan (M3, M6, M7, M8, …). Semua handler sinkron diuji lewat `processPush` — jalur yang sama dengan perangkat.
 *
 * ```ts
 * const t = useTestDb({ seed: true });
 * const hp = await fieldDevice("HP-T1");                 // aktivasi perangkat seed
 * const sopir = await hp.login("sopir1");                 // login PIN daring → sesi + kunci perintah
 * const res = await hp.push([hp.command(sopir, "m3.trip.depart", { tripId })]);
 * expect(res.results[0]).toMatchObject({ status: "applied" });
 * const pull = await hp.pull(sopir);                      // data referensi sesuai lingkup
 * ```
 * Perintah ditandatangani seperti klien (`src/lib/sync-signature.ts`); `signedCommand(...)` bisa dipakai langsung
 * untuk kasus tepi (waktu perangkat mundur, tanggal bisnis salah, tanda tangan palsu, `reboundFrom`).
 */
import { createHash } from "node:crypto";

import { deviceId as seedDeviceId, SEED_DEMO_PIN, userIdByUsername } from "@/db/seed";
import { newId, isUuid } from "@/lib/ids";
import { commandSigningString } from "@/lib/sync-signature";
import { toBusinessDate } from "@/lib/time";
import {
  activateDevice,
  authenticateDevice,
  issueActivationCode,
  pinLogin,
  signDeviceToken,
  signFieldCommand,
  type DeviceAuth,
  type FieldLoginResult,
} from "@/server/core/auth";
import type { ActorContext } from "@/server/core/context";
import { processPull, processPush, processUpload, type PullQuery, type PullResponse, type PushResponse, type UploadResult } from "@/server/core/sync";

import { seededContext } from "./context";

/** Pemilik perintah: hasil login PIN, atau pasangan userId + sessionId. */
export type CommandOwner = Pick<FieldLoginResult, "sessionId"> & ({ user: { id: string } } | { userId: string });

export type SignedCommand = {
  id: string;
  type: string;
  payload: unknown;
  userId: string;
  sessionId: string | null;
  sig: string | null;
  reboundFrom?: string | null;
  deviceTime: string;
  businessDate: string;
  attachmentIds: string[];
  attachmentHashes: string[];
};

export type SignedCommandOptions = {
  id?: string;
  deviceTime?: Date | string;
  businessDate?: string;
  attachmentIds?: string[];
  /** SHA-256 hex isi lampiran (sejajar `attachmentIds`); pakai `sha256Hex(bytes)`. */
  attachmentHashes?: string[];
  reboundFrom?: string | null;
  /** Tanda tangani dengan sesi lain (uji pemalsuan). */
  signWithSessionId?: string;
  /** Tanpa tanda tangan (klien lama). */
  unsigned?: boolean;
};

function ownerUserId(owner: CommandOwner): string {
  return "userId" in owner ? owner.userId : owner.user.id;
}

export function sha256Hex(bytes: Uint8Array | Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Perintah outbox bertanda tangan kunci perintah sesi pemiliknya (seperti `enqueue` klien). */
export function signedCommand(owner: CommandOwner, type: string, payload: unknown, opts: SignedCommandOptions = {}): SignedCommand {
  const deviceTimeDate = opts.deviceTime instanceof Date ? opts.deviceTime : opts.deviceTime ? new Date(opts.deviceTime) : new Date();
  const deviceTime = typeof opts.deviceTime === "string" ? opts.deviceTime : deviceTimeDate.toISOString();
  const cmd: SignedCommand = {
    id: opts.id ?? newId(),
    type,
    payload,
    userId: ownerUserId(owner),
    sessionId: owner.sessionId,
    sig: null,
    reboundFrom: opts.reboundFrom ?? null,
    deviceTime,
    businessDate: opts.businessDate ?? toBusinessDate(deviceTimeDate),
    attachmentIds: opts.attachmentIds ?? [],
    attachmentHashes: opts.attachmentHashes ?? [],
  };
  if (!opts.unsigned) {
    cmd.sig = signFieldCommand(opts.signWithSessionId ?? owner.sessionId, commandSigningString({ ...cmd, sessionId: owner.sessionId }));
  }
  return cmd;
}

export type FieldDevice = {
  deviceId: string;
  secret: string;
  /** Autentikasi permintaan perangkat (token JWT). `sessionId` = sesi pengguna aktif di token (untuk pull). */
  auth: (opts?: { sessionId?: string | null; now?: Date }) => Promise<DeviceAuth>;
  /** Login PIN daring (username seed atau userId). */
  login: (user: string, opts?: { pin?: string; now?: Date }) => Promise<FieldLoginResult>;
  command: (owner: CommandOwner, type: string, payload: unknown, opts?: SignedCommandOptions) => SignedCommand;
  push: (commands: unknown[], opts?: { sentAt?: Date; now?: Date; health?: Record<string, unknown> }) => Promise<PushResponse>;
  /** Pull (v1: `since`/`keys`; pull bersyarat v2: `cursors` — `{}` = klien v2 tanpa data tersimpan). */
  pull: (owner: Pick<FieldLoginResult, "sessionId">, query?: PullQuery, opts?: { now?: Date }) => Promise<PullResponse>;
  upload: (
    owner: CommandOwner,
    file: { bytes: Uint8Array; contentType?: string; kind?: string; attachmentId?: string; capturedAt?: Date; commandId?: string },
  ) => Promise<UploadResult & { sha256: string }>;
};

/**
 * Aktifkan perangkat seed (`HP-T1`, `POS-D01`, `HP-CAD-1`, …) atau perangkat mana pun dengan ID-nya. `admin` = pelaku
 * penerbit kode aktivasi (bawaan admin sistem seed `admin1`).
 */
export async function fieldDevice(device: string, opts: { admin?: ActorContext } = {}): Promise<FieldDevice> {
  const admin = opts.admin ?? seededContext("admin1");
  const id = isUuid(device) ? device : seedDeviceId(device);
  const issued = await issueActivationCode(admin, id);
  const act = await activateDevice(issued.code);
  const auth: FieldDevice["auth"] = async (o = {}) =>
    authenticateDevice(
      new Request("http://localhost/api/sync/push", {
        headers: {
          authorization: `Bearer ${await signDeviceToken(act.deviceSecret, { deviceId: act.deviceId, sessionId: o.sessionId ?? undefined }, { now: o.now })}`,
        },
      }),
      { now: o.now },
    );
  return {
    deviceId: act.deviceId,
    secret: act.deviceSecret,
    auth,
    login: async (user, o = {}) => pinLogin(await auth({ now: o.now }), { userId: isUuid(user) ? user : userIdByUsername(user), pin: o.pin ?? SEED_DEMO_PIN }),
    command: signedCommand,
    push: async (commands, o = {}) =>
      processPush(await auth({ now: o.now }), { commands, sentAt: (o.sentAt ?? o.now ?? new Date()).toISOString(), ...(o.health ? { health: o.health } : {}) }),
    pull: async (owner, query = {}, o = {}) => processPull(await auth({ sessionId: owner.sessionId, now: o.now }), query),
    upload: async (owner, file) => {
      const attachmentId = file.attachmentId ?? newId();
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(file.bytes)], { type: file.contentType ?? "image/jpeg" }), "berkas");
      form.set("attachmentId", attachmentId);
      form.set("userId", ownerUserId(owner));
      form.set("kind", file.kind ?? "delivery_photo");
      form.set("capturedAt", (file.capturedAt ?? new Date()).toISOString());
      if (file.commandId) form.set("commandId", file.commandId);
      const res = await processUpload(await auth(), form);
      return { ...res, sha256: sha256Hex(file.bytes) };
    },
  };
}
