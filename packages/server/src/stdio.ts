import { randomUUID } from "node:crypto";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  ChannelClient,
  type ISocket,
} from "@zcode/rpc";
import {
  IZCodeAgentService,
  createZCodeAgentConnectionScope,
  type ServiceCollection,
} from "@zcode/services";
import { createSessionLinuxExecutionChannel } from "./sessionLinuxExecution/sessionLinuxExecutionChannel.js";

/**
 * Wrap process.stdin/stdout as an ISocket for RPC communication.
 * In stdio mode, stdout is reserved exclusively for RPC data.
 * All logging must go through stderr.
 */
export function wrapStdio(): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  process.stdin.on("data", (chunk: Buffer) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(chunk)));
  });
  process.stdin.on("end", () => {
    onClose.fire();
    onEnd.fire();
  });
  process.stdin.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      process.stdout.write(Buffer.from(buffer.buffer));
    },
    end() {
      process.stdout.end();
    },
    drain() {
      return new Promise<void>((resolve) => {
        if (process.stdout.writableNeedDrain) {
          process.stdout.once("drain", resolve);
        } else {
          resolve();
        }
      });
    },
    dispose() {
      process.stdin.destroy();
    },
  };
}

export interface CreateStdioServerOptions {
  /** 反向 client 回调（desktop-attached 模式下用于 topic resource relay）。 */
  onReverseClientReady?: (client: ChannelClient) => void;
  /**
   * 会话级 Linux 执行 channel：显式启用时挂载到本 stdio 的 ChannelServer 上。
   * 该 channel 不是 ServiceCollection 资源，dispose 由返回句柄交给 entry lifecycle barrier。
   */
  sessionLinuxExecution?: {
    log?: (...args: unknown[]) => void;
  };
}

export function createStdioServer(
  services: ServiceCollection,
  options: CreateStdioServerOptions = {},
) {
  const socket = wrapStdio();
  const protocol = new SocketProtocol(socket);
  const channelServer = new ChannelServer(protocol, "stdio");
  const reverseClient = options.onReverseClientReady ? new ChannelClient(protocol) : undefined;
  if (reverseClient) options.onReverseClientReady?.(reverseClient);
  // 会话级 Linux 执行端：标准 typed channel，复用本 stdio，不新建 wsl.exe / 文本协议。
  const sessionLinuxExecution = options.sessionLinuxExecution
    ? createSessionLinuxExecutionChannel({
        log: options.sessionLinuxExecution.log,
      })
    : undefined;
  if (sessionLinuxExecution) {
    channelServer.registerChannel(sessionLinuxExecution.channelName, sessionLinuxExecution.channel);
  }
  const agentService = services.getOptional(IZCodeAgentService);
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `server-stdio-${randomUUID()}`,
        clientMode: "desktop-continuous",
        role: "trusted-host-relay",
      })
    : undefined;
  services.exposeOnChannelServer(
    channelServer,
    connectionScope
      ? new Map([[IZCodeAgentService.channelName, connectionScope.service]])
      : new Map(),
  );
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }

    // 先同步摘掉 protocol listener，保证从这一刻起不再接收新的 service RPC；
    // connection scope 的异步退订完成后再关闭底层 stdio。
    channelServer.dispose();
    reverseClient?.dispose();
    stopPromise = (async () => {
      try {
        // lifecycle barrier：channel 不是 ServiceCollection 资源，必须显式回收
        // （终止全部 execution / 释放 per-lease adapter）。
        await sessionLinuxExecution?.dispose();
      } finally {
        try {
          await connectionScope?.dispose();
        } finally {
          socket.dispose();
        }
      }
    })();
    return stopPromise;
  };
  socket.onClose(() => {
    void stop();
  });
  return { stop };
}
