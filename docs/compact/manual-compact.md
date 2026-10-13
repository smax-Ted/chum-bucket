# 建立手動壓縮

讓使用者在輸入框送出 `/compact`，立即整理目前 thread 的 context。手動壓縮沿用[自動壓縮](implement-compaction.md)的 `prepareCompaction` 與 `publishCompaction`，差別是不檢查門檻，也不呼叫對話模型。

## 1. 在輸入框辨識命令

在 `src/composer-commands.ts` 定義命令清單：

```typescript
const COMPOSER_COMMANDS = [
  { name: "compact", description: "整理對話上下文，保留原文與完整摘要" },
] as const;
```

建立以下函式，讓 `composer.tsx` 只處理畫面：

- `parseComposerCommand(text)`：去除前後空白後，只有內容完全等於 `/compact` 才回傳 `"compact"`。`/compact 保留決策` 是一般訊息，照常送給模型。
- `commandSuggestions(input)`：輸入框有焦點、內容符合 `/^\/[a-z]*$/`、不在輸入法組字中時，回傳名稱開頭相符的命令。
- `composerKeyAction(input)`：選單開啟時，上下鍵移動選項，Enter 選取並送出，Escape 關閉選單。組字中的 Enter 不送出，判斷 `isComposing` 與 `keyCode === 229`。

選單用 `role="listbox"`，名稱是「對話命令」，每個選項用 `role="option"`。點選或用 Enter 選取時直接送出命令，不只是補完文字。

## 2. 用獨立的 endpoint 建立 compact run

前端遇到 `/compact` 時，送到 `POST /api/compact`，不送到 `/api/chat`：

```json
{ "kind": "compact", "threadId": "<uuid>", "runId": "<id>", "baseRevision": 3 }
```

在 `run-store.ts` 定義 `compactInputSchema`。它和 `chatInputSchema` 共用 `threadId`、`runId`、`baseRevision`，但沒有 `message`。`runInputSchema` 改成兩者的 union。

Compact run 和 chat run 走同一個 `persistRun`。它一樣佔用 thread 的 `active_run_id`，一樣檢查 `baseRevision`。所以 thread 正在執行時送出 `/compact` 會收到 409，兩個 run 不會同時修改 context。輸入框也不會把 `/compact` 存成一則使用者訊息。

`server/chat.ts` 的 `compact` route 解析 body，檢查 `X-Run-Id` 與 body 的 `runId` 相同，再回傳和 chat 相同的 SSE 事件流。前端重連時帶 `Last-Event-ID`，處理方式和 chat 一樣。

## 3. 執行 compact run

在 `executeRun` 依 `run.kind` 分流：

```typescript
if (run.kind === "compact") {
  await finishCompactRun(run, conversation, tools, signal);
} else {
  await finishChatRun(run, conversation, tools, signal);
}
```

`finishCompactRun` 用 `reason: "manual"` 呼叫 `compactConversation`，`turn` 固定為 `0`：

- `prepareCompaction` 不比較 `triggerTokens`，直接呼叫 `planCompaction`。
- `planCompaction` 回傳 `null` 時，結果仍是 `skipped`。歷史太短，或工具呼叫還沒完成，都不能壓縮。
- 不論結果，都用 `publish-compact:0` 保存。自動壓縮的 `skipped` 不寫事件，手動壓縮則一定要寫，前端才知道命令已處理完。

最後用 `finish` step 結束 run：

- `done` 與 `skipped`：用 `finishRun(runId, conversation)` 正常結束。`skipped` 時 display 與 context 都沒變。
- `failed`：用 `finishRun(runId, undefined, "compaction_failed")` 讓 run 失敗。thread 保留原本的 display 與 context。

## 4. 在介面顯示結果

`use-threads.ts` 送出 compact run 時，把 phase 設成 `compacting`，輸入框暫時不能送出。收到 `context-compaction` 事件後，依 `state` 顯示提示：

- `done`：上下文已整理，完整摘要與原文已保留。
- `skipped`：目前沒有足夠的可整理歷史，原文與上下文未變更。
- `failed`：整理上下文失敗，原文與上下文已保留。

`failed` 的提示用 `role="alert"`，其餘用 `role="status"`。重新整理頁面後，摘要訊息仍然顯示在原文之後，標題是「壓縮摘要」。

接著依照[建立附屬對話](side-chat.md)加入 BTW。
