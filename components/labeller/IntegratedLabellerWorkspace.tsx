"use client";
// This string directive marks the client-component boundary: this module can use
// React hooks and browser APIs. It does not mean every statement below runs on
// every render. Imports/module bindings are established when the module loads;
// the component function farther down runs when React renders this instance.
/**
 * AudioLab prototype-style Labeller Workspace, based on V4 Builder.
 *
 * LEFT: Owner-scoped persisted assignments by default; optional local dataset practice.
 * RIGHT: Exactly the same WorkbenchLayout + BlockFields as Builder Preview.
 *
 * Assigned rows open the exact admin-allocated Task Instance/version; practice
 * can create standalone work using the existing audio-queue endpoint.
 * Once opened, D1 annotation revisions power
 * autosave, resume and submission. Template drafts never store real answers.
 *
 * Queue GET transfers metadata, not WAV bytes; opening an item fetches only
 * its published definition/annotation JSON. Audio playback uses R2-backed URLs.
 */
/**
 * Architectural boundary: app/page.tsx mounts this client component inside the
 * shared shell. It coordinates task selection and persistence; WorkbenchLayout
 * arranges the screen, and BlockFields renders the same controls as Builder
 * Preview. Keeping answers here lets every field share one revision/save cycle.
 *
 * Backend map (all paths start with /api/v1):
 * - GET task-definitions and datasets: project catalogs, not recordings.
 * - GET/POST labeller/audio-queue: page metadata / create or reuse real work.
 * - GET assignments/:id and its /annotation: published task + latest answers.
 * - POST assignments/:id/start: record that an assigned task was opened.
 * - POST its /annotation/draft or /submit: append validated D1 revisions.
 * labeller-api.ts wraps the assignment calls; readJson below handles catalogs
 * and the audio queue. Audio controls fetch R2-backed asset URLs separately;
 * mounting a waveform/grounding control can fetch bytes before pressing Play.
 *
 * The supplied project/member IDs describe local pilot context, not a verified
 * login. Backend DEV gates and ownership comparisons are not authentication.
 */
// Braces select named exports from React. These are imported functions, not local
// state variables; later hook calls create/access state for a mounted component.
// Importing a hook does not call it. We will unpack each hook at its call site.
import { startingAssignmentAnswers } from "@/lib/frontend/source-binding";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  Headphones,
  RefreshCw,
  Search,
  LockKeyhole,
} from "lucide-react";
// Without braces, WorkbenchLayout names that module's default export. The @/
// prefix is this project's root alias (tsconfig.json), not an npm package name.
// This component places supplied queue, grounding and children into UI regions.
import WorkbenchLayout from "@/components/workbench/WorkbenchLayout";
// Imports with no binding load styles for their side effect. They neither return
// a CSS object here nor fetch audio. Leave their order intact for the cascade.
import "./prototype-audio-queue.css";
import "./prototype-queue-skin.css";
// This combines a default component with named exports. checkAnswers is a runtime
// function returning validation messages; `type Answers` and `type Samples` are
// compile-time descriptions, erased from emitted JavaScript. In BlockFields,
// Answers = Record<string, unknown>: keys are block IDs; values need inspection
// before use, because different question kinds produce different answer shapes.
import BlockFields, {
  checkAnswers,
  type Answers,
  type Samples,
} from "@/components/workbench/BlockFields";
// readBlock is a real compatibility-normalization function used by the helper
// below; Block is its imported configuration type, not a constructor we call.
import { readBlock, type Block } from "@/components/task-builder/model";
// ApiError is a runtime class extending Error, so instanceof can recognize it.
// Its constructor keeps status and optional issues; the HTTP functions throw it
// for non-2xx responses. AssignmentDetail is only a type describing the returned
// { assignment, taskInstance } JSON. The imported API functions are called later,
// not as a consequence of listing them in this import.
import {
  ApiError,
  getAssignmentDetail,
  withCandidateSets,
  getCurrentAnnotation,
  startAssignment,
  writeAnnotation,
  type AssignmentDetail,
} from "@/lib/frontend/labeller-api";
// This adapter sorts bound assets by position and builds the renderer's Samples
// object (URLs, named slots and first curated candidate). Calling it maps data;
// the function itself performs no fetch, decoding or annotation write.
import { toLabellerSamples } from "@/lib/frontend/labeller-samples";

// Type aliases describe the JSON shapes this UI expects; they create no runtime
// objects or validation. `version?: string` is optional, while `number | null`
// explicitly permits a present but unknown duration. These are distinct cases.
type Definition = {
  // A type alias names an object shape: `id: string` constrains a property's
  // type, not its current value. Unlike constructing a Python dict, this creates
  // no object. The two counters describe editable-draft saves vs publications;
  // they are metadata from the catalog, not this Labeller's answer revision.
  id: string;
  name: string;
  publishedVersion: number;
  draftRevision: number;
};
// `?` lets version be absent; reading an absent property gives undefined. It is
// different from explicitly sending null, which this optional string disallows
// under the project's strict TypeScript settings.
type Dataset = { id: string; name: string; version?: string };
type AudioRow = {
  id: string;
  originalPath: string;
  // `|` is a type union, not the runtime OR operator `||`: D1 metadata may carry
  // a number or null. This field is required even when its value is unknown.
  durationSeconds: number | null;
};

// Duration is metadata from D1, not a playback clock. Null/zero must NOT look
// like a verified zero-second recording. Avoid 0s when rounding short clips.
function formatAudioDuration(seconds: number | null | undefined): string {
  // The parameter is supplied by the queue-card call below using an AudioRow's
  // durationSeconds; undefined is also accepted. `: string` declares the return
  // type. This pure helper returns display text; it changes no state or metadata.
  if (
    // `typeof` tests the runtime value. `!==` means strict inequality, without
    // coercing text like "2" into a number. `||` short-circuits: once one test is
    // true, later tests are skipped and we enter the unknown-duration branch.
    typeof seconds !== "number" ||
    // Number.isFinite excludes NaN and infinities, which typeof calls numbers.
    // A positive finite value is needed before formatting a real duration label.
    !Number.isFinite(seconds) ||
    seconds <= 0
  ) {
    // Early return exits the function. After this branch, TypeScript can narrow
    // seconds to number, so calling its number method toFixed is valid.
    return "Duration unknown";
  }
  // Backticks form a template string; ${...} inserts an expression's result.
  // `test ? a : b` chooses 2 decimal places below 0.1 s, otherwise 1. toFixed
  // RETURNS a rounded string, not a changed seconds value: 0.04 -> "0.04 s",
  // 1.26 -> "1.3 s". This display policy is not an audio timing calculation.
  return `${seconds.toFixed(seconds < 0.1 ? 2 : 1)} s`;
}
// Quoted alternatives make this a union of allowed string VALUES, not all
// possible strings. It checks code at compile time; incoming JSON still needs
// runtime checks. A ready metadata group need not have an assignment yet.
type QueueStatus =
  "ready" | "assigned" | "in_progress" | "submitted" | "reviewed";
