import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Browser } from "playwright";
import { createPlaywrightFixture } from "../../../server/harness/playwright-check";
import {
  createUseBrowserTool,
  type BrowserRunOutcome,
} from "../../../server/harness/tools/use-browser";
import {
  browserOutputSchema,
  type FunctionalCheck,
  type HandoffResolution,
  type PlanCase,
  type SelectionRequired,
  type StyleCheck,
} from "../../../shared/testing";

const check: FunctionalCheck = {
  id: "count",
  criterionId: "counter",
  kind: "functional",
  expectedObservation: "1",
  observation: { kind: "text", target: "heading", comparison: "equals" },
};
const planCase: PlanCase = {
  id: "case",
  title: "Counter",
  preconditions: [],
  actions: [{ kind: "click", target: "button" }],
  checks: [check, { ...check, id: "sibling" }],
};

test("real Chromium with a mocked Jev transport isolates sessions, memoizes actions, blocks replay and rejects stale targets", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chum-browser-test-"));
  let mutations = 0;
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url === "/increment") {
      mutations++;
      response.end("ok");
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<h1>0</h1><span id="hidden-status" hidden>Hidden status</span><span>Visible status</span><input aria-label="note"><button onclick="localStorage.n=String(Number(localStorage.n||0)+1);document.querySelector('h1').textContent=localStorage.n;fetch('/increment')">Add</button>${request.url === "/stale" ? "<script>setTimeout(()=>{document.querySelector('button').outerHTML='<button>Replacement</button>'},200)</script>" : request.url === "/visibility-stale" ? "<script>setTimeout(()=>{document.querySelector('#hidden-status').hidden=false},200)</script>" : ""}`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const target = `http://127.0.0.1:${address.port}/`;
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.JEV_API_KEY;
  process.env.JEV_API_KEY = "test-transport-only";
  let lag = 0;
  const submittedIntents: string[] = [];
  globalThis.fetch = async (_url, init) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, lag);
      init?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("cancelled"));
        },
        { once: true },
      );
    });
    const body = JSON.parse(String(init?.body));
    submittedIntents.push(body.state.intent);
    const criteria = body.questions.target.criteria as Record<string, string>;
    const choice =
      Object.entries(criteria).find(([, description]) =>
        description.includes(
          body.state.intent === "button"
            ? '"tag":"BUTTON"'
            : body.state.intent === "hidden status"
              ? '"id":"hidden-status"'
              : body.state.intent === "missing status"
                ? '"id":"absent-status"'
                : '"tag":"H1"',
        ),
      )?.[0] ?? "none";
    return Response.json({
      model: "jev-transport-mock",
      answers: {
        target: {
          type: "choice",
          choice,
          confidence: 0.99,
          probabilities: Object.fromEntries(
            Object.keys(criteria).map((key) => [key, key === choice ? 1 : 0]),
          ),
        },
      },
    });
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = originalKey;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await t.test(
    "hidden visibility yields false, true fails, and absent targets stay blocked without fake observations",
    async () => {
      const hidden: FunctionalCheck = {
        ...check,
        id: "hidden-false",
        expectedObservation: "false",
        observation: { kind: "visible", target: "hidden status", comparison: "equals" },
      };
      const expectedTrue: FunctionalCheck = {
        ...hidden,
        id: "hidden-true",
        expectedObservation: "true",
      };
      const absent: FunctionalCheck = {
        ...hidden,
        id: "absent",
        observation: { kind: "visible", target: "missing status", comparison: "equals" },
      };
      const visibilityCase: PlanCase = {
        ...planCase,
        id: "visibility",
        actions: [{ kind: "navigate", path: "/" }],
        checks: [hidden, expectedTrue, absent],
      };
      const tool = createUseBrowserTool({
        role: "ac",
        cases: [visibilityCase],
        checks: visibilityCase.checks,
        fixture: createPlaywrightFixture(target, "ac", undefined, directory),
        figmaProperties: null,
        designCapture: null,
      });
      const outputs = await Promise.all(
        visibilityCase.checks.map(async (item) =>
          browserOutputSchema.parse(await tool.execute!({ checkId: item.id })),
        ),
      );
      assert.deepEqual(
        outputs.map((item) => item.evidence.outcome),
        ["pass", "fail", "blocked"],
      );
      assert.deepEqual(
        outputs
          .slice(0, 2)
          .map((item) => ("observed" in item.evidence ? item.evidence.observed : undefined)),
        ["false", "false"],
      );
      assert.equal("observed" in outputs[2]!.evidence, false);
      const choices = outputs.map((item) =>
        item.evidence.browser?.selections.map((row) => ("choice" in row ? row.choice : null)),
      );
      assert.equal(choices[0]?.[0], choices[1]?.[1]);
    },
  );
  await t.test(
    "UI rejects mixed stateful cases before model, browser, or mutation effects",
    async () => {
      const style: StyleCheck = {
        id: "style",
        criterionId: "counter",
        kind: "style",
        design: { fileKey: "test", nodeId: "button" },
        target: "button",
        property: "width",
        tolerance: { kind: "exact" },
      };
      const mixedCase: PlanCase = {
        ...planCase,
        checks: [check, style],
      };
      const priorRequests = requests;
      const priorIntents = [...submittedIntents];
      const result = await createPlaywrightFixture(target, "ui", undefined, directory).run!(
        mixedCase,
        style,
      );
      assert.equal(result.state, "blocked");
      assert.match(result.state === "blocked" ? result.reason : "", /ui_navigation_only/);
      assert.equal("observed" in result, false);
      assert.deepEqual(result.browser, { selections: [] });
      assert.equal(mutations, 0);
      assert.equal(requests, priorRequests);
      assert.deepEqual(submittedIntents, priorIntents);
      const fillCase: PlanCase = {
        ...mixedCase,
        id: "fill-ui",
        actions: [{ kind: "fill", target: "note", value: "unsafe" }],
      };
      delete process.env.JEV_API_KEY;
      try {
        const fillResult = await createPlaywrightFixture(target, "ui", undefined, directory).run!(
          fillCase,
          style,
        );
        assert.equal(fillResult.state, "blocked");
        assert.match(fillResult.state === "blocked" ? fillResult.reason : "", /ui_navigation_only/);
      } finally {
        process.env.JEV_API_KEY = "test-transport-only";
      }
    },
  );
  const key = randomUUID();
  const first = createPlaywrightFixture(target, "ac", undefined, directory, key);
  const second = createPlaywrightFixture(target, "ac", undefined, directory);
  const observations = await Promise.all([
    first.run!(planCase, check),
    first.run!(planCase, planCase.checks[1]!),
    second.run!(planCase, check),
  ]);
  assert.deepEqual(
    observations.map((item) =>
      item.state === "observed" ? item.observed : item.state === "blocked" ? item.reason : null,
    ),
    ["1", "1", "1"],
  );
  assert.equal(mutations, 2);
  const replay = await createPlaywrightFixture(target, "ac", undefined, directory, key).run!(
    planCase,
    check,
  );
  assert.equal(replay.state, "blocked");
  assert.equal(mutations, 2);
  lag = 500;
  const visibilityCheck: FunctionalCheck = {
    ...check,
    id: "visibility-stale",
    expectedObservation: "false",
    observation: { kind: "visible", target: "hidden status", comparison: "equals" },
  };
  const visibilityStale = await createPlaywrightFixture(
    `${target}visibility-stale`,
    "ac",
    undefined,
    directory,
  ).run!(
    { ...planCase, id: "visibility-stale", actions: [], checks: [visibilityCheck] },
    visibilityCheck,
  );
  assert.equal(visibilityStale.state, "blocked");
  assert.match(
    visibilityStale.state === "blocked" ? visibilityStale.reason : "",
    /DOM target changed/,
  );
  assert.equal("observed" in visibilityStale, false);
  const stale = await createPlaywrightFixture(`${target}stale`, "ac", undefined, directory).run!(
    planCase,
    check,
  );
  assert.equal(stale.state, "blocked");
  assert.equal(mutations, 2);
  const controller = new AbortController();
  const pending = createPlaywrightFixture(target, "ac", controller.signal, directory).run!(
    planCase,
    check,
  );
  setTimeout(() => controller.abort(), 300);
  assert.equal((await pending).state, "blocked");
  assert.equal(mutations, 2);
});

