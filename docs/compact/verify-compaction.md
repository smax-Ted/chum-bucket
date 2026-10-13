# 驗證 Compact

先用假的摘要模型與固定訊息驗證切分和保存，再用真實模型與瀏覽器確認三個功能。先完成[建立自動壓縮](implement-compaction.md)、[建立手動壓縮](manual-compact.md)與[建立附屬對話](side-chat.md)。

## 1. 驗證切分與摘要請求

在 `tests/server/harness/compaction.test.ts` 直接呼叫 `planCompaction` 與 `prepareCompaction`。摘要模型用假的 `chatStream` 取代，記錄收到的請求並回傳固定文字。

確認 `planCompaction` 的結果：

- 只有一組問答時回傳 `null`。
- 多組問答時，`tail` 從最早一個放得進 `keepRecentTokens` 的 user 訊息開始。
- 切分點不會落在工具呼叫和結果之間。呼叫的 `state` 不是 `complete` 或 `error`，或有重複的呼叫 ID 時，回傳 `null`。
- 只有一則使用者訊息、後面接很長的工具迴圈時，切分點落在 assistant 訊息。
- 摘要訊息不在第一則時回傳 `null`，不丟掉它。

確認 `prepareCompaction` 的結果：

- 低於門檻時回傳 `skipped`，假模型沒有收到請求。
- 超過門檻時回傳 `done`。新 context 的第一則是 `fromSummary` 訊息，後面是 `tail`，估算值比壓縮前小。
- 第二次壓縮時，請求內容的 `previousSummary` 是上一份摘要原文，請求的 `tools` 是空陣列。
- 假模型回傳以下內容時，結果是 `failed`，原本的訊息不變：finish reason 為 `length`、工具呼叫、空字串、超過 8,000 字元、安全分類標記。
- 工具定義大到摘要後仍不會變小時，結果是 `failed`。
- 資料庫寫入失敗時，錯誤往外拋，結果不是 `failed`。

## 2. 驗證 display 與 context 的保存

在 `conversation.test.ts` 與 `run-store.test.ts` 確認：

- `advanceConversation` 不把 `fromSummary` 訊息加進 display。
- 新訊息的 ID 和 display 裡被壓縮的舊訊息相同時，丟出錯誤。
- `checkpointCompaction` 用同一個 `operationId` 呼叫兩次，只寫入一筆事件。第二次的 state 不同時丟出錯誤。
- 壓縮後結束 run，下一個 run 的 `AcceptedRun.context` 從摘要開始，`threads.messages` 仍保留全部原文和摘要。
- `threads.messages` 有摘要但找不到 context anchor 時，`persistRun` 回傳 409。

## 3. 驗證超限重試

在 `agent-loop.test.ts` 用假的 `chatStream` 模擬供應商錯誤：

1. 第一次丟出 `{ code: "context_length_exceeded" }`，第二次正常回覆。確認依序出現 `reset-model:0:overflow`、`compact-overflow:0`、`model-overflow:0` 三個 step，run 成功。
2. 兩次都超限。確認出現 `reset-model:0:exhausted`，run 以 `ContextOverflowError` 失敗，沒有第三次請求。
3. 丟出 429 與 `fetch failed`。確認它們照原本的重試規則處理，不觸發壓縮。

在 `model-turn.test.ts` 確認 `RUN_ERROR` 事件和直接丟出的錯誤都能被判定為超限。

## 4. 驗證中斷後不重複摘要

用真實 DBOS 與 PostgreSQL 執行一次會觸發壓縮的 run。讓假的摘要模型在回傳後記錄次數，並在 `publish-compact:<turn>` 開始前結束程序。

重新啟動後確認：

- 摘要模型的呼叫次數仍是 1。DBOS 重用 `compact:<turn>` 保存的結果。
- `chat_events` 裡只有一筆 `compact:<operationId>`。
- run 正常結束，context 從摘要開始。

## 5. 驗證附屬對話的邊界

在 `side-chat.integration.test.ts` 用真實資料庫確認：

- 主對話執行中或 `parentId` 是附屬對話時，open 回傳 409。
- 附屬對話 run 結束後，主對話的 `threads.messages` 與 `revision` 都沒變。
- 主對話壓縮過時，附屬對話第一個 run 的 context 從主對話的摘要開始。
- 摘要請求只包含附屬對話新增的訊息，不包含 `seed.display` 裡的訊息。
- 用同一段文字送回兩次，第二次回傳相同的 `runId`，主對話只多一則訊息。附屬對話刪除後再重送，結果相同。用不同文字重送，回傳 409。
- run 執行中呼叫 `DELETE`，run 在下一個 step 前停下，workflow 結束後資料列才被刪除。
- 留下一個開啟中的附屬對話，重新啟動伺服器。啟動後 `side_chats` 沒有資料列，DBOS 沒有恢復它的 run。

## 6. 用真實模型與瀏覽器驗收

48,000 tokens 的門檻需要很長的對話才會觸發。驗收自動壓縮時，用環境變數暫時調低 policy：

1. 在新 thread 送出一則短訊息，在 `prepareCompaction` 印出 `before`。這是固定 prompt 和工具定義的大小。
2. 在 `.env` 把 `COMPACT_TRIGGER_TOKENS` 設成這個值加 8,000，`COMPACT_KEEP_RECENT_TOKENS` 設成 4,000，再重新啟動伺服器。驗收後刪掉這兩行。

接著在瀏覽器依序操作：

1. 在主對話送出數則讀檔或要求長回覆的請求，直到狀態標籤顯示 `compact...`。確認訊息清單出現「壓縮摘要」，原文仍在。問答太短時，摘要會比被取代的原文還長，結果是「整理上下文失敗」，這是預期行為。
2. 重新整理頁面。確認摘要與原文都還在，再送一則訊息，確認模型能接著回答。
3. 在新的空白 thread 輸入 `/compact` 並送出。確認顯示「目前沒有足夠的可整理歷史」，沒有新增使用者訊息。
4. 在有足夠歷史的 thread 輸入 `/comp`，用方向鍵和 Enter 選取命令。確認只建立一個 compact run，畫面顯示「上下文已整理」。
5. 開啟附屬對話，問一個和主線無關的問題。確認主對話的訊息沒有增加。
6. 再開一個附屬對話，送出一則訊息後重新整理頁面。確認附屬對話窗格沒有恢復，資料庫裡也沒有它的 thread。
7. 回到第 5 步的附屬對話，按「預覽摘要」，編輯草稿後送出。確認附屬對話窗格關閉，主對話多一則使用者訊息，內容是編輯後的文字，主模型開始回覆。
8. 從資料庫確認附屬對話的 thread、run、事件與 `side_chats` 資料列都已刪除。

保存每一步的截圖、run ID、`chat_events` 中的 `context-compaction` 事件，以及壓縮前後的 `chat_runs.projection`。
