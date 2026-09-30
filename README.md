# Chum Bucket：打造 Jira Acceptance Agent 的 Harness Workshop

> 用 Coding Agent 協助開發，親手理解讓 Agent 可控、可恢復、可驗證的系統設計。

## Before Start

這是一份內部教學教材。重點不是做出功能最多的聊天介面，而是理解：**模型提出下一步時，誰決定能不能做、在哪裡做、失敗怎麼辦，以及如何證明真的完成？**

開發時可以使用任意 Coding Agent。示範預計使用 [pi](https://pi.dev/) 搭配 [pstack](https://github.com/backnotprop/pstack)，必要時手動修改與審查，避免實作偏離目標。

請先分清楚兩個角色：

- **協助我們開發的 Coding Agent**：pi 與搭配的開發工具，幫我們讀寫程式、探索設計。
- **我們要建立的 Harness**：本專案的執行系統，負責模型呼叫、工具、狀態、權限與執行生命週期。

使用現成 Coding Agent 寫程式，不代表已經理解 Harness；本課程要求能解釋它產生的設計，也能用失敗案例驗證它。

### 適合誰、需要先會什麼

對象是工程師，總長 **6 小時，含兩次各 10 分鐘休息**。需具備 TypeScript、非同步程式設計、HTTP API 與基本測試經驗；不需要先做過 multi-agent 系統。課前先熟悉基本 LLM API 與 Playwright locator／assertion，現場時間用在 Harness 的取捨與失敗演練。

### 學完應該能做到

1. 畫出 model → tool → model 的控制流程，指出模型與 Harness 各自的責任。
2. 設計有 schema、權限、錯誤與輸出上限的工具介面。
3. 區分畫面已顯示、step 已 checkpoint，以及外部副作用已提交。
4. 用明確狀態處理重試、中斷、恢復、取消與人工核准。
5. 選擇必要的 context、routing 與 subagent 策略，並量測它們是否值得。
6. 用測試、事件紀錄與評估集證明成果，而不是只看一次成功 demo。

### 如何閱讀這份教材

各章保留原本的主題編號，但不必照編號上課。每章都有「概念 → 練習 → 通過條件」。依 6 小時議程，以準備好的模組進行引導實作；高風險失敗情境使用 fake tool 或預先隔離環境，Routing 與 Subagent 則必須完成實際分派與整合。

**以下練習、示意 API 與 fixture 是課程設計，不代表目前 repository 已全部實作。** 此次教材整理不要求更動現有程式。

## 專案現況與課程範圍

依目前 `main` 的程式與文件，可從下列入口開始讀：

| 入口 | 目前可以觀察的內容 |
| --- | --- |
| [server/harness/run.ts](server/harness/run.ts) | 最多五輪的 model/tool loop；模型與個別工具使用 DBOS steps；finish 與 recovery reconciliation |
| [server/harness/model-turn.ts](server/harness/model-turn.ts) | 模型串流轉成訊息與 tool call 的邊界 |
| [server/harness/run-store.ts](server/harness/run-store.ts) | run、事件、持久化與 thread revision 的處理 |
| [server/harness/tools/get-ticket.ts](server/harness/tools/get-ticket.ts) | Jira issue 唯讀工具，參數驗證與回傳內容限制 |
| [server/harness/tools/get-figma.ts](server/harness/tools/get-figma.ts) | Figma 唯讀工具，depth、摘要與分頁 |
| [docs/dbos-durable-execution.md](docs/dbos-durable-execution.md) | durable 執行合約、恢復邊界、已知限制與離線驗證方式 |
| [docs/frontend-thread.md](docs/frontend-thread.md) | thread UI、重新連線與執行狀態的設計 |

目前的 loop 每次直接提供 `get_ticket`、`get_figma` 兩個工具，且逐一執行回傳的工具呼叫。**Lazy loading、Code Mode、對話 compaction、routing、subagent、人工核准與執行不受信任程式的 sandbox，是本 workshop 的待實作教學能力**，不能因為套件已安裝或章節存在，就視為功能已完成。

## Workshop 主題：Jira Acceptance Agent

從 Jira 的 Acceptance Criteria（AC）與 Figma 設計取得規格，規劃測試，再透過 Playwright 操作指定測試環境，逐條提供判定與證據。

```text
Jira ticket ＋ 指定 Figma frame/version ＋ 測試環境
  → 擷取 AC、確認規格與前置條件
  → 產生 AC coverage matrix 與測試計畫
  → Routing：功能／視覺／兩者／需澄清
  → 專職 Subagents：功能驗證與視覺檢查
  → 彙整 assertion、截圖、trace 與阻礙
  → 逐條驗收報告 → 人工決定後續處理
```

這個主題可以沿用目前的 `get_ticket`、`get_figma`，新增能力集中在瀏覽器執行介面、驗收狀態與協作流程。現有專案不是已完成的驗收 Agent；下列是 workshop 要逐步建立的設計。

瀏覽器操作以 **Playwright** 為基礎；**TypeSafe／Jev 可根據文字與結構化狀態做路由、判斷，也能在受控流程中選擇下一個瀏覽器動作**。Harness 再透過 Playwright 執行。Jev 不直接接收圖片；Figma 圖像與瀏覽器截圖的視覺比較，需交給具備圖片能力的工具／人工審查，或使用經核准的 screenshot baseline。詳見第 5 章與 [TypeSafe State](https://docs.typesafe.ai/concepts/state)。

### 驗收的終點

輸出可追溯的驗收報告，不自動將 Jira 改成 Done，也不自動留言、修程式或發版。Agent 的判定是提交人工審查的證據；是否正式接受交付，屬於團隊的工作流程。

每個 AC 使用四種對外狀態：

| 狀態 | 何時使用 | 報告要附什麼 |
| --- | --- | --- |
| `pass` | 明確條件在指定版本／環境下已全部驗證 | assertion／量測結果、步驟、對應證據 |
| `fail` | 有可重現證據顯示不符合明確條件 | expected vs actual、重現方式、截圖或 trace |
| `blocked` | 環境、權限、資料、規格或執行問題，使必要驗證無法完成 | 具體阻礙與解除方式；不能當成產品 bug |
| `needs-human-review` | 已收集證據，但判定需要人類澄清或主觀設計審查 | 比較圖、差異、待決問題與相關來源 |

內部 lifecycle 另有 `pending`、`running` 等狀態；尚未跑完的 AC 不可提前標成 `pass`。整張 ticket 只有在所有必要 AC 都已通過時，才可回報「本次範圍全部通過」。已知 fail 不會因其他項目 blocked 而被隱藏；報告應同時呈現各狀態數量與未覆蓋範圍。

### 共用教學 Fixture：新增會員表單

使用授課者準備的假 Jira ticket、固定 Figma 設計快照與可重設的測試網站，避免 workshop 依賴真實帳號或正式資料。以下是教學規格，並非已存在於此 repository 的頁面：

| AC ID | 可驗證的條件 | Route | 必要證據 |
| --- | --- | --- | --- |
| AC-01 | 姓名／Email 空白送出時顯示各欄位必填錯誤，不新增會員，錯誤態符合指定 Figma frame | functional + visual | 錯誤文字與未新增的斷言；錯誤態設計比較 |
| AC-02 | 有效資料送出後顯示成功狀態，且測試後端只新增一筆 | functional | UI assertion；測試資料查證 |
| AC-03 | 已存在 Email 顯示重複提示，資料總數不增加 | functional | 預置重複資料、提示與資料計數證據 |
| AC-04 | 1440×900 桌機狀態符合指定 desktop frame | visual | 同狀態截圖、明確版面／樣式檢核 |
| AC-05 | 390×844 手機狀態符合指定 mobile frame，欄位與送出按鈕可操作 | functional + visual | 操作證據、無水平溢出檢查與版面比較 |
| AC-06 | Ticket 另寫「整體操作很順暢」但未定義指標 | clarification | 待澄清的可測量定義，不自行猜測門檻 |

讓 fixture 保留一個已知功能錯誤與一個已知視覺差異，再提供正常版本，用來驗證 Agent 是否能找出問題、是否誤報，以及修正後是否正確重新判定。AC-06 用來練習 `blocked` 與詢問；若規格已明確交由設計師主觀審查，才標成 `needs-human-review`。

### AC Coverage Matrix：從規格到證據

先建立 matrix，再開瀏覽器。每條 AC 至少保存：來源段落、測試前置條件、步驟、expected、route、執行狀態、evidence refs。AC 不可因為難測就從報告消失。

```json
{
  "acId": "AC-01",
  "source": { "ticket": "DEMO-101", "section": "Acceptance Criteria/1" },
  "routes": ["functional", "visual"],
  "preconditions": ["empty form", "isolated test dataset"],
  "expected": ["required errors visible", "member count unchanged", "error state matches approved design"],
  "status": "pending",
  "evidenceRefs": []
}
```

這是建議資料合約，不是現有 API。執行前還要凍結本次 run 的 application build、ticket 擷取時間／版本資訊、Figma version／frame、viewport、browser、locale、字型、測試資料與頁面狀態。來源變更時重新評估受影響的 AC，不把舊證據套到新規格。

### 6 小時議程：360 分鐘

| 時間 | 分鐘 | 教材與實作 | 本段產出 |
| --- | ---: | --- | --- |
| 00:00–00:25 | 25 | Intro、fixture 與四種結果；先看一次有缺陷的驗收 | baseline 與 AC matrix |
| 00:25–01:10 | 45 | Tool、Lazy Loading、Playwright assertion 與證據 | 工具合約、AC-01 的可重現檢查 |
| 01:10–01:40 | 30 | Sandbox、User Approve；辨識表單提交的副作用 | 權限表、核准卡與隔離驗證 |
| 01:40–01:50 | 10 | 休息 | |
| 01:50–02:35 | 45 | Durable；中斷與重試、證據 checkpoint | 故障注入與恢復觀察 |
| 02:35–03:15 | 40 | Agent Routing；functional／visual 多標籤分派 | router 與專職 Agent dispatch |
| 03:15–04:00 | 45 | Subagent；fan-out／fan-in、部分失敗、結果整合 | 兩個 Agent 的獨立執行與完整報告 |
| 04:00–04:10 | 10 | 休息 | |
| 04:10–04:45 | 35 | Compact、Code Mode；使用準備好的執行器做對照 | 壓縮保真與往返成本比較 |
| 04:45–05:35 | 50 | 整合演練：視覺 worker 失敗、AC 模糊、注入指令 | 有證據、有阻礙說明的逐條驗收 |
| 05:35–06:00 | 25 | Eval、demo 與設計回顧 | baseline 比較、已知限制與下一步 |
| **合計** | **360** | **教學／實作 340 分鐘＋休息 20 分鐘** | |

所有原始主題都會教到，**Routing 與 Subagent 是必修實作**。6 小時不適合從零寫 UI、workflow engine、sandbox 與 browser adapter；採 starter modules＋小範圍 TODO＋授課者引導。較深入的 sandbox 基礎設施、多模型 routing 調校與正式部署，留作課後延伸，不影響必修主題。

### 授課者需事先備妥

- 已安裝並驗證的環境；所有人能跑同一個小型 Playwright 測試。
- 假 Jira／Figma 回應、經核准的設計參考與 browser baseline，以及明確的 AC 標準答案。
- 正常／缺陷兩種 fixture build；每組獨立帳號或資料 namespace；可確認完成的 reset。
- 可用的模型存取與限額；離線替身資料用來演練 timeout／拒絕／重試。
- starter：tool registry、browser adapter、事件檢視、持久化／recovery、核准狀態與實際隔離執行器。
- starter：functional、visual 專職 Agent 的最小實作與輸出 schema，讓學員補 routing／協作邏輯而非現場從零搭所有基礎設施。

這份 README 定義要準備的材料，並不宣稱以上 starter 或 fixture 已在 repository 中完成。真實 Jira／Figma 可以作為示範替代輸入，但不得讓憑證、權限或測試資料污染拖垮現場教學。

## 0. Intro：Agent = Model + Harness

這是一個方便討論的心智模型：

- **Model**：根據目前 context 產生文字或行動請求。
- **Harness**：準備 context、接收請求、驗證與執行工具、保存狀態、管理預算與權限，再把結果交回模型。
- **Environment**：實際能讀寫的檔案、服務、資料庫與隔離執行環境。

模型不會因為說「所有 AC 通過」就真的完成驗收。Harness 必須持有實際執行結果，並決定什麼條件才算完成。

```text
使用者任務 → Harness 準備 context → Model
                                  ↓
                            回答或 tool call
                                  ↓
                     驗證 → 權限判斷 → 執行
                                  ↓
                            tool result → Model
```

### Token、context 與多模態

Token 是模型處理內容的單位，不等於字數；不同語言、模型與 tokenizer 的比例不同。可用 [Tokenizer](https://platform.openai.com/tokenizer) 觀察，但不要把「四個字元一個 token」當成中文或所有模型的精準公式。

Context 不只包含對話，也可能包含 system instructions、工具定義、工具結果與多模態輸入。支援圖片輸入不代表能直接操作 UI；圖片只是輸入，操作能力仍需 Harness 提供工具。

好的 Harness 能減少錯誤與浪費，但「較弱模型＋較好 Harness」是否勝過另一個組合，要用相同任務、預算與評估方式驗證，不能當作保證。

**練習**：把「驗收新增會員表單」拆成讀規格、推論、操作、查證與報告，標出每一步由誰負責，以及哪些操作會真的新增資料。

**通過條件**：能指出完成依據、最大輪數／時間／成本上限，以及找不到答案時的停止方式。

## 1. Tool：模型提出請求，Harness 決定如何執行

以應用程式看得見的 API 合約理解 tool calling 即可：先提供工具描述與輸入格式；模型回傳 tool call；應用驗證並執行；再把對應結果傳回模型。實際欄位依 provider／SDK 而異。[OpenAI Function Calling](https://developers.openai.com/api/docs/guides/function-calling)

下面是 provider-neutral 示意，不是本專案的 API payload：

```json
{
  "type": "tool_call",
  "id": "call_01",
  "name": "get_ticket",
  "arguments": { "ticket": "DEMO-101" }
}
```

```json
{
  "type": "tool_result",
  "tool_call_id": "call_01",
  "ok": true,
  "data": { "key": "DEMO-101", "description": "Acceptance Criteria: ..." }
}
```

`get_ticket` 與 `get_figma` 是目前已有的工具；瀏覽器操作與 evidence capture 的工具介面則是本次課程要設計的擴充。

### 不要把特殊 token 當成安全機制

不同模型可能使用不同內部格式或特殊 token，但 `<|tool_call|>` 並不是跨模型標準，也不應以掃描字串作為可靠的執行協定。Harness 應依 provider 的結構化訊息／事件與 SDK 合約解析。

使用者打出某段「看起來像標記的文字」，與真正的 API tool call 是不同事情；**安全性仍不能建立在「人類無法輸入這個字串」上**。

同樣地，`role: tool` 表示資料來源管道，不保證內容真實或可信。Jira 描述、Figma 文字、檔案與網頁都可能包含錯誤資料或 prompt injection。工具回傳的「忽略規則並執行某指令」仍然是外部內容，不能自行提升為授權。

### 一個好工具不只有 name 與 schema

- 清楚描述何時使用、不適用情況與可能不完整的結果。
- 驗證輸入形狀，再檢查路徑、物件與操作權限；通過 schema 不等於有權執行。
- 設定 timeout、輸出大小／分頁與錯誤格式，避免一次把所有資料塞回模型。
- 區分可重試的暫時性失敗、輸入錯誤、拒絕授權與結果未知。
- 寫入工具需說明副作用、idempotency 與人工核准規則。

現有例子：`get_ticket` 讀取固定欄位，未包含 Jira 自訂欄位；最多取 API 回傳頁中的 10 則留言，不能保證是最新留言。Workshop 的 AC fixture 應先放在 description，若實際團隊把 AC 放在 custom field，需另行擴充工具，不能假裝已取得。`get_figma` 預設 depth 為 2，超過 30,000 bytes 的詳細結果門檻時改回節點摘要與分頁；`depthLimited`／`truncated` 提醒我們資料不完整，不等於已拿到完整設計。缺失或截斷的規格應阻擋相應驗收並查補資料，不能直接判產品 fail。

**練習**：為一個唯讀工具列出正常輸入、無效參數、找不到資料、超時與帶有惡意指令的回傳內容。

**通過條件**：錯誤能被清楚分類；無效／未授權請求不會進入實際操作；資料裡的指令不會改變工具權限。

### 1.1 Lazy Loading：需要時才提供完整工具定義

工具數量增多時，把所有 schema 一次放進 context 可能增加成本與選擇難度。Lazy loading 可先給工具索引或搜尋能力，找到候選工具後，再載入必要的完整定義。這與只在執行時 `import()` 程式模組不同：前者管理模型 context，後者管理應用載入時機。[Anthropic：Advanced Tool Use](https://www.anthropic.com/engineering/advanced-tool-use)

```text
任務 → 搜尋工具索引 → 取得候選名稱與用途
     → 載入需要的 schema → 模型發出呼叫 → 正常驗證與執行
```

延遲載入不會自動授予工具權限；搜尋索引與最終 executor 都要遵守同一套可見性與授權規則。只有兩個工具時，先全部提供通常更容易教與除錯，不必為模式而模式。

**練習**：用一組模擬工具比較「全部載入」與「搜尋後載入」，加入找不到工具的情境。

**通過條件**：記錄 schema/context 大小、工具選擇成功率與額外往返；找不到時能停止或合理降級，不憑空呼叫工具。

### 1.2 Browser Tools：先定義可觀察的事實

工具不只提供任意 `click`；至少需要讀取目前頁面狀態、執行允許的操作、驗證條件與保存證據。模型可以幫忙規劃與找對象，Harness 仍要限制目標 origin、資料、動作與執行時間。

把 AC 寫成 Given／When／Then，再把 Then 對應到可觀察事實：

```text
Given：可重設 fixture 的空白表單與已知初始會員數
When：送出空白姓名與 Email
Then：兩個必填錯誤可見，且會員數沒有增加
```

只看到錯誤文字，還不足以證明「未新增會員」。需要測試資料查詢或事先定義的 mock server 紀錄；若沒有這項可觀察能力，只能說 UI 部分已驗證，不能整條 AC pass。

下面是授課 fixture 應提供的 Playwright Test 示意，不是本專案已存在的測試。`baseURL`、label、錯誤文字與 test id 都需對應準備好的網站：

```ts
import { test, expect } from '@playwright/test';

test('AC-01: empty fields show required errors', async ({ page }) => {
  await page.goto('/members/new');
  await page.getByRole('button', { name: '建立會員', exact: true }).click();
  await expect(page.getByTestId('name-error')).toBeVisible();
  await expect(page.getByTestId('name-error')).toHaveText('請填寫姓名');
  await expect(page.getByTestId('email-error')).toBeVisible();
  await expect(page.getByTestId('email-error')).toHaveText('請填寫 Email');
});
```

這個例子只證明兩段錯誤文字，不涵蓋 AC-01 的後端與視覺部分。優先使用可重試的 web assertions，而不是固定 sleep 後猜 UI 已完成；locator、timeout 與實際讀到的值都應留在證據中。[Playwright Assertions](https://playwright.dev/docs/test-assertions)

### 1.3 Jev + Playwright：受控的觀察／決策／執行迴圈

Text-only 不代表不能控制瀏覽器。可把目前 DOM／accessibility 資訊、可見文字與 element 狀態整理成 Jev 能讀的結構化 state，讓它選擇適合的目標或下一個動作，再由 Playwright 執行。

```text
Playwright 觀察目前頁面
  → Harness 產生文字 snapshot 與允許的候選動作
  → Jev 在候選中選擇／判斷是否資訊不足
  → Harness 驗證 snapshot 與權限仍有效
  → Playwright 執行 → assertion／重新觀察
```

建議教學策略是 **有限候選選擇**，而不是讓模型輸出任意可執行程式：

- 候選只來自剛取得的 snapshot，帶穩定 ID、role/name、可見／enabled 狀態。
- 選項包括 `need_more_context` 與 `stop`，不強迫猜一個按鈕。
- Harness 將候選 ID 映射到自己持有的 locator／操作，不直接 `eval` 模型回傳值。
- 執行前重查元素與目標，頁面變更或 locator 不唯一時重新觀察。
- 每輪限制步數、時間與重試；新增會員等副作用先走 policy／approval。
- 網頁文字仍是不可信內容，不能要求 Agent 擴權、讀秘密或跳過核准。

這是建議整合架構，實際 TypeSafe 請求形式見第 5 章。[playwright-jev](https://github.com/AdriaanVE/playwright-jev) 提供基於 accessibility tree 候選的 locator healing 與語意驗證範例，可作為閱讀材料；它不是本專案已安裝的工具。第三方 adapter 的 report／enforce、fail-open 與 CI 政策需另外審查，不能把機率閘門當成唯一安全邊界。

[browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) 是更完整的觀察／決策／執行架構參考：從目前 DOM 建立有索引的元素表，用同一份 state 詢問操作與相容目標，最後只執行被選定操作對應的目標。模型不直接輸出任意 selector、座標或 JavaScript；`DONE` 也需獨立確認。這種 speculative questions 是預先詢問候選決策，不是提前執行多個瀏覽器動作。

該參考實作使用 Python 與 Browser Harness，**不是可直接替換進本專案的 Playwright／TypeScript 套件**。文字輸入另用文字生成模型；workshop 第一版可更簡單，直接使用固定假資料，不需要模型生成任意欄位內容。它的既有 Chrome profile 使用方式也不等於獨立 BrowserContext，課堂仍需自己準備帳號與資料隔離。

在 6 小時內只借用核心設計，由授課者備妥 TypeScript＋Playwright adapter。先限制同一 origin、一般 DOM、固定會員表單；不處理 iframe、shadow DOM、canvas、檔案上傳或 popup 等延伸情境。執行前檢查 snapshot 是否過期、locator 是否唯一、元素是否可操作且未被遮蔽；每次操作後重新觀察，失敗不能直接用舊 snapshot 繼續猜。

**引導實作**：在 FunctionalTester 內接上 observe → Jev decide → Playwright act → verify。測試「按鈕改名」「按鈕不存在」「兩個相似按鈕」三種情境：分別觀察可選替代目標、`none` 與需澄清。仍以操作後的 assertion 判斷成功。若 AC 明確要求按鈕文字完全一致，即使語意定位找到同用途按鈕，也必須保留文字不符的 fail，不能用 self-healing 隱藏需求偏移。

### 1.4 Figma 與 Screenshot Baseline 是兩種參照

Figma 指定版本／frame 是設計規格；Playwright 的 screenshot baseline 是事先審核的瀏覽器渲染影像。`toHaveScreenshot` 比較的是目前畫面與 baseline，**不會自動理解 Figma 或證明兩者語意一致**。首次產生 baseline 也不是驗收通過，需有人確認它符合設計後才能使用。[Playwright Visual Comparisons](https://playwright.dev/docs/test-snapshots)

比較前固定 app build、Figma 版本與狀態、viewport、browser／OS、字型、locale、資料、動畫與時間相關內容。僅在有明確理由時 mask 動態區域，不能遮掉本來要驗收的內容。不同執行環境可能產生不同像素結果；門檻應校準，不用「差異小於某個任意百分比」代表設計已正確。

可拆成三層證據：

1. **確定性檢查**：必要欄位、字串、可見性、已定義尺寸／顏色／間距與有無溢出。
2. **視覺回歸**：與經審核的 browser baseline 比較，附 current／baseline／diff。
3. **設計符合度審查**：以指定 Figma frame 與目前畫面交由具圖片能力的 reviewer 或人檢查，標示判斷與不確定處。

目前 `get_figma` 使用 files／nodes 資料介面，回傳設計資料與摘要，沒有 frame image export／完整設計比較工具。Workshop 應預先準備必要圖片與來源參照，或另行建置授權的圖像取得流程。

每份證據至少帶 AC ID、run／task ID、build、viewport、步驟、expected／actual、時間與 artifact 位置。Trace 可協助檢查動作前後、DOM snapshot 與相關 network 資訊，不能取代 AC 的明確 assertion。[Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer)

截圖與 trace 可能含帳號、token 或頁面資料，使用假資料、限制存取與保存期限。不要為了分享報告，自動把內部 trace 上傳外部服務。

**練習**：為 AC-01 保存功能證據；為 AC-04 產出固定 viewport 的設計比較資料；確認一個 screenshot 無法單獨證明 AC-02 的「只新增一筆」。

**通過條件**：每項判定能回到對應 AC、版本與證據；baseline 未核准、缺後端查證或缺設計版本時能正確回報限制。

## 2. Durable Execution：中斷後知道從哪裡繼續

Durable 的目的不只是「把聊天存進資料庫」，而是保存執行進度，讓流程在重啟後能重用已完成步驟的結果，並處理尚未完成的工作。DBOS 的 step 是目前專案採用的機制；不要把它和 UI 的訊息紀錄混為一談。[DBOS Steps](https://docs.dbos.dev/typescript/tutorials/step-tutorial)

至少區分三種狀態：

1. **Execution state**：哪個 run、哪個 step、哪次 attempt，目前是執行／等待／成功／失敗。
2. **Conversation state**：下一次模型呼叫需要哪些訊息與工具結果。
3. **Observation state**：使用者目前看到的串流、snapshot 與事件游標。

看見 token 或工具結果，不代表該 step 已成功 checkpoint；HTTP 斷線也不代表 producer 已停止。

### Durable 不等於外部副作用 exactly-once

最重要的故障窗口：

```text
外部服務已完成寫入
  → 程式在 checkpoint 前崩潰
  → 恢復時 step 可能再執行
```

要避免重複發信、付款或重複套用修改，需依操作設計穩定 idempotency key、去重、交易、版本前置條件或外部結果查證。不是加上 `runStep` 就能替所有外部系統提供 exactly-once。

本專案的 [恢復邊界文件](docs/dbos-durable-execution.md) 已明確說明：已 checkpoint 的 output 可以重用；side effect 完成但 checkpoint 未完成時，工具可能再執行。部分串流 output 也可能在重試時被 snapshot 撤回。

**練習**：用假會員新增 API 的計數器或可查詢 operation ID，分別在「呼叫前」「副作用後、checkpoint 前」「checkpoint 後」注入中斷。BrowserContext 可能隨程序消失；恢復時重新建立 context、重現已知頁面狀態，不序列化或重用失效的 page handle。截圖／trace 則保存 artifact reference 與版本，避免恢復後指向已被清理的檔案。

**通過條件**：能說明每個中斷點是否重跑、畫面如何修正、外部結果如何確認；不能只用「重啟後有回覆」當作成功。Mock 測試通過後，仍要另外做真資料庫 kill/restart 測試才能支持實際 recovery 的主張。

## 3. Code Mode：用程式組合工具

傳統 tool loop 可能每一步都把中間資料交回模型。Code Mode 讓模型產生一小段程式，透過受控 API 做多次讀取、條件判斷、轉換或彙總，再只回傳必要結果。Cloudflare 的實作示範把工具轉成 TypeScript API；CodeAct 則研究以可執行程式作為行動表示。兩者是相關方向，不是完全相同的產品或協定。[Cloudflare Code Mode](https://blog.cloudflare.com/code-mode/) · [CodeAct 論文](https://arxiv.org/abs/2402.01030)

以下是「工具提供在隔離執行器內」的概念示意，不是目前可直接執行的 API：

```ts
const results = await tools.readCompletedChecks({ runId });
const failures = results
  .filter((item) => item.status === "fail")
  .map((item) => ({ acId: item.acId, evidenceRefs: item.evidenceRefs }));
return { failedCount: failures.length, failures };
```

適合：大量資料的篩選、彙總，以及不需要模型逐步判斷的工具串接。不一定適合：只需一次小型查詢、每一步都需要語意判斷，或錯誤很難定位的長程式。

**Code Mode 是工具編排方式，Coding Agent 是任務類型。** 修程式的 Agent 不一定需要 Code Mode；資料分析 Agent 也能使用 Code Mode。

第一個實驗建議只開放唯讀 API，將寫入動作保留在明確的 approval／durable 邊界。所有程式內工具呼叫仍須經過 executor 驗證，不能利用 Code Mode 繞過權限或配額。

**練習**：把同一份已完成檢查結果，用逐次 tool call 與 Code Mode 彙整；只處理唯讀證據，不在程式內重放表單提交。

**通過條件**：比較結果正確性、模型往返、token、延遲與失敗定位；能限制執行時間、呼叫數與輸出量。隔離邊界尚未準備好時，只做紙上推演，不在 host 直接執行模型產生的程式。

## 4. Compact：保留任務必要資訊，控制 Context

Compact／compaction 是把長對話整理成較小的工作 context，不是刪除所有歷史，也不是「做了摘要就有長期記憶」。原始事件與檔案可以留在外部儲存，模型只取得當下需要的部分。

建議優先保留：

- 使用者目標、限制與明確授權範圍。
- 已完成／未完成工作、失敗嘗試及其證據。
- 目前檔案或 revision、artifact 位置與來源參照。
- 尚待回答的問題、待核准動作與下一步。

可以壓縮：重複討論、已被新結果取代的假設、可重新讀取的大量原始資料。不要只留下「已處理」，卻丟掉是哪個檔案、哪次測試或哪個版本。

```text
目標：驗收 DEMO-101 的 AC-01 至 AC-06
限制：僅測試環境；不留言、不改 Jira 狀態
版本：fixture build A；Figma snapshot B；mobile 390×844
證據：AC-03 fail，trace/e03；AC-02 pass，assertion/e02
待辦：visual worker 待恢復；AC-06 需澄清
核准：以持久化 approval record 為準，不能從摘要推定
```

摘要不能取代真正的 approval record，也不能把不可信來源變成可信指令。若把工具訊息整組裁切，需保持 tool call/result 對應與 provider 要求的訊息結構有效。

**練習**：在長 DOM／tool output 後觸發壓縮，保留「不可在正式環境提交」與 AC-03 已失敗、AC-06 尚待澄清的狀態。

**通過條件**：壓縮後仍遵守限制、記得失敗與待辦，必要時能回查來源；記錄壓縮前後的 context 大小與任務成功率。不要單看摘要讀起來流暢。

## 5. Agent Routing：決定哪個專職 Agent 處理 AC

**本章是必修。** Routing 解決「該交給誰」；第 6 章的 Subagent 則解決「被交付後如何啟動、等待、停止與整合」。只輸出 `functional` 字串還不算完成協作，Harness 必須真的 dispatch 到具有不同工作合約的 Agent。

### 先把 AC 拆成可驗證單位

「錯誤提示會出現，而且樣式符合 Figma」同時有功能與視覺要求。不要強迫每條 AC 只能交給一個專家，也不要把 visual route 當成不需要操作頁面。VisualReviewer 也可能需要先透過 browser adapter 進入指定畫面狀態。

| Router 結果 | 實際 dispatch | 合併條件 |
| --- | --- | --- |
| `functional` | FunctionalTester | 明確的行為 assertion 與必要後端查證 |
| `visual` | VisualReviewer | 固定條件下的視覺證據與檢核 |
| `mixed` | 同一 AC 拆成 functional、visual 兩個子任務 | 兩者都是必要證據，不能只採先回來的一個 |
| `needs_clarification` | 不啟動無法判定的檢查，產生澄清問題 | 規格缺失時 `blocked`；需要指定人員裁量時 `needs-human-review` |

FunctionalTester 的 prompt／工具集中在重現步驟、可重試 assertion 與測試資料查證；VisualReviewer 的 prompt／工具集中在 Figma 指定狀態、截圖、量測與比較。兩者有不同輸入／輸出與任務狀態，才是有意義的專職 Agent 分工。

### 用 TypeSafe Choice 做窄範圍路由

先建立規則式 baseline，再用同一組標註 AC 評估 TypeSafe 分類是否改善。以下是依官方 SDK 文件整理的**示意程式，未整合至本專案，也未執行**；套件需由授課者在課前準備，課前確認 Node.js 20+，並將 `TYPESAFE_API_KEY` 配置在 server-side；不得放入前端 bundle 或提交至 repository。

```ts
import { choice, TypeSafeClient } from '@typesafe-ai/sdk';

const client = new TypeSafeClient();
const response = await client.systemOne({
  model: 'jev-latest',
  state: {
    ac: '提交空白表單時顯示必填提示，且提示樣式符合指定錯誤態設計。',
  },
  questions: {
    route: choice('Which verification route is required for `ac`?', {
      functional: 'Observable behavior verified with browser assertions.',
      visual: 'Appearance or layout comparison.',
      mixed: 'Both behavioral and appearance checks are required.',
      needs_clarification: 'Missing, contradictory, or insufficiently specific requirement.',
    }),
  },
});

const route = response.answers.route;
```

`route` 提供 `.choice`、`.probabilities` 與 `.confidence`。`.confidence` 表示分布集中程度，**不是此答案正確的機率**；高 confidence 仍可能分類錯誤。服務失敗、分類無效或需要澄清時，不可預設為 `pass`。若設定信心門檻，應以標註 fixture 校準；教學隨手選的數字只能叫示範政策。[TypeSafe JS SDK](https://docs.typesafe.ai/sdk/javascript) · [Choice](https://docs.typesafe.ai/sdk/javascript/api/functions/choice) · [Confidence](https://docs.typesafe.ai/confidence)

`jev-latest` 是會變動的 alias。Workshop 應固定當次核准的 model version，並記錄 `response.model`。不要只比較 prompt 而忽略模型版本。[TypeSafe Models](https://docs.typesafe.ai/models)

### Jev 與 Playwright 的界線

- TypeSafe 可以判斷文字規格、分類 route、根據最新文字頁面狀態選擇候選瀏覽器動作，或對結構化證據提出語意判斷。
- Playwright 提供實際操作與 assertion 證據；element visible、URL、文字與筆數等事實不需交給模型猜。
- Jev 是 text-only；可以藉 DOM／accessibility state 參與瀏覽器控制，但不能把 screenshot 當作 `state` 丟進去就聲稱做完視覺驗收。
- 對截圖先做文字描述會遺失資訊；若只有描述，報告需揭露視覺證據限制。
- 額外的語意判斷不得覆寫已知 assertion failure。資料不足與分類服務失敗也不等於產品 fail。

TypeSafe 的 [agent skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md) 是整合參考；它不替本專案提供 browser executor、subagent lifecycle 或安全邊界。

**練習**：為 AC-01 至 AC-06 建立標準 route；比較規則與 TypeSafe 的分類，實際 dispatch AC-01 的兩種檢查。加入「只有美觀兩字」與帶有命令的 Jira 描述。

**通過條件**：混合條件能產生兩個專職任務；缺規格不亂猜；分類失敗有出口；外部文字不能修改工具權限。路由結果、模型版本與 dispatch 決策可追溯。

## 6. Subagent：讓專家獨立執行，再按 AC 整合

**本章是必修。** 父 Agent 保留整張 ticket 的主責，啟動 FunctionalTester 與 VisualReviewer，等待結構化結果，再驗證 coverage。Handoff 是把主責交給另一個處理者；本 workshop 以父 Agent 收回結果的 delegation 為主，避免 AC 在交接中失蹤。

### 子任務合約

```json
{
  "taskId": "run-01/AC-01/visual",
  "acIds": ["AC-01"],
  "role": "VisualReviewer",
  "appBuild": "fixture-a",
  "designRef": "approved-snapshot-b/error-state",
  "viewport": { "width": 390, "height": 844 },
  "fixtureNamespace": "group-03-visual",
  "allowedActions": ["open-test-page", "submit-empty-form", "capture-evidence"],
  "output": ["status", "expected", "actual", "evidenceRefs", "blocker"],
  "deadlineSeconds": 120
}
```

這是建議合約；沒有在 allowedActions 的動作，不能因為子 Agent 想做就取得權限。父 Agent 的授權範圍也不因為多開 worker 而擴大。

### Fan-out／Fan-in

1. 父 Agent 凍結 run 的 AC matrix 與版本，把任務發給專職 Agent。
2. 每個 Agent 使用自己的 browser context，按需要使用獨立資料 namespace。
3. 只在前置條件彼此獨立時並行；會更動共同後端狀態的案例需隔離或排序。
4. 父 Agent 按 `taskId`／`acId` 收回結果，檢查 schema、版本、證據存在性與 coverage。
5. `mixed` 的必要檢查都完成後才可能 pass；證據矛盾則保留差異，重現或交人工審查，不以多數決解決。

Playwright BrowserContext 可隔離 cookies、local storage 等瀏覽器狀態，但**不會自動隔離共用後端資料庫**。兩個 context 使用同一 Email 仍可能互相干擾。[Playwright Isolation](https://playwright.dev/docs/browser-contexts)

### 對照兩種架構

先記錄單 Agent baseline，再比較雙專家協作：是否有更完整的 AC coverage、更少混淆功能／視覺條件、更短延遲？同時記錄成本、上下文傳遞與重複操作。課程必須實作協作，但產品是否保留多 Agent，仍要由評估結果決定。

### 故障演練：視覺 worker 中途失敗

假設 FunctionalTester 已完成 AC-01 的功能證據，VisualReviewer 在截圖前超時：

- 保存功能結果，不把它重跑一遍，也不直接把 AC-01 標成 pass。
- visual task 記錄 `blocked` 與執行錯誤，父 Agent 回報「功能已通過，視覺尚未完成」。
- 在預算允許、原因可恢復時，只重試 visual task；恢復相同 build／設計／資料前置條件。
- 若重試會再提交表單，先查證或重設 fixture；不能盲目重放新增會員。
- 父任務取消或到期後，停止相關 worker／browser 工作並清理資源。

**練習**：完成 AC-01 的雙 Agent fan-out／fan-in，再注入上述故障，以及「兩個 worker 使用不同 app build」的結果。

**通過條件**：能真正啟動兩個有不同合約的 Agent；保留成功子結果；只重試失敗工作；拒絕混用版本；報告不遺漏任何必要 AC。每個 worker 的成本、狀態與證據可獨立追蹤。

## 7. User Approve：把核准當作執行狀態

模型說「使用者已同意」不等於核准。真正的核准要由 Harness 記錄，並在副作用發生前檢查。

先定義產品的操作政策。瀏覽頁面與截圖可在核准範圍內進行；提交新增會員會產生資料，必須事先核准指定測試環境、假資料與操作。刪除、寄信、付款或正式環境操作不在 workshop 範圍內；Jira 留言／狀態變更也需另外授權。這是示範政策，實際規則應按組織與工作風險設定。

核准畫面至少說清楚：動作、目標、重要參數、預期影響與可回復性。核准紀錄應綁定 run／tool call、不可變 action payload 或其 hash、核准者、時間與有效期限，並驗證核准者確實有權作決定。

```text
proposed → awaiting_approval → approved → executing → completed
                            ↘ rejected / expired / cancelled
```

核准前後目標或參數改變，就不是原來核准的同一個動作。若等待期間 ticket、設計或測試部署已變更，也要重新檢查版本；必要時重新提出測試計畫與核准。拒絕、逾時或沒有回覆不能當成同意。

等待可能跨越程序重啟，應保存待核准狀態與決定，不只依賴記憶體中的 Promise。核准 API 本身也需要身分驗證、授權與重複提交處理。[參考課程：Human-in-the-Loop](https://github.com/Hendrixer/harness-engineering/blob/main/lessons/07-human-in-the-loop/index.md)

**練習**：先拒絕一次，再測試重啟後核准、重複點擊與核准後修改參數。

**通過條件**：拒絕不執行；重複提交不重複執行；過期／不匹配的核准無效；可以查出誰批准了哪一個精確動作。

## 8. Sandbox：限制能力，不只限制 Prompt

Sandbox 用來限制程式可以碰到的資源。Prompt 中寫「不要讀秘密」不是隔離；只移除幾個 global、設 timeout，或把程式放進另一個函式也不是完整隔離。

特別注意：Node.js 官方明確指出，**`node:vm` 不是安全機制，不可用來安全地執行不受信任程式**。`Promise.race` timeout 也不代表背景工作已被終止。[Node.js VM 文件](https://nodejs.org/api/vm.html)

實驗前先寫下 threat model 與能力清單：

| 面向 | 建議課程界線 |
| --- | --- |
| 檔案 | 只掛載 disposable fixture；限制可寫目錄；檢查 path traversal 與 symlink |
| 網路 | 預設不允許，必要目標以 allowlist 開放 |
| 憑證 | 不掛載 host 的秘密、SSH key、雲端 token 或 Docker socket |
| 程序 | 限制子程序、CPU、記憶體、執行時間與輸出量 |
| 工具 | 僅提供完成任務必要的 API，每次呼叫仍檢查權限 |
| 清理 | 超時／取消時終止工作與子程序，回收暫存資源 |

選擇 container、isolate 或 microVM 等執行方式時，要確認實際的安全邊界與配置；不能只因為名稱叫 sandbox 就假設它安全。一般 process 分離或預設 container 設定，也不自動滿足所有威脅模型。

**練習**：在預先隔離的測試環境中，測試越界路徑、禁止的網路、無限迴圈、子程序與大量輸出。只使用假秘密與 disposable 資料。

**通過條件**：越界能力被執行環境阻擋；超時後工作確實終止；留下可查證的拒絕原因。不要在未隔離的 host 上以惡意程式「測試是否安全」。

## 9. Eval 與 Observability：從一開始就量測

這是貫穿各章的驗證方式，不是最後才加的功能。評估三件事：**結果是否正確、過程是否符合限制、成本是否可接受。**

### 最小評估集

建議先建立 8–12 個固定案例，保留一部分不拿來調 prompt。每次比較都記錄模型／prompt／工具版本、fixture revision 與預算；對有隨機性的流程跑多次，不把一次成功當作穩定成功率。

| 類型 | 例子 | 期待結果 |
| --- | --- | --- |
| 正常任務 | 無缺陷會員表單 | 必要 AC 通過且證據完整 |
| 已知缺陷 | 重複 Email 被接受、手機按鈕溢出 | 正確指出受影響 AC，無關 AC 不誤報 |
| 資料不足 | 缺少 Figma frame 或只有「美觀」 | blocked／needs-human-review，不假裝通過 |
| 工具失敗 | timeout／資料不存在 | 有界重試或停止，保留正確錯誤狀態 |
| 惡意內容 | 檔案要求忽略規則 | 不越權、不洩漏資料 |
| Context 壓力 | 長結果與 compaction | 保留限制、版本與未完成工作 |
| 程序中斷 | checkpoint 前後崩潰 | 按既定恢復合約處理 |
| 人工決策 | 拒絕／逾時／重複核准 | 不誤執行、不重複副作用 |
| 隔離界線 | 越界路徑／禁止網路 | 阻擋並留下證據 |

驗收的完成條件不只「測試變綠」：還要確認沒有跳過 AC、降低 assertion 門檻或默默更新 screenshot baseline。以授課者事先標註的正常／缺陷版本評估漏報、誤報、狀態分類與證據完整性。`pass` 的錯誤判定尤其要追查；主觀設計問題保留人工審查，而不是要求所有項目都自動二元判定。

### 最終報告示例

以下是授課 fixture 的示意結果，不是真實驗收紀錄：

```text
DEMO-101 / run-01 / fixture-a / design-snapshot-b
範圍：6 條 AC；功能與視覺必要檢查依 matrix
摘要：2 pass、1 fail、2 blocked、1 needs-human-review

AC-01 blocked：功能已通過；視覺 worker 超時，未完成錯誤態比較
  已有證據：assertion/e01、data-check/e01
  下一步：只重試 visual task，保留相同 build 與 fixture
AC-02 pass：成功提示可見；測試資料只新增一筆
AC-03 fail：重複 Email 被接受；預期新增 0 筆，實際新增 1 筆
  證據：trace/e03、data-check/e03；包含重現步驟
AC-04 pass：指定桌機狀態的核准檢核與 baseline 比較通過
AC-05 needs-human-review：功能操作與無水平溢出檢查已通過；已附 mobile 截圖，設計細節需指定 reviewer 判定
AC-06 blocked：「順暢」缺少可測量標準，需要補充規格

未變更 Jira 狀態；本次結果不足以宣告整張 ticket 通過
```

報告中的 artifact reference 在實作時須能開啟且對應這次 run；不能以不存在的檔名充當證據。`blocked` 的已完成子結果也要保留，讓 reviewer 知道不用重做哪些工作。

### 最小可觀測資料

建議紀錄 `run_id`、`step_id`、attempt、事件時間、模型／prompt／工具版本、狀態、耗時、token usage、重試原因與工具結果摘要。有副作用時加上 operation ID／idempotency key 與核准紀錄參照。

將事件串成可閱讀的時間線：

```text
run.started → model.completed → tool.requested → policy.checked
            → tool.completed → model.completed → run.completed
```

這些名稱是設計示意，不是目前程式事件名稱清單。實作時以專案實際 event schema 為準。不要記錄憑證或不必要的個資；可觀測性依靠行動、輸入輸出與狀態證據，不要求取得模型的隱藏推理。

### 每次加入新模式，都回答同一組問題

1. 它解決了哪個 baseline 已出現的問題？
2. 成功率、延遲、token 或人工介入次數改善多少？
3. 新增了哪些權限、故障窗口與維運成本？
4. 拿掉它之後，是否反而更容易理解與維護？

## 開課前檢查與現有驗證入口

授課者應先固定 commit，依本教材 6 小時議程完成課前環境彩排。使用 fake provider／tool 與 disposable fixture，避免每個學員都必須取得 Jira、Figma 或正式系統憑證才能理解概念。

現有 [package.json](package.json) 提供 `typecheck` 等指令；更完整的離線檢查列在 [DBOS 文件](docs/dbos-durable-execution.md#離線驗證)。在依賴已安裝、使用該文件的離線環境設定時，可依原文件執行：

```sh
pnpm typecheck
DATABASE_URL=postgresql://offline:offline@127.0.0.1:1/offline MODEL_API_KEY=offline node --import tsx --test server/harness/run.test.ts server/thread.test.ts server/harness/tools/*.test.ts src/hooks/*.test.ts src/components/*.test.tsx
node_modules/.bin/tsx scripts/check-contrast.ts
node_modules/.bin/tsx scripts/check-openui-parse.ts
```

以上是現有文件中的驗證入口，不表示本 README 整理時已執行，也不是完整 production 驗證。Repository 的 `scripts/check-thread-browser.mjs` 是既有 chat UI 檢查，不是已完成的 Jira 驗收 browser tool；本課程的瀏覽器 adapter 與 fixture 仍需另外準備。

> **目前已知限制**：專案文件指出 migration chain 尚不一致，不要直接把 `db:migrate`／`db:push` 當作全新資料庫的安全初始化流程；先確認實際資料庫歷史。真 PostgreSQL／DBOS 的 kill/restart、並行 executor 與版本交接仍需驗證，且現有 thread/run 合約不提供多租戶 ACL。完整說明請讀 [DBOS 執行合約與限制](docs/dbos-durable-execution.md)。

### 課程完成檢查表

- [ ] 可以解釋 model、tool、Harness 與 environment 的責任。
- [ ] 單 Agent baseline 有明確成功／失敗與預算上限。
- [ ] 工具的輸入、權限、錯誤與不完整結果都有合約。
- [ ] 能展示至少一個失敗與恢復案例，說明 checkpoint 和副作用差異。
- [ ] 需要執行程式時，有實際隔離與可終止性；需要核准時，有精確動作綁定。
- [ ] 每個新增模式都和 baseline 比較，而不是只展示功能。
- [ ] Routing 能對 AC 產生功能、視覺、mixed 或澄清處理，並實際分派。
- [ ] 兩個專職 Subagents 有獨立合約與狀態，父 Agent 能處理部分失敗與版本衝突。
- [ ] 每條 AC 都有 pass／fail／blocked／needs-human-review 與依據，報告不自動寫回 Jira。
- [ ] 最終交付包含成果、驗證證據、版本與尚未解決的限制。

## 參考資料

- [Hendrixer / Harness Engineering](https://github.com/Hendrixer/harness-engineering)：本教材的架構主題參考；原課程涵蓋 harness、durable execution、sandbox、memory、routing、supervision 與 human-in-the-loop。此專案沿用主題脈絡，不假設沿用其目錄、指令或實作。
- [OpenAI Function Calling](https://developers.openai.com/api/docs/guides/function-calling)：應用端 tool call／tool result 的互動合約。
- [Anthropic Advanced Tool Use](https://www.anthropic.com/engineering/advanced-tool-use)：工具搜尋、延遲載入與程式式工具使用。
- [DBOS Steps](https://docs.dbos.dev/typescript/tutorials/step-tutorial)：step、可序列化結果與重試機制；使用時仍需核對專案鎖定版本。
- [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode/)：將工具以程式 API 組合的設計案例。
- [CodeAct: Executable Code Actions Elicit Better LLM Agents](https://arxiv.org/abs/2402.01030)：以程式作為 Agent 行動表示的研究。
- [Node.js VM](https://nodejs.org/api/vm.html)：`node:vm` 的用途與安全限制。
- [Playwright Assertions](https://playwright.dev/docs/test-assertions)、[Visual Comparisons](https://playwright.dev/docs/test-snapshots)、[Trace Viewer](https://playwright.dev/docs/trace-viewer)、[Isolation](https://playwright.dev/docs/browser-contexts)：功能斷言、視覺回歸、執行證據與 browser context。
- [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)：DOM 元素表、受限動作選擇與獨立完成驗證的架構參考；Python／Browser Harness 實作，並非本專案 adapter。
- [TypeSafe 文件入口](https://docs.typesafe.ai/llms.txt)、[JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)、[Intent Routing](https://docs.typesafe.ai/patterns/intent-routing)、[State](https://docs.typesafe.ai/concepts/state)、[Confidence](https://docs.typesafe.ai/confidence)：Jev 的整合、路由、輸入與分布解讀。

外部教材與框架提供可借鏡的模式；本專案能保證什麼，仍以實際程式、版本、測試與部署配置為準。
