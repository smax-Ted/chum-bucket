# 建立留言批准

讓 `atlassian` 角色提出的 Jira 留言先停在批准卡片，使用者核准後才送出。架構分工見[使用者批准的架構](architecture.md)。

每一步先用 MCP fixture 和假的模型串流確認結果，最後才接上真實 Jira。

## 1. 定義參數與決定的格式

在 `shared/tool-approval.ts` 定義留言參數：

```typescript
export const toolArgumentSchemas = {
  jira_add_comment: z.strictObject({
    issue_key: z.string().regex(/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/),
    body: z.string().min(1).max(32767),
  }),
} as const;
```

用 `strictObject`，模型多傳 `visibility` 之類的欄位時直接失敗。批准卡片顯示的就是這兩個欄位，沒有藏起來的參數。

使用者的決定只有是或否：

```typescript
export const toolApprovalDecisionSchema = z.strictObject({
  threadId: z.uuid(),
  digest: z.string().length(64),
  tool: z.enum(approvalToolNames),
  approved: z.boolean(),
});
```

決定裡沒有參數欄位，所以無法在批准時改寫留言。

定義兩個事件名稱與內容：

- `tool.approval.requested`：`approvalId`、`threadId`、`runId`、`operationId`、`taskId`、`toolCallId`、`childWorkflowId`、`topic`、`tool`、`arguments`、`presentation`、`context`、`digest`、`expiresAt`。
- `tool.approval.resolved`：`approvalId`、`state`、`receipt`。`state` 是 `approved`、`succeeded`、`rejected`、`expired` 或 `cancelled`，`receipt` 是 `{ externalId }` 或 `null`。

`projectToolApprovals(events)` 從事件算出每張卡片的狀態。規則：

- 只有 requested、沒有 resolved，而且還沒過期，就是 `pending`。
- 第一個 resolved 決定狀態。唯一的例外是 `approved`：它之後第一個不是 `approved` 的結果會取代它。
- 找不到對應 requested 的 resolved 忽略不算。

## 2. 開放寫入，但只能直接呼叫

在 `atlassian-policy.ts`：

- `atlassianTools` 加入 `["jira_add_comment", { required: false, routes: ["direct"] }]`。`allowsTool` 遇到 `"codemode"` route 時回傳 `false`。
- MCP 服務的環境變數改成 `READ_ONLY_MODE=false`，`TOOLSETS` 加上 `jira_comments`。
- 設定 `ATLASSIAN_RETRY_TOTAL=0` 與 `ATLASSIAN_RETRY_INCLUDE_WRITES=false`。MCP 自動重試寫入時，Jira 可能多出一則留言。重試交給 DBOS 決定。

`scripts/mcp-atlassian.ts` 拿掉 `--read-only`。

在 `atlassian` 角色的工具組合裡：

- `jira_add_comment` 的 description 改成「提出這段確切的 Jira 留言給使用者批准。批准前不會送出。被拒絕後這個任務不能再提出」。`inputSchema` 用第 1 步的 schema。
- 角色的 dispatcher 收到 `jira_add_comment` 時丟出錯誤。Atlassian MCP 的一般執行路徑也丟出錯誤。

這樣留言只剩一條路能送出：下一步的 orchestration hook。Code Mode 的 sandbox 裡沒有 `external_jira_add_comment`，就算有，dispatcher 也會拒絕。

## 3. 在角色的模型迴圈攔下留言

