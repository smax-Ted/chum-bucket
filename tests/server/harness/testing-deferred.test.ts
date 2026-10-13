import assert from "node:assert/strict";
import { test } from "node:test";
import { testRunIdSchema } from "../../../shared/testing";
import type { DeferredCase, PlanCheck } from "../../../shared/testing";
import {
  canonicalizePlan,
  deriveReport,
  digestOf,
  planPayloadSchema,
  planScopeDigest,
  projectProgress,
  publicIssues,
  publicTaskArtifact,
  sourceCaptureSchema,
  validateReuse,
  validateRequirements,
  type CanonicalPlan,
  type PlanContext,
  type Requirements,
  type SourceCapture,
  type Validation,
} from "../../../server/harness/testing-domain";

function accept<T>(
  validation: Validation<T> | Readonly<{ kind: "not_extractable"; unresolved: readonly string[] }>,
): T {
  if (validation.kind !== "accepted") {
    throw new Error(
      `setup failed: ${validation.kind === "rejected" ? validation.issues.join(", ") : "not extractable"}`,
    );
  }

  return validation.value;
}

const source = { kind: "jira" as const, issueKey: "FETM-78" };
const functionalKeys = ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6", "AC-7"] as const;
const uiKeys = ["UI-AC-1", "UI-AC-2", "UI-AC-3"] as const;

const capture: SourceCapture = {
  reference: source,
  digest: "native-digest",
  anchors: [...functionalKeys, ...uiKeys],
  capturedAt: "2026-10-13T00:00:00Z",
};

function fetmRequirements(captures: readonly SourceCapture[] = [capture]): Requirements {
  return accept(
    validateRequirements(
      {
        criteria: [...functionalKeys, ...uiKeys].map((key) => ({
          key,
          statement: `Statement for ${key}`,
          source,
          anchor: key,
        })),
        unresolved: [],
      },
      { goal: "Plan FETM-78", captures },
    ),
  );
}

const requirements = fetmRequirements();

const context: PlanContext = {
  requirements,
  requirementsDigest: digestOf(requirements),
  goal: "Plan FETM-78",
  targetUrl: null,
  design: null,
  bounds: { maxCases: 20, maxChecks: 80, maxChecksPerCase: 12 },
};

function functionalCase(key: string) {
  return {
    id: `case-${key}`,
    title: `Verify ${key}`,
    preconditions: [],
    actions: [{ kind: "navigate" as const, path: "/" }],
    checks: [
      {
        id: `check-${key}`,
        criterionId: `crit:${key}`,
        kind: "functional" as const,
        expectedObservation: `Observable result for ${key}`,
        observation: {
          kind: "text" as const,
          target: `Result for ${key}`,
          comparison: "equals" as const,
        },
      },
    ],
  };
}

function deferredCase(key: string, overrides: Partial<DeferredCase> = {}): DeferredCase {
  return {
    id: `deferred-${key}`,
    title: `Style expectation for ${key}`,
    steps: ["Open the product page at desktop width", "Inspect the add-to-cart button"],
    expectations: [
      {
        criterionId: `crit:${key}`,
        expectedObservation: "Button background is #2D6A4F and label is white 16px",
      },
    ],
    reason: "Style values come from Jira text and no design is bound",
    ...overrides,
  };
}

const fetmProposal = {
  cases: functionalKeys.map(functionalCase),
  deferredCases: uiKeys.map((key) => deferredCase(key)),
};

test("a source-complete plan covers 7 functional and 3 UI criteria without a URL or design", () => {
  const plan = accept(canonicalizePlan(fetmProposal, context));
  assert.equal(plan.targetUrl, null);
  assert.equal(plan.design, null);
  assert.deepEqual(plan.assignments, {
    ac: functionalKeys.map((key) => `check-${key}`),
    ui: [],
  });
  assert.deepEqual(plan.deferredCases, fetmProposal.deferredCases);
  assert.equal(plan.cases.length, 7);
});

