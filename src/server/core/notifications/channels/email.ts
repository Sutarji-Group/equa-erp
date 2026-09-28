/**
 * Kanal e-mail (cadangan; ringkasan harian ke pemilik, PTB-05). Resend bila `RESEND_API_KEY` terisi; bila tidak:
 * di uji disimpan di memori (`sentEmailsForTests()`), di dev dicetak ke konsol.
 */
import "server-only";

import { Resend } from "resend";

import { serverEnv } from "@/lib/env";

export type EmailMessage = { to: string[]; subject: string; text: string; html?: string };
export type EmailResult = { ok: boolean; mode: "resend" | "memory" | "console"; id?: string; error?: string };

const memoryOutbox: EmailMessage[] = [];

/** Kirim e-mail. Tidak pernah melempar galat. */
export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  if (message.to.length === 0) return { ok: false, mode: "console", error: "Tidak ada penerima." };
  const env = serverEnv();
  if (env.RESEND_API_KEY) {
    try {
      const resend = new Resend(env.RESEND_API_KEY);
      const { data, error } = await resend.emails.send({
        from: env.EMAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      });
      if (error) return { ok: false, mode: "resend", error: error.message };
      return { ok: true, mode: "resend", id: data?.id };
    } catch (error) {
      return { ok: false, mode: "resend", error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (env.NODE_ENV === "test") {
    memoryOutbox.push(message);
    return { ok: true, mode: "memory" };
  }
  console.info(`[equa:email] Kepada: ${message.to.join(", ")}\nSubjek: ${message.subject}\n\n${message.text}`);
  return { ok: true, mode: "console" };
}

/** E-mail yang "terkirim" di lingkungan uji. */
export function sentEmailsForTests(): readonly EmailMessage[] {
  return memoryOutbox;
}

export function clearSentEmailsForTests(): void {
  memoryOutbox.length = 0;
}
