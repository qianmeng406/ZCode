# 远程常驻 server（resident server）规格

状态：草案 v1（Linux SSH 首版）
范围：`packages/server`（远端入口 + 连接流程）。桌面 UI 的断线状态与入口属于后续增量。

## 1. 目标与非目标

目标：SSH 远程工作区支持"常驻运行"模式——远端 server 以独立 daemon 进程运行，
桌面断开（关闭 tab / 断网 / 退出 app）只释放连接与订阅，远端任务继续执行；
重新连接后通过既有 v4 subscribe/snapshot 语义恢复状态。

非目标（v1）：

- 不承诺 daemon / 宿主机崩溃后任务自动续跑（如实显示中断，不自动重放副作用命令）。
- 不做多用户认证、多实例部署、WSL/Docker 常驻（保留 stdio 现状）。
- 不做自动创建容器等云资源管理。

## 2. 状态所有权

```
桌面 App
  └─ SSH 连接（认证 + 部署 + 安全隧道）
       ├─ resident daemon（远端，唯一常驻进程）
       │    ├─ 唯一所有者：Agent runtime / 任务 / 会话持久化
       │    ├─ daemon.json（runtime root 下）：{pid, port, version, startedAt}，0600
       │    └─ 每连接一个 ChannelServer + connection scope（订阅所有权）
       └─ stdio bridge（随 SSH exec 会话生灭，纯字节管道）
            └─ TCP 127.0.0.1:<port>（仅回环）
```

- 任务/会话状态唯一所有者是 daemon（services 层），桌面连接 ID 不作为任务身份。
- 连接 scope 的 dispose 只退订本连接的 V4 订阅（zcodeAgentConnectionScope 既有语义，
  已核实不停止任务）；daemon 不因任何连接断开而退出。
- daemon.json 是 daemon 存活判定的唯一事实源；pid 存活 + 回环 TCP 探活双重校验，
  陈旧文件必须被 `--resident-start` 清理重建。

## 3. 接口

同一个已部署的 `zcode-server.cjs` 增加 argv 子命令（不新增部署产物，不增加上传体积）：

