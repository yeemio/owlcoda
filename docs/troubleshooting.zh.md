# 故障排除

## 首次运行：“No usable model is configured yet”

全新安装**不会**自带维护者的模型配置，出现该提示是正常的，需要你先配置
provider。

推荐顺序：

1. `npm install -g owlcoda`
2. 运行 `owlcoda` 或 `owlcoda admin`，在 Admin 里添加**云端**或**本地
   runtime**
3. 若已有本地 OpenAI 兼容 endpoint，可选：
   `owlcoda init --endpoint http://127.0.0.1:11434`（主机根地址，**不要**加 `/v1`）

```bash
owlcoda admin
owlcoda doctor
```

## `owlcoda` 版本仍然很旧

常见原因：旧 daemon 未退出、npm **镜像源滞后**、或 PATH 上仍是旧全局包。

```bash
npm config get registry
npm update -g owlcoda
npm ls -g owlcoda --depth=0
owlcoda --version
```

然后结束旧 OwlCoda 进程，再重新运行 `owlcoda`。

### npm 镜像滞后（国内常见）

若使用 `https://registry.npmmirror.com` 等镜像，其上的 `owlcoda` **latest**
可能比 [registry.npmjs.org](https://registry.npmjs.org) **晚几小时到一两天**。

对比版本：

```bash
npm config get registry
npm view owlcoda version
npm view owlcoda version --registry https://registry.npmjs.org
```

临时从官方源安装/升级：

```bash
npm install -g owlcoda@latest --registry https://registry.npmjs.org
```

永久改用官方源：

```bash
npm config set registry https://registry.npmjs.org
```

## 端口 8019 已被占用

默认代理/Admin 地址：`http://127.0.0.1:8019`。

### 查看占用进程

**Windows（PowerShell）：**

```powershell
Get-NetTCPConnection -LocalPort 8019 | Select-Object OwningProcess
Get-Process -Id <pid> | Select-Object Id, ProcessName, Path
```

**macOS / Linux：**

```bash
lsof -i :8019
```

若命令行中出现 `owlcoda` 与 `cli.js server`，说明是**残留的 OwlCoda
daemon**，即使 CLI 提示 “non-OwlCoda process” 也应按 OwlCoda 处理。

### 正常停止

```bash
owlcoda stop
owlcoda stop --force
```

若 `owlcoda stop` 显示未运行但 8019 仍被监听，属于**孤儿进程**（无 PID
文件），需按 PID 结束后再启动：

**Windows：**

```powershell
taskkill /PID <pid> /F
```

**macOS / Linux：**

```bash
kill <pid>
```

确认端口释放后，再执行 `owlcoda`。

### 可选：确认是否为 OwlCoda

```bash
curl -s http://127.0.0.1:8019/healthz
```

返回含 `"version"`、`"runtimeToken"` 的 JSON 即为 OwlCoda daemon。

## Admin 能打开但没有模型

与[首次运行](#首次运行no-usable-model-is-configured-yet)相同。在 Admin 中
配置本地 runtime 或云端 provider，或使用：

```bash
owlcoda init --endpoint http://127.0.0.1:11434
```

## Ollama：Ollama 正常但 OwlCoda 显示 runtime 不可达

**现象：**

- `ollama list` 有模型，`curl http://127.0.0.1:11434/v1/models` 正常
- `owlcoda doctor` 报本地 runtime 不可达，或配置后仍无可用模型

**常见原因：**

1. **`routerUrl` 写成了带 `/v1` 的地址**（如 `http://127.0.0.1:11434/v1`）。  
   OwlCoda 会请求 `${routerUrl}/v1/models`，实际变成 `…/v1/v1/models`（404）。  
   **修正：** `routerUrl` 应为 `http://127.0.0.1:11434`（**不要**末尾 `/v1`）。

2. **`config.json` 里 `models` 为空** — Admin 可能只写了 runtime 地址，未添加模型。  
   需至少一条模型，`backendModel` 与 `ollama list` 中的名称完全一致（如 `qwen2.5:7b`）。

**验证：**

```bash
owlcoda doctor
owlcoda models
```

## 小本地模型 Agent 超时或 400（全平台）

**现象：**

- `ollama run <小模型>` 很快有回复
- `owlcoda` REPL 报 `upstream 400`、`does not support tools` 或
  `headers timeout after 30000ms`

**原因：** OwlCoda 是 **tool agent**，不是极简聊天壳。原生 REPL 每轮会带大量
工具定义。许多 **8B 以下** 模型要么不支持 tools，要么首包远比一句 `ollama run`
慢得多。

**策略：** 本地 Agent 建议 **≥ 8B** 且支持 tools；**7B** 仅作实验下限（需较好
硬件）。8B 以下请用运行时直连聊天，不要用 `owlcoda` REPL。见
[model-requirements.zh.md](model-requirements.zh.md)。

**缓解：**

- `ollama pull qwen2.5:7b` 等，并在配置/Admin 中设为默认
- 测试单一本地模型时可关闭自动 fallback：
  `"middleware": { "fallbackEnabled": false }`（`~/.owlcoda/config.json`）
- 本地 Agent 尽量使用 GPU 推理

## 干净重装（全局 npm 包）

```bash
owlcoda stop --force
# 若 8019 仍占用，按上文 taskkill / kill

npm uninstall -g owlcoda

# 删除用户目录：
#   Linux/macOS: rm -rf ~/.owlcoda
#   Windows:     Remove-Item -Recurse -Force $env:USERPROFILE\.owlcoda

npm install -g owlcoda
owlcoda doctor
owlcoda
```

仅删除 `D:\AI\owlcoda` 等源码目录，**不会**卸载全局 `npm` 包，也**不会**
清除 `%USERPROFILE%\.owlcoda`。

## `npm install -g owlcoda` 报 `EACCES`

使用用户级 npm 前缀（见 [install.md](install.md)）。

## 安全问题

勿在公开 issue 中提交漏洞，见 [SECURITY.zh.md](../SECURITY.zh.md)。

## 产品反馈（daemon 提示、Windows 体验）

本公开仓库接受**文档** PR；运行时行为改进（如更准确的端口占用提示、孤儿
daemon 自动清理）请通过
[GitHub Issues](https://github.com/yeemio/owlcoda/issues) 反馈，并附上
`owlcoda --version`、系统、终端类型及 `npm config get registry`。
