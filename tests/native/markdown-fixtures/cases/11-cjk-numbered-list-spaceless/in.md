建议：1. 子包内聚化—将 cache scheduler家族、stream terminal家族等归入子包 2. 合约→实现晋升流水线—避免文档无限膨胀，每个合约文件应有明确的实现截止日期 3. RuntimeKernel插件化扩展点—让新的 governance control可以注册式接入，而非硬编码导入
