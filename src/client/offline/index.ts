/**
 * Klien offline aplikasi lapangan (hanya peramban; docs/ARCHITECTURE.md §7). API untuk halaman lapangan modul:
 *
 * ```tsx
 * "use client";
 * import { enqueue, useReference, useSyncStatus } from "@/client/offline";
 * import { useFieldSession } from "@/components/field/field-gate";
 *
 * const { user } = useFieldSession();
 * const trips = useReference<Trip[]>("m3.trips_today", user.id);
 * await enqueue({ type: "m3.trip.depart", payload: { tripId }, label: `Berangkat ${trip.number}` });
 * ```
 */
export * from "./types";
export { fieldDb, wipeLocalData, PENDING_STATUSES, FIELD_DB_NAME, type OutboxItem, type OutboxStatus, type AttachmentItem, type CredentialItem, type DeviceItem } from "./db";
export { verifyPinOffline, derivePinVerifier, importDeviceKey, signDeviceJwt } from "./crypto";
export { APP_VERSION, activateWithCode, deviceFetch, FieldApiError, forgetDevice, isOnline, loadDevice, serverNow, setWipeHandler, OFFLINE_MESSAGE } from "./api";
export {
  activeSession,
  enrollWithCode,
  getActiveUserId,
  getCredential,
  isScreenLocked,
  knownUsers,
  lastActivityAt,
  lockScreen,
  loginWithPin,
  refreshDeviceUsers,
  switchUser,
  touchActivity,
  unlockScreen,
  DEFAULT_POLICY,
  type KnownUser,
} from "./auth";
export { enqueue, listOutbox, outboxStatusText, pendingByUser, pendingCount, OUTBOX_CHANGED_EVENT, type EnqueueAttachment, type EnqueueCommand } from "./outbox";
export { getSyncState, startSyncWorker, syncNow, PUSH_BATCH_SIZE, SYNC_INTERVAL_MS, type SyncState, type SyncSummary } from "./sync";
export { useOnline, useOutbox, useReference, useSyncStatus, type SyncStatus } from "./hooks";
export { nextDeviceSeq, seedDeviceSeqFloors } from "./numbering";
export { moduleStore, type ModuleStore } from "./module-store";
export { registerOptimistic, withOptimistic, type OptimisticReducer } from "./optimistic";
export { rebindOutbox } from "./signing";
export { formatLocalNumber, deviceTagFromCode } from "@/lib/local-number";
