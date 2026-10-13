import { toolDefinition } from "@tanstack/ai";
import { delegationInputSchema } from "../../../shared/testing";

export const DELEGATE_TASK_TOOL = "delegate_task";

export const delegateTaskTool = toolDefinition({
  name: DELEGATE_TASK_TOOL,
  description:
    "Delegate exactly one durable task. Choose atlassian to capture requirements and, when its goal explicitly asks for a Jira comment on a source issue, propose that comment for human approval; planner with an explicit requirementsRef to plan without a URL, or ac/ui with an explicit planRef and targetUrl for the checks the plan assigns to that role; a plan with deferred cases or an empty ac/ui assignment cannot be executed for those items. Every check result states its evidence.origin, browser for the live adapter or mock for simulated, and neither proves release acceptance. Returns validated results, immutable artifact references, and for a failed role its reason code with bounded validator issues. Never launches prerequisites. Use exactly the fields for the selected role. atlassian accepts role, summary, goal and sources. planner accepts only role, summary, requirementsRef and optional design; do not send goal, sources or targetUrl to planner. ac and ui accept only role, summary, planRef and targetUrl. For the PROJ-123 issue use sources:[{kind:'jira',issueKey:'PROJ-123'}].",
  inputSchema: delegationInputSchema,
  metadata: { direct: true },
});
