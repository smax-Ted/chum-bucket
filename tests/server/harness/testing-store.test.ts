import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  artifactRefSchema,
  delegationInputSchema,
  type TestingRequestInput,
} from "../../../shared/testing";
import {
  canonicalizePlan,
  digestOf,
  planScopeDigest,
  requirementsScopeDigest,
  validateRequirements,
} from "../../../server/harness/testing-domain";
import { roleRegistry } from "../../../server/harness/agents";
import {
  closureDecisions,
  admitAttachedInTransaction,
  TestingPersistenceError,
  hostTestingRuntime,
  missingSourceCaptures,
  resultTaskContext,
  testingFinishOutcome,
  type StoredArtifactRow,
} from "../../../server/harness/testing-store";

const host = hostTestingRuntime({ model: "owner-model", build: "owner-build" });

function row(
  overrides: Partial<StoredArtifactRow> & Pick<StoredArtifactRow, "ref" | "kind">,
): StoredArtifactRow {
  return {
    threadId: "thread-1",
    scopeDigest: "scope",
    payloadDigest: "digest",
    payload: { goal: "Verify checkout" },
    metadata: {},
    dependencies: [],
    origin: {
      runId: "run-1",
      threadId: "thread-1",
      role: overrides.kind === "plan" ? "planner" : "atlassian",
      issuedAt: "2026-10-09T00:00:00.000Z",
    },
    ...overrides,
  };
}

test("invalid planner delegation names the forbidden goal field without exposing input values", async () => {
  const input = {
    role: "planner",
    summary: "Build a full test plan for FETM-78 from the requirements artifact",
    requirementsRef: "art-8bd6426dfb3ed14f0bb827670fa94c42d5f217ca",
    goal: "Create a comprehensive test plan for Jira issue FETM-78 from the captured requirements",
  };
  const tx = null as unknown as Parameters<typeof admitAttachedInTransaction>[0];
  await assert.rejects(
    admitAttachedInTransaction(
      tx,
      "run-parent",
      "thread-1",
      "chatcmpl-tool-b46dde7e21fe0c87",
      input,
      host,
    ),
    (error: unknown) => {
      assert.ok(error instanceof TestingPersistenceError);
      assert.equal(error.status, 400);
      assert.match(error.message, /Invalid testing intent/);
      assert.match(error.message, /goal/);
      assert.match(error.message, /Unrecognized|not allowed/);
      assert.doesNotMatch(error.message, /Create a comprehensive|Build a full|art-8bd6426/);
      return true;
    },
  );
  const { goal: _goal, ...corrected } = input;
  assert.deepEqual(delegationInputSchema.parse(corrected), corrected);
});

test("malformed delegation diagnostics are bounded and never echo secret values", async () => {
  const secret = "secret-provider-token-source-content";
  const tx = null as unknown as Parameters<typeof admitAttachedInTransaction>[0];
  for (const input of [
    null,
    { role: secret },
    { role: "planner", summary: 42, requirementsRef: {}, goal: secret },
    { role: "ac", summary: "Check", planRef: "plan-1", targetUrl: secret },
  ]) {
    await assert.rejects(
      admitAttachedInTransaction(tx, "run-parent", "thread-1", "call-1", input, host),
      (error: unknown) => {
        assert.ok(error instanceof TestingPersistenceError);
        assert.match(error.message, /Invalid testing intent/);
        assert.ok(error.message.length <= 2048);
        assert.ok(!error.message.includes(secret));
        return true;
      },
    );
  }
  await assert.rejects(
    admitAttachedInTransaction(
      tx,
      "run-parent",
      "thread-1",
      "invalid call key",
      { role: "planner", summary: "Plan", requirementsRef: "requirements-1" },
      host,
    ),
    { message: "Invalid testing intent" },
  );
});

