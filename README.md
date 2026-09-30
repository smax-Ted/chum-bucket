## Before Start

> [!NOTE]
> 此專案為教學用專案，透過 Coding Agent 建立 Harness 的系統，客製化自己的 Workflow。  
> 部分 Code 會使用手動編輯的方式，避免整個方向歪掉。  
不限定使用的 Agent 工具，以理解 Harness 觀念為主。  
我會使用 [PI](https://pi.dev/) 進行開發，搭配 [pstack](https://github.com/backnotprop/pstack)。



## 0. Intro

Agent = Model + Harness

- 多模態/非多模態
- Token [Tokenizer](https://platform.openai.com/tokenizer)

好的 Harness 搭配不怎麼樣的模型能力可能大於強大的模型搭配不好的 Harness。

## 1. Tool

LLM 要使用 tool 時，底層會透過特殊的 Token 進行輸出(通常在訓練後進行 fine-tuned 做處理)，以 `<|tool_call|>`, `<|end_tool_call|>` 當作範例，實際上這個 Token 不代表任何的文字：

```text
<|tool_call|>
{
  "name": "get_current_weather",
  "arguments": {
    "location": "Austin, TX, USA"
  }
}
<|end_tool_call|>
```

意思為要使用 `get_current_weather` 的這個 tool。

Harness 系統看到這 Token 的時候，瞭解到需要暫停 LLM 的執行，然後去執行這個 tool。

執行結束後，Harness 會以另一個標記，以`<|tool_result|>`, `<|end_tool_result|>` 告訴 LLM 執行的結果：

```text
<|tool_result|>
{
  "location": "Austin, TX, USA",
  "temperature": 93,
  "unit": "fahrenheit",
  "conditions": "sunny"
}
<|end_tool_result|>
```

這些特殊 token 無法由人類輸入產生，所以模型會知道哪些是 tool 執行的結果。

### Lazying


## 2. Duriable

## 3. Code Mode

- [Code Mode](https://blog.cloudflare.com/code-mode/)
- [CodeAct](https://huggingface.co/papers/2402.01030)

## 4. Compact

## 5. Agent Routing

## 6. Subagent

## 7. User Approve

## 8. Sandbox
