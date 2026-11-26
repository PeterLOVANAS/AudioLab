/** Actual workbench handlers in a deterministic hook harness, without a browser,
 * audio fetches, or precious D1. DOM geometry and pointer capture are simulated;
 * React layout/visual behavior still needs manual verification.
 */
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  ts = require("@typescript/typescript6");
const root = path.resolve(__dirname, "..");
let hooks = [],
  position = 0,
  queue = [],
  dirty = false;
const react = {
  useState(value) {
    const index = position++;
    if (!(index in hooks))
      hooks[index] = typeof value === "function" ? value() : value;
    return [
      hooks[index],
      (next) => {
        const value = typeof next === "function" ? next(hooks[index]) : next;
        if (!Object.is(value, hooks[index])) {
          hooks[index] = value;
          dirty = true;
        }
      },
    ];
  },
  useRef(value) {
    const index = position++;
    return hooks[index] ?? (hooks[index] = { current: value });
  },
  useMemo(fn, deps) {
    const index = position++,
      old = hooks[index];
    if (!old || deps.some((dep, i) => !Object.is(dep, old.deps[i])))
      hooks[index] = { deps, value: fn() };
    return hooks[index].value;
  },
  useEffect(fn, deps) {
    const index = position++,
      old = hooks[index];
    if (!old || !deps || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) {
      hooks[index] = { deps };
      queue.push(fn);
    }
  },
};
const jsx = (type, props, key) => ({ type, props: props || {}, key });
const listeners = {};
class FakeElement {
  constructor(kind = "outside") {
    this.kind = kind;
  }
  contains(target) {
    return target.kind !== "outside";
  }
  closest(selector) {
    if (selector === "[data-lane]") return lane;
    if (selector === ".r-tier-handle")
      return this.kind === "handle" ? this : null;
    if (selector.includes("[data-segment]"))
      return ["segment", "handle", "input", "button"].includes(this.kind)
        ? this
        : null;
    return null;
  }
  getBoundingClientRect() {
    return { left: 0, width: 1000 };
  }
  setPointerCapture() {}
}
const lane = new FakeElement("lane"),
  segment = new FakeElement("segment"),
  handle = new FakeElement("handle");
global.Element = global.HTMLElement = global.HTMLInputElement = FakeElement;
global.document = {
  addEventListener: (name, fn) => (listeners[name] = fn),
  removeEventListener() {},
  body: { style: {} },
};
global.window = { addEventListener() {}, removeEventListener() {} };
global.requestAnimationFrame = () => 0;
global.cancelAnimationFrame = () => {};
const cache = new Map();
function load(relative) {
  if (cache.has(relative)) return cache.get(relative);
  const file = path.join(root, relative),
    mod = { exports: {} };
  const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  new Function("require", "module", "exports", output)(
    (name) => {
      if (name === "react") return react;
      if (name === "react/jsx-runtime")
        return { jsx, jsxs: jsx, Fragment: Symbol.for("fragment") };
      if (name === "lucide-react")
        return new Proxy({}, { get: (_, name) => name });
      if (name === "./preferences")
        return {
          usePreferences: () => ({ language: "en" }),
          PreferenceControls: () => null,
        };
      if (name === "./acoustics" || name === "./phonetics")
        return { Acoustics: () => null, PhoneticPalette: () => null };
      if (name === "@/lib/audio/prototype/audio-cache")
        return {
          acquireAudio: () => ({
            promise: new Promise(() => {}),
            release() {},
          }),
          visiblePeaks: () => [],
        };
      if (name.startsWith("@/") || name.startsWith(".")) {
        const target = name.startsWith("@/")
          ? name.slice(2)
          : path.relative(root, path.resolve(path.dirname(file), name));
        return load(
          target +
            (fs.existsSync(path.join(root, target + ".ts")) ? ".ts" : ".tsx"),
        );
      }
      return require(name);
    },
    mod,
    mod.exports,
  );
  cache.set(relative, mod.exports);
  return mod.exports;
}
const { moveGroundingRange, resizeGroundingRange } = load(
  "lib/audio/grounding-selection.ts",
);
assert.deepEqual(moveGroundingRange([1.123, 2.456], -9, 10), [0, 1.333]);
assert.deepEqual(moveGroundingRange([1, 3], 20, 10), [8, 10]);
assert.deepEqual(
  resizeGroundingRange([1, 3], "start", 4, 10, 1000),
  [2.999, 3],
);
assert.deepEqual(resizeGroundingRange([1, 3], "end", 20, 10, 1000), [1, 10]);
assert.throws(() => moveGroundingRange([3, 1], 2, 10));
assert.throws(() => resizeGroundingRange([1, 3], "end", NaN, 10, 1000));
const { PrototypeAudioPlayer } = load(
  "components/audio-editor/prototype/PrototypeAudioPlayer.tsx",
);
let props,
  tree,
  saved = [];