test("an all-deferred plan is valid, has empty assignments and no executable cases", () => {
  const plan = accept(
    canonicalizePlan(
      {
        cases: [],
        deferredCases: [...functionalKeys, ...uiKeys].map((key) => deferredCase(key)),
      },
      context,
    ),
  );
  assert.deepEqual(plan.cases, []);
  assert.deepEqual(plan.assignments, { ac: [], ui: [] });
  assert.equal(plan.deferredCases?.length, 10);
  assert.equal(planPayloadSchema.safeParse(plan).success, true);
});

test("style-only coverage is valid and a mixed plan assigns each executable kind exactly", () => {
  const design = { fileKey: "DiPISvcpFmaPsK9QonpeDf", nodeId: "1:81" };
  const style: PlanCheck = {
    id: "check-style",
    criterionId: "crit:UI-AC-1",
    kind: "style",
    design,
    property: "width",
    target: "Add to cart button",
    tolerance: { kind: "exact" },
  };
  const plan = accept(
    canonicalizePlan(
      {
        cases: [
          ...functionalKeys.map(functionalCase),
          {
            id: "case-style",
            title: "Button style",
            preconditions: [],
            actions: [{ kind: "navigate", path: "/" }],
            checks: [style],
          },
        ],
        deferredCases: ["UI-AC-2", "UI-AC-3"].map((key) => deferredCase(key)),
      },
      { ...context, design },
    ),
  );
  assert.deepEqual(plan.assignments.ui, ["check-style"]);
  assert.equal(plan.assignments.ac.length, 7);
  assert.deepEqual(
    plan.deferredCases?.flatMap((item) =>
      item.expectations.map((expectation) => expectation.criterionId),
    ),
    ["crit:UI-AC-2", "crit:UI-AC-3"],
  );
});

test("a style check without the requested design is still rejected and never covers a criterion", () => {
  const result = canonicalizePlan(
    {
      cases: [
        ...functionalKeys.map(functionalCase),
        {
          id: "case-style",
          title: "Button style",
          preconditions: [],
          actions: [{ kind: "navigate", path: "/" }],
          checks: [
            {
              id: "check-style",
              criterionId: "crit:UI-AC-1",
              kind: "style",
              design: { fileKey: "__blocked__", nodeId: "0:0" },
              property: "width",
              target: "Button",
              tolerance: { kind: "exact" },
            },
          ],
        },
      ],
      deferredCases: ["UI-AC-2", "UI-AC-3"].map((key) => deferredCase(key)),
    },
    context,
  );
  assert.equal(result.kind, "rejected");
  assert.deepEqual(result.kind === "rejected" ? result.issues : [], [
    "style check check-style does not reference the requested design",
    "criterion crit:UI-AC-1 has no executable check or deferred case",
  ]);
});

test("every criterion must be covered and rejections name the criterion", () => {
  const result = canonicalizePlan(
    { cases: functionalKeys.map(functionalCase), deferredCases: [deferredCase("UI-AC-1")] },
    context,
  );
  assert.deepEqual(result, {
    kind: "rejected",
    issues: [
      "criterion crit:UI-AC-2 has no executable check or deferred case",
      "criterion crit:UI-AC-3 has no executable check or deferred case",
    ],
  });
});

test("deferred cases reject unknown and duplicate identities", () => {
  const result = canonicalizePlan(
    {
      cases: functionalKeys.map(functionalCase),
      deferredCases: [
        ...uiKeys.map((key) => deferredCase(key)),
        deferredCase("AC-1", {
          expectations: [
            { criterionId: "crit:missing", expectedObservation: "Missing criterion outcome" },
          ],
          id: "deferred-missing",
        }),
        deferredCase("AC-1", { id: "case-AC-1" }),
        deferredCase("AC-1", { id: "deferred-AC-1" }),
        deferredCase("AC-1", { id: "deferred-AC-1" }),
      ],
    },
    context,
  );
  assert.deepEqual(result, {
    kind: "rejected",
    issues: [
      "deferred case deferred-missing references an unknown criterion",
      "duplicate case id case-AC-1",
      "duplicate case id deferred-AC-1",
    ],
  });
});

