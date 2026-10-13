import { toolDefinition } from "@tanstack/ai";
import { delegationInputSchema } from "../../../shared/testing";

export const DELEGATE_TASK_TOOL = "delegate_task";

export const delegateTaskTool = toolDefinition({
  name: DELEGATE_TASK_TOOL,
  description:
    "Delegate exactly one durable task. Choose atlassian to capture requirements, planner with an explicit requirementsRef to plan without a URL, or ac/ui with an explicit planRef and targetUrl for mock-only checks. Returns validated results and immutable artifact references. Never launches prerequisites. Jira issue keys identify sources, not criterion selection. For the whole PROJ-123 issue use sources:[{kind:'jira',issueKey:'PROJ-123'}], criteria:{kind:'all'}. Use selected only for explicit criterion keys such as AC-2 and AC-5, preserving that exact subset.",
  inputSchema: delegationInputSchema,
  metadata: { direct: true },
});
