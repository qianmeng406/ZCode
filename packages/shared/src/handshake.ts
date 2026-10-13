export interface HelloMessage {
  type: "zcode-hello";
  version: string;
  platform: string;
  arch: string;
  pid: number;
}

/** 连接方声明的 v4 投递档（resident 握手 ack 可选携带；缺省 desktop-continuous 向后兼容）。 */
export type HelloAckClientMode = "desktop-continuous" | "web-remote-replayable";

export interface HelloAckMessage {
  type: "zcode-hello-ack";
  version: string;
  clientId: string;
  clientMode?: HelloAckClientMode;
}
