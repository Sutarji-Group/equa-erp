"use client";

import { useCallback, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const memory = new Map<string, boolean>();

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  window.addEventListener("storage", callback);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}

function read(key: string, fallback: boolean): boolean {
  try {
    const v = window.localStorage.getItem(key);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch {
    // Penyimpanan diblokir (mode privat) → pakai memori.
  }
  return memory.get(key) ?? fallback;
}

/**
 * Preferensi boolean per penampil (mis. sidebar diciutkan), disimpan di `localStorage` bila tersedia.
 * Aman untuk SSR (nilai awal = `fallback`) dan tidak memicu mismatch hidrasi.
 */
export function usePersistentFlag(key: string, fallback = false): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key, fallback),
    () => fallback,
  );
  const set = useCallback(
    (next: boolean) => {
      memory.set(key, next);
      try {
        window.localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // Abaikan; nilai tetap di memori.
      }
      listeners.forEach((l) => l());
    },
    [key],
  );
  return [value, set];
}
