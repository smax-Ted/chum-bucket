# 建立附屬對話

附屬對話讓使用者暫時離開主線，問一個旁支問題，例如「這個錯誤是什麼意思」，而不讓問答塞滿主對話的 context。討論結束後，使用者把摘要編輯成一則訊息，送回主對話。這就是 Target 裡的 BTW。

附屬對話遵守以下規則：

- 開啟時複製主對話當下的內容。之後主對話的新訊息不會同步過來。
- 附屬對話的 run 不修改主對話。
- 只有使用者確認後的摘要會進入主對話，附屬對話的原文不會。
- 關閉就是停止並刪除。重新整理頁面後，附屬對話不會恢復。

因為關閉就刪除，附屬對話不需要跨程序恢復，也不需要保存草稿。程式只要處理好「刪除前先停下執行中的 run」。

先完成[建立自動壓縮](implement-compaction.md)。附屬對話的 run 也走 `agent-loop`，超過門檻時一樣自動壓縮。

## 1. 建立資料表

`threads.parent_thread_id` 已經存在。附屬對話的 thread 用它指向主對話。另外新增 `side_chats` 表，用 drizzle-kit 產生 migration：

- `id`：和附屬對話 thread 的 `id` 相同。
- `parent_thread_id`：主對話 thread。
- `state`：`open` 或 `closing`。刪除完成後，整列一起刪掉。
- `seed`：開啟時主對話的 `{ display, context }`。

## 2. 開啟附屬對話

`POST /api/side-chat/open/:parentId`。在同一個 transaction 裡依序處理：

1. 鎖定主對話 thread。找不到時回傳 404。
2. `parentId` 本身是附屬對話時，回傳 409。本章不支援巢狀附屬對話。
3. 主對話有執行中的 run 時，回傳 409。執行到一半的內容不能當起點。
4. 建立 `seed`。`display` 是主對話的 `threads.messages`。`context` 用和 `persistRun` 相同的方式從 context anchor 讀回。主對話壓縮過時，附屬對話從摘要和近期訊息開始，不是從全部原文開始。
5. 新增 `side_chats` 資料列，再新增一個 `threads` 資料列。這個 thread 的 `messages` 是 `seed.display`，`title` 是「附屬對話」。

附屬對話 thread 第一次執行 run 時，revision 是 0，還沒有 context anchor。這時用 `seed.context` 當 context。

## 3. 在附屬對話裡執行 run

附屬對話的訊息照樣送到 `POST /api/chat`，`threadId` 是附屬對話的 ID。`persistRun` 發現這個 thread 有 `parent_thread_id` 時，確認 `side_chats.state` 是 `open`，再接受 run。

在 `agent-loop` 每次模型請求與工具呼叫前，呼叫 `assertExecution(run)`。附屬對話的 run 會重新讀取 `side_chats`。資料列不存在或狀態不是 `open` 時，丟出錯誤，停止這個 run。附屬對話開始關閉後，還在執行的 run 會在下一個 step 前停下。

附屬對話使用和主對話相同的工具，工具造成的變更是真實的。例如在附屬對話裡用 `write` 改了檔案，關閉附屬對話不會還原檔案。

## 4. 產生摘要

`POST /api/side-chat/:id/summary`，回傳 `{ text }`。附屬對話有執行中的 run 時，回傳 409。

摘要只涵蓋附屬對話新增的訊息。從附屬對話的 `threads.messages` 取出 ID 不在 `seed.display` 裡、也沒有 `fromSummary` 標記的訊息。沒有任何新訊息時，回傳 409。

用 `summarizeTranscript(plan, "side-summary", signal)` 產生摘要。這裡用 `sideSummarySystemPrompt`，和自動壓縮的 prompt 不同：

- 只整理附屬對話新增的討論，不重述主對話的內容。
- 用繁體中文寫成純文字，因為使用者要直接閱讀和編輯。
- 不提出新的要求，也不呼叫工具。

附屬對話可能很長，超過一次摘要請求的大小。把每則訊息的 JSON 切成 12,000 字元的片段，累積到 60,000 bytes 就送出一次摘要。下一批再把上一次的結果當 `previousSummary` 傳入。

伺服器不保存摘要。使用者編輯後的文字才是要送回主對話的內容，草稿只存在前端。

## 5. 把摘要送回主對話

使用者在「編輯回填摘要」修改文字後，按「確認回填並送出」。前端送出 `POST /api/side-chat/:id/transfer`，body 是 `{ text }`。

一個附屬對話只會送回一次，所以主對話 run 的 `runId` 與訊息 ID 固定為 `side-<附屬對話 ID>`。伺服器在同一個 transaction 裡處理：

1. 查詢這個 `runId`。已存在時，文字相同就回傳原本的 run，不同就回傳 409。
2. 確認附屬對話是 `open`，且沒有執行中的 run。
3. 確認主對話沒有執行中的 run。
4. 在主對話建立 chat run，訊息文字是使用者編輯後的摘要。
5. 把附屬對話改成 `closing`。

transaction 結束後，啟動主對話的 run，再刪除附屬對話，最後回傳主對話的 `runId`。

網路中斷時，前端不知道伺服器是否已經收到，因此用同一段文字重送。即使附屬對話已經刪除，步驟 1 仍會回傳原本的 run，主對話不會收到兩則訊息。

## 6. 關閉時停止並刪除

`DELETE /api/side-chat/:id` 與送回摘要後的清除，都走同一個 `discardSideChat(id)`：

1. 把狀態改成 `closing`。之後的 `assertExecution` 都會失敗。
2. 取消這個附屬對話正在產生的摘要。
3. 對每個 run 呼叫 `DBOS.cancelWorkflow`，等 workflow 真的結束。
4. 刪除事件、run、附屬對話 thread 與 `side_chats` 資料列。

第 3 步一定要等 workflow 結束。只送出取消就刪除資料列，還在執行的 step 會寫入已刪除的 run。

重新整理或關閉分頁時，前端在 `pagehide` 對每個開啟中的附屬對話送出 `DELETE`，並加上 `keepalive: true`，讓請求在頁面卸載後仍能送出。

`pagehide` 不保證會觸發，例如瀏覽器當掉時。所以伺服器啟動時，在 `DBOS.launch()` 之前把所有附屬對話改成 `closing`，並用 `DBOSClient` 取消它們的 workflow。這樣 DBOS 不會恢復上一個程序留下的附屬對話 run。啟動後再刪除這些資料列。伺服器關閉前也刪除所有附屬對話。

瀏覽器當掉後到下次重啟前，殘留的附屬對話會留在資料庫裡。介面不會再顯示它，它也不影響主對話。

## 7. 接上附屬對話窗格

`workshop/03-code-mode` 已有預留的窗格和「開啟附屬對話」按鈕。在 `use-side-chats.ts` 管理窗格清單：

- 開啟時呼叫 open API，用回傳的 ID 載入附屬對話 thread。輸入框改成可以送出。
- 按「關閉」時呼叫 `DELETE`，移除窗格。
- 註冊 `pagehide`，卸載頁面時刪除所有開啟中的附屬對話。
- 只在主對話窗格顯示「開啟附屬對話」。預留窗格目前在附屬窗格也有這個按鈕，要拿掉。

`side-chat-pane.tsx` 在標題列加上「預覽摘要」按鈕，附屬對話執行中時停用。摘要回來後，在「摘要預覽」卡片提供可編輯的文字框與送出按鈕。主對話有執行中的 run 時，不送出，保留草稿並提示稍後再確認。送出成功後，關閉窗格，主對話開始回覆這則摘要。

接著依照[驗證 Compact](verify-compaction.md)確認三個功能。