type AudioGroup = {
  title?: string;
  jobId?:string|null;jobName?:string|null;
  key: string;
  sourceRecordId?: string;
  sourceRecordIds?: string[];
  // T[] means an array of T. One queue card can hold several recording metadata
  // rows; it is not an array of audio-byte buffers or of separate assignments.
  assets: AudioRow[];
  assignmentId: string | null;
  status: QueueStatus;
};
type QueueResult = {
  // This is the response envelope, not one group. definition.version pins the
  // published protocol viewed by the queue; openGroup sends it back when opening
  // new work. requiredAudio is recordings PER group, not groups PER queue page.
  definition: { id: string; version: number; name: string };
  requiredAudio: number;
  totalAudio: number;
  totalSubmitted?:number;
  totalPending?:number;
  totalCompleteGroups: number;
  remainderAudio: number;
  groups: AudioGroup[];
  // A cursor is a server continuation key; null means no further page is offered.
  // Later code passes this string back rather than computing an array offset.
  nextCursor: string | null;
  hasMore: boolean;
};
// A literal union restricts spelling at compile time. This UI status is separate
// from QueueStatus: a task may be in_progress while its latest local edit is dirty.
type SaveState =
  "loading" | "saved" | "dirty" | "saving" | "error" | "conflict" | "submitted";

// Compare complete JSON snapshots, not object identity: a new answer object can
// represent the same values. This is an order-sensitive serialization, not a hash
// or semantic deep comparison, and its cost grows with large timeline answers.
// `const` binds a name that cannot be reassigned; it does not freeze objects.
// Here it holds an arrow function. `(answers: Answers)` declares a parameter;
// `=> expression` implicitly returns that expression. JSON.stringify serializes
// the imported Answers map as text, so later dirty checks compare strings rather
// than references. Calling stamp never marks anything saved or writes D1.
const stamp = (answers: Answers) => JSON.stringify(answers);
// This arrow also has an implicit return despite the line break. instanceof
// narrows an unknown value to Error; only that branch reads .message. The ternary
// provides a fixed fallback for thrown strings/objects instead of assuming every
// JavaScript rejection is an Error instance. Callers put the result in UI state.
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Unexpected error";
// `unknown` requires narrowing before reading properties, unlike `any`. Convert
// server answer issues into at most 20 UI messages; non-API errors have no list.
function getIssues(error: unknown): string[] {
  // error is the caller's caught value, not React state. `string[]` promises an
  // array of messages. `!` negates a test; if the value is not our imported
  // ApiError, || skips the .issues access. Even an ApiError can lack an issue
  // array, so Array.isArray checks that separately. Either failure returns [].
  if (!(error instanceof ApiError) || !Array.isArray(error.issues)) return [];
  // slice(0, 20) copies at most indices 0..19 without mutating the server's array.
  // map calls the arrow once for each entry and builds a NEW message array in the
  // same order. This arrow has braces, so it needs explicit return statements.
  return error.issues.slice(0, 20).map((issue: unknown) => {
    // The callback parameter is ONE item from error.issues, not the outer error.
    // null is falsy but typeof null is "object", so !issue must reject it too.
    // This is a shallow check: arrays/other objects are not excluded here.
    if (!issue || typeof issue !== "object") return "Invalid answer.";
    // `as` tells TypeScript to view this object as a string-keyed record; it
    // does not convert the object or verify its fields. value refers to the same
    // object as issue, with values still unknown. No mutation happens here.
    const value = issue as Record<string, unknown>;
    // `??` uses the fallback ONLY for null/undefined; unlike ||, it preserves an
    // empty string or 0. String(...) converts each selected value to display text;
    // the template adds a colon between block ID and message. Missing fields get
    // readable defaults instead of "undefined". The outer return collects these
    // messages; it does not call setIssues (the save/submit callers do that).
    return `${String(value.blockId ?? "Answer")}: ${String(value.message ?? "Invalid value")}`;
  });
}
// A shallow response guard plus readBlock's compatibility normalization allows
// saved definitions to feed the shared renderer. Invalid outer shapes produce
// no fields; `as Block[]` is a type assertion, not full block-schema validation.
function normalizeBlocks(raw: unknown): Block[] {
  // raw comes from detail?.taskInstance.definition.blocks in a later useMemo.
  // Before detail exists it is undefined, so return [] rather than rendering old
  // task fields. This helper knows only the minimum shape needed for readBlock.
  if (
    // The || guard prevents calling .every on a non-array. every returns true
    // only when all visited entries satisfy its callback (also true for []).
    !Array.isArray(raw) ||
    !raw.every(
      (b) =>
        // b is one raw entry. && evaluates left to right and stops at a falsy
        // result, so b rejects null before b.id is accessed. Subsequent tests
        // require three string properties; they do not validate label contents/options,
        // supported block types, or the complete published protocol schema.
        b &&
        typeof b === "object" &&
        typeof b.id === "string" &&
        typeof b.type === "string" &&
        typeof b.label === "string",
    )
  )
    // `if (condition) return ...` needs no braces for this one statement.
    // !every means ONE invalid entry rejects the whole list, not just that entry.
    return [];
  // The assertion allows typed Block access after the shallow checks, but adds
  // no runtime validation. map(readBlock) passes the imported function itself as
  // a callback; map invokes it for each block. readBlock keeps unsupported kinds
  // unchanged, and for editable kinds normalizes legacy showwhen/options, adds
  // missing candidate choices, and recursively handles nested blocks. map makes
  // a new outer array; this is not a guarantee of a completely deep-cloned graph.
  return (raw as Block[]).map(readBlock);
}
/**
 * Fetch JSON and translate non-2xx responses into ApiError for the caller's UI.
 * T is a generic result type (for example QueueResult); Promise<T> means the
 * value arrives asynchronously. `await` pauses this function, not the UI thread.
 * The final assertion trusts successful JSON rather than validating it as T.
 * `init` can supply an abort signal or POST body. no-store requests fresh mutable
 * metadata; callers decide whether errors belong in queue feedback or save state.
 */