| 命令                | 生命周期             | 行为                                                                                                                                                                                                    |
| ------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--resident-start`  | 随 SSH exec 短暂运行 | 幂等确保 daemon 在跑：存活则退出 0；否则 spawn 自身 `--resident-serve`（detached、stdio ignore、独立进程组），等待 daemon.json + 探活成功后退出。失败带 stderr 诊断退出非 0                             |
| `--resident-serve`  | daemon 常驻          | 绑定 `127.0.0.1`（端口探测空闲），写 daemon.json；每连接：写 zcode-hello → 等 zcode-hello-ack → ChannelServer + connection scope；连接关闭只 dispose scope。SIGTERM 优雅停机（dispose services 后退出） |
| `--resident-bridge` | 随 SSH exec 生灭     | 读 daemon.json → 连接回环端口；stdin↔TCP、TCP↔stdout 双向纯字节管道；stdin EOF → 关 TCP；TCP 断 → 结束 stdout 并退出 0；连接失败 stderr 诊断退出非 0                                                    |
| `--resident-stop`   | 随 SSH exec 短暂运行 | 读 daemon.json → SIGTERM → 宽限后 SIGKILL → 删文件。供后续 UI「停止远端运行时（显式确认）」使用                                                                                                         |

`connectRemote` 增加选项 `resident?: boolean`：

1. detect / deploy 与 stdio 模式相同（`--version` 校验不变）。
2. resident 时先 exec `--resident-start`（继承与 stdio 相同的运行时 env 前缀），等待退出 0；
   再 exec `--resident-bridge` 作为 RPC 流。
3. 握手、wrap、RPC、dispose 逻辑与 stdio 模式完全复用。
4. 返回的 `RemoteConnection` 携带 `resident: true`，供桌面区分"断开 ≠ 任务终止"。

## 4. 不变量

- I1 daemon 只绑定回环地址；接入身份 = SSH 用户（隧道由 SSH 保证），v1 不引入额外令牌，
  但 daemon.json 权限 0600。
- I2 bridge 的 stdout 是纯协议字节流：任何诊断只能写 stderr；daemon 日志写自身
  stderr（stdio ignore，落 /dev/null），不得污染桌面握手窗口。
- I3 每连接握手独立：daemon 对每个 TCP 连接重写 hello；任一连接的坏 ack 只影响该连接。
- I4 daemon 不持有任何连接态任务引用；任务随 services/runtime 存活，连接生灭不影响。
- I5 stdio 模式行为零变化：不带 resident 选项时命令构造、env、部署、握手路径不变。

## 5. 失败语义

- `--resident-start` 失败（spawn 失败 / 等待超时 / daemon 启动即崩）：连接流程失败，
  错误携带 daemon.json 路径与 stderr 尾部，UI 显示连接失败（不存在半可用状态）。
- bridge 连不上 daemon：退出非 0 → 握手报 stream closed；重连时 `--resident-start`
  会重建 daemon。
- daemon 运行中崩溃：所有 bridge 的 TCP 同时断 → 各连接走既有 onDidRemoteClose；
  任务状态如实为中断（v1 不自动续跑）。
- 同主机并发 stdio + resident 连接共享同一数据根，SQLite 锁冲突是既有风险类，
  v1 不新增处理，如实记录。

## 5.1 打包版发布：远端资源 CDN

常驻功能改的是服务端产物，而打包版默认从官方 CDN 按版本号取 `zcode-server.cjs`，
fork 的服务端改动不会自动随包发布（实测：安装包会部署官方产物，`--resident-start`
落到 stdio 分支并以 hello-ack 超时收场）。发布方式：

1. 生成发布树：**桌面构建已自动串联**（`prepare:runtime-assets` 在 prepare:remote-assets
   之后调用本步骤），也可单独跑 `pnpm pack:remote-cdn`；平台列表用
   `ZCODE_REMOTE_CDN_PLATFORMS`（默认 linux-x64，逗号分隔可多平台），
   跳过用 `ZCODE_SKIP_REMOTE_CDN_PACK=1`。
   产出在 `packages/desktop/dist-remote-cdn`，把 `packages/desktop/mock-cdn` 的扁平布局转成 CDN 布局：
   `zcode/electron/releases/<version>/manifest-<arch>.json` 与
   `zcode/electron/releases/components/<arch>/<id>/<version>.tar.gz`
   （归档根 = mount 目录内容，`sha256` 校验归档本身，版本号后缀 = 归档哈希前 12 位；
   已用官方 3.14.3 server-bundle 实物核对）。
2. 把产出目录内容上传到自建托管根。
3. 把 `ZCODE_CDN_BASE_URL` 写进 `.env.production`（构建期固化，推荐，已在本 fork 配好
   指向自建发布树）。构建期该键**只读 .env 文件**：联调时常在 shell 里 export 本地地址，
   若让它并入 `process.env` 会静默覆盖仓库配置（实测把 `http://127.0.0.1:8899` 烘进安装包）。
   需要运行时临时覆盖时用 `ZCODE_REMOTE_ASSET_CDN_BASE_URL`（host 运行时读取），
   且必须确保应用进程真的拿到该变量——应用已在运行时再次启动只会聚焦旧实例，env 不生效。
4. manifest 每次部署都强制联网刷新（`refreshManifest: true`），因此本地已有官方缓存
   不会击败自定义源（已实测确认）。

## 6. 验收

1. 单测：bridge 双向管道与双向终止语义；daemon.json 读写与陈旧判定；per-connection
   hello/ack 帧；connect 层 resident 命令构造与 env 前缀复用；stdio 命令构造不变。
2. 集成（需 Linux SSH 环境，未跑则如实说明）：部署 → 连接 → 发起任务 → 断开 SSH →
   任务继续 → 重连恢复状态与结果；等待确认的任务重连后仍等待。
3. 回归：非 resident 连接全路径不回归；`--version` 校验不回归。