test("deferred cases count against the case and check bounds and cannot hide an empty plan", () => {
  const tight = canonicalizePlan(fetmProposal, {
    ...context,
    bounds: { maxCases: 9, maxChecks: 9, maxChecksPerCase: 12 },
  });
  assert.deepEqual(tight, {
    kind: "rejected",
    issues: ["plan exceeds the case bound", "plan exceeds the check bound"],
  });
  const empty = canonicalizePlan({ cases: [] }, context);
  assert.equal(empty.kind, "rejected");
});

test("schema failures report field paths", () => {
  const result = canonicalizePlan(
    {
      cases: [],
      deferredCases: [{ ...deferredCase("UI-AC-1"), steps: [], reason: "" }],
    },
    context,
  );
  assert.equal(result.kind, "rejected");
  const issues = result.kind === "rejected" ? result.issues : [];
  assert.ok(issues.some((issue) => issue.startsWith("deferredCases[0].steps")));
  assert.ok(issues.some((issue) => issue.startsWith("deferredCases[0].reason")));
});

const legacyProposal = {
  cases: [...functionalKeys, ...uiKeys].map(functionalCase),
};

function storedPlan(plan: CanonicalPlan) {
  return {
    kind: "plan",
    ref: "artifact-plan",
    digest: digestOf(plan),
    threadId: "thread-1",
    payload: plan,
    scopeDigest: planScopeDigest({
      goal: plan.goal,
      targetUrl: plan.targetUrl,
      design: plan.design,
      requirementsDigest: plan.requirementsDigest,
    }),
    dependencies: ["artifact-req"],
    origin: {
      runId: "run-1",
      threadId: "thread-1",
      role: "planner",
      issuedAt: "2026-10-13T00:00:00Z",
    },
  };
}

const reuseContext = (planContext: PlanContext, plan: CanonicalPlan) => ({
  requested: "plan" as const,
  threadId: "thread-1",
  expectedScopeDigest: planScopeDigest({
    goal: plan.goal,
    targetUrl: plan.targetUrl,
    design: plan.design,
    requirementsDigest: plan.requirementsDigest,
  }),
  planContext,
});

test("legacy plans without deferredCases keep their digest and reuse unchanged", () => {
  const legacy = accept(canonicalizePlan(legacyProposal, context));
  assert.equal("deferredCases" in legacy, false);
  const parsed = planPayloadSchema.parse(legacy);
  assert.equal("deferredCases" in parsed, false);
  assert.equal(digestOf(parsed), digestOf(legacy));
  const reused = accept(validateReuse(storedPlan(legacy), reuseContext(context, legacy)));
  assert.equal(reused.kind, "plan");
  assert.equal(digestOf(reused.payload), digestOf(legacy));
  assert.equal("deferredCases" in reused.payload, false);
});

test("plans with deferredCases round-trip through reuse and tampering is rejected", () => {
  const plan = accept(canonicalizePlan(fetmProposal, context));
  const reused = accept(validateReuse(storedPlan(plan), reuseContext(context, plan)));
  assert.equal(digestOf(reused.payload), digestOf(plan));
  assert.deepEqual((reused.payload as CanonicalPlan).deferredCases, plan.deferredCases);
  const tampered = {
    ...plan,
    deferredCases: plan.deferredCases?.map((item, index) =>
      index === 0
        ? {
            ...item,
            expectations: [{ criterionId: "crit:UI-AC-1", expectedObservation: "Different" }],
          }
        : item,
    ),
  };
  assert.deepEqual(
    validateReuse({ ...storedPlan(plan), payload: tampered }, reuseContext(context, plan)),
    { kind: "rejected", issues: ["invalid_evidence"] },
  );
  const stripped = { ...plan } as Record<string, unknown>;
  delete stripped.deferredCases;
  assert.equal(
    validateReuse(
      { ...storedPlan(plan), payload: stripped, digest: digestOf(stripped) },
      reuseContext(context, plan),
    ).kind,
    "rejected",
  );
});

