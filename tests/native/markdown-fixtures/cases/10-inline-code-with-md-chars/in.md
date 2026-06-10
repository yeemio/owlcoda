查看 `process.stdout.columns` 是否被设置：

正常情况下 `Math.max(40, process.stdout.columns || 80)` 会兜底到 80。

变量名包含下划线时，比如 `MY_CONST` 或 `OWLCODA_DEBUG_MD_RAW`，inline code 包裹应该正确显示，下划线不被当成 emphasis。
