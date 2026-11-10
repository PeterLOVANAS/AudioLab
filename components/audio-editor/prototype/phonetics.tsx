"use client";
import { symbolGroups } from "@/lib/audio/prototype/phonetics";
export function PhoneticPalette({
  config,
  onInsert,
}: {
  config: any;
  onInsert: (s: string) => void;
}) {
  return (
    <details className="r-palette" open>
      <summary>
        {config.alphabet} symbols · {config.level} transcription
      </summary>
      {config.alphabet === "SAMPA" && !config.symbols?.length && (
        <p className="r-hint">
          SAMPA inventories are language-specific. Ask the admin to supply your
          project inventory; these are starter symbols.
        </p>
      )}
      {Object.entries(symbolGroups(config)).map(([name, symbols]) => (
        <div key={name}>
          <small>{name}</small>
          <div>
            {symbols.map((s: string) => (
              <button
                key={s}
                type="button"
                title={`Insert ${s}`}
                aria-label={`Insert symbol ${s}`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => onInsert(s)}
              >
                {/^[\u0300-\u036f]/.test(s) ? "◌" + s : s}
              </button>
            ))}
          </div>
        </div>
      ))}
    </details>
  );
}
export function PhoneticsSettings({
  value,
  onChange,
}: {
  value: any;
  onChange: (v: any) => void;
}) {
  return (
    <div className="r-stack">
      <h3>Speech notation</h3>
      <div className="r-form-grid">
        <label className="r-field">
          <span>Symbol system</span>
          <select
            className="field"
            value={value.alphabet}
            onChange={(e) => onChange({ ...value, alphabet: e.target.value })}
          >
            {["IPA", "SAMPA", "X-SAMPA", "ARPABET"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label className="r-field">
          <span>Transcription detail</span>
          <select
            className="field"
            value={value.level}
            onChange={(e) => onChange({ ...value, level: e.target.value })}
          >
            <option value="phonemic">Phonemic / contrastive</option>
            <option value="broad">Broad phonetic</option>
            <option value="narrow">Narrow phonetic</option>
          </select>
        </label>
      </div>
      <label className="r-field">
        <span>
          Project symbols, separated by spaces (optional; recommended for SAMPA)
        </span>
        <textarea
          className="notes"
          value={(value.symbols || []).join(" ")}
          onChange={(e) =>
            onChange({
              ...value,
              symbols: e.target.value.split(/\s+/).filter(Boolean),
            })
          }
        />
      </label>
      <p className="r-hint">
        This configures the palette and exported metadata; it does not
        automatically convert existing labels. Narrow IPA exposes additional
        diacritics. ARPABET uses its own inventory rather than IPA diacritics.
      </p>
    </div>
  );
}
