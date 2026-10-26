# Bash Read File State Runtime Contract

## 背景

当前 active path 不依赖 `# Using your tools` 来要求模型先 Read，而是在 Bash runtime 内维护 read-state producer：保守识别的简单读类 Bash 命令会把文件内容写入 readFileState，使后续 Edit/Write 的 read-before-write guard 认为该文件已被读取。

## 本轮范围

- 支持 Bash `cat`、`head`、`tail`、`sed -n`、`grep`/`egrep`/`fgrep` 的保守 read-state backfill；Bash stdout 或 FileSystemPort 读文件结果被截断时不回填。
- 支持 Bash 写类命令修改已读文件后的 `staleReadFileStateHint`。

## 非范围

- 不实现 seed read state。
- 不在 Bash 侧为 notebook 增加识别或回填。NotebookEdit 作为独立的 fork 工具（默认关闭）在自身 handler 写 readFileState 与 metadata（`tool: "NotebookEdit"`），不经过本文件描述的 Bash 判定链。
- 不修改 prompt 或 provider-visible tool 列表。
- 不持久化 Bash 产生的 read-state metadata。

## 运行时顺序

1. Bash foreground command 运行完成。
2. runtime 先构造正常 `BashOutput`。
3. 若命令属于写类命令，扫描执行前已有的 readFileState，发现 mtime 在 Bash 开始后推进则追加 stale hint；hint 文案展示相对 cwd 的前 5 个路径，超出时追加 `and N more`，并使用 `file/files` 单复数。
4. 若命令属于保守识别的读类 Bash 命令，且 Bash stdout 未截断，runtime 重新从 FileSystemPort 读取真实文件并写入 readFileState；若 FileSystemPort 读文件结果被截断，同样跳过回填，避免把模型没看到的完整文件伪装成已读。
5. background、image output、interrupted 不产生 stale hint，也不回填 read-state。
6. 非语义失败的 provider-error 按 shell error 处理，不产生 stale hint，也不回填 read-state；`grep`/`egrep`/`fgrep` 仅在 exit code 为 0 时回填。