test("owner snapshot versions are passed in and are not a second model constant", () => {
  assert.equal(host.model, "owner-model");
  assert.equal(host.build, "owner-build");
  assert.equal(host.versions.model, "owner-model");
  assert.equal(host.versions.build, "owner-build");
  assert.equal(host.profiles.atlassian, roleRegistry.atlassian.profile);
  assert.equal(host.registration.atlassian.includes(roleRegistry.atlassian.profile), true);
  assert.notEqual(host.registration.atlassian, host.profiles.atlassian);
  assert.deepEqual(host.registration, {
    atlassian: "requirements:requirements-v3:enabled:atlassian_read",
    planner: "plan:planning-v2:enabled:none",
    ac: "ac-result:functional-v2:enabled:browser_ac",
    ui: "ui-result:style-v2:enabled:browser_ui+figma_read",
  });
});

test("explicit bad refs and cross-run results reject without dropping any ref", () => {
  const intent = {
    goal: "Verify checkout",
    sources: [{ kind: "jira" as const, issueKey: "CHUM-42" }],
    targetUrl: "https://preview.example.test/checkout",
  };
  const missing = artifactRefSchema.parse("missing-artifact");
  const result = artifactRefSchema.parse("ac-artifact");
  const decisions = closureDecisions({
    threadId: "thread-1",
    intent,
    refs: [missing, result],
    rows: new Map([
      [
        result,
        row({
          ref: result,
          kind: "ac-result",
          origin: {
            runId: "run-1",
            threadId: "thread-1",
            role: "ac",
            issuedAt: "2026-10-09T00:00:00.000Z",
          },
        }),
      ],
    ]),
    host,
  });
  assert.deepEqual(
    decisions.map((decision) => ({
      ref: decision.ref,
      kind: decision.kind,
      reason: decision.kind === "rejected" ? decision.reason : null,
    })),
    [
      { ref: missing, kind: "rejected", reason: "not_accessible" },
      { ref: result, kind: "rejected", reason: "cross_run_result_forbidden" },
    ],
  );
});

test("planner accepts grounded unresolved requirements with false completeness while retaining snapshot guards", () => {
  const source = { kind: "jira" as const, issueKey: "CHUM-42" };
  const intent: TestingRequestInput = {
    goal: "Verify checkout",
    sources: [source],
    targetUrl: null,
    task: {
      version: 2,
      input: {
        role: "planner",
        summary: "Plan functional checks",
        requirementsRef: artifactRefSchema.parse("requirements-profile-artifact"),
      },
    },
  };
  const requirements = validateRequirements(
    {
      criteria: [{ key: "AC-1", statement: "Receipt appears", source, anchor: "AC-1" }],
      unresolved: ["Price rule is not specified", "Execution URL is not supplied"],
    },
    {
      goal: intent.goal,
      captures: [
        {
          reference: source,
          digest: "source",
          anchors: ["AC-1"],
          capturedAt: "2026-10-10T00:00:00Z",
        },
      ],
    },
  );
  assert.equal(requirements.kind, "accepted");

  if (requirements.kind !== "accepted") {
    return;
  }

  const ref = artifactRefSchema.parse("requirements-profile-artifact");
  const metadata = {
    dependencies: [],
    versions: host.versions,
    profiles: host.profiles,
    registration: host.registration,
    bounds: host.bounds,
    fixture: host.fixture,
    parentRunId: "run-1",
    producerTaskId: "task-1",
    attempt: 1,
    inputDigest: "input",
    outputDigest: digestOf(requirements.value),
    complete: false,
  };
  const artifact = row({
    ref,
    kind: "requirements",
    payload: requirements.value,
    payloadDigest: digestOf(requirements.value),
    metadata,
    scopeDigest: requirementsScopeDigest({ goal: intent.goal, sources: intent.sources }),
  });
  const decide = (value: StoredArtifactRow) =>
    closureDecisions({
      threadId: "thread-1",
      intent,
      refs: [ref],
      rows: new Map([[ref, value]]),
      host,
    });
  assert.equal(decide(artifact)[0]?.kind, "accepted");
  assert.deepEqual(
    closureDecisions({
      threadId: "thread-1",
      intent: { ...intent, task: undefined },
      refs: [ref],
      rows: new Map([[ref, artifact]]),
      host,
    }),
    [{ ref, kind: "rejected", reason: "incomplete" }],
  );
  const rejections: [StoredArtifactRow, string][] = [
    [{ ...artifact, threadId: "foreign-thread" }, "not_accessible"],
    [{ ...artifact, origin: { ...artifact.origin, role: "planner" } }, "untrusted_producer"],
    [{ ...artifact, payloadDigest: "tampered" }, "invalid_evidence"],
    [{ ...artifact, scopeDigest: "tampered" }, "scope_mismatch"],
    [
      {
        ...artifact,
        payload: { ...requirements.value, captures: [] },
        payloadDigest: digestOf({ ...requirements.value, captures: [] }),
      },
      "incomplete",
    ],
    [
      { ...artifact, dependencies: [artifactRefSchema.parse("missing-dependency")] },
      "dependency_rejected",
    ],
  ];
  for (const [candidate, reason] of rejections) {
    assert.deepEqual(decide(candidate), [{ ref, kind: "rejected", reason }]);
  }
  assert.deepEqual(
    decide({
      ...artifact,
      metadata: { ...metadata, profiles: { ...metadata.profiles, atlassian: "requirements-v1" } },
    }),
    [{ ref, kind: "rejected", reason: "incompatible_snapshot" }],
  );
});

