import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type ElementHandle,
  type Page,
} from "playwright";
import {
  MAX_CASE_HANDOFFS,
  type BrowserSelection,
  type FunctionalCheck,
  type HandoffDecision,
  type HandoffResolution,
  type HandoffSnapshot,
  type HandoffTarget,
  type PlanCase,
  type PlanCheck,
  type PublicEvidence,
  type StyleCheck,
} from "../../shared/testing";
import { JevError, selectCandidate } from "./jev-client";
import type { BrowserAdapter, BrowserOutcome, BrowserRunOutcome } from "./tools/use-browser";

const LIVE_BROWSER = {
  identity: { id: "playwright-chromium", version: "v1" },
  adapterVersion: "playwright-jev-v1",
} as const;
const ACTIVE_CASE_MS = 90_000;
const PAUSED_CASE_MS = 180_000;
const REPLAY_FORBIDDEN = "Prior browser execution may have produced effects; replay is forbidden";
type BrowserDetails = NonNullable<PublicEvidence["browser"]>;
type Screenshot = NonNullable<BrowserDetails["screenshot"]>;
type Observation = BrowserOutcome & { browser?: BrowserDetails };
type Operation = HandoffTarget["operation"];
type JevSelection = Awaited<ReturnType<typeof selectCandidate>>;
class BrowserBlocked extends Error {}

class CaseEnded extends Error {
  constructor(
    readonly code: string,
    readonly detail: Readonly<Record<string, unknown>>,
  ) {
    super(code);
  }
}

function failureReason(stage: string, error: unknown, signal: AbortSignal): string {
  const code = signal.aborted
    ? "cancelled_or_timed_out"
    : error instanceof JevError || error instanceof CaseEnded
      ? error.code
      : error instanceof BrowserBlocked
        ? error.message
        : "browser_or_storage_error";

  return JSON.stringify({
    stage,
    code,
    replay: "forbidden",
    ...(error instanceof JevError && error.diagnostics ? { diagnostics: error.diagnostics } : {}),
    ...(error instanceof CaseEnded ? error.detail : {}),
  });
}

const styleProperties: Record<string, string> = {
  color: "color",
  backgroundColor: "backgroundColor",
  fontSize: "fontSize",
  fontWeight: "fontWeight",
  opacity: "opacity",
  cornerRadius: "borderRadius",
  borderRadius: "borderRadius",
  letterSpacing: "letterSpacing",
  lineHeight: "lineHeight",
};

function permittedUrl(url: URL, target: URL): boolean {
  return (
    ["http:", "https:"].includes(url.protocol) &&
    url.origin === target.origin &&
    !url.username &&
    !url.password
  );
}

function allowedUrl(raw: string, target: URL): string {
  const url = new URL(raw, target);

  if (!permittedUrl(url, target)) {
    throw new Error(
      "Navigation outside the authorized origin or containing URL credentials is blocked",
    );
  }

  return url.href;
}