test("browser evidence cannot claim live provenance without the live adapter and observation metadata", () => {
  const evidence = {
    kind: "functional",
    outcome: "pass",
    expected: "1",
    observed: "1",
    actionIndex: 0,
    caseId: "case",
    checkId: "count",
    origin: "browser",
    fixture: { id: "playwright-chromium", version: "v1" },
    adapterVersion: "playwright-jev-v1",
    browser: { selections: [] },
  };
  assert.equal(browserOutputSchema.safeParse({ checkId: "count", evidence }).success, true);
  for (const invalid of [
    { ...evidence, browser: undefined },
    { ...evidence, adapterVersion: "mock-adapter-v1" },
    { ...evidence, origin: "mock" },
  ])
    assert.equal(
      browserOutputSchema.safeParse({ checkId: "count", evidence: invalid }).success,
      false,
    );
});

test("browser provenance distinguishes Jev, agent choice and agent navigation, and agent rows carry no confidence", () => {
  const agentChoice = {
    source: "agent_choose",
    handoffId: "h1",
    candidateId: "c1",
    fingerprintDigest: "f".repeat(64),
    target: { intent: "button", operation: "click", at: { kind: "action", index: 0 } },
  };
  const evidence = (selections: readonly unknown[]) => ({
    checkId: "count",
    evidence: {
      kind: "functional",
      outcome: "pass",
      expected: "1",
      observed: "1",
      actionIndex: 0,
      caseId: "case",
      checkId: "count",
      origin: "browser",
      fixture: { id: "playwright-chromium", version: "v1" },
      adapterVersion: "playwright-jev-v1",
      browser: { selections },
    },
  });
  const valid = [
    { model: "jev-latest", choice: "c0", confidence: 0.9, candidateDigest: "d".repeat(64) },
    agentChoice,
    {
      source: "agent_navigate",
      handoffId: "h2",
      linkId: "l0",
      from: "http://shop.test/",
      to: "http://shop.test/cart.html",
    },
  ];
  assert.equal(browserOutputSchema.safeParse(evidence(valid)).success, true);
  assert.equal(
    browserOutputSchema.safeParse(evidence([{ ...agentChoice, confidence: 1 }])).success,
    false,
  );
});

test("live tools reject foreign scope before any browser or model effect and retain deterministic discrepancy", async () => {
  const tool = createUseBrowserTool({
    role: "ac",
    cases: [planCase],
    checks: [check],
    fixture: {
      identity: { id: "playwright-chromium", version: "v1" },
      adapterVersion: "playwright-jev-v1",
      run: async () => ({ state: "observed", observed: "2", browser: { selections: [] } }),
    },
    figmaProperties: null,
    designCapture: null,
  });
  await assert.rejects(async () => tool.execute!({ checkId: "foreign" }), /Unknown scoped check/);
  const output = browserOutputSchema.parse(await tool.execute!({ checkId: "count" }));
  assert.equal(output.evidence.outcome, "fail");
  assert.equal(output.evidence.origin, "browser");
});

