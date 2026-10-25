# settings-ai-features

设置页里的 AI 功能配置行：提示词优化与 Oracle 审查共用的模型选择，以及优化方式/上下文范围。

不变量：

- 组件不直接调用 `SettingService`；`onChange` 由调用方提供并负责持久化。
- 模型值为 `null` 表示跟随会话模型，必须保留“跟随会话模型”选项，不能吞掉显式 `null`。
- 落盘的模型偏好恒为显式推理档位：选中模型时写模型目录的最低公开档（Registry 执行侧
  强制要求显式档位，缺档请求会被 "Reasoning level is required" 拒绝）；档位下拉只列
  真实档位，无「默认档」哨兵项。旧「默认档」语义的无档/失效档存量数据由会话层一次性
  迁移（`migrateAiFeatureSelectionLevel`）补齐，执行侧不做静默补档。
- 已下线模型的历史选择仍要能显示在触发器里，不能退化成空占位。
