"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircle } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
  type Control,
  type FieldPath,
  type FieldValues,
  type Resolver,
  useForm,
  type UseFormProps,
  type UseFormReturn,
  useFormState,
} from "react-hook-form";
import type { z } from "zod";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { DateInput } from "./date-input";
import { LiterInput, MoneyInput } from "./integer-input";

/**
 * `useForm` + `zodResolver` dengan tipe masukan/keluaran dari skema Zod (skema yang sama dipakai layanan server).
 * ```tsx
 * const form = useZodForm(createOrderSchema, { defaultValues: { volumeL: 5000 } });
 * <Form {...form}><form onSubmit={form.handleSubmit(onSubmit)}>…</form></Form>
 * ```
 */
export function useZodForm<TSchema extends z.ZodType<FieldValues, FieldValues>>(
  schema: TSchema,
  options: Omit<UseFormProps<z.input<TSchema>, unknown, z.output<TSchema>>, "resolver"> = {},
): UseFormReturn<z.input<TSchema>, unknown, z.output<TSchema>> {
  return useForm<z.input<TSchema>, unknown, z.output<TSchema>>({
    mode: "onTouched",
    ...options,
    resolver: zodResolver(schema) as unknown as Resolver<z.input<TSchema>, unknown, z.output<TSchema>>,
  });
}

type BaseFieldProps<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  control: Control<TFieldValues, any, any>;
  name: TName;
  label?: ReactNode;
  description?: ReactNode;
  /** Tampilkan tanda wajib (*) pada label. */
  required?: boolean;
  disabled?: boolean;
  className?: string;
};

function asControl<T extends FieldValues>(control: Control<T, unknown, unknown>): Control<T> {
  return control as unknown as Control<T>;
}

function FieldLabel({ label, required }: { label?: ReactNode; required?: boolean }) {
  if (!label) return null;
  return (
    <FormLabel>
      {label}
      {required ? (
        <span aria-hidden className="text-destructive">
          *
        </span>
      ) : null}
    </FormLabel>
  );
}

export type FormFieldTextProps<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>> = BaseFieldProps<
  TFieldValues,
  TName
> &
  Pick<ComponentProps<"input">, "type" | "placeholder" | "autoComplete" | "inputMode" | "maxLength" | "autoFocus">;