function originPath(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

async function fingerprint(element: ElementHandle<Element>): Promise<string> {
  return element.evaluate(
    (node, visible) =>
      JSON.stringify({
        visible,
        tag: node.tagName,
        id: node.id,
        role: node.getAttribute("role"),
        markers: node
          .getAttributeNames()
          .filter((name) => name.startsWith("data-"))
          .slice(0, 10),
        children: node.childElementCount,
        text: (node instanceof HTMLElement ? node.innerText : node.textContent)
          ?.trim()
          .slice(0, 240),
        label: node.getAttribute("aria-label"),
        type: node.getAttribute("type"),
        context: node.parentElement?.innerText?.trim().slice(0, 300),
        connected: node.isConnected,
      }),
    await element.isVisible(),
  );
}

type TargetCandidate = Readonly<{
  id: string;
  description: string;
  element: ElementHandle<Element>;
}>;

async function targetCandidates(
  page: Page,
  operation: Operation,
): Promise<readonly TargetCandidate[]> {
  const selector =
    operation === "fill"
      ? "input:not([type=password]):not([type=hidden]),textarea"
      : operation === "click"
        ? "button,a,[role=button],input[type=submit]"
        : "h1,h2,h3,p,span,button,a,input:not([type=password]):not([type=hidden]),textarea,label,[role],strong,small,output,dd,dt,div";
  const all = await page.$$(selector);
  const candidates: TargetCandidate[] = [];

  for (const element of all) {
    const layoutContainer = await element.evaluate(
      (node) =>
        node.tagName === "DIV" &&
        node.childElementCount > 0 &&
        !node.hasAttribute("role") &&
        !node.hasAttribute("aria-label"),
    );

    if (!layoutContainer && (operation === "visible" || (await element.isVisible()))) {
      candidates.push({
        id: `c${candidates.length}`,
        description: await fingerprint(element),
        element,
      });

      if (candidates.length > 80) {
        throw new BrowserBlocked("DOM candidate limit exceeded; narrow the page");
      }
    }
  }

  return candidates;
}

type LinkCandidate = Readonly<{
  id: string;
  description: string;
  url: string;
  href: string;
  fingerprint: string;
  element: ElementHandle<Element>;
}>;

function linkFacts(element: ElementHandle<Element>) {
  return element.evaluate((node) => ({
    anchor: node.tagName === "A",
    href: (node as HTMLAnchorElement).href,
    download: node.hasAttribute("download"),
    label: (
      (node as HTMLElement).innerText.trim() ||
      node.getAttribute("aria-label")?.trim() ||
      ""
    ).slice(0, 512),
  }));
}

async function linkCandidates(
  page: Page,
  target: URL,
): Promise<Readonly<{ links: readonly LinkCandidate[]; truncated: boolean }>> {
  const links: LinkCandidate[] = [];
  const seen = new Set<string>();

  for (const element of await page.$$("a[href],area[href]")) {
    const facts = await linkFacts(element);
    const url = URL.parse(facts.href);

    if (!url || !permittedUrl(url, target) || facts.download || seen.has(url.href)) {
      continue;
    }

    if (facts.anchor && !(await element.isVisible())) {
      continue;
    }

    if (links.length === 80) {
      return { links, truncated: true };
    }

    seen.add(url.href);
    links.push({
      id: `l${links.length}`,
      description: facts.label,
      url: originPath(url),
      href: url.href,
      fingerprint: await fingerprint(element),
      element,
    });
  }

  return { links, truncated: false };
}

const supportedStyleProperties = new Set(["width", "height", ...Object.keys(styleProperties)]);

function normalizeColor(value: string): string {
  const match = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(value);

  return match
    ? `#${match
        .slice(1)
        .map((part) => Number(part).toString(16).padStart(2, "0"))
        .join("")}`
    : value;
}

function observedUrl(page: Page): string {
  return originPath(new URL(page.url()));
}

async function ensureFontsReady(page: Page): Promise<void> {
  const ready = await page.evaluate(async () =>
    Promise.race([
      document.fonts.ready.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]),
  );

  if (!ready) {
    throw new BrowserBlocked("font_readiness_timeout");
  }
}

type Recorded = Readonly<{ outcome: BrowserOutcome; segment: number }>;

type CaseProgress = {
  stage: string;
  segment: number;
  navigationDenied: boolean;
  readonly selections: BrowserSelection[];
  readonly records: Map<string, Recorded>;
  readonly screenshots: Map<number, Screenshot>;
};

type Chosen = Readonly<{
  kind: "choose";
  handoffId: string;
  candidateId: string;
  candidate: TargetCandidate;
}>;

type Followed = Readonly<{
  kind: "navigate";
  handoffId: string;
  linkId: string;
  link: LinkCandidate;
}>;

type Handoff = (
  run: CaseRun,
  target: HandoffTarget,
  candidates: readonly TargetCandidate[],
  error: JevError,
) => Promise<Chosen | Followed>;

type CaseEnv = Readonly<{
  targetUrl: string;
  planCase: PlanCase;
  checks: readonly PlanCheck[];
  signal: AbortSignal;
  artifactDirectory?: string;
  launch: () => Promise<Browser>;
  handoff: Handoff;
}>;

type CaseRun = Readonly<{ env: CaseEnv; page: Page; target: URL; progress: CaseProgress }>;

async function jevSelection(
  intent: string,
  candidates: readonly TargetCandidate[],
  signal: AbortSignal,
): Promise<JevSelection | JevError> {
  try {
    return await selectCandidate(
      intent,
      candidates.map(({ id, description }) => ({ id, description })),
      signal,
    );
  } catch (error) {
    if (error instanceof JevError && error.code === "uncertain_or_invalid_selection") {
      return error;
    }

    throw error;
  }
}

async function acceptedTarget(
  run: CaseRun,
  candidates: readonly TargetCandidate[],
  selection: JevSelection,
): Promise<ElementHandle<Element>> {
  run.progress.selections.push(selection);
  run.env.signal.throwIfAborted();
  const candidate = candidates.find((item) => item.id === selection.choice)!;

  if ((await fingerprint(candidate.element)) !== candidate.description) {
    throw new BrowserBlocked("DOM target changed during selection");
  }

  return candidate.element;
}

async function chosenTarget(
  run: CaseRun,
  target: HandoffTarget,
  chosen: Chosen,
): Promise<ElementHandle<Element>> {
  const { candidate } = chosen;

  if ((await fingerprint(candidate.element).catch(() => null)) !== candidate.description) {
    throw new CaseEnded("handoff_target_changed", { handoffId: chosen.handoffId });
  }

  run.progress.selections.push({
    source: "agent_choose",
    handoffId: chosen.handoffId,
    candidateId: chosen.candidateId,
    fingerprintDigest: createHash("sha256").update(candidate.description).digest("hex"),
    target,
  });

  return candidate.element;
}

async function freezeAnimations(page: Page): Promise<void> {
  await page.addStyleTag({
    content:
      "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}",
  });
}

async function settlePage({ page, target, progress }: CaseRun): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  allowedUrl(page.url(), target);

  if (progress.navigationDenied) {
    throw new BrowserBlocked("navigation_denied");
  }
}

