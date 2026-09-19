# ds2jev

把 DeepSeek-Flash 包装成 JEV（TypeSafe System One）适配层：接受 `{state, questions}`，用一次 DeepSeek `chat/completions` 调用回答全部问题，输出 JEV 响应格式。

零依赖（仅 Node 内置 `fetch` / `node:http`），Node >= 20.12。

## 前置

需要 `DEEPSEEK_API_KEY`（CLI/server 在环境变量缺失时会自动尝试从 `~/.env.local` 加载）。

## CLI

```bash
node src/cli.mjs --pretty --thinking high < request.json
node src/cli.mjs request.json          # 或从文件读
```

选项：`--pretty`（缩进输出）、`--thinking <low|high|max>`（开启思考模式）。

## HTTP 服务

```bash
node src/server.mjs --port 8787
curl -sS -X POST http://127.0.0.1:8787/v1/systemone \
  -H 'content-type: application/json' --data @request.json
```

路径 `/v1/systemone` 与官方 SDK 一致，可用 `TYPESAFE_BASE_URL=http://127.0.0.1:8787` 把官方 SDK 指过来。

## 支持的询问类型

|type|criteria|
|---|---|
|`boolean` / `noul`（别名，输出回显输入原词）|可选 `{true?, false?}`|
|`choice`|必需非空对象 `{label: description}`|
|`score`|必需数组，长度 ≥ 2，index 即分数|

请求体里的 `model` 等额外字段一律忽略。

## 输出示例

```json
{
  "model": "deepseek-flash",
  "answers": {
    "is_urgent": { "type": "boolean", "probability": 0.95 },
    "department": { "type": "choice", "choice": "billing", "confidence": 0.95, "probabilities": { "billing": 0.95, "sales": 0.01, "technical": 0.04 } },
    "frustration": { "type": "score", "score": 1.8, "confidence": 0.8, "legend": { "0": "平静", "1": "沮丧", "2": "愤怒" }, "probabilities": { "0": 0.02, "1": 0.18, "2": 0.8 } }
  },
  "usage": { "input_tokens": 459, "output_tokens": 73 }
}
```

## 与真实 Jev 的差异

- `confidence` 由归一化后的最大概率算得（真实 Jev 由模型内部置信度给出）。
- `score` 是概率加权期望 `Σ i·pᵢ`，不采信模型给的原始 score 值。
- 概率不做 round（真实网关 round 到 2 位）。
- 不输出 `providerMetadata`。消费者（jev-router、jev-operator）读取 answer 内嵌的 `confidence` 即可正常工作。
- `usage` 使用官方 SDK 契约的 snake_case（`input_tokens` / `output_tokens`）。

## 限制

- 全部问题合并进一次调用；问题数过多（> 5）或单题选项过多时输出质量可能下降，表现为缺题/越界，此时 adapter 会重试最多 3 次。
- 概率未经 RLCD 校准，不等于原生 Jev 的校准质量。

## 测试

```bash
npm test
```