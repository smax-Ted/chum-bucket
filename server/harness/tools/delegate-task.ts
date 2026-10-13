import { toolDefinition } from "@tanstack/ai";
import { delegationInputSchema } from "../../../shared/testing";

export const DELEGATE_TASK_TOOL = "delegate_task";

export const delegateTaskTool = toolDefinition({
  name: DELEGATE_TASK_TOOL,
  description:
    "Delegate exactly one durable task. Choose atlassian to capture requirements and, when its goal explicitly asks for a Jira comment on a source issue, propose that comment for human approval; planner with an explicit requirementsRef to plan without a URL, or ac/ui with an explicit planRef and targetUrl for the checks the plan assigns to that role; a plan with deferred cases or an empty ac/ui assignment cannot be executed for those items. Every check result states its evidence.origin, browser for the live adapter or mock for simulated, and neither proves release acceptance. Returns validated results, immutable artifact references, and for a failed role its reason code with bounded validator issues. Never launches prerequisites. Use exactly the fields for the selected role. atlassian accepts role, summary, goal, sources and criteria. planner accepts only role, summary, requirementsRef and optional design; do not send goal, sources, criteria or targetUrl to planner. ac and ui accept only role, summary, planRef and targetUrl. Jira issue keys identify sources, not criterion selection. For the whole PROJ-123 issue use sources:[{kind:'jira',issueKey:'PROJ-123'}], criteria:{kind:'all'}. Use selected only for explicit criterion keys such as AC-2 and AC-5, preserving that exact subset.",
  inputSchema: delegationInputSchema,
  metadata: { direct: true },
});