[建立委派](../subagents/implement-delegation.md#4-在模型迴圈加上-orchestration-hook)在 `agent-loop.ts` 加過 orchestration hook。在 `testing-child.ts` 為角色的 `runAgentLoop` 也傳入 hook：

```typescript
orchestration: (call) => gateToolApproval(approvalRun(run), call, run.signal),
```

`approvalRun` 是 `{ parentRunId, operationId, taskId, childWorkflowId, attemptNonce, role }`。`gateToolApproval` 只處理 `call.name === "jira_add_comment"` 而且 `role === "atlassian"`，其他呼叫回傳 `unhandled`。

hook 在 `tool:<turn>:<index>` step 之外執行，所以 `gateToolApproval` 裡可以呼叫 `DBOS.recv`。`recv` 不能放在 step 裡。

## 4. 建立請求

`gateToolApproval` 的第一個 step 是 `approval-request:<call.id>`，`retriesAllowed: false`。依序：

1. 用第 1 步的 schema 解析參數。
2. 讀回 operation。已結束、已取消或已過期時拒絕。
3. `issue_key` 必須在委派的 `sources` 裡。角色不能留言到沒讀過的 issue。
4. 這個 task 已經有被拒絕、過期或取消的請求時拒絕。被拒絕後，模型不能換個說法再問一次。
5. 組出 context：`{ site, visibility: "jira-default", policy: "jira-comment-v1" }`。`site` 是去掉結尾 `/` 的 `JIRA_BASE_URL`。
6. 算出三個值：

   ```typescript
   const approvalId = uuidFromDigest(sha256(`${childWorkflowId}:${call.id}`));
   const topic = `tool-approval:${taskId}:${call.id}`;
   const digest = sha256(canonicalJson({ run, call: call.id, input, context, deadline }));
   ```

7. 寫入 `tool.approval.requested` 事件到主對話的 run，`expiresAt` 是 operation 的期限。

`approvalId` 由 workflow ID 與工具呼叫 ID 決定。step 重放時算出同一個 ID，不會多出第二張卡片。

拒絕時回傳 `denial` 工具結果：`{ status, externalId: null, retryable: false, instruction: "Do not propose another comment in this task. Finish reading the requested sources." }`。

## 5. 等待並檢查決定

```typescript
const received = await DBOS.recv<unknown>(request.topic, {
  deadlineEpochMS: Date.parse(request.expiresAt),
});
```

把收到的值分成四種：

- `{ cancel: true, approvalId }` 而且 ID 相同：`cancelled`。
- `approvalId`、`tool`、`digest` 都相同，`approved` 是 `true`：`approved`。
- `null`：期限到了，`expired`。
- 其他任何值：`rejected`。digest 不同的決定當成拒絕，不是忽略。

不是 `approved` 時，在 `approval-resolve:<call.id>` step 寫入對應的 resolved 事件，回傳 denial。

## 6. 送出留言

核准後依序執行三個 steps：

1. **`approval-approve:<call.id>`**：寫入 `approved`。之後如果送出失敗，畫面和主 Agent 會知道「使用者已核准，但沒有確認送達」。
2. **`approval-dispatch:<call.id>`**：再讀一次 operation，已取消或過期就回傳 `cancelled`。呼叫 `guardActualIO` 扣工具預算。最後呼叫 `sendApprovedJiraComment(request.arguments, context.site, signal)`。
3. **`approval-resolve:<call.id>`**：寫入 `succeeded` 與留言 ID，或 `cancelled`。

送出由 `jiraCommentApproval.dispatch` 負責，它呼叫 `sendApprovedJiraComment`：

- 用 schema 重新解析存下的參數。
- 目前設定的 Jira 網站必須等於 context 的 `site`。批准後改了 `.env` 指向別的 Jira，就不送出。
- 透過 MCP 呼叫 `jira_add_comment`。mcp-atlassian 把結果包在 `{ result: "<JSON 字串>" }` 裡，先解開。
- `dispatch` 檢查回傳裡有留言 `id`，沒有就丟出錯誤，不假裝成功。

角色收到 `{ status: "succeeded", externalId, retryable: false, instruction }`，接著讀完其他來源。

## 7. 接收使用者的決定

在 `server/chat.ts` 新增 `POST /approvals/:id/decision`，掛在 `/api/chat` 下：

1. 要求 header `X-Tool-Approval: 1`，而且 `Sec-Fetch-Site` 是 `same-origin`，或 `Origin` 等於伺服器的 origin。別的網站不能替使用者按核准。
2. `:id` 必須是 UUID，body 符合 `toolApprovalDecisionSchema`。
3. 從事件讀回這張卡片，`tool`、`digest`、`threadId` 都要相同，狀態要是 `pending`。否則回傳 409。
4. 呼叫 `DBOS.send(request.childWorkflowId, { approvalId, tool, digest, approved }, request.topic, `approval-decision:${approvalId}`)`。

`DBOS.send` 失敗時回傳 409，不回報成功。回應只代表訊息已經送進資料庫，留言結果要等 resolved 事件。

## 8. 取消時喚醒等待

使用者在委派卡片按「取消」時，`cancelTesting` 設定 `cancel_accepted_at`。這時角色還停在 `recv`，不會看到取消 delivery。

在 `cancelTesting` 之後呼叫 `wakePendingApprovals(runId, operationId)`：對每個還沒有 resolved 的請求，送出 `{ cancel: true, approvalId }`，key 是 `approval-cancel:<approvalId>`。

讀卡片狀態時，operation 已取消而請求還是 `pending`，一律顯示成 `cancelled`。

## 9. 把結果交給主 Agent

`delegate_task` 的 close step 回傳值加上 `comment: await readCommentOutcome(runId, operationId)`。這個委派沒有提出留言時是 `null`，否則是：

```typescript
{
  status: "succeeded" | "approved" | "rejected" | "expired" | "cancelled";
  externalId: string | null;
  message: string;
}
```

`message` 是固定文字，告訴主 Agent 怎麼回報：

- `succeeded`：留言已送出，回報留言 ID。
- `rejected`：使用者拒絕，沒有送出。除非使用者在新訊息裡再次要求，不要再委派這則留言。
- `expired` 與 `cancelled`：沒有送出。
- `approved`：使用者已核准但沒有確認送達。不要說已送出，也不要再委派。

在主 Agent 的 prompt 加上：要留言時，委派 `atlassian`，把 issue 放進 `sources`，`goal` 明確寫出要留言，並引用使用者給的確切文字。只有 `comment.status` 是 `succeeded` 時才能說留言已送出。

在 `atlassian` 的 prompt 加上：只有委派內容明確要求留言時才呼叫 `jira_add_comment`，直接呼叫，不要用 Code Mode。被拒絕、取消或過期後不要再提出。

## 10. 顯示批准卡片

`use-threads.ts`：

- SSE 收到事件時，用 `parseToolApprovalEvent` 解析，再用 `applyToolApprovalEvent` 更新 `approvals`。
- `hydrateThread` 多回傳 `approvals`，重新整理後卡片還在。
- `decideApproval(approval, approved)` 送出第 7 步的請求，帶上 `X-Tool-Approval: 1`。

`ToolApprovals` 只顯示 `pending` 的卡片：標題「Jira 留言核准 · <issue_key>」、目標網站、提醒「Jira 預設可見性，並非私人留言」、`issue_key` 與完整 `body`、期限，以及「核准送出」和「拒絕」兩個按鈕。

- 送出後兩個按鈕換成一行「決策已送出，等待系統確認」。
- 送出失敗時顯示「決策未確認或狀態已變更。請重新整理確認，勿重複送出。」
- 過了 `expiresAt` 兩個按鈕都停用。

卡片只顯示在主對話窗格，附屬對話不讀取也不顯示批准。決定後卡片消失，結果由主 Agent 在回覆裡說明。

接著依照[驗證留言批准](verify-approval.md)確認整個流程。
