"use client";
import { useEffect, useState } from "react";
import { adminRequest as api } from "@/lib/frontend/admin-api";
import type { ProjectMemberRecord } from "@/lib/contracts/assignment-api";
import type {
  AllocationItem,
  AllocationRequest,
  AllocationPreview,
} from "@/lib/contracts/assignment-allocation";

/** Owns only allocation selections and the reviewed preview. Existing member and
 * assignment lists remain owned by AdminWorkspace. Confirm always posts the
 * saved preview pairs; changing any input invalidates that preview immediately.
 */
export default function AssignmentAllocationPanel({
  projectId,
  members,
  datasets,
  definitions,
  onAllocated,
}: {
  projectId: string;
  members: ProjectMemberRecord[];
  datasets: Array<{ id: string; name: string }>;
  definitions: Array<{ id: string; name: string; publishedVersion: number }>;
  onAllocated: () => Promise<void>;
}) {
  const [adminId, setAdminId] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const [protocol, setProtocol] = useState("");
  const [mode, setMode] = useState<"fixed" | "balanced">("fixed");
  const [count, setCount] = useState(2);
  const [workers, setWorkers] = useState<string[]>([]);
  const [items, setItems] = useState<AllocationItem[]>([]);
  const [keys, setKeys] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<{
    request: AllocationRequest;
    data: AllocationPreview;
  } | null>(null);
  useEffect(() => {
    setAdminId((previous) =>
      members.some((m) => m.userId === previous && m.role === "admin")
        ? previous
        : (members.find((m) => m.role === "admin")?.userId ?? ""),
    );
  }, [members]);
  useEffect(() => {
    setPreview(null);
    setNotice("");
  }, [adminId, datasetId, protocol, mode, count, workers, keys]);
  // Abort obsolete catalog loads; never show another dataset's selected items.
  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    setKeys([]);
    setNextCursor(null);
    setError("");
    setLoading(false);
    if (adminId && datasetId) {
      setLoading(true);
      const query = new URLSearchParams({ projectId, adminId, datasetId });
      api<{ items: AllocationItem[]; nextCursor: string | null }>(
        `assignment-allocation?${query}`,
        undefined,
        controller.signal,
      )
        .then((result) => {
          if (!controller.signal.aborted) {
            setItems(result.items);
            setNextCursor(result.nextCursor);
          }
        })
        .catch((reason) => {
          if (!controller.signal.aborted) setError(String(reason));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }
    return () => controller.abort();
  }, [projectId, adminId, datasetId]);
  async function more() {
    if (!nextCursor) return;
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({
        projectId,
        adminId,
        datasetId,
        cursor: nextCursor,
      });
      const result = await api<{
        items: AllocationItem[];
        nextCursor: string | null;
      }>(`assignment-allocation?${query}`);
      setItems((previous) => [
        ...previous,
        ...result.items.filter(
          (item) => !previous.some((old) => old.key === item.key),
        ),
      ]);
      setNextCursor(result.nextCursor);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }
  const eligible = members.filter((member) => member.role === "labeller");
  function toggleWorker(id: string) {
    setPreview(null);
    setWorkers((previous) =>
      previous.includes(id)
        ? previous.filter((value) => value !== id)
        : [...previous, id],
    );
  }
  async function showPreview() {
    setBusy(true);
    setError("");
    setNotice("");
    setPreview(null);
    const [definitionId, version] = protocol.split(":");
    const request: AllocationRequest = {
      projectId,
      adminId,
      datasetId,
      definitionId,
      definitionVersion: Number(version),
      itemKeys: keys,
      labellerIds: workers,
      independentLabellers: mode === "fixed" ? workers.length : count,
      mode,
    };
    try {
      const result = await api<{ preview: AllocationPreview }>(
        "assignment-allocation?action=preview",
        request,
      );
      setPreview({ request, data: result.preview });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{
        result: {
          created: number;
          alreadyAssigned: number;
          assignments: number;
        };
      }>("assignment-allocation?action=confirm", {
        ...preview.request,
        pairs: preview.data.pairs.map(({ itemKey, labellerId }) => ({
          itemKey,
          labellerId,
        })),
      });
      setNotice(
        `Saved ${result.result.assignments} assignments: ${result.result.created} new, ${result.result.alreadyAssigned} already assigned. Refresh the Labeller Workspace to see them.`,
      );
      setPreview(null);
      await onAllocated();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="admin-panel allocation-panel"
      aria-busy={busy || loading}
    >
      <h2>Allocate labeller tasks</h2>
      <p>
        Use the project selector above. Choose source questions/items, then
        assign independent workers. Existing answers remain private.
      </p>
      <fieldset disabled={busy || loading} className="allocation-controls">
        <div className="admin-grid">
          <label>
            Local admin fixture
            <select
              value={adminId}
              onChange={(event) => setAdminId(event.target.value)}
            >
              <option value="">Choose an existing admin</option>
              {members
                .filter((m) => m.role === "admin")
                .map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.displayName} ({m.userId})
                  </option>
                ))}
            </select>
          </label>
          <label>
            Published Task Definition / version
            <select
              value={protocol}
              onChange={(event) => setProtocol(event.target.value)}
            >
              <option value="">Choose a published definition</option>
              {definitions.flatMap((def) =>
                Array.from({ length: def.publishedVersion }, (_, i) => (
                  <option
                    key={`${def.id}:${i + 1}`}
                    value={`${def.id}:${i + 1}`}
                  >
                    {def.name} · v{i + 1}
                  </option>
                )),
              )}
            </select>
          </label>
          <label>
            Dataset
            <select
              value={datasetId}
              onChange={(event) => setDatasetId(event.target.value)}
            >
              <option value="">Choose dataset</option>
              {datasets.map((dataset) => (
                <option key={dataset.id} value={dataset.id}>
                  {dataset.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Allocation mode
            <select
              value={mode}
              onChange={(event) => setMode(event.target.value as typeof mode)}
            >
              <option value="fixed">
                Fixed panel — everyone gets each item
              </option>
              <option value="balanced">
                Balanced — N distinct workers per item
              </option>
            </select>
          </label>
          <label>
            Independent labellers per item (N)
            <input
              type="number"
              min={1}
              max={20}
              value={mode === "fixed" ? workers.length : count}
              readOnly={mode === "fixed"}
              onChange={(event) => setCount(Number(event.target.value))}
            />
          </label>
        </div>
        {!members.some((member) => member.role === "admin") && (
          <p className="admin-hint">
            No admin fixture exists in this project. Use the disposable demo
            setup, or explicitly register a local admin through the development
            member API. This selector is not login.
          </p>
        )}
        {!definitions.length && (
          <p>
            Publish a Task Definition in Task Builder first (NUM_BATCH=1 for
            this MVP).
          </p>
        )}
        <h3>Eligible project labellers</h3>
        <div className="allocation-workers">
          {eligible.map((member) => (
            <label className="allocation-check" key={member.userId}>
              <input
                type="checkbox"
                checked={workers.includes(member.userId)}
                onChange={() => toggleWorker(member.userId)}
              />
              <span>
                {member.displayName}
                <small>{member.userId}</small>
              </span>
            </label>
          ))}
        </div>
        {!eligible.length && (
          <p>Add local labellers using Project members below.</p>
        )}
        <h3>Question / source items ({keys.length} selected)</h3>
        <button
          type="button"
          disabled={!items.length}
          onClick={() => setKeys(items.slice(0, 10).map((item) => item.key))}
        >
          Select first 10
        </button>{" "}
        <button
          type="button"
          disabled={!items.length}
          onClick={() => setKeys(items.slice(0, 50).map((item) => item.key))}
        >
          Select first 50
        </button>{" "}
        <button type="button" onClick={() => setKeys([])}>
          Clear selection
        </button>
        <div className="admin-table-scroll allocation-items">
          <table>
            <thead>
              <tr>
                <th>Select</th>
                <th>Question / item</th>
                <th>Audio</th>
                <th>Source identity</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.key}>
                  <td>
                    <input
                      aria-label={`Select item ${item.itemId ?? item.recordId ?? item.originalPath}`}
                      type="checkbox"
                      checked={keys.includes(item.key)}
                      disabled={!keys.includes(item.key) && keys.length >= 50}
                      onChange={() =>
                        setKeys((previous) =>
                          previous.includes(item.key)
                            ? previous.filter((key) => key !== item.key)
                            : [...previous, item.key],
                        )
                      }
                    />
                  </td>
                  <td>
                    {item.question ??
                      item.itemId ??
                      item.recordId ??
                      "Audio-only item"}
                  </td>
                  <td>{item.originalPath}</td>
                  <td>
                    <small>
                      {item.sampleId ?? "Legacy sample"} /{" "}
                      {item.itemId ?? item.recordId ?? "audio"}
                      {item.sourceVersion ? ` · ${item.sourceVersion}` : ""}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {datasetId && !loading && !items.length && (
          <p>No items available in this dataset.</p>
        )}
        {nextCursor && (
          <button type="button" onClick={() => void more()}>
            Load more items
          </button>
        )}
        <p className="admin-hint">
          At most 50 items and 500 assignments per confirmation. Fixed panel N
          equals the number of selected workers. Worker groups are deferred;
          select individuals here.
        </p>
        <button
          type="button"
          className="admin-primary"
          disabled={
            !adminId ||
            !protocol ||
            !datasetId ||
            !keys.length ||
            !workers.length
          }
          onClick={() => void showPreview()}
        >
          Preview assignments
        </button>
      </fieldset>
      {loading && <p role="status">Loading dataset items…</p>}
      {busy && <p role="status">Validating / saving allocation…</p>}
      {error && (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="admin-success" role="status">
          {notice}
        </p>
      )}
      {preview && (
        <div className="allocation-preview">
          <h3>
            {preview.data.uniqueItems} unique items → {preview.data.assignments}{" "}
            individual assignments
          </h3>
          <p>
            {preview.data.newAssignments} new;{" "}
            {preview.data.assignments - preview.data.newAssignments} already
            assigned.
          </p>
          <p>
            {preview.data.perWorker
              .map((worker) => `${worker.name}: ${worker.proposed} tasks`)
              .join(" · ")}
          </p>
          <div className="admin-table-scroll allocation-items">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Worker</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {preview.data.pairs.map((pair) => (
                  <tr key={JSON.stringify([pair.itemKey, pair.labellerId])}>
                    <td>
                      {preview.data.items.find(
                        (item) => item.key === pair.itemKey,
                      )?.question ??
                        preview.data.items.find(
                          (item) => item.key === pair.itemKey,
                        )?.itemId ??
                        pair.itemKey}
                    </td>
                    <td>
                      {pair.labellerName}
                      <small>{pair.labellerId}</small>
                    </td>
                    <td>{pair.existing ? "Already assigned" : "New"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            className="admin-primary"
            disabled={busy}
            onClick={() => void confirm()}
          >
            Confirm {preview.data.assignments} assignments
          </button>
        </div>
      )}
    </section>
  );
}
