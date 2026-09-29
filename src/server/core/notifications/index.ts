/**
 * Notifikasi — API publik (`import { notify } from "@/server/core/notifications"`).
 */
import "server-only";

export * from "./catalog";
export * from "./service";
export { sendDailyDigest, type DigestResult } from "./digest";
export { sendEmail, sentEmailsForTests, clearSentEmailsForTests, type EmailMessage } from "./channels/email";
export { isEmailDeliveryConfigured, type EmailAttachment } from "./channels/email";
export { isWebPushConfigured, sendWebPush } from "./channels/webpush";
