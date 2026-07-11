/**
 * ToggleSwitch — a shared on/off switch PRIMITIVE (#306 item 3).
 *
 * A real toggle SWITCH (a sliding track + thumb), not a checkbox: rendered as a `role="switch"`
 * button with `aria-checked` so it is accessible (keyboard-operable, correctly announced by screen
 * readers) AND agent-drivable via a stable `data-testid`. Controlled — the caller owns the boolean
 * and gets `onChange(next)` on activation. Presentational only (no storage / data access); the
 * container wires persistence.
 */
export function ToggleSwitch({
  checked,
  onChange,
  label,
  testid,
  disabled = false,
}: {
  /** Current on/off state. */
  checked: boolean;
  /** Called with the toggled value when the user activates the switch. */
  onChange: (next: boolean) => void;
  /** Accessible name (also the `title`) — this control has no visible text of its own. */
  label: string;
  /** Stable selector for tests / agents. */
  testid?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      data-testid={testid}
      data-checked={checked ? 'true' : 'false'}
      disabled={disabled}
      className="dig-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="dig-switch-track" aria-hidden="true">
        <span className="dig-switch-thumb" />
      </span>
    </button>
  );
}
