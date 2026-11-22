import { Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  value: number;
  /** Highest allowed value; below 1 disables the stepper. */
  max: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  /** Accessible name of the number field. */
  label?: string;
  size?: 'default' | 'sm';
  className?: string;
}

/** − [n] + pill, clamped to 1..max. */
export function QuantityStepper({ value, max, onChange, disabled = false, label = 'Quantity', size = 'default', className }: Props) {
  const clamp = (n: number) => Math.max(1, Math.min(max, n));
  const off = disabled || max < 1;
  const btn = cn('flex cursor-pointer items-center justify-center disabled:cursor-not-allowed disabled:text-muted-2', size === 'sm' ? 'size-8' : 'size-10');
  return (
    <div className={cn('inline-flex items-center rounded-full border border-line bg-white', size === 'sm' ? 'h-8' : 'h-10', className)}>
      <button type="button" aria-label="Decrease quantity" disabled={off || value <= 1} onClick={() => onChange(clamp(value - 1))} className={btn}>
        <Minus className="size-4" />
      </button>
      <input
        type="number"
        aria-label={label}
        min={1}
        max={Math.max(1, max)}
        value={value}
        disabled={off}
        onChange={(e) => onChange(clamp(Number(e.target.value) || 1))}
        className={cn(
          'h-full bg-transparent text-center text-sm font-semibold outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
          size === 'sm' ? 'w-9' : 'w-12',
        )}
      />
      <button type="button" aria-label="Increase quantity" disabled={off || value >= max} onClick={() => onChange(clamp(value + 1))} className={btn}>
        <Plus className="size-4" />
      </button>
    </div>
  );
}