async function closeSegment(run: CaseRun, handoffId: string): Promise<void> {
  const { progress } = run;

  if (![...progress.records.values()].some((item) => item.segment === progress.segment)) {
    return;
  }

  const screenshot = await captureScreenshot(run.page, run.env.artifactDirectory).catch(() => {
    throw new CaseEnded("segment_screenshot_failed", { handoffId });
  });
  progress.screenshots.set(progress.segment, screenshot);
  progress.segment += 1;
}

async function followLink(run: CaseRun, { handoffId, linkId, link }: Followed): Promise<void> {
  const { page, target, progress } = run;
  const [currentFingerprint, currentFacts] = await Promise.all([
    fingerprint(link.element),
    linkFacts(link.element),
  ]).catch(() => []);

  if (currentFingerprint !== link.fingerprint || currentFacts?.href !== link.href) {
    throw new CaseEnded("handoff_target_changed", { handoffId });
  }

  await closeSegment(run, handoffId);
  const from = observedUrl(page);

  try {
    await page.goto(allowedUrl(link.href, target), { waitUntil: "domcontentloaded" });
    await settlePage(run);
  } catch {
    throw new CaseEnded("handoff_navigation_failed", { handoffId });
  }

  if (progress.stage === "observation") {
    await freezeAnimations(page);
  }

  progress.selections.push({
    source: "agent_navigate",
    handoffId,
    linkId,
    from,
    to: observedUrl(page),
  });
}

