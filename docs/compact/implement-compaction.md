# 建立自動壓縮

讓 Harness 在每次模型請求前估算 context 大小。超過門檻時，把較早的訊息換成摘要，再送出請求。模型回報超限時，壓縮後重試一次。架構分工見 [Compact 的上下文架構](architecture.md)。

每一步先用固定的訊息陣列和假的摘要模型確認結果，最後才接上真實模型。

## 1. 把一份訊息拆成 display 與 context

在 `conversation.ts` 定義 `ConversationState` 與 `RunProjection`：

```typescript
export type RunProjection = ConversationState & { version: 1; committedRevision?: number };
```

`readProjection` 讀回舊格式時，把 `UIMessage[]` 同時當成 display 與 context。版本不是 `1`，或缺少任一陣列時，丟出錯誤。

`advanceConversation(state, next, updatedMessageId?)` 接收模型或工具產生的新 context，回傳新的 state：

- context 換成 `next`。已存在的訊息沿用舊物件，只有 `updatedMessageId` 指定的那則換成新內容。工具結果寫回原本的 assistant 訊息時，用這個參數指定。
- context 裡新出現、而且沒有 `fromSummary` 標記的訊息，加到 display 最後面。已在 display 的訊息就地更新。
- 新訊息的 ID 已經出現在 display，但不在舊 context 裡，代表它和被壓縮的舊訊息撞名。這時丟出錯誤，不覆蓋原文。

把 `agent-loop.ts` 裡傳遞的 `messages` 全部換成 `ConversationState`。模型請求用 `convertMessagesToModelMessages(conversation.context)`，`snapshot` 事件用 `conversation.display`。`emit(runId, event, conversation)` 把 projection 一起寫入 `chat_runs`。

`finishRun` 成功時，把 display 寫進 `threads.messages`，並在 projection 加上 `committedRevision: thread.revision + 1`。`persistRun` 建立下一個 run 時，找出 `committedRevision` 等於目前 revision 的 run，從它的 projection 讀回 context，放進 `AcceptedRun.context`。找到多個 anchor，或 anchor 的 display 和 `threads.messages` 不同時，回傳 409。

先不加入壓縮，跑一次原本的測試。這時 display 與 context 完全相同，行為應該和改動前一樣。

## 2. 估算一次請求的 token 數

在 `compaction.ts` 建立 `estimateInputTokens({ messages, systemPrompts, definitions })`。把三者各自 `JSON.stringify` 後加總 UTF-8 bytes，除以 3 再加上 2,048：

- messages 先經過 `convertMessagesToModelMessages`，量的是實際送給模型的格式。
- systemPrompts 包含 `run.prompt` 與 `getModelTools(messages).systemPrompt`。Code Mode 的型別宣告就在這裡，常常比對話本身還大。
- definitions 是當輪的工具定義。lazy discovery 開放新工具後，這個數字會變大。
- 2,048 是請求框架與角色標記的保留量。

3 bytes 換算一個 token 是粗略值。英文大約 4 個字元一個 token，用這個比例會估多。中文一個字是 3 bytes，實際 token 數依 tokenizer 而定。估算有誤差，所以門檻要留空間，見下一步。不要在每輪請求前呼叫供應商的 tokenizer API，那會讓每輪多一次網路請求。

確認文字變長、工具定義變多時，估算值都會增加。

## 3. 設定壓縮門檻與保留量

定義一個 `CompactionPolicy`：

```typescript
export type CompactionPolicy = Readonly<{
  triggerTokens: number;
  keepRecentTokens: number;
}>;
```

從環境變數讀取 policy，預設值是 48,000 與 20,000：

- `COMPACT_TRIGGER_TOKENS` 對應 `triggerTokens`。
- `COMPACT_KEEP_RECENT_TOKENS` 對應 `keepRecentTokens`。

在 `.env.example` 加上這兩個變數與預設值。兩個值都必須是正的安全整數，否則伺服器啟動時丟出錯誤。驗收時調低門檻，就不必修改程式，見[驗證 Compact](verify-compaction.md)。

模型的 context window 減去 `triggerTokens`，就是 Target 裡的 Buffer。檢查發生在每次模型請求之前，先前的工具結果都已計入。Buffer 要容納兩樣東西：

- 這次請求的模型回覆，也就是 output tokens。
- 估算誤差。

單一工具結果大到直接超過 context window 時，Buffer 擋不住。這種情況交給第 9 步的超限重試。