type FakeSpec = {
  tag: string;
  text?: string;
  attributes?: Record<string, string>;
  hidden?: boolean;
  onClick?: () => void;
};

class FakeNode {
  constructor(
    readonly spec: FakeSpec,
    private readonly pageUrl: () => string,
  ) {}

  get tagName() {
    return this.spec.tag;
  }

  get id() {
    return this.spec.attributes?.id ?? "";
  }

  get childElementCount() {
    return 0;
  }

  get innerText() {
    return this.spec.text ?? "";
  }

  get textContent() {
    return this.spec.text ?? "";
  }

  get parentElement() {
    return null;
  }

  get isConnected() {
    return true;
  }

  get href() {
    return new URL(this.spec.attributes?.href ?? "", this.pageUrl()).href;
  }

  getAttribute(name: string) {
    return this.spec.attributes?.[name] ?? null;
  }

  getAttributeNames() {
    return Object.keys(this.spec.attributes ?? {});
  }

  hasAttribute(name: string) {
    return this.getAttribute(name) !== null;
  }
}

Object.assign(globalThis, { HTMLElement: FakeNode });

function matchesPart(node: FakeNode, part: string): boolean {
  const [, tag = "", rest = ""] = /^([a-z0-9]*)(.*)$/.exec(part) ?? [];

  if (tag && node.tagName !== tag.toUpperCase()) {
    return false;
  }

  return [...rest.matchAll(/(:not\()?\[([a-z-]+)(?:=([a-z-]+))?\]\)?/g)].every(
    ([, negated, name, value]) => {
      const actual = node.getAttribute(name!);
      const holds = value === undefined ? actual !== null : actual === value;

      return holds !== (negated !== undefined);
    },
  );
}

function fakeBrowser(pages: Readonly<Record<string, readonly FakeSpec[]>>) {
  const site = {
    url: "about:blank",
    nodes: [] as FakeNode[],
    visits: [] as string[],
    clicks: [] as string[],
    fills: [] as string[],
    shots: 0,
    launches: 0,
    closed: false,
  };
  const handle = (node: FakeNode) => ({
    evaluate: async (fn: (node: FakeNode, arg: unknown) => unknown, arg?: unknown) => fn(node, arg),
    isVisible: async () => !node.spec.hidden,
    getAttribute: async (name: string) => node.getAttribute(name),
    click: async () => {
      site.clicks.push(node.innerText);
      node.spec.onClick?.();
    },
    fill: async (value: string) => {
      site.fills.push(value);
    },
    innerText: async () => node.innerText,
    inputValue: async () => node.getAttribute("value") ?? "",
    boundingBox: async () => ({ x: 0, y: 0, width: 120, height: 32 }),
  });
  const page = {
    url: () => site.url,
    goto: async (url: string) => {
      site.url = url;
      site.visits.push(url);
      site.nodes = (pages[new URL(url).pathname] ?? []).map(
        (spec) => new FakeNode(spec, () => site.url),
      );

      return null;
    },
    waitForLoadState: async () => undefined,
    addStyleTag: async () => undefined,
    $$: async (selector: string) =>
      site.nodes
        .filter((node) => selector.split(",").some((part) => matchesPart(node, part)))
        .map(handle),
    screenshot: async () => {
      site.shots += 1;

      return Buffer.from(`shot-${site.shots}`);
    },
    evaluate: async () => true,
    waitForTimeout: async () => undefined,
    setDefaultTimeout: () => undefined,
    setDefaultNavigationTimeout: () => undefined,
  };
  const context = {
    routeWebSocket: async () => undefined,
    route: async () => undefined,
    newPage: async () => page,
    on: () => undefined,
    close: async () => undefined,
  };
  const browser = {
    newContext: async () => context,
    close: async () => {
      site.closed = true;
    },
  };

  return {
    site,
    launch: async () => {
      site.launches += 1;

      return browser as unknown as Browser;
    },
  };
}

type JevPick = (intent: string, criteria: Readonly<Record<string, string>>) => string;

function mockJev(t: TestContext, pick: JevPick): string[] {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.JEV_API_KEY;
  const intents: string[] = [];
  process.env.JEV_API_KEY = "test-transport-only";
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const criteria = body.questions.target.criteria as Record<string, string>;
    intents.push(body.state.intent);
    const choice = pick(body.state.intent, criteria);

    if (choice === "hang") {
      return new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    }

    return Response.json({
      model: "jev-transport-mock",
      answers: {
        target: {
          type: "choice",
          choice,
          confidence: 0.99,
          probabilities: Object.fromEntries(
            Object.keys(criteria).map((key) => [key, key === choice ? 1 : 0]),
          ),
        },
      },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = originalKey;
  });

  return intents;
}

function choosing(rules: Readonly<Record<string, string>>): JevPick {
  return (intent, criteria) => {
    const wanted = Object.entries(rules).find(([key]) => intent.includes(key))?.[1];
    const match = wanted
      ? Object.entries(criteria).find(([id, text]) => id !== "none" && text.includes(wanted))
      : undefined;

    return match?.[0] ?? "none";
  };
}

const SHOP = "http://shop.test/";
const evidenceDirectory = await mkdtemp(join(tmpdir(), "chum-handoff-test-"));
after(() => rm(evidenceDirectory, { recursive: true, force: true }));

function freezeClock(t: TestContext) {
  t.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: Date.parse("2026-10-13T00:00:00.000Z"),
  });
}

