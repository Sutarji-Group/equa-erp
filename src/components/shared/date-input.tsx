"use client";

import { CalendarDays, X } from "lucide-react";
import { useState } from "react";
import { id as localeId } from "react-day-picker/locale";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type BusinessDate, formatTanggal, isBusinessDate, toBusinessDate, WIB_TIMEZONE, wibToUtc } from "@/lib/time";
import { cn } from "@/lib/utils";

/** Tanggal bisnis `YYYY-MM-DD` → instan tengah hari WIB (aman dari pergeseran zona di kalender). */
export function businessDateToCalendarDate(date: BusinessDate): Date {
  return wibToUtc(date, "12:00");
}

/** Instan dari kalender (zona WIB) → tanggal bisnis `YYYY-MM-DD`. */
export function calendarDateToBusinessDate(date: Date): BusinessDate {
  return toBusinessDate(date);
}

export type DateInputProps = {
  /** Tanggal bisnis WIB `YYYY-MM-DD` atau `null`. */
  value: BusinessDate | null | undefined;
  onValueChange: (value: BusinessDate | null) => void;
  /** Batas bawah/atas (inklusif), `YYYY-MM-DD`. */
  min?: BusinessDate;
  max?: BusinessDate;
  placeholder?: string;
  /** Tampilkan tombol kosongkan. */
  clearable?: boolean;
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
};

/**
 * Pemilih tanggal bisnis WIB. Kalender selalu memakai zona Asia/Jakarta (tidak bergantung zona perangkat) dan
 * bahasa Indonesia; nilai keluar berupa string `YYYY-MM-DD`.
 */
export function DateInput({
  value,
  onValueChange,
  min,
  max,
  placeholder = "Pilih tanggal",
  clearable,
  disabled,
  id,
  name,
  className,
  ...aria
}: DateInputProps) {
  const [open, setOpen] = useState(false);
  const valid = value && isBusinessDate(value) ? value : null;
  const selected = valid ? businessDateToCalendarDate(valid) : undefined;
  const disabledMatchers = [
    ...(min ? [{ before: businessDateToCalendarDate(min) }] : []),
    ...(max ? [{ after: businessDateToCalendarDate(max) }] : []),
  ];

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            disabled={disabled}
            aria-invalid={aria["aria-invalid"]}
            aria-describedby={aria["aria-describedby"]}
            className={cn("w-full justify-start text-left font-normal", !valid && "text-muted-foreground")}
          >
            <CalendarDays aria-hidden />
            {valid ? formatTanggal(valid) : placeholder}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            locale={localeId}
            timeZone={WIB_TIMEZONE}
            noonSafe
            selected={selected}
            defaultMonth={selected}
            disabled={disabledMatchers}
            onSelect={(d: Date | undefined) => {
              onValueChange(d ? calendarDateToBusinessDate(d) : null);
              setOpen(false);
            }}
            autoFocus
          />
        </PopoverContent>
      </Popover>
      {clearable && valid && !disabled ? (
        <Button type="button" variant="ghost" size="icon" aria-label="Kosongkan tanggal" onClick={() => onValueChange(null)}>
          <X aria-hidden />
        </Button>
      ) : null}
      {name ? <input type="hidden" name={name} value={valid ?? ""} /> : null}
    </div>
  );
}