async function selectTarget(run: CaseRun, target: HandoffTarget): Promise<ElementHandle<Element>> {
  for (;;) {
    const candidates = await targetCandidates(run.page, target.operation);
    const selection = await jevSelection(target.intent, candidates, run.env.signal);

    if (!(selection instanceof JevError)) {
      return acceptedTarget(run, candidates, selection);
    }

    const resolved = await run.env.handoff(run, target, candidates, selection);

    if (resolved.kind === "choose") {
      return chosenTarget(run, target, resolved);
    }

    await followLink(run, resolved);
  }
}

async function functionalObservation(run: CaseRun, check: FunctionalCheck): Promise<string> {
  const observation = check.observation;

  if (!observation) {
    throw new BrowserBlocked("Legacy check has no executable observation");
  }

  if (observation.kind === "url") {
    return observedUrl(run.page);
  }

  const element = await selectTarget(run, {
    intent: observation.target,
    operation: observation.kind === "visible" ? "visible" : "observe",
    at: { kind: "check", checkId: check.id },
  });

  if (observation.kind === "visible") {
    return String(await element.isVisible());
  }

  if (observation.kind === "value") {
    return element.inputValue();
  }

  return (await element.innerText()).trim();
}

async function styleObservation(run: CaseRun, check: StyleCheck): Promise<string> {
  if (!check.target) {
    throw new BrowserBlocked("Legacy style check has no executable target");
  }

  if (!supportedStyleProperties.has(check.property)) {
    throw new BrowserBlocked("Unsupported deterministic style property");
  }

  await ensureFontsReady(run.page);
  const element = await selectTarget(run, {
    intent: check.target,
    operation: "observe",
    at: { kind: "check", checkId: check.id },
  });
  const box = await stableBox(run.page, element, run.env.signal);

  if (check.property === "width" || check.property === "height") {
    return `${box[check.property]}px`;
  }

  const value = await element.evaluate(
    (node, property) => String(Reflect.get(getComputedStyle(node), property)),
    styleProperties[check.property]!,
  );

  return normalizeColor(value);
}

async function observeCheck(run: CaseRun, check: PlanCheck): Promise<string> {
  return check.kind === "functional"
    ? functionalObservation(run, check)
    : styleObservation(run, check);
}

async function stableBox(page: Page, element: ElementHandle<Element>, signal: AbortSignal) {
  let previous = await element.boundingBox();
  let stableSamples = 0;

  for (let sample = 0; sample < 8; sample++) {
    signal.throwIfAborted();
    await page.waitForTimeout(100);
    const current = await element.boundingBox();

    if (!current || !previous) {
      throw new BrowserBlocked("target_has_no_border_box");
    }

    const stable = (["x", "y", "width", "height"] as const).every(
      (key) => Math.abs(current[key] - previous![key]) < 0.1,
    );
    stableSamples = stable ? stableSamples + 1 : 0;

    if (stableSamples >= 2) {
      return current;
    }

    previous = current;
  }

  throw new BrowserBlocked("layout_readiness_timeout");
}

async function guardContext(
  context: BrowserContext,
  target: URL,
  denyNavigation: () => void,
): Promise<void> {
  await context.routeWebSocket("**/*", (socket) => socket.close());
  await context.route("**/*", async (route) => {
    try {
      allowedUrl(route.request().url(), target);
      await route.continue();
    } catch {
      if (route.request().isNavigationRequest()) {
        denyNavigation();
      }

      await route.abort();
    }
  });
}

async function applyAction(
  run: CaseRun,
  action: PlanCase["actions"][number],
  index: number,
): Promise<void> {
  const { page, target } = run;

  if (action.kind === "navigate") {
    await page.goto(allowedUrl(action.path, target), { waitUntil: "domcontentloaded" });

    return;
  }

  const element = await selectTarget(run, {
    intent: action.target,
    operation: action.kind,
    at: { kind: "action", index },
  });

  if (action.kind === "fill") {
    await element.fill(action.value, { timeout: 5_000 });

    return;
  }

  const href = await element.getAttribute("href");

  if (href) {
    allowedUrl(href, new URL(page.url()));
  }

  await element.click({ timeout: 5_000 });
}

