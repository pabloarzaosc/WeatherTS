/**
 * The on/off header every layer panel opens with.
 *
 * One component rather than a copy per panel: the control carries the layer's
 * state as much as it sets it -- a lit dot and a LIVE/OFF/ERROR readout -- so
 * two panels drifting apart would mean two different answers to "is this on?".
 */
export function LayerPower({
  label,
  on,
  onToggle,
  error = false,
  onText = "LIVE",
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
  /** Draws the row as faulted and reads ERROR, whatever the toggle state. */
  error?: boolean;
  /** What "on" reads: the archive's layers are on, but not live. */
  onText?: string;
}) {
  const cls = `layer-power${on ? " is-on" : ""}${error ? " is-error" : ""}`;
  return (
    <button type="button" className={cls} aria-pressed={on} onClick={onToggle}>
      <span className="layer-power__dot" />
      <span className="layer-power__txt">{label}</span>
      <span className="layer-power__state">{error ? "ERROR" : on ? onText : "OFF"}</span>
    </button>
  );
}
