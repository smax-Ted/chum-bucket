# 建立 Code Mode

建立 `codemode({ code })`，讓模型用同一段 TypeScript 呼叫工具並整理結果。每一步先用可控制的輸入確認結果，再接入模型。架構分工見 [Code Mode 的工具編排架構](architecture.md)。

## 1. 固定版本與輸入契約

起點已預裝 `@tanstack/ai-code-mode@0.4.13` 與 `@tanstack/ai-isolate-quickjs@0.3.1`，lockfile 鎖定 QuickJS driver 的依賴 `quickjs-emscripten@0.31.0`。這兩個套件的版本固定，不帶 `^`。升級時重新核對 driver 與 bridge 行為，不直接套用其他版本的範例。

在 `tools/code-mode.ts` 定義 `codeModeToolName = "codemode"`，用 Zod 定義只有 `code: string` 的 strict object。拒絕其他欄位，並把 schema 轉成模型可讀的 JSON Schema。

本章對外使用 `{ code }`。套件工具使用 `{ typescriptCode }`，因此只在 wrapper 內做欄位轉換。不要把套件名稱 `execute_typescript` 或內部欄位混入對外定義。

先確認合法字串能通過；缺少 `code`、數字輸入與額外欄位都不能啟動執行。

## 2. 建立共用 dispatcher 與 binding adapter

在 `tools/index.ts` 保留一個依當輪訊息分派工具的入口。直接工具呼叫與 Code Mode 都使用這個入口，繼續執行本機 schema 驗證、MCP 白名單檢查與 discovery 檢查。

讓 `composeCodeModeTurn` 接收以下依賴：

- `definitions` 是當輪獲允許的工具定義。
- `dispatch` 接收 `ModelCall` 與 `ToolExecutionContext`，回傳工具結果。
- `guard` 檢查不能跨越邊界的已設定憑證。
- `policy` 集中保存時間、記憶體、呼叫次數與資料大小限制。

排除 `codemode` 與 `discover_atlassian_tools` 後，把定義轉為具有 `execute` 的 server tool。每個 adapter 都把輸入交給共用 dispatcher，不能另建一條直接呼叫 MCP client 的捷徑。

為子呼叫建立 `<parentToolCallId>/external/<序號>`。把同一個 ID 放進 `ModelCall.id` 與 `context.toolCallId`，並傳遞執行中的 `AbortSignal`。每次執行重新計數，平行呼叫也共用同一份預算。

先用記錄輸入的假 dispatcher 呼叫 adapter。確認工具名稱、原生參數、子呼叫 ID 與取消訊號完整傳入。

## 3. 接上 QuickJS 執行

使用 `createQuickJSIsolateDriver()` 建立 driver，再把 server tools 傳給 `createCodeMode`。指定 `timeout`、`memoryLimit` 與 `transpile`。在 `transpile` 先檢查 source 限制，再呼叫 `stripTypeScript`。

每次呼叫使用新的 context。不要保存上次執行的全域變數，也不要注入 `process`、`require`、`fetch`、資料庫連線或 MCP client。套件執行路徑在 `finally` 呼叫 `dispose()`；自行使用 driver 時也維持這個清理流程。呼叫清理不代表所有 pending host 工作已結束，限制見[執行邊界](execution-boundaries.md)。

先執行 `return 2 + 3;`，確認取得成功結果 `5`。再讓假 `external_read` 回傳兩段文字，以短程式組合後回傳。此時不需要真實模型或 Jira。

