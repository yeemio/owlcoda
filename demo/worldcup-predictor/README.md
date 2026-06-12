# ⚽ World Cup 2026 Predictor — OwlCoda Official Demo

> 一个真实的多模型分析应用,接上 OwlCoda 只需要一个 `baseURL` ——
> 模型路由、健康监控、自动 fallback、审计,全是白送的。

用你**自己的模型**(本地 Ollama/MLX/vLLM 或云端 API,经 OwlCoda 统一路由)对 2026 世界杯
全部 104 场比赛做 **Pro / Anti / Judge 三角辩论式预测**。全程本地运行,数据不出你的电脑,
网站本身不调用任何外部接口——缺的动态信息(伤停、新闻、赔率)由你输入或截图上传。

分析框架移植自 hermes-football 竞彩三角辩论体系(真实生产框架),内含其反编造规则与
Judge 硬门槛(证据分层降权、方向分纪律、风控 veto 评估)。所有输出都是"辩论包",
最后一步永远是**你拍板**。

## 30 秒上手

```bash
# 1. 启动 owlcoda(已配置过模型的话只需这一步)
owlcoda serve

# 2. 启动 demo
cd demo/worldcup-predictor
npm install
npm run demo
# → http://localhost:5173
```

首次使用 owlcoda?两条命令完成模型接入:

```bash
owlcoda init --endpoint http://127.0.0.1:11434/v1   # 自动发现你的本地模型
owlcoda serve
```

## 配 1 个模型 vs 配 3 个模型

| | 单模型三角 | 多模型辩论 |
|---|---|---|
| 玩法 | 一个模型轮演 Pro/Anti/Judge | 每个角色独立模型,OwlCoda 按角色路由 |
| 体验 | 立即可玩 | 不同模型互相攻防,分歧真实可见 |
| 参考路由 | 任意 | Pro=mimo 类,Anti=kimi 类,Judge=deepseek 类(线上同款) |

在「设置」页连接 owlcoda 后,把已配模型拖给角色即可;换模型零代码改动。
主模型失败时 OwlCoda 自动切到你指定的 fallback——引擎面板会把这一刻演给你看。

## 你会看到什么(OwlCoda 引擎面板)

分析页右侧的实时仪表盘,全部由真实 SSE 事件驱动,不做假动画:

- **实时路由流向图**:浏览器 → Demo → OwlCoda → 你的模型,谁在推理谁发光
- **角色作战席**:模型徽章、实时字符流计数、耗时秒表、fallback 高光提示
- **健康监测条**:所有已配模型的心跳状态
- **Run Manifest**:每个角色的实际模型/token/耗时,完整审计见 `owlcoda audit`

## 内置数据与示例

- 104 场官方赛程 + 48 队 FIFA 官方 26 人名册(2026-06 快照,带来源标注)
- 两场**真实生产辩论回放**:墨西哥 vs 南非、韩国 vs 捷克(来自 hermes-football
  线上系统,标注"历史回放",原模型署名保留)

## 诚实原则

- 你没提供的证据维度标 `unsupported`,模型被明确禁止编造(尤其是赔率数字)
- 证据不足时框架输出 pass/watch,不硬推方向
- 本 demo 不构成任何投注建议

---
Powered by [OwlCoda](../../README.md) · Your models. Your tools. Your data.
