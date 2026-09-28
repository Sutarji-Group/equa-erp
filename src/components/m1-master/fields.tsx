import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * Bidang formulir sederhana untuk Server Action (server-safe): label + input/select/textarea + petunjuk.
 * Nama bidang = nama kunci FormData.
 */
export function FieldRow({ label, htmlFor, hint, required, children, className }: { label: string; htmlFor: string; hint?: ReactNode; required?: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function TextField({ label, name, hint, required, className, ...props }: { label: string; name: string; hint?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  const id = props.id ?? `f-${name}`;
  return (
    <FieldRow label={label} htmlFor={id} hint={hint} required={required} className={className}>
      <Input id={id} name={name} required={required} {...props} />
    </FieldRow>
  );
}

export function TextAreaField({ label, name, hint, required, className, ...props }: { label: string; name: string; hint?: ReactNode } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = props.id ?? `f-${name}`;
  return (
    <FieldRow label={label} htmlFor={id} hint={hint} required={required} className={className}>
      <Textarea id={id} name={name} required={required} rows={2} {...props} />
    </FieldRow>
  );
}

export type Option = { value: string; label: string };

/** Select bawaan peramban (ringan, berfungsi di formulir tanpa JS). */
export function SelectField({
  label,
  name,
  options,
  hint,
  required,
  placeholder,
  className,
  ...props
}: { label: string; name: string; options: readonly Option[]; hint?: ReactNode; placeholder?: string } & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = props.id ?? `f-${name}`;
  return (
    <FieldRow label={label} htmlFor={id} hint={hint} required={required} className={className}>
      <select
        id={id}
        name={name}
        required={required}
        className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        {...props}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldRow>
  );
}

/** Kotak centang untuk FormData (`on` bila dicentang). */
export function CheckField({ label, name, defaultChecked, hint }: { label: string; name: string; defaultChecked?: boolean; hint?: ReactNode }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="mt-0.5 size-4 accent-primary" />
      <span>
        {label}
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}

/** Kisi 2 kolom responsif untuk bidang formulir. */
export function FormGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid gap-3 sm:grid-cols-2", className)}>{children}</div>;
}