test("deferred cases appear in coverage without becoming results, passes or assignments", () => {
  const allDeferred = [...functionalKeys, ...uiKeys].map((key) => deferredCase(key));
  const plan = accept(canonicalizePlan({ cases: [], deferredCases: allDeferred }, context));
  const report = deriveReport({
    runId: testRunIdSchema.parse("run-1"),
    rootOutcome: "completed",
    requirements,
    plan,
    acResults: null,
    uiResults: null,
    unresolvedSources: [],
    artifacts: [],
    progressVersion: 1,
    outcomes: {},
  });
  assert.deepEqual(
    report.coverage,
    [...functionalKeys, ...uiKeys].map((key) => ({
      criterionId: `crit:${key}`,
      caseId: `deferred-${key}`,
      checkId: null,
      state: "deferred",
    })),
  );
  assert.deepEqual(report.results, { ac: [], ui: [] });
  assert.deepEqual(report.plan?.deferredCases, allDeferred);
  assert.deepEqual(report.plan?.assignments, { ac: [], ui: [] });
  assert.deepEqual(report.acceptance, { verdict: "not_verified", reason: "release_not_assessed" });
  assert.deepEqual(report.roleOutcomes.ac, {
    status: "not_required",
    reason: "no_functional_checks",
  });
  assert.deepEqual(report.roleOutcomes.ui, { status: "not_required", reason: "no_style_checks" });
});

test("a mixed plan keeps unexecuted executable checks uncovered while deferred criteria are covered", () => {
  const plan = accept(canonicalizePlan(fetmProposal, context));
  const report = deriveReport({
    runId: testRunIdSchema.parse("run-1"),
    rootOutcome: "completed",
    requirements,
    plan,
    acResults: null,
    uiResults: null,
    unresolvedSources: [],
    artifacts: [],
    progressVersion: 1,
    outcomes: {},
  });
  assert.deepEqual(
    report.coverage.filter((row) => row.state === "deferred").map((row) => row.criterionId),
    uiKeys.map((key) => `crit:${key}`),
  );
  assert.equal(report.acceptance.verdict, "blocked");
});

test("empty assignments make both execution roles not required", () => {
  const card = projectProgress(3, {}, { assignments: { ac: [], ui: [] } });
  assert.deepEqual(card.rows.ac, { status: "not_required", reason: "no_functional_checks" });
  assert.deepEqual(card.rows.ui, { status: "not_required", reason: "no_style_checks" });
  assert.deepEqual(card.rows.planner, { status: "waiting", reason: "dispatch" });
});

test("public plan artifacts carry deferred cases only when the plan has them", () => {
  const withDeferred = accept(canonicalizePlan(fetmProposal, context));
  const without = accept(canonicalizePlan(legacyProposal, context));
  const publicWith = publicTaskArtifact({ ref: "a", kind: "plan", payload: withDeferred });
  const publicWithout = publicTaskArtifact({ ref: "b", kind: "plan", payload: without });
  assert.deepEqual(
    publicWith.kind === "plan" ? publicWith.payload.deferredCases : null,
    fetmProposal.deferredCases,
  );
  assert.equal(publicWithout.kind === "plan" && "deferredCases" in publicWithout.payload, false);
});