test("source capture coverage is the requested source set", () => {
  const requested = [{ kind: "jira" as const, issueKey: "CHUM-42" }];
  assert.deepEqual(
    missingSourceCaptures(requested, [
      {
        reference: { kind: "confluence", pageId: "99" },
        digest: "other",
        anchors: ["AC-1"],
        capturedAt: "2026-10-09T00:00:00.000Z",
      },
    ]),
    requested,
  );
  assert.deepEqual(
    missingSourceCaptures(requested, [
      {
        reference: { kind: "jira", issueKey: "CHUM-42" },
        digest: "capture",
        anchors: ["AC-1"],
        capturedAt: "2026-10-09T00:00:00.000Z",
      },
    ]),
    [],
  );
});

test("parent finish maps testing outcome without treating success as completed", () => {
  assert.equal(testingFinishOutcome("execution_failed", false), "failed");
  assert.equal(testingFinishOutcome("workflow_cancelled", true), "cancelled");
  assert.equal(testingFinishOutcome("provider_timed_out", false), "timed_out");
  assert.equal(testingFinishOutcome("ok", true), "missing");
});

test("supervised testing migration has no SQL comments", async () => {
  const sql = await readFile(
    new URL("../../../drizzle/0003_supervised_testing.sql", import.meta.url),
    "utf8",
  );
  const stripped = sql.replaceAll("--> statement-breakpoint", "");
  assert.equal(stripped.includes("--"), false);
  assert.equal(stripped.includes("/*"), false);
  assert.equal(sql.includes("testing_operations"), true);
  assert.equal(sql.includes("testing_publications"), true);
});

test("host runtime rejects an empty owner snapshot", () => {
  assert.throws(() => hostTestingRuntime({ model: " ", build: "owner-build" }), /host snapshot/);
});