[`createCodeMode` 的這個版本](https://github.com/TanStack/ai/blob/@tanstack/ai-code-mode@0.4.13/packages/ai-code-mode/src/create-code-mode-tool.ts)要求至少一個 tool。本章永遠有 `get_figma`、`read`、`write` 與 `edit`，因此不需要處理零 bindings。

## 4. 由同一份 bindings 產生模型說明

使用 `toolsToBindings(sandboxTools, "external_")` 取得 bindings，再用 `generateTypeStubs` 產生 TypeScript 宣告。保留每個工具的原生 description 與參數定義。

在 `prompts.ts` 定義 `codeModeDescription(functionNames)` 與 `codeModeSystemPrompt({ functions, typeDefinitions })`。`code-mode.ts` 負責產生 bindings 與宣告，`prompts.ts` 只負責組成文字。Prompt 說明以下規則：

- 用 `{ code }` 呼叫 `codemode`，並列出可用函式與宣告。
- 等待所有 `external_*` 呼叫。有先後依賴的操作依序 `await`，只有互不依賴的讀取才適合 `Promise.all`。
- 用 `return` 交回結果。每次執行彼此獨立。
- Sandbox 沒有直接的網路或檔案 API。所有檔案、網路與服務操作都經過 `external_*`。不要寫成「沒有檔案存取」，因為 `external_read` 與 `external_write` 仍能讀寫檔案。

型別宣告供模型理解 API，不是 runtime 驗證。JSON Schema adapter 仍須回到原工具 handler 驗證輸入，不能因為已產生宣告就略過檢查。

## 5. 宣告工具的回傳格式

沒有 `outputSchema` 的 binding，`generateTypeStubs` 只會產生 `Promise<unknown>`。模型只能猜欄位，例如把 `summary` 寫成 `fields.summary`，程式仍會成功執行，只是拿到 `null`。

mcp-atlassian 的工具都宣告 `x-fastmcp-wrap-result`，實際資料是 `result` 字串裡的 JSON。照以下方式處理：

1. 在 `atlassian.ts` 的 `remoteRegistration` 展開結果。工具的 `outputSchema` 帶有 `x-fastmcp-wrap-result` 時，對 `result` 執行 `JSON.parse`。解析失敗就回傳原字串。直接呼叫與 Code Mode 都拿到展開後的資料。
2. 在 `atlassian-output.ts` 用 zod 的 `z.looseObject` 為白名單內的 5 個工具定義回傳格式。只列穩定的欄位，例如 `key`、`summary`、`status.name`、`issues`，其餘欄位設為 optional。`looseObject` 保留沒有列出的欄位。
3. 在 `fs.ts` 的 `toolDefinition` 加上 `outputSchema`，描述 Pi 工具回傳的 `content` 陣列。
4. 在 `tools/index.ts` 把這些 schema 轉成 JSON Schema，以 `outputSchemas` 傳給 `composeCodeModeTurn`。`sandboxTool` 把對應的 schema 放進 `CodeModeTool.outputSchema`。

傳入 JSON Schema 而不是 zod，套件只用它產生宣告，不做回傳驗證。上游格式變動時，宣告可能過時，但工具呼叫不會因此失敗。

確認 prompt 中每個函式都有實際 binding，且不存在 `external_codemode` 或 `external_discover_atlassian_tools`。`external_read` 與已探索的 `external_jira_get_issue` 都宣告為 `Promise<...Output>`，`external_get_figma` 仍是 `Promise<unknown>`。

## 6. 組合當輪工具並延續 discovery

把 `getModelTools(messages)` 的回傳契約擴充為 `{ definitions, systemPrompt }`。先從持久化訊息重建已探索工具，再組合原工具定義與 `codemode` 定義。

在 `executeTool(messages, call, context)` 判斷工具名稱。一般呼叫走原 dispatcher；`codemode` 則重建當輪允許的 bindings，執行 `turn.execute(call.input, context)`。

保留 discovery 在 sandbox 外執行。沿用 `jira_get_issue` 的 `update_history: false` 政策，不讓程式自行改成會更新瀏覽紀錄的查詢。

確認未探索的 MCP 工具沒有 binding。完成一次合法 discovery 後，下一輪才出現該函式；清除成功結果或換成使用者文字後，函式不再出現。

## 7. 加上執行限制與停止狀態

依[執行邊界](execution-boundaries.md)設定 source、host 輸入、host 結果、console、最終結果與事件的預算。用 UTF-8 bytes 計算資料限制，在相應的工具入口或回傳出口檢查。

用 `AbortSignal.any` 合併三個訊號：外層 tool step 的 `abortSignal`、Code Mode 的 `timeoutMs` deadline，以及本次執行的 controller。每個 host 呼叫在開始與回傳時都檢查停止狀態。

把超出政策、憑證檢查失敗與工具授權失敗設成不可恢復的本次執行錯誤。即使 guest 用 `try/catch` 吃掉例外，wrapper 仍須讓整次呼叫失敗。一般工具錯誤可交回 guest 處理，但不能用相同機制吞掉邊界違規。

完成、取消或失敗時，關閉本次執行的新 host 呼叫並中止 controller。取消或失敗的 MCP session 沿用既有 abort 與 retire 流程，run 的工具 scope 仍由外層 `finally` 清理。

Guest 可能漏掉 `await`，執行結束時仍有 host 工作在跑。在 `withRunTools` 用 `pending` 集合記錄 dispatcher 啟動的每個 Promise，並在 `finally` 以 `Promise.allSettled(pending)` 等它們結束，再關閉 Atlassian scope。Code Mode 結束時先中止 controller，所以等待開始前取消訊號已經送出。

這個等待沒有上限，因此每個 handler 都必須配合 `abortSignal`。`read`、`write`、`edit` 由 Pi 工具處理訊號，`get_figma` 把訊號交給 `fetch`，MCP 呼叫由 `withAbort` 在取消時立即拒絕。新增 handler 時同樣接上訊號，否則會卡住整個 run 的收尾。

確認超限後沒有新的 dispatcher 呼叫，舊 Promise 完成也不會觸發下一個工具。

## 8. 投影事件，再交回聊天迴圈

接受套件的 `code_mode:execution_started`、`console`、`external_call`、`external_result`、`external_error` 與 `execution_finished` 事件。

先檢查原始 payload，再投影成追蹤用資料。保留函式名稱、時間長度、資料大小與成功狀態；不把完整程式、參數、工具內容或 console 文字複製到自訂事件。最終工具結果仍有自己的資料限制。

在 `tool-events.ts` 建立有上限的 buffer，附上 parent tool call ID 與事件序號。在 `agent-loop.ts` 的 `executeToolStep` 把 `emitCustomEvent` 接到 buffer。工具執行結束後先關閉 buffer，依序保存事件，再保存外層 `TOOL_CALL_RESULT`。遲到事件不能寫入已關閉的 buffer。

確認 `execution_finished` 出現在外層結果之前，且事件中找不到測試檔案的全文。

## 9. 接回既有 DBOS tool step

在 `agent-loop.ts` 的 `modelStep` 取得 `{ definitions, systemPrompt }`，將定義交給 adapter，並把 Code Mode prompt 加到 `systemPrompts` 的第二項。保留模型的原始程式輸入，資源限制的前置程式只在執行 wrapper 內加入。

在原有 `tool:<turn>:<index>` step 執行 `codemode`。保留模型呼叫、事件儲存、對話更新與 SSE 重連的既有流程。不要在 binding 裡新增一層 `DBOS.runStep`，期待取得獨立的子呼叫 checkpoint。

用 `runAgentLoop` 搭配假的 `chatStream` 與直接執行的 checkpoint 測試這段整合。第一輪要求讀取暫存檔並回傳短摘要，第二輪產生回答。確認只有一個外層工具結果，模型收到整理結果，loop 回傳 `done`。

最後依照[Code Mode 驗收](verify-code-mode.md)檢查真實隔離環境、host 邊界與跨程序恢復。