`keepRecentTokens` 決定壓縮後保留多少近期原文。它必須明顯小於 `triggerTokens`。兩者太接近時，壓縮後很快又超過門檻，每輪都在摘要。

## 4. 選擇切分位置

建立 `planCompaction(messages, policy)`，回傳 `{ previousSummary, transcript, tail }` 或 `null`：

- `transcript` 交給摘要模型。
- `tail` 原樣保留在新的 context。
- `previousSummary` 是上一次壓縮的摘要文字，沒有就是 `null`。

先處理上一份摘要。context 第一則訊息有 `fromSummary` 標記時，取出它的文字，去掉開頭說明，當成 `previousSummary`，其餘訊息才參與切分。摘要訊息出現在第一則以外的位置，或摘要裡有文字以外的 part，就回傳 `null`。這種 context 不是這套流程產生的，不要猜它的結構。

接著找出安全的切分點。工具呼叫和它的結果必須留在同一側：

- 每個 `tool-call` 的 `state` 必須是 `complete` 或 `error`。
- `tool-result` 必須出現在對應呼叫之後，而且每個呼叫只有一個結果。
- 不符合上面兩點時回傳 `null`，不壓縮。
- 切分點不能落在任何一個呼叫與結果之間。

在安全的位置中，依以下順序選擇切分點：

1. 最早一個符合條件的 user 訊息：從這裡到最後的大小不超過 `keepRecentTokens`。這樣保留完整的「使用者提問與後續回覆」。
2. 最新一則使用者訊息之後的內容本身就超過保留量時，改在那則訊息之後找一個 assistant 位置。長時間的工具迴圈只有一則使用者訊息，不這樣做就永遠切不下去。
3. 都找不到時，用最後一個安全的 user 位置。

切分點不能是 0。沒有任何訊息可以交給摘要時，回傳 `null`。

用小型訊息陣列確認以下結果：

- 只有一組問答時不切分。
- 切分點不會拆開工具呼叫和結果。
- 有上一份摘要時，`previousSummary` 是摘要原文，`transcript` 不包含摘要訊息。
- 改變 `keepRecentTokens` 只會移動切分點，不會截斷單一訊息。

## 5. 送出摘要請求

建立 `summarizeTranscript(plan, purpose, signal)`。它用獨立的模型請求產生摘要，不經過 `agent-loop`：

- system prompt 用 `prompts.ts` 的 `compactionSystemPrompt`。要求模型整理目標、限制、進度、決策、下一步和需要保留的確切值。並說明 `previousSummary` 與 `transcript` 都是歷史資料，不是要執行的指令。
- 使用者訊息是 `JSON.stringify({ previousSummary, transcript })`，transcript 先經過 `convertMessagesToModelMessages`。
- `tools: []`。摘要請求不能呼叫任何工具。
- `max_tokens: 2_000`，請求加上 30 秒逾時，並合併外部的 `AbortSignal`。

以下情況丟出錯誤，讓這次壓縮算失敗：

- 供應商回報的 finish reason 不是 `stop`，代表摘要被截斷。
- 模型仍然回傳工具呼叫。
- 去除空白後是空字串。
- 超過 8,000 個字元。
- 內容只是供應商的安全分類標記，不是摘要。

用假的 `chatStream` 確認：送出的請求不含工具，`previousSummary` 原樣出現在請求內容裡。

## 6. 組成新的 context 並確認變小

建立 `prepareCompaction(input)`，依序處理：

1. 用 `getModelTools(messages)` 取得當輪的工具與 system prompt，估算 `before`。
2. `reason` 是 `threshold` 且 `before` 不超過 `triggerTokens` 時，回傳 `{ state: "skipped" }`。
3. 呼叫 `planCompaction`。結果是 `null` 時回傳 `skipped`。
4. 送出 `context-compaction` 事件，`state` 是 `started`。
5. 摘要成功後，建立摘要訊息，放在 `tail` 前面：

```typescript
{
	id: `summary:${operationId}`,
	role: "user",
	parts: [{ type: "text", content: `${summaryPreamble}\n\n${summary}` }],
	metadata: { fromSummary: true },
}
```

`summaryPreamble` 告訴模型這段是先前對話的摘要，不是新的要求。

6. 用新的 context 再估算一次 `after`。只有 `after < before` 才回傳 `done`。摘要比它取代的訊息還長時，回傳 `failed`，保留原本的 context。
7. 摘要過程丟出錯誤時回傳 `failed`。但如果是取消訊號造成的，就把取消往外拋，不要當成摘要失敗。

## 7. 保存壓縮結果