async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers,
  });
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const body =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    throw new ApiError(
      response.status,
      typeof body.error === "string" ? body.error : `HTTP ${response.status}`,
      body.issues,
    );
  }
  return raw as T;
}

// Props are inputs from the shell, destructured into local names. The optional
// onDirtyChange callback sends information upward so the shell can warn before
// navigation; focusAssignmentId lets the overview request a particular task.
// The shell keys this component by project/member/focus, remounting on that key's
// change. It therefore owns those broader context changes, not this form alone.
export default function IntegratedLabellerWorkspace({
  projectId,
  labellerId,
  focusAssignmentId,
  onDirtyChange,
}: {
  projectId: string;
  labellerId: string;
  focusAssignmentId?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  // State survives renders within this mounted component. Catalogs and the
  // selected IDs are separate: selecting a definition/dataset triggers the queue
  // effect, while search/statusFilter only derive a view of already loaded rows.
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [definitionId, setDefinitionId] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const [assignedOnly,setAssignedOnly]=useState(true);
  const [queueJobId,setQueueJobId]=useState("");
  const [ownedJobs,setOwnedJobs]=useState<Array<{id:string;name:string;total:number}>>([]);
  // Job selection is scoped to a verified worker/project, never carried into
  // another project where its ID would silently produce an empty queue.
  useEffect(()=>{setQueueJobId("");setOwnedJobs([]);},[projectId,labellerId]);
  const [queue, setQueue] = useState<AudioGroup[]>([]);
  const [queueInfo, setQueueInfo] = useState<QueueResult | null>(null);
  const [queueCursor, setQueueCursor] = useState<string | null>(null);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "todo" | "submitted"
  >("all");
  const [assignmentId, setAssignmentId] = useState<string | null>(
    focusAssignmentId ?? null,
  );
  const [detail, setDetail] = useState<AssignmentDetail | null>(null);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [taskLoading, setTaskLoading] = useState(Boolean(focusAssignmentId));
  // useState preserves the answer map between renders; <Answers> is its generic
  // type argument (a block-ID -> unknown-value record). setAnswers schedules a
  // render with new values, making all controlled fields see the same answers.
  // It does NOT write D1. updateAnswers marks local edits, and the autosave effect
  // bridges those edits to writeAnnotation; only its response confirms a save.
  const [answers, setAnswers] = useState<Answers>({});
  const [revision, setRevision] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [feedback, setFeedback] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // Refs retain mutable coordination values without scheduling renders. Async
  // callbacks can read their latest .current values after an await, whereas a
  // closure captures state from the render that created it. State drives visible
  // answers/revision/status; these refs track the active task, latest answers,
  // accepted revision and last confirmed snapshot for pending operations.
  const activeRef = useRef<string | null>(assignmentId);
  const answersRef = useRef<Answers>({});
  const revisionRef = useRef(0);
  const savedStampRef = useRef(stamp({}));
  // A Promise<boolean> is a future success/failure result; null means no draft
  // operation is registered. Sharing this in-flight operation serializes this
  // component's draft writes. It cannot serialize writes from another tab.
  const saveInFlight = useRef<Promise<boolean> | null>(null);
  const submittingRef = useRef(false);
  const loadEpoch = useRef(0);
  const queueEpoch = useRef(0);
  const [refreshIndex, setRefreshIndex] = useState(0);

  // Dirty means local JSON differs from the last confirmed server snapshot.
  // Report pending writes/submission/conflicts too: identical-looking answers
  // alone do not prove it is safe to leave. `?.` calls the callback only if given.
  // Effects run after rendering; cleanup below clears the shell flag on unmount
  // (or callback replacement). This notification does not itself flush a save.
  // Closing a ballot is not a submitted annotation for non-voters. Keep their
  // real status/history and make this terminal job read-only without fake saves.
  const votingClosed = Object.values(
    detail?.taskInstance.candidateSets ?? {},
  ).some((set) => set.closed);
  const votingClosedRef = useRef(false);
  votingClosedRef.current = votingClosed;
  const isDirty = Boolean(
    !votingClosed && assignmentId && stamp(answers) !== savedStampRef.current,
  );
  useEffect(() => {
    onDirtyChange?.(
      isDirty ||
        Boolean(saveInFlight.current) ||
        submitting ||
        saveState === "conflict",
    );
  }, [isDirty, submitting, saveState, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    if (focusAssignmentId) setAssignmentId(focusAssignmentId);
  }, [focusAssignmentId]);

  // Effect dependencies describe when external work must be synchronized again:
  // changing projectId resets these choices and starts a new pair of requests.
  // Promise.all loads independent catalogs concurrently; a failure displays one
  // queue error. Cleanup aborts obsolete fetches and checks prevent their results
  // from updating state. `void` discards the promise value; the chain handles its
  // rejection. This effect loads metadata; mounted audio fields have other costs.
  // Only lightweight catalogs load here; no audio requests on entering mode.
  useEffect(() => {
    const ctrl = new AbortController();
    setCatalogLoading(true);
    setQueueError("");
    setDefinitions([]);
    setDatasets([]);
    setDefinitionId("");
    setDatasetId("");
    if (!projectId) {
      setCatalogLoading(false);
      return () => ctrl.abort();
    }
    void Promise.all([
      readJson<{ definitions: Definition[] }>(
        `/api/v1/task-definitions?projectId=${encodeURIComponent(projectId)}`,
        { signal: ctrl.signal },
      ),
      readJson<{ datasets: Dataset[] }>(
        `/api/v1/datasets?projectId=${encodeURIComponent(projectId)}`,
        { signal: ctrl.signal },
      ),
    ])
      .then(([defs, data]) => {
        if (ctrl.signal.aborted) return;
        setDefinitions(defs.definitions ?? []);
        setDatasets(data.datasets ?? []);
        setDefinitionId(
          (defs.definitions ?? []).find((d) => d.publishedVersion > 0)?.id ??
            "",
        );
        setDatasetId(data.datasets?.[0]?.id ?? "");
      })
      .catch((error) => {
        if (!ctrl.signal.aborted) setQueueError(errorText(error));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setCatalogLoading(false);
      });
    return () => ctrl.abort();
  }, [projectId]);

  /**
   * Read a page for the selected source; a cursor appends, no cursor replaces.
   * limit=12 counts task GROUPS, not recordings per group (requiredAudio). The
   * backend derives that requirement from the published definition. Each epoch
   * is a request number: an older response must not overwrite a newer queue even
   * if cancellation was absent or too late. Errors stay in the queue panel.
   *
   * useCallback retains this function while its dependencies are unchanged;
   * those dependencies are the selection values captured by its closure. This
   * also lets the queue effect rerun when the function's selected context changes.
   */
  const loadQueue = useCallback(
    async (cursor?: string, signal?: AbortSignal) => {
      if (!assignedOnly && (!definitionId || !datasetId)) {
        setQueue([]);
        setQueueInfo(null);
        return;
      }
      const epoch = ++queueEpoch.current;
      setQueueLoading(true);
      setQueueError("");
      try {
        const params = new URLSearchParams({
          projectId,
          labellerId,
          definitionId,
          datasetId,
          limit: "12",
        });
        if (cursor) params.set("cursor", cursor);
        const assignedParams=new URLSearchParams({projectId,labellerId,limit:"20",...(cursor?{cursor}:{}),...(queueJobId?{queueJobId}:{})});
        const result = await readJson<QueueResult>(
          assignedOnly?`/api/v1/labeller/assigned-queue?${assignedParams}`:`/api/v1/labeller/audio-queue?${params}`,
          { signal },
        );
        if (signal?.aborted || epoch !== queueEpoch.current) return;
        // A functional state updater receives React's current queued value,
        // avoiding a stale captured array when appending. Deduplicate group keys
        // without changing server order, so repeated pages do not duplicate cards.
        setQueue((previous) =>
          cursor
            ? [
                ...previous,
                ...result.groups.filter(
                  (row) =>
                    !previous.some((existing) => existing.key === row.key),
                ),
              ]
            : result.groups,
        );
        setOwnedJobs((result as QueueResult & {jobs?:Array<{id:string;name:string;total:number}>}).jobs ?? []);
        setQueueInfo(result);
        setQueueCursor(result.nextCursor);
      } catch (error) {
        if (!signal?.aborted && epoch === queueEpoch.current)
          setQueueError(errorText(error));
      } finally {
        if (epoch === queueEpoch.current) setQueueLoading(false);
      }
    },
    [projectId, labellerId, definitionId, datasetId,assignedOnly,queueJobId],
  );
  useEffect(() => {
    const ctrl = new AbortController();
    setQueue([]);
    setQueueInfo(null);
    setQueueCursor(null);
    void loadQueue(undefined, ctrl.signal);
    return () => ctrl.abort();
  }, [loadQueue, refreshIndex]);

  // Reset local task data, then load detail and the latest annotation together.
  // The detail contains the instance's pinned published version; the annotation
  // supplies this Labeller's saved answers/revision (null before the first save).
  // Abort + epoch checks protect the main load from stale responses. Check the
  // returned project/member too, but this client check is not server authorization.
  // startAssignment is a separate best-effort write: its errors are intentionally
  // swallowed below, so loading the form does not require that write to succeed.
  // Fetch only the OPENED assignment's published task and revision.
  useEffect(() => {
    const ctrl = new AbortController();
    const epoch = ++loadEpoch.current;
    activeRef.current = assignmentId;
    setDetail(null);
    setTaskLoading(Boolean(assignmentId));
    setAnswers({});
    answersRef.current = {};
    savedStampRef.current = stamp({});
    revisionRef.current = 0;
    setRevision(0);
    setSaveState("loading");
    setFeedback("");
    setIssues([]);
    if (!assignmentId) {
      setTaskLoading(false);
      return () => ctrl.abort();
    }
    void Promise.all([
      // Fetch only the opened job's owner projection; never prefetch peer votes.
      getAssignmentDetail(assignmentId, ctrl.signal).then((detail) =>
        withCandidateSets(detail, labellerId, ctrl.signal),
      ),
      getCurrentAnnotation(assignmentId, labellerId, ctrl.signal),
    ])
      .then(([loaded, current]) => {
        if (ctrl.signal.aborted || epoch !== loadEpoch.current) return;
        if (
          loaded.assignment.projectId !== projectId ||
          loaded.assignment.labellerId !== labellerId
        )
          throw new Error(
            "This assignment belongs to a different Labeller or project.",
          );
        // Server-pinned prefill seeds only a brand new annotation. Never merge
        // it into a saved draft: a missing key may be an intentional deletion.
        const saved = startingAssignmentAnswers(loaded.taskInstance, current.current);
        answersRef.current = saved;
        savedStampRef.current = stamp(current.current?.answers ?? {});
        revisionRef.current = current.current?.revision ?? 0;
        setAnswers(saved);
        setRevision(revisionRef.current);
        setDetail(loaded);
        setSaveState(
          current.current?.status === "submitted" ||
            loaded.assignment.status === "submitted" ||
            loaded.assignment.status === "reviewed"
            ? "submitted"
            : stamp(saved) !== savedStampRef.current ? "dirty" : "saved",
        );
        if (loaded.assignment.status === "assigned") {
          void startAssignment(assignmentId, labellerId)
            .then(() => {
              setQueue((items) =>
                items.map((item) =>
                  item.assignmentId === assignmentId
                    ? { ...item, status: "in_progress" }
                    : item,
                ),
              );
            })
            .catch(() => {
              /* Another tab may already have started it. */
            });
        }
      })
      .catch((error) => {
        if (!ctrl.signal.aborted) {
          setSaveState("error");
          setFeedback(errorText(error));
        }
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setTaskLoading(false);
      });
    return () => ctrl.abort();
  }, [assignmentId, projectId, labellerId]);

  // useMemo caches derived values until these dependencies change; it does not
  // persist data or fetch audio. toLabellerSamples maps ordered instance slots to
  // the renderer's preview-compatible props, including URLs and curated candidates.
  // The server resolves published bindings from pinned inputs, keeping both
  // later Builder edits and later source imports out of this job.
  const blocks = useMemo(
    () => normalizeBlocks(detail?.taskInstance.resolvedDefinition?.blocks ?? detail?.taskInstance.definition.blocks),
    [detail],
  );
  const samples = useMemo<Samples>(
    () => (detail ? toLabellerSamples(detail.taskInstance, blocks) : {}),
    [detail, blocks],
  );
  const hasGrounding = blocks.some(
    (block) => block.type === "timeline_annotation",
  );

  // BlockFields calls this callback with a replacement answer map. Update the ref
  // immediately for async readers and state for the screen, clear old feedback,
  // and mark dirty/saved by comparison. Submission guards reject further parent
  // answer updates; fieldset disabling below is additional UI protection.
  function updateAnswers(value: Answers) {
    if (submittingRef.current || saveState === "submitted" || votingClosed) return;
    answersRef.current = value;
    setAnswers(value);
    setFeedback("");
    setIssues([]);
    setSaveState(stamp(value) === savedStampRef.current ? "saved" : "dirty");
  }
  /**
   * Save one captured draft snapshot, or await the draft already in flight.
   * Returns true for an accepted/unchanged draft, false when blocked or failed.
   * revisionRef supplies expectedRevision: the server validates answers against
   * the published protocol, then D1 triggers reject stale/locked inserts. A 409
   * becomes conflict; other errors become error with optional per-block issues.
   *
   * Capture the task ID and payload before await. On success, update this editor
   * only if that task is still active; compare against CURRENT answers so edits
   * made during the request remain dirty instead of being falsely marked saved.
   * The callback depends on labellerId, while refs provide fresh mutable values.
   */
  const saveOnce = useCallback(async (): Promise<boolean> => {
    if (votingClosedRef.current) return true;
    const id = activeRef.current;
    if (!id || submittingRef.current) return false;
    if (saveInFlight.current) return saveInFlight.current;
    const snapshot = stamp(answersRef.current);
    if (snapshot === savedStampRef.current) return true;
    const payload = answersRef.current;
    setSaveState("saving");
    setFeedback("");
    const operation = (async () => {
      try {
        const result = await writeAnnotation(
          id,
          labellerId,
          revisionRef.current,
          payload,
          "draft",
        );
        if (activeRef.current !== id) return false;
        savedStampRef.current = snapshot;
        revisionRef.current = result.annotation.revision;
        setRevision(result.annotation.revision);
        setSaveState(
          stamp(answersRef.current) === snapshot ? "saved" : "dirty",
        );
        return true;
      } catch (error) {
        if (activeRef.current === id) {
          setSaveState(
            error instanceof ApiError && error.status === 409
              ? "conflict"
              : "error",
          );
          setFeedback(errorText(error));
          setIssues(getIssues(error));
        }
        return false;
      }
    })();
    saveInFlight.current = operation;
    try {
      return await operation;
    } finally {
      // finally runs for either outcome; identity checking avoids clearing a
      // different registered operation. Releasing this gate permits the next save.
      if (saveInFlight.current === operation) saveInFlight.current = null;
    }
  }, [labellerId]);
  // A switch may occur while an older snapshot is saving and newer edits exist.
  // Wait and recheck until caught up, for at most four passes; false keeps the
  // current task open. The bound avoids waiting indefinitely under continued
  // edits; it is not four automatic retries of a failed HTTP request.
  const flushDraft = useCallback(async (): Promise<boolean> => {
    if (votingClosedRef.current) return true;
    for (let n = 0; n < 4; n++) {
      if (saveInFlight.current && !(await saveInFlight.current)) return false;
      if (stamp(answersRef.current) === savedStampRef.current) return true;
      if (!(await saveOnce())) return false;
    }
    return stamp(answersRef.current) === savedStampRef.current;
  }, [saveOnce]);
  // Debounce persistence: after eligible edits settle, wait 3000 ms before saving.
  // Cleanup cancels the previous timer whenever dependencies change or we unmount.
  // This reduces requests during typing; it is not a durable background queue.
  // error/conflict pauses automatic attempts so failures are visible to the user.
  useEffect(() => {
    if (
      !detail ||
      votingClosed ||
      !isDirty ||
      submitting ||
      ["conflict", "error", "submitted"].includes(saveState)
    )
      return;
    const timer = window.setTimeout(() => {
      void saveOnce();
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [detail, answers, isDirty, saveState, submitting, saveOnce, votingClosed]);
  // Register once ([]), reading refs so this long-lived handler sees fresh data.
  // Ask the browser to warn about leaving; this does not save during unload or
  // guarantee delivery of an outstanding request. Cleanup removes the listener.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (
        (!votingClosedRef.current &&
          stamp(answersRef.current) !== savedStampRef.current) ||
        saveInFlight.current
      )
        event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  // Shared async gate for queue/source switches: block during opening/submission,
  // stop at a revision conflict, or flush pending edits. Promise<boolean> carries
  // the decision callers must await before changing selection; failure shows why.
  // The shell's role/project navigation instead uses its own dirty warning.
  // The caller must await pending edits BEFORE opening another queue item.
  async function canSwitch(): Promise<boolean> {
    if (submittingRef.current || openingKey) return false;
    if (saveState === "conflict") {
      setFeedback("Resolve the revision conflict before leaving.");
      return false;
    }
    if (activeRef.current && !(await flushDraft())) {
      setFeedback(
        "Save failed; the current task stays open to protect your edits.",
      );
      return false;
    }
    return true;
  }
  // Select existing work, or POST ordered asset IDs and the QUEUE's version to
  // create/reuse an instance + assignment. Setting assignmentId triggers the load
  // effect; this handler does not fetch answer JSON itself. The backend rejects a
  // republished version/different batch with 409. openingKey shows "Opening..."
  // and disables relevant controls; catch/finally report errors and clear it.
  async function openGroup(group: AudioGroup) {
    if (!queueInfo || !(await canSwitch())) return;
    if (group.assignmentId) {
      setAssignmentId(group.assignmentId);
      return;
    }
    setOpeningKey(group.key);
    setQueueError("");
    try {
      const result = await readJson<{
        assignment: { id: string; status: QueueStatus };
      }>("/api/v1/labeller/audio-queue", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          labellerId,
          definitionId,
          datasetId,
          definitionVersion: queueInfo.definition.version,
          assetIds: group.assets.map((a) => a.id),
          ...(group.sourceRecordId ? {sourceRecordId:group.sourceRecordId} : {}),
          ...(group.sourceRecordIds ? {sourceRecordIds:group.sourceRecordIds} : {}),
        }),
      });
      setQueue((items) =>
        items.map((item) =>
          item.key === group.key
            ? {
                ...item,
                assignmentId: result.assignment.id,
                status: result.assignment.status,
              }
            : item,
        ),
      );
      setAssignmentId(result.assignment.id);
    } catch (error) {
      setQueueError(errorText(error));
    } finally {
      setOpeningKey(null);
    }
  }
  // The literal-union input permits only two source changes. Clear the active
  // editor only after canSwitch succeeds; changing an ID then reloads queue data
  // through loadQueue's dependencies. A blocked switch preserves the old choice.
  async function changeSource(field: "definition" | "dataset", value: string) {
    if (!(await canSwitch())) return;
    setAssignmentId(null);
    if (field === "definition") setDefinitionId(value);
    else setDatasetId(value);
  }
  /**
   * Finalize the current answers, not merely the last autosaved snapshot.
   * checkAnswers gives immediate feedback; server validation remains authoritative
   * and may return additional issues. Set the ref guard synchronously and state
   * for rendering, wait for any draft to finish (and advance revisionRef), then
   * POST current answers to /submit. No extra draft save is required beforehand.
   * On success, the server revision locks the assignment and this UI marks it
   * submitted. Errors preserve answers, show issues/conflicts and release the
   * submission guard in finally. There is no automatic conflict merge here.
   */
  async function submit() {
    if (
      !detail ||
      !activeRef.current ||
      submittingRef.current ||
      saveState === "submitted" ||
      saveState === "conflict"
    )
      return;
    const problems = checkAnswers(blocks, answersRef.current);
    if (problems.length) {
      setIssues(problems);
      setFeedback("Complete required questions before submitting.");
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setFeedback("");
    const id = activeRef.current;
    try {
      if (saveInFlight.current && !(await saveInFlight.current))
        throw new Error("Draft save failed; resolve it before submitting.");
      const saved = answersRef.current;
      const result = await writeAnnotation(
        id,
        labellerId,
        revisionRef.current,
        saved,
        "submit",
      );
      if (activeRef.current !== id) return;
      savedStampRef.current = stamp(saved);
      revisionRef.current = result.annotation.revision;
      setRevision(result.annotation.revision);
      setSaveState("submitted");
      setQueue((rows) =>
        rows.map((row) =>
          row.assignmentId === id ? { ...row, status: "submitted" } : row,
        ),
      );
      if(assignedOnly)void loadQueue();
      setFeedback(
        "Submitted successfully. The saved annotation is now read-only.",
      );
    } catch (error) {
      setSaveState(
        error instanceof ApiError && error.status === 409
          ? "conflict"
          : "error",
      );
      setIssues(getIssues(error));
      setFeedback(errorText(error));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }
  // Explicit conflict recovery/discard: confirm before replacing local edits with
  // the latest server answers and revision (or empty answers/revision 0). Refuse
  // while a draft is in flight and ignore success for a no-longer-active task.
  // Read failure shows feedback without replacing local answers; this does not
  // merge two versions or recover edits that never reached the server.
  async function reloadSaved() {
    const id = activeRef.current;
    if (
      !id ||
      saveInFlight.current ||
      !window.confirm("Discard local edits and reload the last saved revision?")
    )
      return;
    try {
      const current = await getCurrentAnnotation(id, labellerId);
      if (activeRef.current !== id) return;
      const saved = startingAssignmentAnswers(detail?.taskInstance ?? {}, current.current);
      answersRef.current = saved;
      savedStampRef.current = stamp(current.current?.answers ?? {});
      revisionRef.current = current.current?.revision ?? 0;
      setAnswers(saved);
      setRevision(revisionRef.current);
      setSaveState(
        current.current?.status === "submitted" ? "submitted"
          : stamp(saved) !== savedStampRef.current ? "dirty" : "saved",
      );
      setFeedback(current.current ? "Last saved revision restored." : "Initial source text restored; save to persist it.");
      setIssues([]);
    } catch (error) {
      setFeedback(errorText(error));
    }
  }
  // Keep queue filtering entirely client-side for ALREADY fetched metadata.
  // This does not trigger R2 downloads or extra D1 calls as the user types.
  // Memoize derived results and positions to avoid repeated scans while rendering.
  // These memo dependencies cover every filter input. A displayed empty result
  // means no matches among LOADED groups, not necessarily the entire dataset.
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return queue.filter((group) => {
      if (
        statusFilter === "todo" &&
        ["submitted", "reviewed"].includes(group.status)
      )
        return false;
      if (
        statusFilter === "submitted" &&
        !["submitted", "reviewed"].includes(group.status)
      )
        return false;
      return (
        !term ||
        group.title?.toLowerCase().includes(term) ||
        group.assets.some((row) =>
          row.originalPath.toLowerCase().includes(term),
        ) ||
        group.key.toLowerCase().includes(term)
      );
    });
  }, [queue, search, statusFilter]);
  const queuePositions = useMemo(
    () => new Map(queue.map((group, index) => [group.key, index])),
    [queue],
  );
  const currentIndex = queue.findIndex(
    (row) => row.assignmentId === assignmentId,
  );
  const current = detail?.taskInstance;
  const currentJob = queue.find(group=>group.assignmentId===assignmentId);

  const taskName =
    current?.definition.name ??
    queueInfo?.definition.name ??
    "Choose an audio task";
  const instructions =
    current?.resolvedDefinition?.instructions ?? current?.definition.instructions ??
    "Select a recording from the audio queue to begin.";
  const readOnly = submitting || saveState === "submitted" || votingClosed;
  // Server total covers all complete groups; done counts only loaded submissions.
  // `?.` tolerates missing data; `??` supplies a fallback for null/undefined only.
  const total = queueInfo?.totalCompleteGroups ?? 0;
  const done = queueInfo?.totalSubmitted ?? queue.filter(
    (row) => row.status === "submitted" || row.status === "reviewed",
  ).length;

  // Render is a description of UI, not an imperative sequence of DOM edits:
  // - WorkbenchLayout accepts queue/grounding/children as composition props.
  // - value={...} + onChange={...} makes selectors/search controlled by state.
  // - && shows optional content; the task ternary chooses loading, unselected,
  //   loaded or error content. Those branches follow state, not network timing.
  // - BlockFields receives answers + updateAnswers: fields request changes, this
  //   parent owns them. Its assignment key resets child-local state on task change.
  // - void in event callbacks discards their async result, not the operation;
  //   handlers must catch/report errors. No database work belongs in render itself.
  // A native fallback player is shown when no timeline block provides grounding;
  // nested waveform controls can still fetch/decode via their own effects.
  return (
    <div className="alw3-mode alw3-workspace alw4-audio-workspace">
      <div className="alw3-header alw3-workspace-heading">
        <div>
          <span className="al-eyebrow">LABELLER MODE · AUDIO TASKS</span>
          <h1>
            {taskName === "Choose an audio task"
              ? "Annotation workspace"
              : taskName}
          </h1>
          <p className="alw4-current-job">Job: {currentJob?.jobName ?? (queueJobId ? ownedJobs.find(job=>job.id===queueJobId)?.name : "Choose an assigned job or task")}</p>
          <p>
            Listen to the recording, follow the published protocol, and save
            your independent annotation.
          </p>
        </div>
        <button
          type="button"
          className="alw3-secondary"
          disabled={queueLoading || openingKey !== null || isDirty}
          onClick={() => setRefreshIndex((value) => value + 1)}
        >
          <RefreshCw size={16} /> Refresh queue
        </button>
      </div>
      {queueError && (
        <div className="alw3-error" role="alert">
          {queueError}
        </div>
      )}
      <WorkbenchLayout
        name={taskName}
        instructions={instructions}
        queue={
          <div className="alw4-queue">
            <div className="alw4-queue-head">
              <h2>
                Task queue{" "}
                <span
                  className="alw4-counter"
                  title={assignedOnly?"Your persisted assignments across datasets and published versions":"Total full audio groups in this dataset"}
                >
                  {total}
                </span>
              </h2>
              <p className="alw4-queue-summary">
                {queue.length} loaded · {done} submitted
              </p>
              {!catalogLoading &&
                !definitions.some((d) => d.publishedVersion > 0) && (
                  <p className="alw3-error">
                    No published templates yet. Publish a task in Task Builder
                    first.
                  </p>
                )}
            </div>

            {/* Keep the queue as compact as the prototype. The dataset/definition
            selector is still available, but not shown above every task card. */}
            {!assignedOnly && <details className="alw4-source-config">
              <summary>
                <span>Template &amp; dataset</span>
                <small>
                  {definitions.find((d) => d.id === definitionId)?.name ??
                    "Choose a task"}{" "}
                  ·{" "}
                  {datasets.find((d) => d.id === datasetId)?.name ??
                    "Choose a dataset"}
                </small>
              </summary>
              <div className="alw4-source-fields">
                <label className="alw4-field">
                  <span>Published Task Builder template</span>
                  <select
                    value={definitionId}
                    disabled={catalogLoading || Boolean(openingKey)}
                    onChange={(event) =>
                      void changeSource("definition", event.target.value)
                    }
                  >
                    {!definitionId && (
                      <option value="">Choose a published task</option>
                    )}
                    {definitions
                      .filter((d) => d.publishedVersion > 0)
                      .map((d) => (
                        <option value={d.id} key={d.id}>
                          {d.name} · v{d.publishedVersion}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="alw4-field">
                  <span>Audio dataset</span>
                  <select
                    value={datasetId}
                    disabled={catalogLoading || Boolean(openingKey)}
                    onChange={(event) =>
                      void changeSource("dataset", event.target.value)
                    }
                  >
                    {!datasetId && <option value="">Choose a dataset</option>}
                    {datasets.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                        {d.version ? ` · ${d.version}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </details>}
            <label className="alw4-field alw4-job-picker">
              <span>Assigned job</span>
              <select aria-label="Assigned job" value={queueJobId} disabled={Boolean(openingKey)}
                onChange={async event=>{const next=event.target.value;if(await canSwitch()){setAssignmentId(null);setDetail(null);setQueueJobId(next);}}}>
                <option value="">All my assigned jobs</option>
                {ownedJobs.map(job=><option key={job.id} value={job.id}>{job.name} ({job.total})</option>)}
              </select>
              <small>Only assignments saved by your admin appear here.</small>
            </label>
            {queueInfo && (
              <p className="alw4-batch-note">
                <Headphones size={13} />
                {assignedOnly ? `${total} assigned · ${done} submitted · ${queueInfo.totalPending??0} pending` : queueInfo.requiredAudio === 1
                  ? "1 recording per task"
                  : `${queueInfo.requiredAudio} recordings per task`}
              </p>
            )}
            {queueInfo?.remainderAudio ? (
              <p className="alw4-queue-info">
                {queueInfo.remainderAudio} recording(s) remain outside complete
                batches.
              </p>
            ) : null}
            <div className="alw4-queue-tools">
              <div className="alw4-search">
                <Search size={14} />
                <input
                  aria-label="Search loaded audio queue"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search loaded tasks…"
                />
              </div>
              <select
                className="alw4-filter"
                aria-label="Queue status filter"
                value={statusFilter}
                onChange={(event) =>
                  setStatusFilter(event.target.value as typeof statusFilter)
                }
              >
                <option value="all">All tasks</option>
                <option value="todo">To do / in progress</option>
                <option value="submitted">My submissions</option>
              </select>
            </div>
            <div className="alw4-queue-list" aria-label="Audio tasks">
              {filtered.map((group) => (
                <button
                  key={group.key}
                  type="button"
                  disabled={Boolean(openingKey) || taskLoading || submitting}
                  aria-pressed={Boolean(
                    assignmentId && group.assignmentId === assignmentId,
                  )}
                  title={group.assets.map((a) => a.originalPath).join("\n")}
                  className={`alw3-queue-row alw4-audio-row ${assignmentId && group.assignmentId === assignmentId ? "active" : ""}`}
                  onClick={() => void openGroup(group)}
                >
                  <small className="alw4-card-id">
                    TASK{" "}
                    {String((queuePositions.get(group.key) ?? 0) + 1).padStart(
                      4,
                      "0",
                    )}
                  </small>
                  <strong className="alw4-card-title">
                    {group.assets.length === 1
                      ? group.title ?? group.assets[0].originalPath.split("/").at(-1)
                      : `${group.assets.length}-audio batch`}
                  </strong>
                  <span className="alw4-card-subtitle">
                    {group.assets.length === 1
                      ? `${formatAudioDuration(group.assets[0].durationSeconds)} · Audio annotation`
                      : `${group.assets
                          .map((a) => a.originalPath.split("/").at(-1))
                          .slice(0, 2)
                          .join(" · ")}${group.assets.length > 2 ? " …" : ""}`}
                  </span>
                  <span className="alw4-card-footer">
                    <span
                      className={`alw4-card-status alw4-card-status-${group.status}`}
                    >
                      {openingKey === group.key
                        ? "Opening…"
                        : group.status === "ready"
                          ? "Ready"
                          : group.status.replaceAll("_", " ")}
                    </span>
                    {group.assets.length > 1 && (
                      <small className="alw4-card-count">
                        {group.assets.length} clips
                      </small>
                    )}
                  </span>
                </button>
              ))}
              {queueLoading && (
                <p className="alw4-queue-info">Loading task metadata…</p>
              )}
              {!queueLoading && !filtered.length && (
                <p className="alw4-queue-info">
                  No matching tasks in the loaded queue.
                </p>
              )}
              {queueCursor && (
                <button
                  type="button"
                  className="alw3-secondary alw3-full alw4-load-more"
                  disabled={queueLoading}
                  onClick={() => void loadQueue(queueCursor)}
                >
                  Load 12 more tasks
                </button>
              )}
            </div>
            <div className="alw4-privacy">
              <LockKeyhole size={13} /> {blocks.some((b) => b.trainingAnswerPreview && b.showSourceAnswer)
                ? "Training task: selected original answers are shown. Other labellers' answers remain private."
                : "Responses stay independent. No reference answers are shown."}
            </div>
          </div>
        }
        grounding={
          !hasGrounding && current ? (
            <section className="tb-panel tb-preview-player">
              <p className="tb-eyebrow">PRIMARY R2 RECORDING</p>
              <audio
                controls
                preload="none"
                src={current.audioUrl}
                aria-label="Primary assigned recording"
              />
              <p className="alw3-muted">{current.originalPath}</p>
            </section>
          ) : null
        }
      >
        {taskLoading ? (
          <p>
            Loading published task, audio bindings, and your last saved
            revision…
          </p>
        ) : !assignmentId ? (
          <section className="alw3-panel">
            <h2>Choose a recording</h2>
            <p>
              Select a queue row on the left. For a multi-audio template, each
              row represents a complete audio batch.
            </p>
            <p>
              Opening a row creates or reuses its real Task Instance and
              assignment. Answers are saved to D1.
            </p>
          </section>
        ) : detail ? (
          <>
            <div className="alw3-task-meta">
              <span>Published v{current?.definitionVersion}</span>
              <span>{samples.batchAudio?.length ?? 1} bound audio(s)</span>
              <span>Revision {revision}</span>
              <span className={`alw3-save alw3-save-${saveState}`}>
                {saveState === "saved"
                  ? "All changes saved"
                  : saveState === "dirty"
                    ? "Unsaved changes"
                    : saveState === "saving"
                      ? "Autosaving…"
                      : saveState === "submitted"
                        ? "Submitted · read only"
                        : saveState === "conflict"
                          ? "Revision conflict"
                          : saveState === "error"
                            ? "Save error"
                            : "Loading"}
              </span>
            </div>
            {feedback && (
              <div className={saveState === "submitted" ? "alw3-success" : "alw3-error"} role={saveState === "submitted" ? "status" : "alert"}>
                {feedback}
              </div>
            )}
            {issues.length > 0 && (
              <div className="alw3-error" role="alert">
                <strong>Validation</strong>
                <ul>
                  {issues.map((issue, index) => (
                    <li key={index}>{issue}</li>
                  ))}
                </ul>
              </div>
            )}
            <fieldset className="alw3-fieldset">
              <BlockFields
                key={detail.assignment.id}
                readOnly={readOnly}
                blocks={blocks}
                answers={answers}
                onChange={updateAnswers}
                samples={samples}
                allowLocalAudio={false}
              />
            </fieldset>
            <div className="alw3-actions">
              <button
                type="button"
                className="alw3-secondary"
                disabled={readOnly}
                onClick={() => void reloadSaved()}
              >
                Reload last saved revision
              </button>
              <button
                type="button"
                className="alw3-secondary"
                disabled={readOnly || saveState === "conflict"}
                onClick={() => void saveOnce()}
              >
                Save draft
              </button>
              <button
                type="button"
                className="alw3-primary"
                disabled={
                  readOnly || !blocks.length || saveState === "conflict"
                }
                onClick={() => void submit()}
              >
                {submitting ? "Submitting…" : "Submit annotation"}
              </button>
            </div>
            {saveState === "conflict" && (
              <div className="alw3-error">
                Another tab changed this task.
                <button type="button" onClick={() => void reloadSaved()}>
                  Reload server revision
                </button>
              </div>
            )}
            <div className="alw3-actions">
              <button
                type="button"
                className="alw3-secondary"
                disabled={currentIndex <= 0}
                onClick={() => {
                  if (currentIndex > 0) void openGroup(queue[currentIndex - 1]);
                }}
              >
                Previous
              </button>
              <button
                type="button"
                className="alw3-secondary"
                disabled={currentIndex < 0 || currentIndex >= queue.length - 1}
                onClick={() => {
                  if (currentIndex >= 0 && currentIndex < queue.length - 1)
                    void openGroup(queue[currentIndex + 1]);
                }}
              >
                Next <ChevronRight size={14} />
              </button>
            </div>
          </>
        ) : (
          <div className="alw3-error">
            Could not load this assignment. {feedback}
          </div>
        )}
      </WorkbenchLayout>
      <p className="alw3-dev-note">
        LOCAL DEVELOPMENT · authenticated demo accounts. Production requires
        configured Cloudflare Access.
      </p>
    </div>
  );
}
