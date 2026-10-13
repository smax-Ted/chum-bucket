# 建立自訂工具

建立 `get_figma` 與 Pi 的 `read`、`write`、`edit`，再把工具接入聊天。以下工具檔案放在 `server/harness/tools/`。

## 0. 集中測試目錄

後續每一章都會新增測試。先把測試集中到 `tests/`，讓所有章節使用同一個指令。

- 把既有的 `server/**/*.test.ts` 與 `src/**/*.test.ts(x)` 搬到 `tests/`，路徑對應原始碼。例如 `server/harness/tools/get-figma.ts` 的測試放在 `tests/server/harness/tools/get-figma.test.ts`。
- 把多個測試共用的替身放在 `tests/fixtures/`。
- 新增 `tests/tsconfig.json`，繼承根目錄的 `tsconfig.json`，並包含 `tests/` 與原始碼目錄。
- 新增 `tests/runner.mjs`。沒有參數時，它找出 `tests/` 底下所有 `*.test.*`；有參數時只執行指定檔案。它用 `node --import tsx --test` 執行，並設定 `TSX_TSCONFIG_PATH=tests/tsconfig.json`。
- 在 `package.json` 加入 `"test": "node tests/runner.mjs"`，並把 `typecheck` 改成 `tsc -p tsconfig.json && tsc -p tests/tsconfig.json`。

執行 `pnpm test` 與 `pnpm typecheck`，確認搬移後的既有測試都通過。

## 1. 實作 get_figma

在 `get-figma.ts` 建立 `getFigma`。用 `toolDefinition` 宣告名稱、description 與 input schema，再用 `.server()` 綁定 handler。

依照以下要求處理輸入與 API 回應：

- 讓 `target` 接受 Figma `/file/`、`/design/` URL 或 file key。URL 含 `/branch/{key}` 時，改用 branch 的 key。
- 用選填的 `nodeId` 覆蓋 URL 的 `node-id`，並把 `1-2` 轉成 `1:2`。
- 限制 `depth` 為 1–10 的整數，預設 2。限制 `offset` 為非負整數，預設 0，只用於摘要分頁。
- 在 handler 內讀取 `process.env.FIGMA_API_KEY`，用全域 `fetch` 呼叫 API。
- 固定呼叫 `https://api.figma.com/v1/files/{key}`，指定節點時改呼叫 `/nodes?ids=...`。拒絕非 `figma.com` 的 URL，不讓模型指定 API URL。
- 用 `AbortSignal.any` 合併 30 秒逾時與 `context.abortSignal`。
- 保留節點 ID、名稱、文字、尺寸、layout 與樣式，移除隱藏節點。
- 詳細結果超過 30,000 bytes 時，改回傳節點摘要，每頁 20 筆，並附上 `nextOffset`。摘要總數只計算本次取得的節點。
- 用 `depthLimited` 標記子節點可能不完整，用 `truncated` 標記結果是否改成摘要。
- 遇到缺少金鑰、無效的 URL、file key 或 node ID、HTTP 錯誤、非 JSON 回應、找不到節點時，丟出簡短的 `Error`。錯誤訊息只帶 HTTP status，不帶金鑰或回應 body。

新增 `tests/server/harness/tools/get-figma.test.ts`，使用 `node:test`。在測試中替換 `globalThis.fetch` 與 `process.env.FIGMA_API_KEY`，結束後還原。驗證以下行為：

- URL 解析與指定節點。
- 移除隱藏節點。
- 摘要分頁。
- 錯誤處理。
- 結果標明深度限制，以及是否改成節點摘要。

參考 commit：`9945adf`（`feat(tools): add Figma and ticket tools`）。

## 2. 包裝 Pi 的 read、write、edit

`cwd` 只是相對路徑的起點，不能限制工具可存取的路徑。請在沒有私人檔案的練習環境操作。這個 Target 不建立檔案沙箱，也不建立寫入批准 UI。已開始的寫入被取消後，也不會自動復原。

在 `fs.ts` 用 `@earendil-works/pi-coding-agent` 的 `createReadTool`、`createWriteTool`、`createEditTool` 建立工具，並傳入 `process.cwd()`。每個工具都用 `toolDefinition` 包裝，保留 Pi 的 `name`、`description` 與 `parameters`，再用 `.server()` 綁定 handler。

讓 handler 先用 Zod 驗證輸入，再呼叫 Pi 的 `execute(toolCallId, input, abortSignal)`。缺少 `toolCallId` 時丟出錯誤。直接回傳 Pi 的結果，保留 `content` 與 `details`。

三個工具的輸入如下：

- `read` 接受 `{ path, offset?, limit? }`，`offset` 從第 1 行開始。
- `write` 接受 `{ path, content }`，會建立父目錄並覆寫檔案。
- `edit` 接受 `{ path, edits: [{ oldText, newText }] }`，依原始文字做精確替換。找不到文字、匹配到多處，或修改範圍重疊時，Pi 拒絕修改並保留原檔。

新增 `tests/server/harness/tools/fs.test.ts`，只在 `mkdtemp` 建立的暫存目錄操作，並把路徑轉成相對於 `process.cwd()` 的路徑。驗證以下行為：

- write、read、edit、再 read 的內容相符。
- 錯誤的 edit 不改檔。
- 傳入已取消的 `abortSignal` 時，三個工具都回報 `Operation aborted`，檔案與目錄維持原狀。
- 缺少 `toolCallId` 時，工具在執行前失敗。

參考 commit：`469c874`（`feat(tools): fs tool`）裡的 `fs.ts` 與 `fs.test.ts`。該 commit 的 `run.ts` 已改用 DBOS，這一章不需要。

## 3. 將自訂工具接入聊天

在 `index.ts` 匯出 `localTools = [getFigma, read, write, edit]`。在 `server/chat.ts` 把清單傳給原生 `chat()` 的 `tools`。金鑰與 handler 都留在後端，模型只看到工具定義。

把 `tool-playground/` 加入 `.gitignore`。在聊天介面依序執行檔案寫入、讀取、修改與讀回，再讀取一個有權限的 Figma 檔案與指定的 frame。確認工具結果有回到模型，重新整理頁面後仍能讀回對話。

接著[接入本機 Atlassian MCP](atlassian-mcp.md)，完成兩組工具的串接驗收。