test("host-captured Figma links persist in the requirements artifact and its public view", () => {
  const links = [
    {
      url: "https://www.figma.com/design/DiPISvcpFmaPsK9QonpeDf?node-id=1-81",
      label: "商品頁 桌面",
      fileKey: "DiPISvcpFmaPsK9QonpeDf",
      nodeId: "1:81",
    },
    {
      url: "https://www.figma.com/design/DiPISvcpFmaPsK9QonpeDf?node-id=1-82",
      label: "購物車 桌面",
      fileKey: "DiPISvcpFmaPsK9QonpeDf",
      nodeId: "1:82",
    },
  ];
  const linked = fetmRequirements([{ ...capture, links }]);
  assert.deepEqual(linked.captures[0]?.links, links);
  assert.equal(sourceCaptureSchema.safeParse(linked.captures[0]).success, true);
  const view = publicTaskArtifact({ ref: "r", kind: "requirements", payload: linked });
  assert.deepEqual(
    view.kind === "requirements" ? view.payload.links : null,
    links.map((link) => ({ ...link, source })),
  );
  const plain = publicTaskArtifact({ ref: "r", kind: "requirements", payload: requirements });
  assert.equal(plain.kind === "requirements" && "links" in plain.payload, false);
  assert.equal("links" in (requirements.captures[0] ?? {}), false);
});

test("grouped expectations each consume the total and per-scenario check budgets", () => {
  const keys = [...functionalKeys, ...uiKeys];
  const scenarios = (count: number, perCase: number) =>
    Array.from({ length: Math.ceil(count / perCase) }, (_, index) => ({
      ...deferredCase("AC-1"),
      id: `group-${index}`,
      expectations: Array.from(
        { length: Math.min(perCase, count - index * perCase) },
        (_, offset) => ({
          criterionId: `crit:${keys[(index * perCase + offset) % keys.length]}`,
          expectedObservation: `Source-bound expected outcome ${index * perCase + offset}`,
        }),
      ),
    }));
  const atLimit = accept(
    canonicalizePlan({ cases: [], deferredCases: scenarios(80, 12) }, context),
  );
  assert.equal(atLimit.deferredCases?.length, 7);
  assert.equal(atLimit.deferredCases?.flatMap((item) => item.expectations).length, 80);
  assert.deepEqual(atLimit.assignments, { ac: [], ui: [] });
  assert.deepEqual(canonicalizePlan({ cases: [], deferredCases: scenarios(81, 12) }, context), {
    kind: "rejected",
    issues: ["plan exceeds the check bound"],
  });
  assert.deepEqual(canonicalizePlan({ cases: [], deferredCases: scenarios(13, 13) }, context), {
    kind: "rejected",
    issues: ["case group-0 exceeds the check bound"],
  });
});

test("every grouped expectation is validated and empty expectation lists are rejected", () => {
  const result = canonicalizePlan(
    {
      ...fetmProposal,
      deferredCases: fetmProposal.deferredCases.map((scenario, index) =>
        index === 0
          ? {
              ...scenario,
              expectations: [
                ...scenario.expectations,
                { criterionId: "crit:unknown", expectedObservation: "Unknown criterion outcome" },
              ],
            }
          : scenario,
      ),
    },
    context,
  );
  assert.deepEqual(result, {
    kind: "rejected",
    issues: ["deferred case deferred-UI-AC-1 references an unknown criterion"],
  });
  const empty = canonicalizePlan(
    { cases: [], deferredCases: [{ ...deferredCase("AC-1"), expectations: [] }] },
    context,
  );
  assert.equal(empty.kind, "rejected");
  assert.ok(
    empty.kind === "rejected" &&
      empty.issues.some((issue) => issue.startsWith("deferredCases[0].expectations")),
  );
});

test("public issues are bounded, trimmed and deduplicated", () => {
  const long = `criterion ${"x".repeat(600)}`;
  const issues = publicIssues([
    "  first issue  ",
    "first issue",
    "",
    long,
    ...Array.from({ length: 20 }, (_, index) => `issue ${index}`),
  ]);
  assert.equal(issues.length, 8);
  assert.equal(issues[0], "first issue");
  assert.ok(issues.every((issue) => issue.length <= 240 && issue.trim() === issue));
});
