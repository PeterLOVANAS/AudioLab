"use client";
import { useState } from "react";
import { normalizeSourceChoices } from "@/lib/frontend/choice-source";
import type { Option } from "./model";

/** Explicit replacement, local parsing only. Stable IDs in {id,label} arrays are
 * retained; failed imports leave the block untouched. No media or JSON is uploaded.
 */
export default function ChoiceJsonImport({
  onImport,
}: {
  onImport: (options: Option[]) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  function apply() {
    try {
      const options = normalizeSourceChoices(text, "json");
      if (options.some((option) => option.id === "__custom__"))
        throw new Error("__custom__ is reserved");
      onImport(options);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Invalid JSON");
    }
  }
  return (
    <details className="tb-choice-json-import">
      <summary>Import choices from JSON</summary>
      <p>
        Use an array of names or objects with id and label. Import replaces
        manual choices and switches off the dataset choices binding.
      </p>
      <input
        aria-label="Choices JSON file"
        type="file"
        accept=".json,application/json"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          if (file.size > 250000) {
            setError("JSON file exceeds 250 KB");
            return;
          }
          try {
            setText(await file.text());
            setError("");
          } catch {
            setError("Cannot read JSON file");
          }
        }}
      />
      <textarea
        aria-label="Choices JSON"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder='["Bird", "Rain", "Wind"]'
      />
      <button type="button" onClick={apply}>
        Import JSON choices
      </button>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