function liveFixture(
  t: TestContext,
  pages: Readonly<Record<string, readonly FakeSpec[]>>,
  options: Readonly<{ role?: "ac" | "ui"; signal?: AbortSignal; key?: string }> = {},
) {
  const fake = fakeBrowser(pages);
  const fixture = createPlaywrightFixture(
    SHOP,
    options.role ?? "ac",
    options.signal,
    evidenceDirectory,
    options.key ?? randomUUID(),
    fake.launch,
  );
  t.after(() => fixture.dispose());

  return { fixture, site: fake.site };
}

function described(tag: string, text: string, label: string | null = null): string {
  return JSON.stringify({
    visible: true,
    tag,
    id: "",
    role: null,
    markers: [],
    children: 0,
    text,
    label,
    type: null,
    connected: true,
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stable(outcome: BrowserRunOutcome): unknown {
  if (outcome.state === "selection_required" || !outcome.browser) {
    return outcome;
  }

  const { selections, screenshot } = outcome.browser;

  return {
    ...outcome,
    browser: {
      selections: selections.map((row) =>
        "candidateDigest" in row && /^[0-9a-f]{64}$/.test(row.candidateDigest)
          ? { ...row, candidateDigest: "sha256" }
          : row,
      ),
      ...(screenshot
        ? {
            screenshot: {
              path: /^[0-9a-f-]{36}\.png$/.test(screenshot.path) ? "uuid.png" : screenshot.path,
              digest: screenshot.digest,
            },
          }
        : {}),
    },
  };
}

function navigate(handoffId: string, linkId: string): HandoffResolution {
  return { handoffId, decision: { kind: "navigate", linkId } };
}

function choose(handoffId: string, candidateId: string): HandoffResolution {
  return { handoffId, decision: { kind: "choose", candidateId } };
}

function shop(labelled: boolean) {
  const subtotal: FakeSpec = { tag: "SPAN", text: "Subtotal: 1" };
  const plus: FakeSpec = {
    tag: "BUTTON",
    text: "+",
    ...(labelled ? { attributes: { "aria-label": "Increase quantity" } } : {}),
    onClick: () => {
      subtotal.text = "Subtotal: 2";
    },
  };

  const pages: Record<string, FakeSpec[]> = {
    "/": [
      { tag: "H1", text: "Welcome" },
      { tag: "A", text: "Order summary", attributes: { href: "/cart.html" } },
      { tag: "A", text: "Partner", attributes: { href: "http://partner.test/" } },
      { tag: "A", text: "Brochure", attributes: { href: "/brochure.pdf", download: "" } },
      { tag: "BUTTON", text: "Help" },
    ],
    "/cart.html": [
      { tag: "H1", text: "Order summary" },
      { tag: "A", text: "Home", attributes: { href: "/" } },
      plus,
      { tag: "BUTTON", text: "-" },
      subtotal,
    ],
  };

  return { plus, pages };
}

const rules = {
  "quantity increase": '"label":"Increase quantity"',
  subtotal: '"text":"Subtotal',
  heading: '"text":"Welcome"',
  help: '"text":"Help"',
};
const subtotalCheck: FunctionalCheck = {
  id: "subtotal",
  criterionId: "quantity",
  kind: "functional",
  expectedObservation: "Subtotal: 2",
  observation: { kind: "text", target: "subtotal in the order summary", comparison: "equals" },
};
const headingCheck: FunctionalCheck = {
  id: "heading",
  criterionId: "welcome",
  kind: "functional",
  expectedObservation: "Welcome",
  observation: { kind: "text", target: "heading of the page", comparison: "equals" },
};
const helpCheck: FunctionalCheck = {
  id: "help",
  criterionId: "welcome",
  kind: "functional",
  expectedObservation: "Help",
  observation: { kind: "text", target: "help button", comparison: "equals" },
};
const quantityCase: PlanCase = {
  id: "quantity",
  title: "Increase quantity",
  preconditions: [],
  actions: [
    { kind: "navigate", path: "/" },
    { kind: "click", target: "quantity increase control in the order summary" },
  ],
  checks: [subtotalCheck],
};
const directCase: PlanCase = {
  ...quantityCase,
  id: "direct",
  actions: [
    { kind: "navigate", path: "/cart.html" },
    { kind: "click", target: "quantity increase control in the order summary" },
  ],
};
const summaryCase: PlanCase = {
  id: "summary",
  title: "Summary",
  preconditions: [],
  actions: [{ kind: "navigate", path: "/" }],
  checks: [headingCheck, { ...subtotalCheck, expectedObservation: "Subtotal: 1" }, helpCheck],
};
const homeLinks = [{ id: "l0", description: "Order summary", url: "http://shop.test/cart.html" }];
const noneDiagnostics = (candidateCount: number) => ({
  code: "uncertain_or_invalid_selection",
  choice: "none",
  confidence: 0.99,
  probability: 1,
  gap: 1,
  probabilityTotal: 1,
  candidateCount,
  probabilityCount: candidateCount,
});

test("a Jev miss on an action pauses the case with the browser open and returns its snapshot", async (t) => {
  freezeClock(t);
  mockJev(t, choosing(rules));
  const { fixture, site } = liveFixture(t, shop(true).pages);

  assert.deepEqual(await fixture.run(quantityCase, subtotalCheck), {
    state: "selection_required",
    handoff: {
      id: "h1",
      caseId: "quantity",
      ordinal: 1,
      laterHandoffsAllowed: 2,
      expiresAt: "2026-10-13T00:03:00.000Z",
      url: "http://shop.test/",
      target: {
        intent: "quantity increase control in the order summary",
        operation: "click",
        at: { kind: "action", index: 1 },
      },
      candidates: [
        { id: "c0", description: described("A", "Order summary") },
        { id: "c1", description: described("A", "Partner") },
        { id: "c2", description: described("A", "Brochure") },
        { id: "c3", description: described("BUTTON", "Help") },
      ],
      links: homeLinks,
      linksTruncated: false,
      diagnostics: noneDiagnostics(5),
    },
  });
  assert.deepEqual(
    { launches: site.launches, closed: site.closed, clicks: site.clicks },
    { launches: 1, closed: false, clicks: [] },
  );
});

test("a Jev miss on an observation pauses at that check with the browser open", async (t) => {
  freezeClock(t);
  mockJev(t, choosing(rules));
  const { fixture, site } = liveFixture(t, shop(true).pages);

  assert.deepEqual(await fixture.run(summaryCase, headingCheck), {
    state: "selection_required",
    handoff: {
      id: "h1",
      caseId: "summary",
      ordinal: 1,
      laterHandoffsAllowed: 2,
      expiresAt: "2026-10-13T00:03:00.000Z",
      url: "http://shop.test/",
      target: {
        intent: "subtotal in the order summary",
        operation: "observe",
        at: { kind: "check", checkId: "subtotal" },
      },
      candidates: [
        { id: "c0", description: described("H1", "Welcome") },
        { id: "c1", description: described("A", "Order summary") },
        { id: "c2", description: described("A", "Partner") },
        { id: "c3", description: described("A", "Brochure") },
        { id: "c4", description: described("BUTTON", "Help") },
      ],
      links: homeLinks,
      linksTruncated: false,
      diagnostics: noneDiagnostics(6),
    },
  });
  assert.deepEqual(
    { launches: site.launches, closed: site.closed },
    { launches: 1, closed: false },
  );
});

test("navigate retries Jev with the original intent on the linked page and continues the case", async (t) => {
  freezeClock(t);
  const intents = mockJev(t, choosing(rules));
  const { fixture, site } = liveFixture(t, shop(true).pages);
  await fixture.run(quantityCase, subtotalCheck);

  assert.deepEqual(stable(await fixture.run(quantityCase, subtotalCheck, navigate("h1", "l0"))), {
    state: "observed",
    observed: "Subtotal: 2",
    browser: {
      selections: [
        {
          source: "agent_navigate",
          handoffId: "h1",
          linkId: "l0",
          from: "http://shop.test/",
          to: "http://shop.test/cart.html",
        },
        { model: "jev-transport-mock", choice: "c1", confidence: 0.99, candidateDigest: "sha256" },
        { model: "jev-transport-mock", choice: "c4", confidence: 0.99, candidateDigest: "sha256" },
      ],
      screenshot: { path: "uuid.png", digest: sha256("shot-1") },
    },
  });
  assert.deepEqual(intents, [
    "quantity increase control in the order summary",
    "quantity increase control in the order summary",
    "subtotal in the order summary",
  ]);
  assert.deepEqual(
    { clicks: site.clicks, visits: site.visits, launches: site.launches, closed: site.closed },
    {
      clicks: ["+"],
      visits: ["http://shop.test/", "http://shop.test/", "http://shop.test/cart.html"],
      launches: 1,
      closed: true,
    },
  );
});

test("choose completes the original operation and records agent provenance without a confidence", async (t) => {
  freezeClock(t);
  const intents = mockJev(t, choosing(rules));
  const { fixture, site } = liveFixture(t, shop(false).pages);
  await fixture.run(directCase, subtotalCheck);

  assert.deepEqual(stable(await fixture.run(directCase, subtotalCheck, choose("h1", "c1"))), {
    state: "observed",
    observed: "Subtotal: 2",
    browser: {
      selections: [
        {
          source: "agent_choose",
          handoffId: "h1",
          candidateId: "c1",
          fingerprintDigest: sha256(described("BUTTON", "+")),
          target: {
            intent: "quantity increase control in the order summary",
            operation: "click",
            at: { kind: "action", index: 1 },
          },
        },
        { model: "jev-transport-mock", choice: "c4", confidence: 0.99, candidateDigest: "sha256" },
      ],
      screenshot: { path: "uuid.png", digest: sha256("shot-1") },
    },
  });
  assert.deepEqual(intents, [
    "quantity increase control in the order summary",
    "subtotal in the order summary",
  ]);
  assert.deepEqual(site.clicks, ["+"]);
});

test("UI choose only completes a read-only measurement and UI never runs stateful actions", async (t) => {
  freezeClock(t);
  mockJev(t, () => "none");
  const style: StyleCheck = {
    id: "cta-width",
    criterionId: "cta",
    kind: "style",
    design: { fileKey: "FILE", nodeId: "1:2" },
    target: "primary call to action",
    property: "width",
    tolerance: { kind: "exact" },
  };
  const ctaCase: PlanCase = {
    id: "cta",
    title: "Call to action",
    preconditions: [],
    actions: [{ kind: "navigate", path: "/" }],
    checks: [style],
  };
  const pages = {
    "/": [
      { tag: "H1", text: "Welcome" },
      { tag: "BUTTON", text: "Start" },
    ],
  };
  const { fixture, site } = liveFixture(t, pages, { role: "ui" });
  const paused = await fixture.run(ctaCase, style);

  assert.deepEqual(paused.state === "selection_required" && paused.handoff.target, {
    intent: "primary call to action",
    operation: "observe",
    at: { kind: "check", checkId: "cta-width" },
  });
  assert.deepEqual(stable(await fixture.run(ctaCase, style, choose("h1", "c1"))), {
    state: "observed",
    observed: "120px",
    browser: {
      selections: [
        {
          source: "agent_choose",
          handoffId: "h1",
          candidateId: "c1",
          fingerprintDigest: sha256(described("BUTTON", "Start")),
          target: {
            intent: "primary call to action",
            operation: "observe",
            at: { kind: "check", checkId: "cta-width" },
          },
        },
      ],
      screenshot: { path: "uuid.png", digest: sha256("shot-1") },
    },
  });
  assert.deepEqual({ clicks: site.clicks, fills: site.fills }, { clicks: [], fills: [] });
  const stateful = liveFixture(t, pages, { role: "ui" });
  const blocked = await stateful.fixture.run(
    { ...ctaCase, id: "stateful", actions: [{ kind: "click", target: "Start" }] },
    style,
  );

  assert.match(blocked.state === "blocked" ? blocked.reason : "", /ui_navigation_only/);
  assert.equal(stateful.site.launches, 0);
});

test("abandon blocks the current and later checks with the agent reason, never fail, and siblings read the cached outcome", async (t) => {
  freezeClock(t);
  const intents = mockJev(t, choosing(rules));
  const { fixture, site } = liveFixture(t, shop(true).pages);
  const tool = createUseBrowserTool({
    role: "ac",
    cases: [summaryCase],
    checks: summaryCase.checks,
    fixture,
    figmaProperties: null,
    designCapture: null,
  });
  const paused = (await tool.execute!({ checkId: "heading" })) as SelectionRequired;

  assert.deepEqual(
    { state: paused.state, checkId: paused.checkId, at: paused.handoff.target.at },
    { state: "selection_required", checkId: "heading", at: { kind: "check", checkId: "subtotal" } },
  );
  const reason = "The subtotal is not reachable from the home page";
  const outputs = [
    await tool.execute!({
      checkId: "subtotal",
      resolution: { handoffId: "h1", decision: { kind: "abandon", reason } },
    }),
    await tool.execute!({ checkId: "help" }),
    await tool.execute!({ checkId: "heading" }),
  ].map((output) => browserOutputSchema.parse(output).evidence);
  const abandoned = JSON.stringify({
    stage: "observation",
    code: "handoff_abandoned",
    replay: "forbidden",
    handoffId: "h1",
    reason,
  });

  assert.deepEqual(
    outputs.map((evidence) => [
      evidence.checkId,
      evidence.outcome,
      "reason" in evidence ? evidence.reason : evidence.observed,
      evidence.browser?.screenshot?.digest,
    ]),
    [
      ["subtotal", "blocked", abandoned, sha256("shot-1")],
      ["help", "blocked", abandoned, sha256("shot-1")],
      ["heading", "pass", "Welcome", sha256("shot-1")],
    ],
  );
  assert.deepEqual(
    { intents, launches: site.launches, visits: site.visits, shots: site.shots },
    {
      intents: ["heading of the page", "subtotal in the order summary"],
      launches: 1,
      visits: ["http://shop.test/", "http://shop.test/"],
      shots: 1,
    },
  );
  const action = liveFixture(t, shop(true).pages);
  const actionCase: PlanCase = { ...quantityCase, checks: [subtotalCheck, headingCheck] };
  await action.fixture.run(actionCase, subtotalCheck);
  const blocked = {
    state: "blocked",
    reason: JSON.stringify({
      stage: "action_1_click",
      code: "handoff_abandoned",
      replay: "forbidden",
      handoffId: "h1",
      reason: "No quantity control is linked",
    }),
    browser: { selections: [] },
  };

  assert.deepEqual(
    [
      await action.fixture.run(actionCase, headingCheck, {
        handoffId: "h1",
        decision: { kind: "abandon", reason: "No quantity control is linked" },
      }),
      await action.fixture.run(actionCase, subtotalCheck),
    ],
    [blocked, blocked],
  );
  assert.deepEqual(action.site.clicks, []);
});

test("fingerprint drift on choose blocks the case without another handoff", async (t) => {
  freezeClock(t);
  const intents = mockJev(t, choosing(rules));
  const store = shop(false);
  const { fixture, site } = liveFixture(t, store.pages);
  await fixture.run(directCase, subtotalCheck);
  store.plus.text = "Add one";

  assert.deepEqual(await fixture.run(directCase, subtotalCheck, choose("h1", "c1")), {
    state: "blocked",
    reason: JSON.stringify({
      stage: "action_1_click",
      code: "handoff_target_changed",
      replay: "forbidden",
      handoffId: "h1",
    }),
    browser: { selections: [] },
  });
  assert.deepEqual(
    { clicks: site.clicks, intents, closed: site.closed },
    { clicks: [], intents: ["quantity increase control in the order summary"], closed: true },
  );
});

test("a case allows three handoffs across checks, re-reads do not count, and the fourth Jev miss blocks", async (t) => {
  freezeClock(t);
  const intents = mockJev(t, () => "none");
  const totalCheck: FunctionalCheck = {
    id: "total",
    criterionId: "totals",
    kind: "functional",
    expectedObservation: "Total due: 3",
    observation: { kind: "text", target: "order total", comparison: "equals" },
  };
  const pointsCheck: FunctionalCheck = {
    ...totalCheck,
    id: "points",
    expectedObservation: "120",
    observation: { kind: "text", target: "loyalty points", comparison: "equals" },
  };
  const totalsCase: PlanCase = {
    id: "totals",
    title: "Totals",
    preconditions: [],
    actions: [{ kind: "navigate", path: "/" }],
    checks: [totalCheck, pointsCheck],
  };
  const { fixture } = liveFixture(t, {
    "/": [
      { tag: "H1", text: "Welcome" },
      { tag: "A", text: "Catalog", attributes: { href: "/catalog.html" } },
    ],
    "/catalog.html": [
      { tag: "H1", text: "Catalog" },
      { tag: "A", text: "Home", attributes: { href: "/" } },
      { tag: "SPAN", text: "Total due: 3" },
    ],
  });
  const counted = (outcome: BrowserRunOutcome) =>
    outcome.state === "selection_required"
      ? [outcome.handoff.id, outcome.handoff.ordinal, outcome.handoff.laterHandoffsAllowed]
      : outcome.state;
  const issued = [
    await fixture.run(totalsCase, totalCheck),
    await fixture.run(totalsCase, totalCheck, navigate("h1", "l0")),
    await fixture.run(totalsCase, totalCheck, choose("h2", "c2")),
    await fixture.run(totalsCase, pointsCheck),
    await fixture.run(totalsCase, totalCheck),
  ];

  assert.deepEqual(issued.map(counted), [
    ["h1", 1, 2],
    ["h2", 2, 1],
    ["h3", 3, 0],
    ["h3", 3, 0],
    ["h3", 3, 0],
  ]);
  const provenance = [
    {
      source: "agent_navigate",
      handoffId: "h1",
      linkId: "l0",
      from: "http://shop.test/",
      to: "http://shop.test/catalog.html",
    },
    {
      source: "agent_choose",
      handoffId: "h2",
      candidateId: "c2",
      fingerprintDigest: sha256(described("SPAN", "Total due: 3")),
      target: {
        intent: "order total",
        operation: "observe",
        at: { kind: "check", checkId: "total" },
      },
    },
    {
      source: "agent_navigate",
      handoffId: "h3",
      linkId: "l0",
      from: "http://shop.test/catalog.html",
      to: "http://shop.test/",
    },
  ];

  assert.deepEqual(stable(await fixture.run(totalsCase, pointsCheck, navigate("h3", "l0"))), {
    state: "blocked",
    reason: JSON.stringify({
      stage: "observation",
      code: "handoff_limit",
      replay: "forbidden",
      diagnostics: {
        choice: "none",
        confidence: 0.99,
        probability: 1,
        gap: 1,
        probabilityTotal: 1,
        candidateCount: 3,
        probabilityCount: 3,
      },
    }),
    browser: { selections: provenance, screenshot: { path: "uuid.png", digest: sha256("shot-2") } },
  });
  assert.deepEqual(stable(await fixture.run(totalsCase, totalCheck)), {
    state: "observed",
    observed: "Total due: 3",
    browser: { selections: provenance, screenshot: { path: "uuid.png", digest: sha256("shot-1") } },
  });
  assert.deepEqual(intents, ["order total", "order total", "loyalty points", "loyalty points"]);
});

test("a resent decision is idempotent while conflicting, unknown or unpaused resolutions change nothing", async (t) => {
  freezeClock(t);
  mockJev(t, choosing(rules));
  const { fixture, site } = liveFixture(t, shop(false).pages);
  await fixture.run(quantityCase, subtotalCheck);
  const second = await fixture.run(quantityCase, subtotalCheck, navigate("h1", "l0"));
  const visits = [...site.visits];

  assert.deepEqual(await fixture.run(quantityCase, subtotalCheck, navigate("h1", "l0")), second);
  for (const [resolution, message] of [
    [choose("h1", "c0"), "Handoff h1 was already resolved with a different decision"],
    [choose("h2", "c9"), "Handoff h2 has no candidate c9"],
    [navigate("h2", "l9"), "Handoff h2 has no link l9"],
    [navigate("h7", "l0"), "Handoff h7 is not pending for case quantity"],
  ] as const) {
    await assert.rejects(fixture.run(quantityCase, subtotalCheck, resolution), { message });
  }
  assert.deepEqual(await fixture.run(quantityCase, subtotalCheck), second);
  assert.deepEqual(
    second.state === "selection_required" && [second.handoff.id, second.handoff.ordinal],
    ["h2", 2],
  );
  assert.deepEqual(site.visits, visits);
  const done = await fixture.run(quantityCase, subtotalCheck, choose("h2", "c1"));

  assert.equal(done.state === "observed" && done.observed, "Subtotal: 2");
  assert.deepEqual(await fixture.run(quantityCase, subtotalCheck, choose("h2", "c1")), done);
  await assert.rejects(fixture.run(quantityCase, subtotalCheck, navigate("h2", "l0")), {
    message: "Handoff h2 was already resolved with a different decision",
  });
  await assert.rejects(fixture.run(quantityCase, subtotalCheck, navigate("h3", "l0")), {
    message: "Handoff h3 is not pending for case quantity",
  });
  assert.deepEqual(site.clicks, ["+"]);
});

test("a restarted fixture with the replay marker blocks without launching, even for a stale handoff", async (t) => {
  freezeClock(t);
  mockJev(t, choosing(rules));
  const key = randomUUID();
  const original = liveFixture(t, shop(true).pages, { key });
  await original.fixture.run(quantityCase, subtotalCheck);
  const restarted = liveFixture(t, shop(true).pages, { key });
  const blocked = {
    state: "blocked",
    reason: "Prior browser execution may have produced effects; replay is forbidden",
    browser: { selections: [] },
  };

  assert.deepEqual(
    [
      await restarted.fixture.run(quantityCase, subtotalCheck, navigate("h1", "l0")),
      await restarted.fixture.run(quantityCase, subtotalCheck),
    ],
    [blocked, blocked],
  );
  assert.deepEqual(
    { launches: restarted.site.launches, visits: restarted.site.visits },
    { launches: 0, visits: [] },
  );
  const fresh = liveFixture(t, shop(true).pages);
  await assert.rejects(fresh.fixture.run(quantityCase, subtotalCheck, navigate("h1", "l0")), {
    message: "Case quantity has no paused browser session",
  });
  assert.equal(fresh.site.launches, 0);
});

test("pause expiry closes the browser and blocks the case", async (t) => {
  freezeClock(t);
  mockJev(t, choosing(rules));
  const { fixture, site } = liveFixture(t, shop(true).pages);
  await fixture.run(quantityCase, subtotalCheck);
  t.mock.timers.tick(179_999);

  assert.equal((await fixture.run(quantityCase, subtotalCheck)).state, "selection_required");
  assert.equal(site.closed, false);
  t.mock.timers.tick(1);

  for (let turn = 0; turn < 20 && !site.closed; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(site.closed, true);
  assert.deepEqual(await fixture.run(quantityCase, subtotalCheck), {
    state: "blocked",
    reason: JSON.stringify({
      stage: "action_1_click",
      code: "handoff_expired",
      replay: "forbidden",
      handoffId: "h1",
    }),
    browser: { selections: [] },
  });
  assert.equal(site.closed, true);
  await assert.rejects(fixture.run(quantityCase, subtotalCheck, navigate("h1", "l0")), {
    message: "Handoff h1 is not pending for case quantity",
  });
});

test("a decision arriving after the pause deadline is refused before the expiry timer fires", async (t) => {
  freezeClock(t);
  mockJev(t, choosing(rules));
  const { fixture, site } = liveFixture(t, shop(true).pages);
  await fixture.run(quantityCase, subtotalCheck);
  t.mock.timers.setTime(Date.parse("2026-10-13T00:03:00.000Z"));

  await assert.rejects(fixture.run(quantityCase, subtotalCheck, navigate("h1", "l0")), {
    message: "Handoff h1 is not pending for case quantity",
  });
  assert.deepEqual(await fixture.run(quantityCase, subtotalCheck), {
    state: "blocked",
    reason: JSON.stringify({
      stage: "action_1_click",
      code: "handoff_expired",
      replay: "forbidden",
      handoffId: "h1",
    }),
    browser: { selections: [] },
  });
  assert.deepEqual(
    { visits: site.visits, closed: site.closed },
    { visits: ["http://shop.test/", "http://shop.test/"], closed: true },
  );
});

test("parent abort and dispose close a paused browser and block the case", async (t) => {
  freezeClock(t);
  mockJev(t, choosing(rules));
  const cancelled = {
    state: "blocked",
    reason: JSON.stringify({
      stage: "action_1_click",
      code: "cancelled_or_timed_out",
      replay: "forbidden",
    }),
    browser: { selections: [] },
  };
  const controller = new AbortController();
  const aborted = liveFixture(t, shop(true).pages, { signal: controller.signal });
  await aborted.fixture.run(quantityCase, subtotalCheck);
  controller.abort();

  assert.deepEqual(await aborted.fixture.run(quantityCase, subtotalCheck), cancelled);
  assert.equal(aborted.site.closed, true);
  const disposed = liveFixture(t, shop(true).pages);
  await disposed.fixture.run(quantityCase, subtotalCheck);
  await disposed.fixture.dispose();

  assert.equal(disposed.site.closed, true);
  assert.deepEqual(await disposed.fixture.run(quantityCase, subtotalCheck), cancelled);
});

test("paused time is excluded from the 90 second active budget, which still applies after resume", async (t) => {
  freezeClock(t);
  let calls = 0;
  const intents = mockJev(t, () => {
    calls += 1;

    return calls === 1 ? "none" : "hang";
  });
  const { fixture } = liveFixture(t, shop(true).pages);
  await fixture.run(quantityCase, subtotalCheck);
  t.mock.timers.tick(170_000);

  assert.equal((await fixture.run(quantityCase, subtotalCheck)).state, "selection_required");
  let settled = false;
  const resumed = fixture.run(quantityCase, subtotalCheck, navigate("h1", "l0")).finally(() => {
    settled = true;
  });
  const turn = () => new Promise((resolve) => setImmediate(resolve));

  while (intents.length < 2) {
    await turn();
  }

  t.mock.timers.tick(89_999);
  await turn();
  await turn();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await resumed, {
    state: "blocked",
    reason: JSON.stringify({
      stage: "action_1_click",
      code: "cancelled_or_timed_out",
      replay: "forbidden",
    }),
    browser: {
      selections: [
        {
          source: "agent_navigate",
          handoffId: "h1",
          linkId: "l0",
          from: "http://shop.test/",
          to: "http://shop.test/cart.html",
        },
      ],
    },
  });
});

test("an agent navigation after an observation keeps that observation's page screenshot", async (t) => {
  freezeClock(t);
  mockJev(t, choosing(rules));
  const { fixture, site } = liveFixture(t, shop(true).pages);
  const pageCase: PlanCase = {
    ...summaryCase,
    checks: [headingCheck, { ...subtotalCheck, expectedObservation: "Subtotal: 1" }],
  };
  await fixture.run(pageCase, headingCheck);
  const outcomes = [
    await fixture.run(pageCase, subtotalCheck, navigate("h1", "l0")),
    await fixture.run(pageCase, headingCheck),
  ];

  assert.deepEqual(
    outcomes.map((outcome) =>
      outcome.state === "observed"
        ? [outcome.observed, outcome.browser?.screenshot?.digest]
        : outcome.state,
    ),
    [
      ["Subtotal: 1", sha256("shot-2")],
      ["Welcome", sha256("shot-1")],
    ],
  );
  assert.equal(site.shots, 2);
});
