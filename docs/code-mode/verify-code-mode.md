# 驗證 Code Mode

用真實 QuickJS driver、假模型與可控制的工具，驗證程式能組合結果，也會在越權或超限時停止。先完成[建立 Code Mode](implement-code-mode.md)。

## 1. 建立離線驗收資料

在 `tests/server/harness/tools/code-mode.test.ts` 建立工具層測試。使用暫存目錄、固定檔案內容與記錄呼叫的 dispatcher，結束時清理暫存檔案。

執行真實 QuickJS driver，不要 mock 掉 `execute` 後只斷言程式字串。MCP 沿用 `tests/fixtures/mcp-fixture.ts` 在本機啟動的 HTTP MCP server，從 fixture 讀取 `tools/list` 與 `tools/call` 的紀錄。所有憑證測試使用假的 sentinel，不使用真實 token。

先用以下短程式驗證 Pi `read` 結果的整理：

```typescript
	const file = await external_read({ path: "測試產生的暫存檔路徑" });
	return file.content.map((part) => part.text).join("");
```

把範例路徑換成測試建立的檔案。確認回傳實際內容，再用 `write`、`edit`、`read` 依序修改與讀回。從 host 直接讀檔核對內容，不能只相信工具回傳成功。

## 2. 驗證模型看到的契約

用 `getModelTools(messages)` 檢查以下結果：

- 原工具仍可直接呼叫，另有名為 `codemode` 的工具。
- 對外 schema 只接受 `{ code: string }`，沒有 `typescriptCode` 或額外欄位。
- Prompt 保留工具 description 與參數宣告，函式名稱和實際 bindings 一致。
- `external_codemode` 與 `external_discover_atlassian_tools` 都不存在。
- 未探索的 MCP 工具沒有 binding。成功 discovery 後，下一輪才出現。
- 不完整、失敗或偽造的 discovery 歷史不會開放工具。
- `external_read` 與已探索的 `external_jira_get_issue` 宣告為 `Promise<...Output>`，且 Output 列出 `key`、`summary` 等欄位。

在 `atlassian.test.ts` 讓 fixture 的工具帶上 `x-fastmcp-wrap-result`，並回傳 `{ result: "<JSON>" }`。確認 `executeTool` 拿到解析後的物件；`result` 不是 JSON 時，拿到原字串。

再讓 guest 猜一個沒有開放的函式名稱。確認呼叫失敗，dispatcher 與 MCP fixture 的呼叫次數都沒有增加。

## 3. 驗證 bridge 與停止邊界

在測試中縮小預算，讓超限情境保持短暫。每個情境都記錄 dispatcher 次數、結果與事件。

1. 送出非物件工具輸入與不合 schema 的參數。確認錯誤發生在實際操作前。
2. 執行有型別語法的程式與互不依賴的平行讀取。確認參數與結果能往返 JSON，子呼叫 ID 唯一，且共用呼叫預算。
3. 超過 source、host 輸入、host 結果與最終結果限制。確認超限位置之後沒有新操作，也沒有把過大的結果交給模型。
4. 執行無窮迴圈與超過 QuickJS heap 預算的配置。確認取得受控錯誤，之後的新執行仍能成功。
5. 大量輸出中文與 emoji，再嘗試改寫 console 及相關原型。確認限制按 UTF-8 bytes 生效，host collector 沒有先接收完整超量文字。
6. 在開始前取消，在 host 工具等待中取消，再讓工具於取消後才完成。確認後續呼叫遭拒絕，遲到事件不寫入 buffer。
7. 故意漏掉 `await`，讓 Promise continuation 嘗試再呼叫另一個工具。確認執行結束後不再 dispatch 新工作。
8. 在程式、參數、host 結果、console 與錯誤中放入假憑證。讓 guest 捕捉例外後繼續，確認 wrapper 仍判定失敗，模型結果與事件沒有 sentinel。

測試取消時，另外記錄 host 工作是否真的結束。回傳超時、取消 guest 等待與停止 host 操作是不同觀察結果。對忽略取消訊號的 handler，記錄其限制，不宣稱外部副作用已撤回。

## 4. 驗證事件與完整聊天

在 `tests/server/harness/code-mode-run.test.ts` 用 `runAgentLoop`、假的 `chatStream` 與真實的 `withRunTools` 連接 Code Mode。Checkpoint 直接執行 `work`，不需要資料庫。第一輪要求讀取暫存檔並回傳短結果，第二輪根據結果回答。

確認模型第二輪只收到一個外層工具結果。結果可以包含受限 logs，但不會自動增加每個內部工具的完整訊息。

在 `tool-events.test.ts` 與 `code-mode-run.test.ts` 檢查：

- 自訂事件包含 parent tool call ID，並依事件順序保存。
- 事件只保留追蹤資料，沒有完整 source、參數、工具內容或 console 文字。
- `execution_finished` 先於外層 `TOOL_CALL_RESULT`。
- 事件 buffer 超限會停止接受事件，不會無限制堆積。
- 儲存失敗時停止保存後續事件。

SSE 重連與瀏覽器斷線沿用 Durable Execution 章的測試，這一章不重複驗證。

這種事件 buffer 在工具結束後才交給儲存層，不能宣稱每個內部呼叫都即時顯示，也不能把已看到事件當作 checkpoint 已完成。

## 5. 用兩個 server 程序驗證恢復

使用專用 Postgres 與真正的 DBOS。沿用前章的[中斷驗收方式](../durable-execution/verify-recovery.md)，在確認指定位置後才用 `SIGKILL` 終止 server，再啟動另一個程序恢復。

用工作目錄內的計數檔觀察副作用。先寫入 `0`，再要求模型逐字以下列程式呼叫一次 `codemode`。程式讀取計數、加一後寫回，再空轉 8 秒，留下終止的時間。

```typescript
	const file = await external_read({ path: "tool-playground/counter.txt" });
	const count = Number(file.content[0].text.trim()) + 1;
	await external_write({ path: "tool-playground/counter.txt", content: String(count) });
	const until = Date.now() + 8000;
	while (Date.now() < until) {}
	return count;
```

驗證以下兩個情境，每個情境前把計數重設為 `0`：

1. 等到 `chat_events` 出現 `TOOL_CALL_RESULT`，也就是外層 checkpoint 完成後再終止。重啟後計數維持 `1`，`code_mode:execution_started` 只有一筆，模型取得已保存的結果。
2. 等到計數變成 `1`，也就是寫入已成功、外層 checkpoint 尚未完成時終止。重啟後整段程式重跑，計數變成 `2`，工具結果也是 `2`。

兩個情境的 run 都應以 `succeeded` 結束。第 2 個情境證明已成功的 host 操作會在恢復時再做一次。不要在正式 Jira 寫入留言做中斷測試。若使用假的 checkpoint，只把結果列為離線流程驗證，不能當成跨程序恢復通過。

## 6. 交付驗收結果

執行 `pnpm test`、`pnpm typecheck`、`pnpm exec oxlint` 與 `pnpm build`。依 `AGENTS.md` 執行提交前檢查。

記錄各項檢查的通過、失敗或未執行狀態。對中斷情境保存 run ID、終止位置、計數檔的值與最終結果。缺少資料庫或 MCP 服務時，指出受阻的項目，不以 fixture 結果代替。

這個 Target 完成時，應能證明程式可使用獲准工具、限制生效、事件與對話可保存，以及整段重跑的副作用風險有明確處理。