function record(progress: CaseProgress, checkId: string, outcome: BrowserOutcome): void {
  progress.records.set(checkId, { outcome, segment: progress.segment });
}

async function observeChecks(run: CaseRun): Promise<void> {
  const { env, progress } = run;

  for (const [index, check] of env.checks.entries()) {
    try {
      env.signal.throwIfAborted();
      record(progress, check.id, { state: "observed", observed: await observeCheck(run, check) });
    } catch (error) {
      const reason = failureReason("observation", error, env.signal);
      const terminal = error instanceof CaseEnded || env.signal.aborted;

      if (!terminal) {
        record(progress, check.id, { state: "blocked", reason });
        continue;
      }

      for (const rest of env.checks.slice(index)) {
        record(progress, rest.id, { state: "blocked", reason });
      }

      return;
    }
  }
}

function outcomes(checks: readonly PlanCheck[], progress: CaseProgress): Map<string, Observation> {
  const selections = [...progress.selections];

  return new Map(
    checks.map((check): [string, Observation] => {
      const recorded = progress.records.get(check.id)!;
      const screenshot = progress.screenshots.get(recorded.segment);

      return [
        check.id,
        { ...recorded.outcome, browser: { selections, ...(screenshot ? { screenshot } : {}) } },
      ];
    }),
  );
}

async function captureScreenshot(page: Page, artifactDirectory?: string) {
  const directory = artifactDirectory ?? join(process.cwd(), ".data", "browser-evidence");
  await mkdir(directory, { recursive: true });
  const filename = `${randomUUID()}.png`;
  const screenshot = await page.screenshot({ animations: "disabled" });
  await writeFile(join(directory, filename), screenshot);

  return { path: filename, digest: createHash("sha256").update(screenshot).digest("hex") };
}

type Lease = {
  browser?: Browser;
  context?: BrowserContext;
  closing?: Promise<void>;
};

function prepareCase(targetUrl: string, planCase: PlanCase): URL {
  const target = new URL(targetUrl);
  allowedUrl(targetUrl, target);

  if (!process.env.JEV_API_KEY) {
    throw new BrowserBlocked("JEV_API_KEY is required");
  }

  if (planCase.actions.length > 20) {
    throw new BrowserBlocked("Case exceeds the 20-action limit");
  }

  if (planCase.preconditions.length) {
    throw new BrowserBlocked(
      "External preconditions cannot be verified; encode setup as actions and use preconditions []",
    );
  }

  return target;
}

function launchChromium(): Promise<Browser> {
  // toogle demo or not
  // return chromium.launch({ headless: false, slowMo: 500, timeout: 15_000 });
  return chromium.launch({ headless: true, timeout: 15_000 });
}

async function openCasePage(
  launch: () => Promise<Browser>,
  target: URL,
  lease: Lease,
  signal: AbortSignal,
  denyNavigation: () => void,
): Promise<Page> {
  lease.browser = await launch();
  signal.throwIfAborted();
  lease.context = await lease.browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
    reducedMotion: "reduce",
    acceptDownloads: false,
  });
  signal.throwIfAborted();
  await guardContext(lease.context, target, denyNavigation);
  const page = await lease.context.newPage();
  page.setDefaultTimeout(5_000);
  page.setDefaultNavigationTimeout(10_000);
  lease.context.on("page", (popup) => {
    if (popup !== page) {
      void popup.close();
    }
  });

  return page;
}

