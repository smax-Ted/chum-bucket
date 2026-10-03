import { generateSystemPrompt, type LibrarySpec } from "@openuidev/lang-core";
import { readFileSync } from "fs";
import { join } from "path";
import { openuiPromptOptions as promptOptions } from "@openuidev/react-ui/genui-lib/prompt-options";

export function openuiInstructions(extra?: string): string {
  const library = JSON.parse(
    readFileSync(join(process.cwd(), "src/generated/spec.json"), "utf-8"),
  ) as LibrarySpec;
  return generateSystemPrompt({
    cloud: false,
    library,
    promptOptions,
    ...(extra ? { instructions: extra } : {}),
  });
}

export const TEST_PLANNER = `請根據我提供的產品需求、設計文件或功能描述，制定一份可執行、可追蹤的 Test Plan。

## 輸入資料

功能或版本名稱：
[填寫名稱]

需求與驗收條件：
[貼上 PRD、User Story、Acceptance Criteria 或功能描述]

技術與系統資訊：
[前端、後端、API、第三方服務、資料庫等]

目標平台：
[Web、iOS、Android、Desktop 等]

測試環境：
[作業系統、瀏覽器、裝置、Staging、Production-like 等]

發布時程：
[測試開始日、Code Freeze、預計發布日]

已知限制：
[人力、環境、資料、時間或尚未完成的功能]

相關文件：
[設計稿、API 文件、Ticket、Figma URL 等]

## 工作流程

### 1. 分析需求

先完成以下分析：

- 摘要功能目的、主要使用者與關鍵流程。
- 將需求拆成可驗證的測試項目。
- 找出模糊、矛盾或缺少驗收條件的地方。
- 識別受影響的既有功能、整合服務與資料流程。
- 找出高風險區域、邊界條件與可能的回歸範圍。
- 判斷需要哪些測試類型，例如：
  - Functional
  - UI/Visual
  - API/Integration
  - Regression
  - Compatibility
  - Accessibility
  - Performance
  - Security
  - Exploratory
  - User Acceptance Testing

缺少資訊時，不要自行捏造。

若缺少的資訊會明顯改變測試範圍，先列出最多 5 個需要確認的問題。其他缺口請使用合理假設繼續規劃，並把假設單獨列出。

### 2. 制定 Test Plan

請依照以下結構輸出：

# Test Plan: [功能或版本名稱]

## 1. Executive summary

說明：

- 測試對象
- 測試目的
- 主要品質風險
- 預計測試時程
- 發布判斷重點

## 2. Requirement analysis

用表格列出：

| Requirement ID | Requirement | Acceptance criteria | Testable | Open question |
|---|---|---|---|---|

如果原始需求沒有 ID，請建立 \`REQ-001\` 格式的暫用 ID。

## 3. Test scope

分別列出：

### In scope

- 要測試的功能
- 使用者流程
- 平台與裝置
- API 或系統整合
- 需要執行的測試類型

### Out of scope

- 本輪不測試的功能
- 尚未完成或無法測試的項目
- 不包含的第三方行為
- 已知限制

每個 Out-of-scope 項目都要說明原因和可能風險。

## 4. Test strategy

針對每種測試類型說明：

| Test type | Objective | Approach | Priority | Owner | Tool or evidence |
|---|---|---|---|---|---|

策略至少包含：

- Positive scenarios
- Negative scenarios
- Boundary value analysis
- Empty、null、invalid 與重複輸入
- 權限與角色差異
- 錯誤處理與復原
- 網路中斷、逾時與重試
- 跨瀏覽器或裝置差異
- 受影響功能的回歸測試

不要只寫「進行功能測試」。請說明要測什麼、怎麼測，以及通過標準。

## 5. Test scenarios

先產出高階測試情境，不要直接展開成冗長測試步驟。

| Scenario ID | Requirement ID | Scenario | Type | Priority | Expected outcome |
|---|---|---|---|---|---|

情境需涵蓋：

- 主要成功流程
- 替代流程
- 錯誤流程
- 邊界值
- Empty state
- 權限與角色
- 整合失敗
- 資料一致性
- 回歸影響
- 使用者中斷後重新操作

使用 \`TS-[MODULE]-001\` 作為 Scenario ID。

## 6. Regression plan

將回歸測試分級：

| Suite | Target duration | Coverage | Trigger |
|---|---:|---|---|
| Sanity | 10 至 15 分鐘 | 修正項目的快速驗證 | Hotfix 後 |
| Smoke | 15 至 30 分鐘 | 核心流程 | 每次 Build |
| Targeted regression | 30 至 60 分鐘 | 本次變更影響區域 | 每次功能變更 |
| Full regression | 2 至 4 小時 | 完整系統 | Release 前 |

列出：

- 必須通過的 P0 流程
- 直接受影響的功能
- 間接受影響的功能
- 建議執行順序
- 測試相依關係
- 哪些案例適合自動化

## 7. Test environment

用表格整理：

| Area | Requirement |
|---|---|
| Build/version | |
| Backend/API environment | |
| Database/state | |
| Browser/OS | |
| Mobile devices | |
| Accounts and roles | |
| Feature flags | |
| External services | |
| Logging/monitoring | |

## 8. Test data

列出：

| Data set | Purpose | Setup method | Cleanup method | Sensitive data concern |
|---|---|---|---|---|

測試資料要涵蓋有效、無效、空值、邊界值、重複值與特殊字元。

不得填入真實密碼、Token 或個人敏感資料。

## 9. Entry criteria

建立可勾選的清單，例如：

- [ ] 需求與驗收條件已確認
- [ ] 設計稿已定稿
- [ ] 測試環境可以使用
- [ ] 測試資料已準備
- [ ] Build 已部署
- [ ] 已知限制已有紀錄

每項條件必須能客觀判斷是否完成。

## 10. Exit criteria

定義可量測的發布門檻，包括：

- P0 測試通過率
- P1 測試通過率
- 尚未執行或被阻擋的測試數量
- Critical 與 High severity bug 的容許數量
- Regression 結果
- 已接受風險的核准方式
- Go、Conditional Go、No-Go 的判定規則

不要直接套用固定的 90% 門檻。根據功能風險提出合理標準，並說明理由。

## 11. Risk assessment

| Risk | Probability | Impact | Detection method | Mitigation | Contingency |
|---|---|---|---|---|---|

優先考慮：

- 核心流程中斷
- 資料遺失或資料不一致
- 權限或資安問題
- 第三方服務失效
- 環境與正式站差異
- 測試時間不足
- 無法建立所需測試資料
- 既有功能回歸

## 12. Timeline and responsibilities

| Phase | Task | Owner | Start | End | Dependency | Deliverable |
|---|---|---|---|---|---|---|

階段可包含：

- Requirement review
- Test design
- Environment setup
- Smoke testing
- Functional testing
- Regression testing
- Bug verification
- Release sign-off

若沒有提供日期，請使用相對時程，例如 \`T-5 days\`。

## 13. Deliverables

列出本次測試要交付的文件：

- Test Plan
- Test Scenarios
- Detailed Test Cases
- Regression Suite
- Bug Reports
- Test Execution Report
- Coverage Matrix
- Go/No-Go Recommendation

## 14. Coverage matrix

| Requirement ID | Test scenario IDs | Test type | Coverage status | Gap |
|---|---|---|---|---|

每項需求至少要對應一個測試情境。沒有覆蓋的需求必須說明原因。

## 15. Open questions and assumptions

分成：

### Open questions

列出需要由 PM、Design、Engineering 或其他負責人回答的問題。

### Assumptions

列出制定這份計畫時採用的假設，以及假設錯誤時會影響哪些測試內容。

## 16. QA recommendation

最後提供：

- 目前測試計畫是否足以開始執行
- 最大的三項品質風險
- 測試開始前必須解決的阻礙
- 建議優先執行的測試
- 尚未涵蓋的測試缺口

### 3. 最終自我檢查

輸出前確認：

- In scope 和 Out of scope 都有明確定義。
- 每項需求都能追溯到測試情境。
- 每個情境都有明確的預期結果。
- 已包含正向、負向、邊界與失敗情境。
- 已定義測試環境與測試資料。
- Entry 與 Exit criteria 可以客觀量測。
- 風險都有偵測方式與緩解措施。
- 時程考慮相依關係與人力限制。
- 沒有把未知資訊寫成事實。
- 所有測試內容都可以由另一位 QA 直接理解並執行。

請使用繁體中文和 Markdown 輸出。
`;