function nodes(node) {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (typeof node !== "object") return [];
  return [node, ...nodes(node.props?.children)];
}
function find(predicate) {
  const result = nodes(tree).find(predicate);
  assert.ok(result, "Expected rendered control");
  return result;
}
function render() {
  let rounds = 0;
  do {
    dirty = false;
    position = 0;
    queue = [];
    tree = PrototypeAudioPlayer(props);
    tree.props.ref.current = new FakeElement("root");
    for (const effect of queue) effect();
    assert.ok(++rounds < 10, "stable hooks");
  } while (dirty);
}
function fixture(readOnly = false) {
  hooks = [];
  queue = [];
  saved = [];
  props = {
    assets: [
      {
        id: "wav",
        role: "primary",
        duration: 10,
        sample_rate: 1000,
        url: "unused",
      },
    ],
    role: "primary",
    onRole() {},
    coverage: {},
    onCoverage() {},
    selection: [0, 0],
    onSelection: (range) => {
      props.selection = range;
      dirty = true;
    },
    tiers: [
      {
        id: "words",
        label: "Imported words",
        items: [{ id: "tg-1", text: "hello", start: 1.123, end: 2.456 }],
      },
      {
        id: "phones",
        label: "Imported phones",
        items: [{ id: "tg-1", text: "h", start: 4, end: 5 }],
      },
    ],
    ...(!readOnly
      ? {
          onSegment(tier, item) {
            saved.push({ tier, item });
            props.tiers = props.tiers.map((t) =>
              t.id === tier
                ? {
                    ...t,
                    items: t.items.map((i) => (i.id === item.id ? item : i)),
                  }
                : t,
            );
            dirty = true;
          },
        }
      : {}),
  };
  render();
}
const event = (x, target = segment, currentTarget = segment) => ({
  clientX: x,
  pointerId: 1,
  target,
  currentTarget,
  stopPropagation() {},
  preventDefault() {},
});
const getSegment = (text = "hello") =>
  find((n) => n.props["data-segment"] && n.props["aria-label"].includes(text));
const getLane = () => find((n) => n.props["data-lane"]);
function outside() {
  listeners.pointerdown({ target: new FakeElement("outside") });
  render();
}
fixture();
assert.equal(tree.props["data-selection-active"], false);
getSegment().props.onPointerDown(event(150));
render();
assert.deepEqual(props.selection, [1.123, 2.456]);
assert.equal(tree.props["data-selection-active"], true);
assert.equal(
  nodes(tree).filter((n) =>
    n.props.className?.includes("r-tier-segment selected"),
  ).length,
  1,
  "same IDs in different tiers do not cross-select",
);
getLane().props.onPointerMove(event(250, segment, lane));
render();
getLane().props.onPointerUp(event(250, segment, lane));
render();
assert.ok(Math.abs(props.selection[0] - 2.123) < 1e-9);
assert.ok(Math.abs(props.selection[1] - 3.456) < 1e-9);
outside();
assert.equal(tree.props["data-selection-active"], false);
assert.deepEqual(props.selection, [0, 0]);
assert.equal(saved.length, 1);
assert.equal(saved[0].item.id, "tg-1");
assert.equal(saved[0].tier, "words");
assert.equal(saved[0].item.text, "hello");
assert.equal(
  nodes(tree).some((n) => n.props.className === "r-edit-cursor"),
  false,
);
assert.equal(
  nodes(tree).some((n) => n.props.className === "r-inline-editor"),
  false,
);
// Resize the existing imported interval. Outside click commits to the same ID.
getSegment().props.onPointerDown(event(250));
render();
getLane().props.onPointerUp(event(250, segment, lane));
render();
let selected = getSegment();
nodes(selected)
  .find((n) => n.props["aria-label"] === "End boundary of hello")
  .props.onPointerDown(event(345, handle, handle));
render();
getLane().props.onPointerMove(event(450, handle, lane));
render();
getLane().props.onPointerUp(event(450, handle, lane));
render();
outside();
assert.equal(saved.at(-1).item.end, 4.5);
assert.equal(saved.at(-1).item.id, "tg-1");
assert.equal(props.tiers[1].items[0].start, 4, "other tier unchanged");
// Blank range and zero-length clicks disappear without inserting/deleting labels.
const count = saved.length;
getLane().props.onPointerDown(event(600, lane, lane));
render();
getLane().props.onPointerMove(event(700, lane, lane));
render();
getLane().props.onPointerUp(event(700, lane, lane));
render();
outside();
assert.equal(saved.length, count);
getLane().props.onPointerDown(event(650, lane, lane));
render();
getLane().props.onPointerUp(event(650, lane, lane));
render();
assert.equal(tree.props["data-selection-active"], false);
// Read-only workbenches can inspect a label, never mutate it via body dragging.
fixture(true);
getSegment().props.onPointerDown(event(150));
render();
getLane().props.onPointerMove(event(500, segment, lane));
render();
outside();
assert.equal(saved.length, 0);
assert.equal(props.tiers[0].items[0].start, 1.123);
// Failure from the adapter must not leave a false success or delete the original.
fixture();
props.onSegment = () => {
  throw new Error("Overlap not allowed");
};
render();
getSegment().props.onPointerDown(event(150));
render();
getLane().props.onPointerMove(event(250, segment, lane));
render();
getLane().props.onPointerUp(event(250, segment, lane));
render();
outside();
assert.equal(props.tiers[0].items[0].start, 1.123);
assert.equal(tree.props["data-selection-active"], false);
console.log(
  "PASS Grounding: actual pointer handlers select imported intervals, move, resize, preserve IDs/tiers, dismiss outside, retain invalid/blank edits safely, and respect read-only mode. No browser or DB.",
);