async function executeCase(env: CaseEnv): Promise<Map<string, Observation>> {
  const lease: Lease = {};
  const progress: CaseProgress = {
    stage: "scope",
    segment: 0,
    navigationDenied: false,
    selections: [],
    records: new Map(),
    screenshots: new Map(),
  };

  const close = () => {
    lease.closing ??= (async () => {
      await lease.context?.close().catch(() => undefined);
      await lease.browser?.close().catch(() => undefined);
    })();

    return lease.closing;
  };

  const abort = () => {
    void close();
  };

  env.signal.addEventListener("abort", abort, { once: true });

  try {
    env.signal.throwIfAborted();
    const target = prepareCase(env.targetUrl, env.planCase);
    progress.stage = "launch";
    const page = await openCasePage(env.launch, target, lease, env.signal, () => {
      progress.navigationDenied = true;
    });
    const run: CaseRun = { env, page, target, progress };
    progress.stage = "initial_navigation";
    await page.goto(target.href, { waitUntil: "domcontentloaded" });

    for (const [index, action] of env.planCase.actions.entries()) {
      progress.stage = `action_${index}_${action.kind}`;
      env.signal.throwIfAborted();
      allowedUrl(page.url(), target);
      await applyAction(run, action, index);
      await settlePage(run);
    }

    await freezeAnimations(page);
    progress.stage = "observation";
    await observeChecks(run);

    if (!env.signal.aborted) {
      progress.stage = "screenshot";
      progress.screenshots.set(
        progress.segment,
        await captureScreenshot(page, env.artifactDirectory),
      );
    }

    return outcomes(env.checks, progress);
  } catch (error) {
    const reason = failureReason(
      progress.stage,
      progress.navigationDenied ? new BrowserBlocked("navigation_denied") : error,
      env.signal,
    );
    const browser = { selections: [...progress.selections] };

    return new Map(
      env.checks.map((check): [string, Observation] => [
        check.id,
        { state: "blocked", reason, browser },
      ]),
    );
  } finally {
    env.signal.removeEventListener("abort", abort);
    await lease.closing;
    await lease.context?.close().catch(() => undefined);
    await lease.browser?.close().catch(() => undefined);
  }
}

function activeBudget(totalMs: number) {
  const controller = new AbortController();
  let remaining = totalMs;
  let resumedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    signal: controller.signal,
    resume: () => {
      resumedAt = Date.now();
      timer = setTimeout(() => controller.abort(), remaining);
    },
    suspend: () => {
      clearTimeout(timer);
      remaining -= Date.now() - resumedAt;
    },
    stop: () => {
      clearTimeout(timer);
    },
  };
}

async function claimMarker(path: string): Promise<boolean> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "started", { flag: "wx" });

    return true;
  } catch {
    return false;
  }
}

type Pending = Readonly<{
  snapshot: HandoffSnapshot;
  candidates: ReadonlyMap<string, TargetCandidate>;
  links: ReadonlyMap<string, LinkCandidate>;
  deadline: number;
  settle: (outcome: Chosen | Followed | Error) => void;
}>;

type SessionState =
  | Readonly<{ kind: "running"; settled: Promise<void> }>
  | Readonly<{ kind: "paused"; pending: Pending }>
  | Readonly<{ kind: "terminal"; results: ReadonlyMap<string, Observation> }>
  | Readonly<{ kind: "forbidden" }>;

type SessionInput = Omit<CaseEnv, "signal" | "handoff"> &
  Readonly<{ marker: string; parent?: AbortSignal; handoffId: () => string }>;

function expired(pending: Pending): CaseEnded {
  return new CaseEnded("handoff_expired", { handoffId: pending.snapshot.id });
}

function decided(
  pending: Pending,
  { handoffId, decision }: HandoffResolution,
): Chosen | Followed | CaseEnded {
  if (decision.kind === "abandon") {
    return new CaseEnded("handoff_abandoned", { handoffId, reason: decision.reason });
  }

  if (decision.kind === "choose") {
    const candidate = pending.candidates.get(decision.candidateId);

    if (!candidate) {
      throw new Error(`Handoff ${handoffId} has no candidate ${decision.candidateId}`);
    }

    return { kind: "choose", handoffId, candidateId: decision.candidateId, candidate };
  }

  const link = pending.links.get(decision.linkId);

  if (!link) {
    throw new Error(`Handoff ${handoffId} has no link ${decision.linkId}`);
  }

  return { kind: "navigate", handoffId, linkId: decision.linkId, link };
}

