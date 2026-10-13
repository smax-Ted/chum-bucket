# 驗證留言批准

先用 MCP fixture 驗證權限、事件與 HTTP 邊界，再用真實 DBOS 驗證重啟，最後用真實 Jira 跑一次。先完成[建立留言批准](implement-approval.md)。

## 1. 驗證留言只有一條路能送出

在 `tests/server/harness/tool-approval.test.ts` 與 `testing-tools.test.ts` 確認：

- `allowsTool("atlassian", "jira_add_comment", "codemode")` 是 `false`。`main` 與 `planner` 直接呼叫也是 `false`。
- `atlassian` 的 Code Mode 裡 `typeof external_jira_add_comment` 是 `"undefined"`，fixture 沒有收到 `tools/call`。
- 角色的 dispatcher 直接執行 `jira_add_comment` 時，丟出 `Jira comments require durable orchestration approval`。
- MCP 服務的環境變數是 `READ_ONLY_MODE=false`、`ATLASSIAN_RETRY_TOTAL=0`、`ATLASSIAN_RETRY_INCLUDE_WRITES=false`，寫入工具只開放 `jira_add_comment`。
- `toolArgumentSchemas.jira_add_comment` 拒絕多出的欄位與格式錯誤的 `issue_key`。
- `jiraCommentApproval.dispatch` 收到沒有 `id` 的回應時丟出錯誤。設定的 Jira 網站和 context 不同時，`sendApprovedJiraComment` 不開啟 MCP 連線。

## 2. 驗證卡片狀態

在 `tests/server/harness/tool-approval-events.test.ts` 直接呼叫 `projectToolApprovals` 與 `applyToolApprovalEvent`：

- 只有 requested 是 `pending`。過了 `expiresAt` 是 `expired`。
- 先 `rejected` 再 `succeeded`，結果仍是 `rejected`。
- 先 `approved` 再 `succeeded`，結果是 `succeeded`。
- 沒有對應 requested 的 resolved 被忽略。
- 決定與取消的 idempotency key 不同，同一張卡片的決定 key 固定。

在 `tests/server/harness/comment-outcome.test.ts` 確認 `commentOutcomeOf` 對每種狀態回傳正確的 `message`，只有 `approved` 時告訴主 Agent「沒有確認送達」。

## 3. 驗證 HTTP 邊界

在 `tests/server/tool-approval-http.test.ts` 確認：

- 缺少 `X-Tool-Approval: 1` 時回傳 409。
- `Origin` 是別的網站、而且 `Sec-Fetch-Site` 不是 `same-origin` 時回傳 409。
- body 多了 `body`、`arguments` 或 `visibility` 時回傳 400。

在 `tests/server/harness/tool-approval.integration.test.ts` 用真實資料庫確認：

- 寫入 requested 事件後，`readToolApprovals` 讀到一張 `pending` 卡片，`readToolApprovalRequest` 讀回 `topic` 與 `childWorkflowId`。
- task 被拒絕過一次後，`hasFinalApprovalDenial` 是 `true`。`requestApproval` 用它拒絕新的請求。
- 核准請求呼叫 `DBOS.send` 時，帶的是請求裡的 `topic` 與 `approval-decision:<approvalId>`。

## 4. 驗證重啟

`tests/scripts/jira-comment-recovery.test.js` 啟動自己的 worker，用 SIGKILL 結束再重啟。模型與 Jira 都是 fixture。為它建立一個獨立的資料庫並套用 migration：

```bash
JIRA_COMMENT_RECOVERY_DATABASE_URL=<測試資料庫> pnpm test tests/scripts/jira-comment-recovery.test.js
```

三個情境：

1. **等待時重啟**：卡片出現後結束 worker。worker 停止期間，用同一個 key 先送核准再送拒絕。重啟後狀態是 `succeeded`，沒有 `rejected`。第一個決定有效。
2. **送出後、記錄前重啟**：Jira fixture 收到留言後立刻結束 worker。重啟後狀態是 `succeeded`，fixture 至少收到 1 次留言。這個情境允許重複，見[架構文件](architecture.md#只保證不會未經批准送出)。
3. **取消**：卡片出現後結束 worker，直接送出 `{ cancel: true, approvalId }`，key 是 `approval-cancel:<approvalId>`，再重啟。狀態是 `cancelled`，fixture 沒有收到任何留言。

## 5. 用真實 Jira 驗收

這一步會在 Jira 新增真實留言。用一張測試用的 issue。

準備：

1. 在 `.env` 設定 `MODEL_API_KEY`、`JIRA_BASE_URL`、`JIRA_EMAIL` 與 `JIRA_API_TOKEN`。
2. 重新啟動 `pnpm mcp:atlassian`。確認它沒有帶 `--read-only`。
3. 執行 `pnpm dev`。

在瀏覽器依序操作：

1. 送出「在 PROJ-123 留言：workshop 測試留言 1」。確認主對話出現批准卡片，`body` 和你輸入的文字完全相同。這時 Jira 上還沒有新留言。
2. 重新整理頁面。確認卡片還在。
3. 停止 `pnpm dev`，等 5 秒再啟動。確認卡片還在，按「核准送出」。確認卡片消失，Jira 上出現一則留言，主 Agent 回報留言 ID。
4. 送出「在 PROJ-123 留言：workshop 測試留言 2」，按「拒絕」。確認 Jira 沒有新留言，主 Agent 說明沒有送出，沒有自己再委派一次。
5. 再要求一則留言，這次在委派卡片按「取消」。確認批准卡片消失，Jira 沒有新留言。
6. 開啟附屬對話，要求它留言。確認附屬對話沒有批准卡片，也沒有送出留言。

從資料庫確認每張卡片在 `chat_events` 有一筆 `tool.approval.requested`，以及對應的 `tool.approval.resolved`。核准的那張依序是 `approved` 與 `succeeded`，`receipt.externalId` 和 Jira 上的留言 ID 相同。

驗收後刪除 Jira 上的測試留言。
