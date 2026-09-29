/**
 * A number input that lets you finish typing.
 *
 * The bug this exists to kill: the host dialog clamped on every keystroke, so typing "180" into
 * Duration produced 1 → 5 (clamped up) → 58 → 240 (clamped down) — the last digits vanished and the
 * field fought back. The fix is to keep the raw text while the field has focus and only coerce it to a
 * number when the pointer leaves the field (or the form is submitted).
 */
import { useEffect, useState } from 'react';
import { TextInput } from '../../../components/ui';

export function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
}) {
  const [raw, setRaw] = useState(String(value));
  const [focused, setFocused] = useState(false);

  /* Follow outside changes (a preset, a reset) — but never while someone is typing. */
  useEffect(() => {
    if (!focused) setRaw(String(value));
  }, [value, focused]);

  const commit = () => {
    const digits = raw.replace(/[^0-9]/g, '');
    const parsed = digits === '' ? min : Number(digits);
    const clamped = Math.min(Math.max(parsed, min), max);
    onChange(clamped);
    setRaw(String(clamped));
  };

  return (
    <div>
      <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor={id}>
        {label} <span className="text-[11px] text-[var(--color-muted)]">({min}–{max})</span>
      </label>
      <TextInput
        id={id}
        value={raw}
        inputMode="numeric"
        autoComplete="off"
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onChange={(event) => setRaw(event.target.value.replace(/[^0-9]/g, ''))}
      />
    </div>
  );
}