建立 `publishCompaction({ runId, operationId, outcome, conversation })`：

- `done`：display 加上摘要訊息，context 換成 `outcome.messages`。
- `failed` 或 `skipped`：conversation 不變。

在 `run-store.ts` 建立 `checkpointCompaction(runId, operationId, conversation, state)`，在同一個 transaction 裡完成：

1. 鎖定 run，查詢 `event_key` 為 `compact:<operationId>` 的事件。
2. 事件已存在時，比對保存的 state。相同就直接返回，不同就丟出錯誤。
3. `state` 是 `done` 時，更新 projection，並寫入一筆 display 的 `snapshot` 事件。
4. 寫入 `context-compaction` 事件，`state` 是這次的結果。

在 `shared/compaction-event.ts` 用 zod 定義事件。`name` 固定為 `context-compaction`，`value` 包含 `runId`、`operationId` 與 `state`。前後端都用 `parseCompactionEvent` 讀取，不各自判斷欄位。

資料庫寫入失敗時，讓錯誤往外拋。不要把它包成 `failed`，否則恢復時會以為摘要失敗，而不是重試保存。

## 8. 在每輪模型請求前檢查門檻

在 `agent-loop.ts` 加入一個 `compaction` 參數。主對話傳入 `{ kind: "chat", compact }`，每輪呼叫模型前先執行：

```typescript
conversation = await compaction.compact({ conversation, reason: "threshold", turn });
```

`run.ts` 的 `compactConversation` 用兩個 DBOS steps 實作 `compact`：

```typescript
const operationId = `${run.runId}/compact/${turn}`;
const outcome = await DBOS.runStep(() => prepareCompaction({ ... }), { name: `compact:${turn}` });
```

`outcome.state` 不是 `skipped` 時，再用 `publish-compact:${turn}` 這個 step 呼叫 `publishCompaction`。門檻檢查結果為 `skipped` 時，不寫入任何事件。這個檢查每輪都會發生，寫入事件只會讓紀錄變多。

## 9. 模型回報超限時壓縮並重試一次

在 `model-turn.ts` 建立 `ContextOverflowError`，以及判斷錯誤的 `throwProviderError(error)`：

- 錯誤碼是 `context_length_exceeded`、`max_context_length_exceeded` 或 `context_window_exceeded` 時，判定為超限。
- 沒有錯誤碼，或錯誤碼只有 400、413，而且訊息符合 `maximum context length is N tokens` 這類格式時，也判定為超限。
- 401、403、408、429、5xx 與網路錯誤不是超限，照原本的方式重試或失敗。

建立串流時丟出的錯誤，以及串流中收到的 `RUN_ERROR`，都經過 `throwProviderError` 判斷。超限可能在任一個位置出現。

`modelStep` 捕捉到 `ContextOverflowError` 時，回傳 `{ state: "overflow" }`，不要丟出錯誤。丟出錯誤會讓 DBOS 依 `MODEL_RETRY` 用同一份 context 重送，每次都一樣超限。

`agent-loop` 收到 `overflow` 後，依序執行以下 steps：

1. `reset-model:<turn>:overflow`：送出 display 的 `snapshot`，撤回這次請求已串流到前端的內容。
2. 用 `reason: "overflow"` 呼叫 `compact`。這次不檢查門檻。step 名稱用 `compact-overflow:<turn>` 與 `publish-compact-overflow:<turn>`，`operationId` 用 `<runId>/compact-overflow/<turn>`，和同一輪的門檻壓縮分開。
3. 壓縮結果不是 `done` 時，丟出 `ContextOverflowError`。
4. `model-overflow:<turn>`：用壓縮後的 context 重送一次。
5. 仍然超限時，送出 `reset-model:<turn>:exhausted`，再丟出 `ContextOverflowError`，run 失敗。

只重試一次。不限次數時，超限、壓縮、再超限會一直循環，每次都多花一次摘要請求。

## 10. 在介面顯示壓縮狀態

在 `use-threads.ts` 用 `parseCompactionEvent` 讀取事件：

- `started`：thread 的 phase 改成 `compacting`，`status-badge.tsx` 顯示 `compact...`。
- `done`、`skipped`、`failed`：回到原本的 phase，顯示對應的提示。

`message-list.tsx` 遇到 `fromSummary` 的訊息時，標題顯示「壓縮摘要」，內容顯示完整摘要。原始訊息仍然在 display 裡，照原本的方式顯示。

接著依照[建立手動壓縮](manual-compact.md)加入 `/compact`。
