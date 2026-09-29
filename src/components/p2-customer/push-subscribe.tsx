"use client";

/**
 * Aktifkan notifikasi push perangkat pelanggan (US-P2-03 KP-4). Memakai service worker PWA yang sama
 * (`/serwist/sw.js`) dan kunci publik VAPID dari server. Tanpa VAPID/izin → tombol tidak ditampilkan / pesan tindakan.
 */
import { BellRing } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function PushSubscribe({ vapidPublicKey }: { vapidPublicKey: string | null }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  if (!vapidPublicKey) return null;
  async function enable() {
    setState("busy");
    setMessage(null);
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("Peramban ini tidak mendukung notifikasi. Anda tetap menerima pesan WhatsApp.");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("Izin notifikasi ditolak. Aktifkan di pengaturan peramban bila ingin menerima notifikasi.");
      const reg = await navigator.serviceWorker.register("/serwist/sw.js", { scope: "/", type: "module" });
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey!) });
      const res = await fetch("/api/customer/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub.toJSON()) });
      if (!res.ok) throw new Error("Notifikasi gagal diaktifkan. Coba lagi nanti.");
      setState("done");
      setMessage("Notifikasi aktif di perangkat ini.");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Notifikasi gagal diaktifkan.");
    }
  }
  return (
    <div className="grid gap-2">
      <Button type="button" variant="outline" size="sm" className="w-fit" onClick={enable} disabled={state === "busy" || state === "done"}>
        <BellRing aria-hidden /> {state === "done" ? "Notifikasi aktif" : "Aktifkan notifikasi di perangkat ini"}
      </Button>
      {message ? <p className={state === "error" ? "text-sm text-destructive" : "text-sm text-success"}>{message}</p> : null}
    </div>
  );
}