/** Kolom teks (react-hook-form + label + pesan galat Zod). */
export function FormFieldText<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>>({
  control,
  name,
  label,
  description,
  required,
  disabled,
  className,
  ...inputProps
}: FormFieldTextProps<TFieldValues, TName>) {
  return (
    <FormField
      control={asControl(control)}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FieldLabel label={label} required={required} />
          <FormControl>
            <Input {...inputProps} {...field} value={field.value ?? ""} disabled={disabled || field.disabled} />
          </FormControl>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export type FormFieldTextareaProps<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>> = BaseFieldProps<
  TFieldValues,
  TName
> & { placeholder?: string; rows?: number; maxLength?: number };

/** Kolom teks panjang. */
export function FormFieldTextarea<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>>({
  control,
  name,
  label,
  description,
  required,
  disabled,
  className,
  ...textareaProps
}: FormFieldTextareaProps<TFieldValues, TName>) {
  return (
    <FormField
      control={asControl(control)}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FieldLabel label={label} required={required} />
          <FormControl>
            <Textarea {...textareaProps} {...field} value={field.value ?? ""} disabled={disabled || field.disabled} />
          </FormControl>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export type SelectOption = { value: string; label: string; disabled?: boolean };

export type FormFieldSelectProps<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>> = BaseFieldProps<
  TFieldValues,
  TName
> & { options: readonly SelectOption[]; placeholder?: string };

/** Kolom pilihan (Select). Nilai string; pakai `enumOptions("…")` dari `@/lib/labels` untuk enum. */
export function FormFieldSelect<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>>({
  control,
  name,
  label,
  description,
  required,
  disabled,
  className,
  options,
  placeholder = "Pilih…",
}: FormFieldSelectProps<TFieldValues, TName>) {
  return (
    <FormField
      control={asControl(control)}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FieldLabel label={label} required={required} />
          <Select value={field.value ?? ""} onValueChange={field.onChange} disabled={disabled || field.disabled} name={field.name}>
            <FormControl>
              <SelectTrigger className="w-full" onBlur={field.onBlur} ref={field.ref}>
                <SelectValue placeholder={placeholder} />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export type FormFieldNumberProps<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>> = BaseFieldProps<
  TFieldValues,
  TName
> & { placeholder?: string; max?: number };

/** Kolom rupiah bulat (nilai `number | null`). Padankan dengan `zRupiah*` di skema. */
export function FormFieldMoney<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>>({
  control,
  name,
  label,
  description,
  required,
  disabled,
  className,
  placeholder,
  max,
}: FormFieldNumberProps<TFieldValues, TName>) {
  return (
    <FormField
      control={asControl(control)}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FieldLabel label={label} required={required} />
          <FormControl>
            <MoneyInput
              ref={field.ref}
              name={field.name}
              value={field.value ?? null}
              onValueChange={field.onChange}
              onBlur={field.onBlur}
              disabled={disabled || field.disabled}
              placeholder={placeholder}
              max={max}
            />
          </FormControl>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** Kolom liter bulat (nilai `number | null`). */
export function FormFieldLiter<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>>({
  control,
  name,
  label,
  description,
  required,
  disabled,
  className,
  placeholder,
  max,
}: FormFieldNumberProps<TFieldValues, TName>) {
  return (
    <FormField
      control={asControl(control)}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FieldLabel label={label} required={required} />
          <FormControl>
            <LiterInput
              ref={field.ref}
              name={field.name}
              value={field.value ?? null}
              onValueChange={field.onChange}
              onBlur={field.onBlur}
              disabled={disabled || field.disabled}
              placeholder={placeholder}
              max={max}
            />
          </FormControl>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export type FormFieldDateProps<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>> = BaseFieldProps<
  TFieldValues,
  TName
> & { min?: string; max?: string; placeholder?: string; clearable?: boolean };

/** Kolom tanggal bisnis WIB (`YYYY-MM-DD`). */
export function FormFieldDate<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>>({
  control,
  name,
  label,
  description,
  required,
  disabled,
  className,
  min,
  max,
  placeholder,
  clearable,
}: FormFieldDateProps<TFieldValues, TName>) {
  return (
    <FormField
      control={asControl(control)}
      name={name}
      render={({ field, fieldState }) => (
        <FormItem className={className}>
          <FieldLabel label={label} required={required} />
          <FormControl>
            <DateInput
              value={field.value ?? null}
              onValueChange={(v) => {
                field.onChange(v);
                field.onBlur();
              }}
              min={min}
              max={max}
              placeholder={placeholder}
              clearable={clearable}
              disabled={disabled || field.disabled}
              aria-invalid={fieldState.invalid || undefined}
            />
          </FormControl>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export type FormFieldToggleProps<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>> = BaseFieldProps<
  TFieldValues,
  TName
> & { variant?: "checkbox" | "switch" };

/** Kotak centang / sakelar boolean dengan label di sampingnya. */
export function FormFieldCheckbox<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>>({
  control,
  name,
  label,
  description,
  disabled,
  className,
  variant = "checkbox",
}: FormFieldToggleProps<TFieldValues, TName>) {
  return (
    <FormField
      control={asControl(control)}
      name={name}
      render={({ field }) => (
        <FormItem className={cn("flex flex-row items-start gap-3", className)}>
          <FormControl>
            {variant === "switch" ? (
              <Switch
                checked={!!field.value}
                onCheckedChange={field.onChange}
                onBlur={field.onBlur}
                ref={field.ref}
                disabled={disabled || field.disabled}
              />
            ) : (
              <Checkbox
                checked={!!field.value}
                onCheckedChange={(v) => field.onChange(v === true)}
                onBlur={field.onBlur}
                ref={field.ref}
                disabled={disabled || field.disabled}
              />
            )}
          </FormControl>
          <div className="grid gap-1 leading-none">
            {label ? <FormLabel className="font-normal">{label}</FormLabel> : null}
            {description ? <FormDescription>{description}</FormDescription> : null}
            <FormMessage />
          </div>
        </FormItem>
      )}
    />
  );
}

export type FormSubmitButtonProps<TFieldValues extends FieldValues = FieldValues> = Omit<
  ComponentProps<typeof Button>,
  "type"
> & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  control?: Control<TFieldValues, any, any>;
  /** Teks saat menyimpan. */
  pendingLabel?: string;
};

/** Tombol kirim: nonaktif & berputar selama `isSubmitting`. Harus di dalam `<Form>` atau diberi `control`. */
export function FormSubmitButton<TFieldValues extends FieldValues = FieldValues>({
  control,
  pendingLabel = "Menyimpan…",
  children,
  disabled,
  ...props
}: FormSubmitButtonProps<TFieldValues>) {
  const { isSubmitting } = useFormState({ control: control ? asControl(control) : undefined });
  return (
    <Button type="submit" disabled={disabled || isSubmitting} {...props}>
      {isSubmitting ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
      {isSubmitting ? pendingLabel : children}
    </Button>
  );
}

/** Pesan galat tingkat formulir (`form.setError("root", { message })`), mis. dari `DomainError` server. */
export function FormRootError<TFieldValues extends FieldValues = FieldValues>({
  control,
  className,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  control?: Control<TFieldValues, any, any>;
  className?: string;
}) {
  const { errors } = useFormState({ control: control ? asControl(control) : undefined });
  const root = errors.root as { message?: string; server?: { message?: string } } | undefined;
  const message = root?.message ?? root?.server?.message;
  if (!message) return null;
  return (
    <p role="alert" className={cn("rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive", className)}>
      {String(message)}
    </p>
  );
}