function projection(
  state: Exclude<SessionState, { kind: "running" }>,
  checkId: string,
): BrowserRunOutcome {
  if (state.kind === "paused") {
    return { state: "selection_required", handoff: state.pending.snapshot };
  }

  if (state.kind === "forbidden") {
    return { state: "blocked", reason: REPLAY_FORBIDDEN, browser: { selections: [] } };
  }

  return (
    state.results.get(checkId) ?? { state: "blocked", reason: "Check is outside the role scope" }
  );
}

class CaseSession {
  private readonly consumed = new Map<string, HandoffDecision>();

  private readonly stop = new AbortController();

  private readonly budget = activeBudget(ACTIVE_CASE_MS);

  private readonly signal: AbortSignal;

  private readonly driving: Promise<void>;

  private issued = 0;

  private wake: () => void = () => undefined;

  private state: SessionState = this.running();

  constructor(private readonly input: SessionInput) {
    this.signal = AbortSignal.any([
      ...(input.parent ? [input.parent] : []),
      this.budget.signal,
      this.stop.signal,
    ]);
    this.driving = this.drive();
  }

  async run(checkId: string, resolution?: HandoffResolution): Promise<BrowserRunOutcome> {
    this.expireIfDue();

    if (resolution && this.state.kind !== "forbidden") {
      this.apply(resolution);
    }

    return projection(await this.settled(), checkId);
  }

  async dispose(): Promise<void> {
    this.stop.abort();
    await this.driving;
  }

  private running(): SessionState {
    return {
      kind: "running",
      settled: new Promise<void>((resolve) => {
        this.wake = resolve;
      }),
    };
  }

  private settleTo(next: SessionState): void {
    this.state = next;
    this.wake();
  }

  private async drive(): Promise<void> {
    if (!(await claimMarker(this.input.marker))) {
      this.settleTo({ kind: "forbidden" });

      return;
    }

    this.budget.resume();
    const results = await executeCase({
      ...this.input,
      signal: this.signal,
      handoff: (run, target, candidates, error) => this.handoff(run, target, candidates, error),
    });
    this.budget.stop();
    this.settleTo({ kind: "terminal", results });
  }

  private async handoff(
    run: CaseRun,
    target: HandoffTarget,
    candidates: readonly TargetCandidate[],
    error: JevError,
  ): Promise<Chosen | Followed> {
    if (this.issued === MAX_CASE_HANDOFFS) {
      throw new CaseEnded("handoff_limit", { diagnostics: error.diagnostics });
    }

    const { links, truncated } = await linkCandidates(run.page, run.target);
    this.signal.throwIfAborted();
    this.issued += 1;
    const deadline = Date.now() + PAUSED_CASE_MS;

    return this.pause({
      snapshot: {
        id: this.input.handoffId(),
        caseId: this.input.planCase.id,
        ordinal: this.issued,
        laterHandoffsAllowed: MAX_CASE_HANDOFFS - this.issued,
        expiresAt: new Date(deadline).toISOString(),
        url: observedUrl(run.page),
        target,
        candidates: candidates.map(({ id, description }) => ({ id, description })),
        links: links.map(({ id, description, url }) => ({ id, description, url })),
        linksTruncated: truncated,
        diagnostics: { code: "uncertain_or_invalid_selection", ...error.diagnostics! },
      },
      candidates: new Map(candidates.map((item) => [item.id, item])),
      links: new Map(links.map((item) => [item.id, item])),
      deadline,
    });
  }

