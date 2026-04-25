# OwlCoda Admin And Provider Diagnostics

这份文档只写当前已经存在、可用的 browser admin / handoff / provider diagnostics 工作流。

## Browser Admin vs TUI

`/models` TUI 负责：

- 快速看当前模型状态、问题和可用性
- 在终端里切模型、刷新、看 issues/overview
- 发现问题后直接发起 browser handoff

Browser admin 负责：

- 更适合表单和批处理的配置修改
- `set default`
- 编辑 endpoint model 字段
- 设置 key / `apiKeyEnv`
- `test connection`
- `delete`
- `add model`
- alias conflict 批量修复
- orphan bind
- catalog import
- 查看 per-item result

分工原则：

- TUI 优先发现问题和快速跳转
- Browser 优先处理需要上下文、表单或批处理的修改

## Open Browser Admin

CLI 支持：

```bash
owlcoda ui
owlcoda admin
owlcoda ui --print-url
owlcoda ui --route models --select kimi-code --view issues
owlcoda admin --route catalog
```

参数：

- `--print-url`：只打印 URL，不尝试打开浏览器
- `--route <models|aliases|orphans|catalog>`：打开 browser admin 的目标页面
- `--select <modelId>`：预选中某个 model
- `--view <name>`：传递子视图或 filter hint，例如 `issues`

默认行为：

1. ensure/reuse 本地 OwlCoda server
2. 生成 one-shot admin URL
3. 尝试打开浏览器
4. 无论浏览器是否打开成功，都打印完整 URL 作为 fallback

## `/models` Browser Handoff

TUI 里当前可用的 handoff：

```text
/models edit <id>
/models browser [route] [id]
```

示例：

```text
/models edit kimi-code
/models browser catalog
/models browser orphans kimi-code
```

handoff URL 形状：

```text
http://127.0.0.1:<port>/admin/?token=<one-shot>#/<route>?select=<modelId>&view=<view>
```

其中：

- `route` 至少支持 `models` / `aliases` / `orphans` / `catalog`
- `select` 和 `view` 是可选的

如果 token 失效或 auth 失败：

- browser 会显示 auth failure
- CLI / TUI 会提示重新发起 handoff
- 处理方式就是重新执行 `owlcoda ui ...` 或 `/models edit ...`

## Current Admin Capabilities

当前 browser admin 已支持：

- Models 只读/编辑
- `set default`
- 编辑 model fields
- 设置 key
- `test connection`
- `delete`
- `add model`
- alias conflict 批量修复
- orphan bind
- catalog import
- per-item result 返回

其中：

- `/admin/api/config` 不回显 secret 明文
- `apiKey` 只返回是否已设置
- browser 只显示 `apiKeyEnv` 变量名，不显示变量值

## Provider Failure Diagnostics

当前 provider diagnostics 的常见类别：

- `dns_error`
- `connect_error`
- `tls_error`
- `timeout`
- `abort`
- `http_4xx`
- `http_5xx`
- `stream_interrupted`
- `unknown_fetch_error`

用户现在看到的错误会是这种粒度：

- `kimi-code request failed: DNS lookup failed for api.kimi.com`
- `kimi-code request failed: timeout after 60s`
- `kimi-code request failed: upstream 502 from provider`
- `kimi-code request failed: stream closed before first token`
- `Request cancelled by user`

覆盖到的关键路径：

- native 主 agent
- subagent
- `/v1/messages`
- `/v1/chat/completions`
- admin `test connection`
- `/warmup`
- LLM skill synthesis fallback warning

`audit.jsonl` 失败记录现在可对齐：

- `requestId`
- `model`
- `servedBy`
- `durationMs`
- `status`
- `streaming`
- `fallbackUsed`
- `failure.kind`
- `failure.message`
- `failure.retryable`
- `failure.rawCauseCode`
- `failure.errno`
- `failure.syscall`
- `failure.upstreamRequestId`

说明：

- 真正的用户请求路径以 `/v1/messages` / `/v1/chat/completions` 的 `requestId` 为主
- admin `test connection` 和 `/warmup` 复用同一套分类与文案，但它们是 operator 动作，不写入 `audit.jsonl`

`unknown_fetch_error` 的含义：

- OwlCoda 看到了失败
- 但没有拿到足够的 transport / HTTP / abort / stream signal
- 这时不会硬猜原因，只会诚实保留原始短错误

## Current Boundaries

当前明确边界：

- local/backend catalog 条目主要走 `Orphans`
- browser admin 不支持远程访问或多用户
- 不做 websocket
- secret 不在 browser 回显
- admin bundle 缺失时，`/admin` 会显示友好的 bundle-missing 页面
- one-shot token 过期时，需要重新发起 handoff
- catalog import 目前只针对 endpoint-based 条目；本地/backend 条目主要通过 `Orphans` 处理

## FAQ / Operator Notes

### Admin bundle 缺失时会看到什么？

- `owlcoda ui --print-url` 仍会打印 URL
- `owlcoda ui` 会明确提示 bundle 未构建
- 直接访问 `/admin` 会看到 bundle-missing 页面，不是 silent 404

### one-shot token 过期怎么办？

重新执行：

- `owlcoda ui`
- `owlcoda ui --route ... --select ...`
- `/models edit <id>`
- `/models browser ...`

### 为什么 browser 里不直接显示 secret？

这是有意的最小暴露原则：

- 配置读接口脱敏
- browser 只知道 key 是否已设置
- `apiKeyEnv` 只显示变量名，不显示变量值

### 为什么 catalog 导入和 key 设置分两步？

因为 catalog/import 负责建立 model 条目，secret 管理是独立写路径：

- import 先把 model 配置落进 config
- key / env 再通过独立 mutator 路径设置

这样更容易做审计、脱敏和错误定位。
