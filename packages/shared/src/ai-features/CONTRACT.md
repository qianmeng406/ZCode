# shared-ai-features

提示词优化配置的跨进程取值契约。设置页、会话面板与 Host 校验共用同一组枚举，避免 UI 与 schema 漂移。

不变量：

- 持久化只接受 `polish` / `structure` 与 `draft` / `conversation`；损坏值在读取时回落到默认值。
- 模型选择不属于本模块：`null` 表示跟随会话模型，由 `AppSettings` 承载。
- 新增取值必须先扩展本模块的联合类型与守卫，再更新设置 schema 与 UI。