  private pause(paused: Omit<Pending, "settle">): Promise<Chosen | Followed> {
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        ...paused,
        settle: (outcome) => {
          clearTimeout(timer);
          this.signal.removeEventListener("abort", abort);
          this.budget.resume();
          this.state = this.running();

          if (outcome instanceof Error) {
            reject(outcome);
          } else {
            resolve(outcome);
          }
        },
      };
      const abort = () => pending.settle(new BrowserBlocked("cancelled"));
      const timer = setTimeout(() => pending.settle(expired(pending)), PAUSED_CASE_MS);
      this.signal.addEventListener("abort", abort, { once: true });
      this.budget.suspend();
      this.settleTo({ kind: "paused", pending });
    });
  }

  private expireIfDue(): void {
    if (this.state.kind === "paused" && Date.now() >= this.state.pending.deadline) {
      this.state.pending.settle(expired(this.state.pending));
    }
  }

  private apply(resolution: HandoffResolution): void {
    const prior = this.consumed.get(resolution.handoffId);

    if (prior) {
      if (!isDeepStrictEqual(prior, resolution.decision)) {
        throw new Error(
          `Handoff ${resolution.handoffId} was already resolved with a different decision`,
        );
      }

      return;
    }

    if (this.state.kind !== "paused" || this.state.pending.snapshot.id !== resolution.handoffId) {
      throw new Error(
        `Handoff ${resolution.handoffId} is not pending for case ${this.input.planCase.id}`,
      );
    }

    const pending = this.state.pending;
    const outcome = decided(pending, resolution);
    this.consumed.set(resolution.handoffId, resolution.decision);
    pending.settle(outcome);
  }

  private async settled(): Promise<Exclude<SessionState, { kind: "running" }>> {
    while (this.state.kind === "running") {
      await this.state.settled;
    }

    return this.state;
  }
}

export function createPlaywrightFixture(
  targetUrl: string,
  role: "ac" | "ui",
  signal?: AbortSignal,
  artifactDirectory?: string,
  attemptKey: string = randomUUID(),
  launch: () => Promise<Browser> = launchChromium,
): BrowserAdapter & Readonly<{ dispose: () => Promise<void> }> {
  const sessions = new Map<string, CaseSession>();
  let handoffs = 0;

  const markerFor = (planCase: PlanCase) =>
    join(
      process.cwd(),
      ".data",
      "browser-executions",
      createHash("sha256").update(`${attemptKey}:${role}:${planCase.id}`).digest("hex"),
    );

  const open = (planCase: PlanCase): CaseSession => {
    const session = new CaseSession({
      targetUrl,
      planCase,
      checks: planCase.checks.filter(
        (item) => item.kind === (role === "ac" ? "functional" : "style"),
      ),
      marker: markerFor(planCase),
      parent: signal,
      artifactDirectory,
      launch,
      handoffId: () => {
        handoffs += 1;

        return `h${handoffs}`;
      },
    });
    sessions.set(planCase.id, session);

    return session;
  };

  return {
    ...LIVE_BROWSER,
    run: async (planCase, check, resolution) => {
      if (role === "ui" && planCase.actions.some((action) => action.kind !== "navigate")) {
        return {
          state: "blocked",
          reason: JSON.stringify({
            stage: "scope",
            code: "ui_navigation_only",
            detail:
              "UI v1 is read-only navigation and measurement; stateful case actions belong to AC",
          }),
          browser: { selections: [] },
        };
      }

      const live = sessions.get(planCase.id);

      if (live) {
        return live.run(check.id, resolution);
      }

      if (resolution) {
        const markerExists = await access(markerFor(planCase)).then(
          () => true,
          () => false,
        );

        if (!markerExists) {
          throw new Error(`Case ${planCase.id} has no paused browser session`);
        }
      }

      return (sessions.get(planCase.id) ?? open(planCase)).run(check.id);
    },
    dispose: async () => {
      await Promise.all([...sessions.values()].map((session) => session.dispose()));
    },
  };
}
