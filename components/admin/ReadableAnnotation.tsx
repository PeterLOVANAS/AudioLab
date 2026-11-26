import { readableBlockAnswer } from "@/lib/contracts/readable-answers";
import type { ResearchBlock } from "@/lib/contracts/research-export";

/** Render a labelled export projection without exposing raw option UUIDs as the
 * answer. React escapes source text; IDs/revisions remain in the JSON provenance.
 * This component has no input controls and cannot alter an annotation.
 */
export function ReadableValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span>No answer</span>;
  if (Array.isArray(value))
    return value.length ? (
      <ol>
        {value.map((entry, index) => (
          <li key={index}>
            <ReadableValue value={entry} />
          </li>
        ))}
      </ol>
    ) : (
      <span>No entries</span>
    );
  if (typeof value === "object")
    return (
      <dl>
        {Object.entries(value).map(([key, entry]) => (
          <div key={key}>
            <dt>{key.replace(/([A-Z])/g, " $1")}</dt>
            <dd>
              <ReadableValue value={entry} />
            </dd>
          </div>
        ))}
      </dl>
    );
  return <span style={{ whiteSpace: "pre-wrap" }}>{String(value)}</span>;
}
/** Shared readable summary for individual per-audio and whole-task answers. */
export function ReadableAnnotation({
  block,
  value,
  audioLabels = [],
}: {
  block: ResearchBlock;
  value: unknown;
  audioLabels?: string[];
}) {
  return (
    <section className="export-readable-answer">
      <h4>{block.label}</h4>
      <ReadableValue value={readableBlockAnswer(block, value, audioLabels)} />
    </section>
  );
}
