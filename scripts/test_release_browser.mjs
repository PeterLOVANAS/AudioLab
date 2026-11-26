/** R02B real Chrome/Chromium acceptance. Uses private CLI files in the disposable state;
 * never uses a personal Chrome profile, screenshots login, or records tokens.
 * Run after test_release_http.py prepare/provision/exercise. No remote origins.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright-core";

const root = await fs.realpath(path.resolve(process.argv[2] ?? ""));
assert(
  root.startsWith(path.join(await fs.realpath(os.tmpdir()), "audiolab-r02b-")),
);
const read = async (name) =>
  JSON.parse(await fs.readFile(path.join(root, name), "utf8"));
const fixture = await read("R02B_FIXTURE.json");
assert.equal(fixture.kind, "audiolab.r02b/1");
const admin = (await read("admin-credentials.json")).accounts[0];
const workers = (await read("labellers-private.json")).accounts;
const output = path.join(root, "browser");
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const evidence = {
  browser: "",
  checks: [],
  errors: [],
  failedRequests: [],
  httpFailures: [],
};
// CI installs Playwright's matching Chromium; local acceptance defaults to the
// existing Chrome. This selects a browser binary only, not application behavior.
const channel = process.env.AUDIOLAB_BROWSER_CHANNEL || "chrome";
assert(["chrome", "chromium"].includes(channel));
const browser = await chromium.launch({ channel, headless: true });
evidence.browser = browser.version();
evidence.channel = channel;
const contexts = [];
let page;
/** Wait for real rendered state and network responses rather than fixed sleeps. */
async function session(account) {
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:5202",
    viewport: { width: 1440, height: 1100 },
  });
  contexts.push(context);
  const tab = await context.newPage();
  tab.setDefaultTimeout(12000);
  tab.on("pageerror", (error) => evidence.errors.push(error.message));
  tab.on("console", (msg) => {
    if (msg.type() === "error")
      evidence.errors.push({ message: msg.text(), url: msg.location().url });
  });
  tab.on("requestfailed", (req) => {
    if (req.failure()?.errorText !== "net::ERR_ABORTED")
      evidence.failedRequests.push({
        url: req.url(),
        error: req.failure()?.errorText,
      });
  });
  tab.on("response", (res) => {
    if (res.status() >= 400)
      evidence.httpFailures.push({ url: res.url(), status: res.status() });
  });
  // Hold only the first real session response to verify the loading shell never
  // exposes the previous identity. Continue to the actual Worker, not a fixture.
  let releaseSession;
  const sessionReady = new Promise((resolve) => {
    releaseSession = resolve;
  });
  await tab.route("**/api/v1/auth/session", async (route) => {
    await sessionReady;
    await route.continue();
  });
  await tab.goto("http://127.0.0.1:5202");
  await tab.getByText("Checking login…", { exact: true }).waitFor();
  assert.equal(await tab.locator(".al-user").count(), 0);
  releaseSession();
  await tab.getByLabel("Username", { exact: true }).fill(account.username);
  await tab.getByLabel("Password", { exact: true }).fill(account.password);
  await tab.getByRole("button", { name: "Sign in", exact: true }).click();
  await tab
    .getByLabel("Project", { exact: true })
    .selectOption(fixture.projectId);
  const response = await tab.request.get("/api/v1/auth/session");
  assert(response.ok());
  const verified = await response.json();
  const identity = tab.locator(".al-user");
  await identity
    .getByText(verified.user.displayName, { exact: true })
    .waitFor();
  assert.equal(
    await identity.locator("strong").innerText(),
    verified.user.displayName,
  );
  const role = verified.memberships.find(
    (member) => member.projectId === fixture.projectId,
  )?.role;
  assert(role);
  assert.equal(await identity.locator("small").innerText(), role);
  await tab
    .locator(".al-role-preview")
    .getByText(`${verified.user.displayName} · ${role}`, { exact: true })
    .waitFor();
  evidence.checks.push(
    "Verified session account name and project role: " + role,
  );
  return tab;
}
async function shot(name) {
  await page.screenshot({
    path: path.join(output, name + ".png"),
    fullPage: true,
  });
}
function selectField(tab, name) {
  // Native labels wrap their option text, so an exact getByLabel name is not
  // stable. Match the label's leading text and use its actual select control.
  return tab
    .locator("label")
    .filter({
      hasText: new RegExp(
        "^\\s*" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
    })
    .first()
    .locator("select");
}
async function checkText(locator, text) {
  await locator
    .getByText(text, { exact: false })
    .filter({ visible: true })
    .first()
    .waitFor();
}
async function savedFixture() {
  await fs.writeFile(
    path.join(root, "R02B_FIXTURE.json"),
    JSON.stringify(fixture, null, 2),
    { mode: 0o600 },
  );
}
async function clickResponse(tab, button, suffix, method = "POST") {
  const response = tab.waitForResponse(
    (res) => res.url().includes(suffix) && res.request().method() === method,
  );
  await button.click();
  const result = await response;
  assert(result.ok(), `HTTP ${result.status()}: ${suffix}`);
  return result.json();
}
try {
  page = await session(admin);
  if (process.argv.includes("--new-ui-run")) {
    // A new end-to-end pass appends independent synthetic work; prior finals
    // stay immutable. The UI below still performs edit/publish and allocation.
    const existing = await page.request.get(
      `/api/v1/task-definitions/${fixture.browserDefinitionId}`,
    );
    assert(existing.ok());
    const { taskDefinition } = await existing.json();
    const created = await page.request.post("/api/v1/task-definitions", {
      data: {
        projectId: fixture.projectId,
        draft: {
          ...taskDefinition.draft,
          name: "R02B Browser Grounding draft",
        },
      },
      headers: { Origin: "http://127.0.0.1:5202" },
    });
    assert(created.ok());
    fixture.browserDefinitionId = (await created.json()).taskDefinition.id;
    fixture.browserRunName = "R02B browser grounding " + Date.now();
    delete fixture.browserJobId;
    await savedFixture();
  }
  const runName = fixture.browserRunName ?? "R02B browser grounding";
  if (!fixture.browserJobId) {
    const response = await page.request.get(
      `/api/v1/team-jobs?projectId=${fixture.projectId}`,
    );
    assert(response.ok());
    const { jobs } = await response.json();
    const existing = jobs.find((job) => job.name === runName);
    if (existing) {
      fixture.browserJobId = existing.id;
      await savedFixture();
    }
  }
  await page.getByRole("button", { name: "Task Builder", exact: true }).click();
  await page
    .getByLabel("Save to project", { exact: true })
    .selectOption(fixture.projectId);
  await page
    .getByLabel("Open definition", { exact: true })
    .selectOption(fixture.browserDefinitionId);
  await page.getByLabel("Task name", { exact: true }).waitFor();
  if (!fixture.browserJobId) {
    await page
      .getByLabel("Task name", { exact: true })
      .fill("R02B Browser Grounding");
    // Test a real source-field edit and restore the intended binding before
    // publication; selected dataset data must drive the preview.
    await page.locator("summary").filter({ hasText: "Tone intervals" }).click();
    const binding = page
      .locator('[data-block="ground"] .tb-source-settings label')
      .filter({ hasText: "Question / title" })
      .locator("select");
    await binding.selectOption("item.prompt");
    await binding.selectOption("item.ground_prompt");
    if (
      await page
        .getByRole("button", { name: "Save draft", exact: true })
        .isEnabled()
    )
      await clickResponse(
        page,
        page.getByRole("button", { name: "Save draft", exact: true }),
        "/task-definitions",
        "PUT",
      );
    await clickResponse(
      page,
      page.getByRole("button", { name: "Publish", exact: true }),
      "/publish",
    );
    await page
      .getByRole("button", { name: "Labeller Preview", exact: true })
      .click();
    await checkText(page, "Mark tone intervals");
  }
  await shot("01-published-builder");
  evidence.checks.push("Admin login, project selection, edit/save/publish");
  await page
    .getByRole("button", { name: "Team & assignments", exact: true })
    .click();
  if (!fixture.browserJobId) {
    await page.getByLabel("Job name", { exact: true }).fill(runName);
    await selectField(page, "Team").selectOption(fixture.teamId);
    const options = await selectField(page, "Task Definition / version")
      .locator("option")
      .evaluateAll((options) =>
        options.map((o) => ({ value: o.value, text: o.textContent })),
      );
    const protocol = options
      .filter((o) => o.value.startsWith(fixture.browserDefinitionId + ":"))
      .at(-1);
    assert(protocol);
    await selectField(page, "Task Definition / version").selectOption(
      protocol.value,
    );
    await selectField(page, "Dataset").selectOption(fixture.datasetId);
    await selectField(page, "Distribution").selectOption("voting");
    await page
      .getByRole("checkbox", { name: /^Select item/ })
      .first()
      .check();
    await page
      .getByLabel("Number of items to sample", { exact: true })
      .fill("1");
    await clickResponse(
      page,
      page.getByRole("button", { name: "Preview team job", exact: true }),
      "action=preview",
    );
    await shot("02-allocation-preview");
    const launched = await clickResponse(
      page,
      page.getByRole("button", {
        name: "Confirm & save assignments",
        exact: true,
      }),
      "action=launch",
    );
    fixture.browserJobId = launched.jobId ?? launched.job?.id;
    fixture.browserAssignments = launched.assignments;
    // The launch response contains the plan under job/summary on older builds.
    if (!fixture.browserJobId) {
      const response = await page.request.get(
        `/api/v1/team-jobs?projectId=${fixture.projectId}`,
      );
      const { jobs } = await response.json();
      fixture.browserJobId = jobs.find((job) => job.name === runName).id;
    }
    await savedFixture();
  }
  evidence.checks.push(
    "Team selection, published protocol, dataset, voting preview and persisted allocation",
  );
  await page
    .getByRole("button", { name: "Labeller progress", exact: true })
    .click();
  await selectField(page, "Team job").selectOption(fixture.browserJobId);
  await page
    .getByRole("button", { name: "Final Results", exact: true })
    .click();
  const beforeResult = await (
    await page.request.get(
      `/api/v1/team-jobs?action=results&projectId=${fixture.projectId}&jobId=${fixture.browserJobId}`,
    )
  ).json();
  if (!beforeResult.complete) {
    await checkText(
      page,
      "Final Results unlock after all assignments are submitted",
    );
    await shot("03-partial-results-gated");
  }
  const adminPage = page;
  const intervals = [
    [[1, 5]],
    [[3, 7]],
    [
      [1, 3],
      [5, 7],
    ],
  ];
  for (let index = 0; index < workers.length; index++) {
    page = await session(workers[index]);
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    async function openAssigned() {
      await page
        .getByLabel("Assigned job", { exact: true })
        .selectOption(fixture.browserJobId);
      await page
        .getByLabel("Audio tasks", { exact: true })
        .getByRole("button")
        .first()
        .click();
      await page.getByLabel("Listening note", { exact: true }).waitFor();
    }
    await openAssigned();
    if (await page.getByLabel("Listening note", { exact: true }).isDisabled()) {
      await checkText(page, "Submitted");
      evidence.checks.push(
        workers[index].username +
          ": existing independent submitted revision resumes read-only",
      );
      await page.context().close();
      continue;
    }
    // UI editing only: draw a selection, then use the editor's precision
    // controls. No React state injection or direct annotation POSTs.
    const note = "Independent browser annotation by " + workers[index].username;
    if (
      (await page
        .getByLabel("Listening note", { exact: true })
        .inputValue()) !== note
    ) {
      const saved = page.waitForResponse(
        (res) =>
          res.url().endsWith("/annotation/draft") &&
          res.request().method() === "POST" &&
          res.ok(),
      );
      await page.getByLabel("Listening note", { exact: true }).fill(note);
      await saved;
    }
    // Resume a failed automation run through the real editing UI; retain all
    // earlier draft revisions, and never alter already submitted answers.
    const deletes = page
      .locator(".r-timing")
      .getByRole("button", { name: "Delete", exact: true });
    while (await deletes.count()) await deletes.first().click();
    await checkText(page, "All changes saved");
    for (const [start, end] of intervals[index]) {
      const wave = page.getByLabel(
        "Waveform: click for cursor, drag to label",
        { exact: true },
      );
      await wave.scrollIntoViewIfNeeded();
      const box = await wave.boundingBox();
      assert(box && box.width > 0);
      // Begin outside existing events; dragging an existing interval edits it.
      await page.mouse.move(box.x + box.width * 0.02, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2, {
        steps: 12,
      });
      await page.mouse.up();
      await page.getByLabel("Segment end", { exact: true }).fill("8");
      await page
        .getByLabel("Segment start", { exact: true })
        .fill(String(start));
      await page.getByLabel("Segment end", { exact: true }).fill(String(end));
      await page.getByLabel("Segment label", { exact: true }).fill("tone");
      await clickResponse(
        page,
        page.getByRole("button", { name: "Save segment", exact: true }),
        "/annotation/draft",
      );
      await checkText(page, "All changes saved");
    }
    await shot("04-worker-" + index + "-intervals");
    await page.reload();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await openAssigned();
    assert.equal(
      await page.getByLabel("Listening note", { exact: true }).inputValue(),
      note,
    );
    const actualStarts = await page
      .getByLabel("Events start", { exact: true })
      .evaluateAll((inputs) => inputs.map((input) => Number(input.value)));
    assert.deepEqual(
      actualStarts,
      intervals[index].map((pair) => pair[0]),
    );
    // Rehydrated answers can render before the asynchronous audio lease assigns
    // its Blob URL. Calling play() on the empty element queues a request that
    // the later source load aborts. Wait for real media readiness and use the
    // product control instead of bypassing its disabled-until-loaded guard.
    await page.waitForFunction(() => {
      const audio = document.querySelector(".tb-prototype-shell audio");
      return (
        audio &&
        audio.currentSrc &&
        audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        audio.duration === 10
      );
    });
    await page
      .getByRole("button", {
        name: "Play selection or cursor",
        exact: true,
      })
      .click();
    await page.waitForFunction(() => {
      const audio = document.querySelector(".tb-prototype-shell audio");
      return (
        audio &&
        !audio.paused &&
        audio.currentTime > 0.1 &&
        audio.duration === 10
      );
    });
    await page
      .getByRole("button", { name: "Pause audio", exact: true })
      .click();
    await clickResponse(
      page,
      page.getByRole("button", { name: "Submit annotation", exact: true }),
      "/annotation/submit",
    );
    await checkText(page, "Submitted");
    evidence.checks.push(
      workers[index].username +
        ": UI queue, real playback, intervals, autosave, reload/resume, independent final",
    );
    await page.context().close();
  }
  page = adminPage;
  await page
    .getByRole("button", { name: "Refresh progress", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Final Results", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Inspect results", exact: true })
    .first()
    .click();
  const inspector = page.getByRole("region", {
    name: "Result inspector",
    exact: true,
  });
  await checkText(inspector, "3 valid comparisons");
  await checkText(inspector, "mean 33.3%");
  for (const [index, name] of ["Alice", "Bob", "Chai"].entries()) {
    const svg = inspector.getByRole("img", {
      name: "Submitted intervals for " + name,
      exact: true,
    });
    const rects = await svg
      .locator("rect")
      .evaluateAll((rects) =>
        rects.map((rect) => [
          Number(rect.getAttribute("x")),
          Number(rect.getAttribute("width")),
        ]),
      );
    assert.deepEqual(
      rects,
      intervals[index].map(([start, end]) => [
        start * 100,
        (end - start) * 100,
      ]),
    );
  }
  await shot("05-final-grounding-matrix");
  evidence.checks.push(
    "Rendered actual intervals on common ten-second scale, 3 pairs and mean 33.3%",
  );
  const matrix = inspector.getByRole("table");
  assert.equal(
    await matrix.getByRole("cell", { name: "33.3%", exact: true }).count(),
    6,
  );
  const inspectorAudio = inspector.locator("audio").first();
  await inspectorAudio.evaluate(async (audio) => {
    audio.currentTime = 2;
    await audio.play();
  });
  await page.waitForFunction(
    () => document.querySelector(".result-inspector audio")?.currentTime > 2.2,
  );
  await inspectorAudio.evaluate((audio) => audio.pause());
  assert(
    Number(
      await inspector
        .locator("svg")
        .first()
        .locator("line")
        .last()
        .getAttribute("x1"),
    ) > 200,
  );
  for (const [name, row] of Object.entries(fixture.scenarios)) {
    const loaded = page.waitForResponse(
      (res) =>
        res.url().includes("action=results") &&
        res.url().includes(row.jobId) &&
        res.ok(),
    );
    await selectField(page, "Team job").selectOption(row.jobId);
    const result = await (await loaded).json();
    for (const block of result.blocks) {
      await page
        .locator(".job-result")
        .filter({
          has: page.getByRole("heading", {
            name: new RegExp(
              block.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            ),
          }),
        })
        .first()
        .waitFor();
    }
    // Inspect every resolved block/slot, including repeated children. Actual
    // readable values must mount without a browser exception.
    const buttons = page.getByRole("button", {
      name: "Inspect results",
      exact: true,
    });
    assert.equal(await buttons.count(), result.items.length);
    for (let i = 0; i < result.items.length; i++) {
      await buttons.nth(i).click();
      await checkText(
        page.getByRole("region", { name: "Result inspector" }),
        "Readable submitted annotations",
      );
      const details = page
        .getByRole("region", { name: "Result inspector" })
        .locator("details");
      for (let j = 0; j < (await details.count()); j++)
        await details.nth(j).locator(":scope > summary").click();
      assert(
        !(
          await page
            .getByRole("region", { name: "Result inspector" })
            .innerText()
        ).includes("R02B_PRIVATE_"),
      );
    }
    await shot("06-results-" + name);
    evidence.checks.push(
      name + ": " + result.items.length + " actual result inspectors rendered",
    );
  }
  await page
    .getByRole("button", { name: "Progress Overview", exact: true })
    .click();
  await checkText(page, "Individual submissions");
  await page
    .getByRole("button", { name: "Labeller Analysis", exact: true })
    .click();
  await checkText(page, "Alice");
  await shot("07-labeller-analysis");
  await page
    .getByRole("button", { name: "Research exports", exact: true })
    .click();
  await selectField(page, "Research job").selectOption(fixture.browserJobId);
  for (const label of [
    "Download job JSON",
    "Per-audio JSON ZIP",
    "JSON + annotated audio ZIP",
  ]) {
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: label, exact: true }).click();
    const download = await downloaded;
    assert.equal(await download.failure(), null);
    await download.saveAs(path.join(output, download.suggestedFilename()));
  }
  await shot("08-research-export");
  evidence.checks.push(
    "All progress views and three real browser export downloads",
  );
  await page
    .getByRole("button", { name: "Project configuration", exact: true })
    .click();
  if (!fixture.qaProjectId) {
    await page
      .getByLabel("Project name", { exact: true })
      .fill("R02B UI-created study");
    await page
      .getByLabel("URL slug (lowercase, hyphens only)", { exact: true })
      .fill("r02b-ui-" + fixture.projectId.slice(0, 8));
    fixture.qaProjectId = (
      await clickResponse(
        page,
        page.getByRole("button", { name: "Create project", exact: true }),
        "/projects",
      )
    ).project.id;
    await savedFixture();
  }
  await page
    .getByRole("button", { name: /task.definition/i })
    .filter({ hasText: /^Task/ })
    .first()
    .click();
  if (!fixture.qaDraftId) {
    await selectField(page.locator(".al-cfg-form"), "Project").selectOption(
      fixture.qaProjectId,
    );
    await page
      .getByLabel("Definition name", { exact: true })
      .fill("R02B UI starter draft");
    await page
      .getByLabel("Task instructions", { exact: true })
      .fill("Listen independently to synthetic audio.");
    fixture.qaDraftId = (
      await clickResponse(
        page,
        page.getByRole("button", {
          name: "Create Task Definition draft",
          exact: true,
        }),
        "/task-definitions",
      )
    ).taskDefinition.id;
    await savedFixture();
  }
  await shot("09-project-configuration");
  evidence.checks.push(
    "Teammate Project Configuration: real UI project and starter definition creation",
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).waitFor();
  assert.equal(await page.locator(".al-user").count(), 0);
  assert.equal(await page.locator(".al-role-preview").count(), 0);
  await page.reload();
  await page.getByLabel("Username", { exact: true }).waitFor();
  assert.equal(await page.locator(".al-user").count(), 0);
  evidence.checks.push(
    "Logout and missing session remove authenticated identity",
  );
  evidence.applicationErrors = evidence.errors.filter(
    (error) => !error.url?.endsWith("/favicon.ico"),
  );
  assert.deepEqual(evidence.applicationErrors, []);
  assert.deepEqual(evidence.httpFailures, []);
  assert.deepEqual(evidence.failedRequests, []);
  evidence.status = "PASS";
  console.log(
    `PASS ${channel} UI, real audio playback, all result blocks, grounding matrix, synchronized cursor and exports`,
  );
  await fs.writeFile(
    path.join(output, "dom.txt"),
    await page.locator("body").innerText(),
  );
} catch (error) {
  evidence.failure = error.stack;
  if (page) {
    await shot("failure");
    await fs.writeFile(
      path.join(output, "failure-dom.txt"),
      await page.locator("body").innerText(),
    );
  }
  throw error;
} finally {
  await fs.writeFile(
    path.join(output, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
