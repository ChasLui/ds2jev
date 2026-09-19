# ds2jev

把 DeepSeek-Flash 包装成 JEV（TypeSafe System One）适配层：接受 `{state, questions}`，用一次 DeepSeek `chat/completions` 调用回答全部问题，输出 JEV 响应格式。

源码为 TypeScript；运行时不依赖任何 npm 包（仅 Node 内置 `fetch` / `node:http`），Node >= 22.18（依赖原生类型剥离直接运行 `.ts`）。

## 前置

需要 `DEEPSEEK_API_KEY`（Node 端在环境变量缺失时会自动尝试从 `~/.env.local` 加载）。

## CLI

```bash
node src/cli.ts --pretty --thinking high < request.json
node src/cli.ts request.json          # 或从文件读
```

选项：`--pretty`（缩进输出）、`--thinking <low|high|max>`（开启思考模式）。

## HTTP 服务（Node）

```bash
npm start                              # 等价于 node src/serve.ts；PORT 可覆盖端口
curl -sS -X POST http://127.0.0.1:8787/v1/systemone \
  -H 'content-type: application/json' --data @request.json
```

路径 `/v1/systemone` 与官方 SDK 一致，可用 `TYPESAFE_BASE_URL=http://127.0.0.1:8787` 把官方 SDK 指过来。

## 部署

### Cloudflare Worker

```bash
npm run build:cf    # 构建到 dist/ds2jev/
npm run deploy:cf   # 构建并 wrangler deploy（需 CF 凭据）
```

本地调试用 `wrangler dev`（即 `npm run dev`），密钥放 `.dev.vars`（gitignored）。

### Vercel

push 到 Git 或在仓库根执行 `vercel`；`/v1/systemone` 由 `vercel.json` rewrite 到 `api/systemone.ts`。环境变量（`DEEPSEEK_API_KEY` 等）在 Vercel 项目设置里配置。

### Docker

```bash
npm run docker:build
npm run docker:run     # 需本机已 export DEEPSEEK_API_KEY
```

镜像内为 `vite build --ssr` 产出的单文件 Node 服务，无需 node_modules。

## 环境变量

|变量|说明|
|---|---|
|`DEEPSEEK_API_KEY`|必需|
|`DEEPSEEK_BASE_URL`|API base，默认 `https://api.deepseek.com`|
|`DEEPSEEK_MODEL`|模型，默认 `deepseek-flash`|
|`PORT`|Node 服务端口，默认 `8787`|
|`HOST`|Node 服务 bind 地址，默认 `127.0.0.1`（容器由镜像设为 `0.0.0.0`）|

Cloudflare 本地用 `.dev.vars`，Vercel 用项目环境变量，Docker 用 `-e` / `--env-file`。

## 技术栈

TypeScript（`tsc 7` 仅类型检查：`npm run typecheck`；测试与运行由 Node 原生剥离直接跑 `.ts`）、Vite 8（Rolldown）构建 CF / Node 产物、oxlint + oxfmt 做 lint / 格式化。

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
npm test           # 离线单测（node --test，无网络）
npm run typecheck  # tsc 7 类型检查
npm run lint       # oxlint
```
