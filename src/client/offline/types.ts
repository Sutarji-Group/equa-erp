/**
 * Tipe kontrak API lapangan di sisi peramban (cermin dari `src/server/core/auth` & `src/server/core/sync` — kode klien
 * tidak boleh mengimpor modul server).
 */

export type FieldHome = "/sopir" | "/pos" | "/produksi";

export type PublicDevice = {
  id: string;
  code: string;
  name: string;
  kind: string;
  status: string;
  isSpare: boolean;
  truckId: string | null;
  outletId: string | null;
  waterSourceId: string | null;
  unitLabel: string | null;
  home: FieldHome;
  source: "field" | "pos";
};

export type PinVerifier = { algorithm: "PBKDF2-SHA256"; iterations: number; salt: string; verifier: string };

export type FieldUserInfo = { id: string; username: string; name: string; employeeId: string; roles: string[]; roleLabel: string };

export type PinPolicy = { maxAttempts: number; lockMinutes: number; idleMinutes: number };

export type FieldLoginResponse = {
  ok: true;
  sessionId: string;
  expiresAt: string;
  user: FieldUserInfo;
  verifier: PinVerifier;
  policy: PinPolicy;
  serverTime: string;
};

export type ActivationResponse = { ok: true; deviceId: string; deviceSecret: string; device: PublicDevice; serverTime: string };

export type DeviceUserInfo = { id: string; name: string; roleLabel: string; hasPin: boolean };

export type PushResultStatus = "applied" | "duplicate" | "rejected" | "conflict" | "retry";

export type PushResult = {
  id: string;
  status: PushResultStatus;
  originalStatus?: "applied" | "rejected" | "conflict";
  code?: string;
  message?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  result?: unknown;
  clockSkewFlagged?: boolean;
};

export type OfflineParams = {
  queue: { minQueueDays: number; syncMaxMinutes: number };
  pinLock: { maxAttempts: number; lockMinutes: number };
  screenLockMinutes: number;
  photoMaxKb: number;
  clockSkewMinutes: number;
};

export type PullResponse = {
  ok: true;
  serverTime: string;
  cursor: string;
  device: PublicDevice;
  minVersion: string;
  updateRequired: boolean;
  params: OfflineParams;
  data: Record<string, unknown>;
  errors: Record<string, string>;
};

export type ApiErrorBody = { ok: false; code: string; message: string; wipe?: boolean; lockedUntil?: string; attemptsLeft?: number };