test("a plan bound to no target stays reusable for an explicit execution URL", () => {
  const source = { kind: "jira" as const, issueKey: "CHUM-42" };
  const goal = "Verify checkout";
  const requirements = validateRequirements(
    {
      criteria: [{ key: "AC-1", statement: "Receipt appears", source, anchor: "AC-1" }],
      unresolved: [],
    },
    {
      goal,
      captures: [
        {
          reference: source,
          digest: "source",
          anchors: ["AC-1"],
          capturedAt: "2026-10-10T00:00:00Z",
        },
      ],
    },
  );
  assert.equal(requirements.kind, "accepted");

  if (requirements.kind !== "accepted") {
    return;
  }

  const requirementsRef = artifactRefSchema.parse("requirements-artifact");
  const planRef = artifactRefSchema.parse("plan-artifact");
  const requirementsDigest = digestOf(requirements.value);
  const plan = canonicalizePlan(
    {
      cases: [],
      deferredCases: [
        {
          id: "deferred-1",
          title: "Receipt copy",
          steps: ["Open the receipt"],
          expectations: [{ criterionId: "crit:AC-1", expectedObservation: "Receipt appears" }],
          reason: "Receipt setup is unavailable",
        },
      ],
    },
    {
      requirements: requirements.value,
      requirementsDigest,
      goal,
      targetUrl: null,
      design: null,
      bounds: host.bounds,
    },
  );
  assert.equal(plan.kind, "accepted");

  if (plan.kind !== "accepted") {
    return;
  }

  const metadata = (payloadDigest: string, dependencies: string[]) => ({
    dependencies,
    versions: host.versions,
    profiles: host.profiles,
    registration: host.registration,
    bounds: host.bounds,
    fixture: host.fixture,
    parentRunId: "run-1",
    producerTaskId: "task-1",
    attempt: 1,
    inputDigest: "input",
    outputDigest: payloadDigest,
    complete: true,
  });
  const requirementsRow = row({
    ref: requirementsRef,
    kind: "requirements",
    payload: requirements.value,
    payloadDigest: requirementsDigest,
    metadata: metadata(requirementsDigest, []),
    scopeDigest: requirementsScopeDigest({ goal, sources: [source] }),
  });
  const planRow = (targetUrl: string | null) => {
    const payload = { ...plan.value, targetUrl };

    return row({
      ref: planRef,
      kind: "plan",
      payload,
      payloadDigest: digestOf(payload),
      metadata: metadata(digestOf(payload), [requirementsRef]),
      scopeDigest: planScopeDigest({
        goal,
        targetUrl,
        design: null,
        requirementsDigest,
      }),
      dependencies: [requirementsRef],
    });
  };
  const decide = (stored: StoredArtifactRow, targetUrl: string | null) =>
    closureDecisions({
      threadId: "thread-1",
      intent: {
        goal,
        sources: [source],
        targetUrl,
        task: {
          version: 2,
          input: {
            role: "ac",
            summary: "Run checks",
            planRef,
            targetUrl: "https://preview.example.test/",
          },
        },
      },
      refs: [planRef],
      rows: new Map<string, StoredArtifactRow>([
        [requirementsRef, requirementsRow],
        [planRef, stored],
      ]),
      host,
    });
  assert.equal(decide(planRow(null), "https://preview.example.test/")[0]?.kind, "accepted");
});

test("execution binds an unbound plan to the explicit URL and rejects any other URL for a bound plan", () => {
  const base = {
    requirementsDigest: "digest",
    goal: "Verify checkout",
    design: null,
    cases: [],
    bounds: host.bounds,
  };
  const input = {
    role: "ac" as const,
    summary: "Run checks",
    planRef: artifactRefSchema.parse("plan-artifact"),
    targetUrl: "https://preview.example.test/",
  };
  const unbound = { ...base, targetUrl: null, assignments: { ac: ["check-1"], ui: [] } };
  assert.deepEqual(resultTaskContext(unbound, input), {
    targetUrl: "https://preview.example.test/",
    design: undefined,
  });
  const bound = { ...unbound, targetUrl: "https://preview.example.test/" };
  assert.equal(resultTaskContext(bound, input).targetUrl, "https://preview.example.test/");
  assert.throws(
    () => resultTaskContext({ ...unbound, targetUrl: "https://other.example.test/" }, input),
    { message: "Plan target URL is incompatible" },
  );
  assert.throws(() => resultTaskContext({ ...unbound, assignments: { ac: [], ui: [] } }, input), {
    message: /no automated checks for the delegated role/,
  });
});
