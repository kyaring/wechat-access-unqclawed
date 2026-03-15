/**
 * @file centrifuge-client.ts
 * @description Centrifuge WebSocket 网关客户端（CodeBuddy 模式）
 *
 * 使用 centrifuge-js 库连接 Centrifugo 服务端，实现与 WechatAccessWebSocketClient
 * 相同的公共接口，使 handlePrompt / handleCancel 等消息处理器无需修改即可工作。
 *
 * 逆向自 WorkBuddy.app 中的 WecomCentrifugoClient 实现。
 */

import { randomUUID } from "node:crypto";
import { Centrifuge, Subscription } from "centrifuge";
import WebSocket from "ws";
import type {
  AGPEnvelope,
  AGPMethod,
  ConnectionState,
  WebSocketClientCallbacks,
  PromptMessage,
  CancelMessage,
  UpdatePayload,
  PromptResponsePayload,
  ContentBlock,
  ToolCall,
} from "./types.js";

/** Centrifuge 客户端配置 */
export interface CentrifugeClientConfig {
  /** Centrifugo WebSocket 端点 URL */
  url: string;
  /** 连接 token（JWT，从 registerWorkspace 获取） */
  connectionToken: string;
  /** 订阅的 channel 名称 */
  channel: string;
  /** channel 订阅 token（从 registerWorkspace 获取） */
  subscriptionToken: string;
  /** 设备唯一标识 */
  guid: string;
  /** 用户 ID */
  userId: string;
  /** 日志端口前缀 */
  gatewayPort?: string;
  /** CodeBuddy API base URL（用于 HTTP 回复 WeChat KF 消息） */
  httpBaseUrl?: string;
  /** CodeBuddy access token（用于 HTTP 回复） */
  httpAccessToken?: string;
  /** WorkBuddy workspace sessionId（用于 COPILOT_RESPONSE metadata） */
  workspaceSessionId?: string;
}

export class CentrifugeGatewayClient {
  private config: CentrifugeClientConfig;
  private callbacks: WebSocketClientCallbacks;
  private client: Centrifuge | null = null;
  private sub: Subscription | null = null;
  private extraSubs: Subscription[] = [];
  private state: ConnectionState = "disconnected";
  private processedMsgIds = new Set<string>();

  private static readonly MAX_MSG_ID_CACHE = 1000;

  private get logPrefix(): string {
    return `[centrifuge:${this.config.gatewayPort ?? "unknown"}]`;
  }

  constructor(config: CentrifugeClientConfig, callbacks: WebSocketClientCallbacks = {}) {
    this.config = config;
    this.callbacks = callbacks;
  }

  start = (): void => {
    if (this.state === "connected" || this.state === "connecting") {
      console.log(`${this.logPrefix} 已连接或正在连接，跳过`);
      return;
    }

    this.state = "connecting";
    console.log(`${this.logPrefix} 正在连接: ${this.config.url}, channel=${this.config.channel}`);

    this.client = new Centrifuge(this.config.url, {
      token: this.config.connectionToken,
      websocket: WebSocket,
    });

    this.client.on("connected", (ctx) => {
      console.log(`${this.logPrefix} 连接成功 (transport=${ctx.transport})`);
      this.state = "connected";
      this.callbacks.onConnected?.();
    });

    this.client.on("disconnected", (ctx) => {
      console.log(`${this.logPrefix} 连接断开: code=${ctx.code}, reason=${ctx.reason}`);
      if (this.state !== "disconnected") {
        this.state = "disconnected";
        this.callbacks.onDisconnected?.(ctx.reason || `code=${ctx.code}`);
      }
    });

    this.client.on("connecting", (ctx) => {
      console.log(`${this.logPrefix} 重连中: code=${ctx.code}, reason=${ctx.reason}`);
      if (this.state === "connected") {
        this.state = "reconnecting";
      }
    });

    this.client.on("error", (ctx) => {
      console.error(`${this.logPrefix} 错误: ${ctx.error.message}`);
      this.callbacks.onError?.(new Error(ctx.error.message));
    });

    // 创建 channel 订阅
    this.sub = this.client.newSubscription(this.config.channel, {
      token: this.config.subscriptionToken,
    });

    this.sub.on("publication", (ctx) => {
      this.handlePublication(ctx.data);
    });

    this.sub.on("error", (ctx) => {
      console.error(`${this.logPrefix} 订阅错误: ${ctx.error.message}`);
    });

    this.sub.subscribe();
    this.client.connect();
  };

  stop = (): void => {
    console.log(`${this.logPrefix} 正在停止...`);
    this.state = "disconnected";
    this.processedMsgIds.clear();

    for (const sub of this.extraSubs) {
      sub.unsubscribe();
    }
    this.extraSubs = [];

    if (this.sub) {
      this.sub.unsubscribe();
      this.sub = null;
    }
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    console.log(`${this.logPrefix} 已停止`);
  };

  getState = (): ConnectionState => this.state;

  setCallbacks = (callbacks: Partial<WebSocketClientCallbacks>): void => {
    this.callbacks = { ...this.callbacks, ...callbacks };
  };

  /** 订阅额外的 channel（用于 Claw workspace 等，复用同一个 Centrifuge 连接） */
  subscribeChannel = (channel: string, subscriptionToken: string): void => {
    if (!this.client) {
      console.warn(`${this.logPrefix} 无法订阅: 客户端未初始化`);
      return;
    }

    console.log(`${this.logPrefix} 订阅额外 channel: ${channel}`);
    const sub = this.client.newSubscription(channel, { token: subscriptionToken });

    sub.on("publication", (ctx) => {
      this.handlePublication(ctx.data);
    });

    sub.on("error", (ctx) => {
      console.error(`${this.logPrefix} 额外订阅错误 (${channel}): ${ctx.error.message}`);
    });

    sub.on("subscribed", () => {
      console.log(`${this.logPrefix} 额外 channel 已订阅: ${channel}`);
    });

    this.extraSubs.push(sub);
    sub.subscribe();
  };

  // ============================================
  // 上行消息发送（与 WechatAccessWebSocketClient 同签名）
  // ============================================

  sendMessageChunk = (sessionId: string, promptId: string, content: ContentBlock, guid?: string, userId?: string): void => {
    const payload: UpdatePayload = {
      session_id: sessionId,
      prompt_id: promptId,
      update_type: "message_chunk",
      content,
    };
    this.sendEnvelope("session.update", payload, guid, userId);
  };

  sendToolCall = (sessionId: string, promptId: string, toolCall: ToolCall, guid?: string, userId?: string): void => {
    const payload: UpdatePayload = {
      session_id: sessionId,
      prompt_id: promptId,
      update_type: "tool_call",
      tool_call: toolCall,
    };
    this.sendEnvelope("session.update", payload, guid, userId);
  };

  sendToolCallUpdate = (sessionId: string, promptId: string, toolCall: ToolCall, guid?: string, userId?: string): void => {
    const payload: UpdatePayload = {
      session_id: sessionId,
      prompt_id: promptId,
      update_type: "tool_call_update",
      tool_call: toolCall,
    };
    this.sendEnvelope("session.update", payload, guid, userId);
  };

  sendPromptResponse = (payload: PromptResponsePayload, guid?: string, userId?: string): void => {
    // WeChat KF 消息：通过 HTTP COPILOT_RESPONSE 回复（与 WorkBuddy 行为一致）
    if (this.config.httpBaseUrl && this.config.httpAccessToken) {
      const message = payload.content?.map(c => c.text).join("") || payload.error || "";
      const httpPayload = {
        type: "COPILOT_RESPONSE",
        msgId: payload.prompt_id,
        chatId: payload.session_id,  // 原始 WeChat KF chatId（从 incoming message 透传）
        success: payload.stop_reason === "end_turn",
        message,
        metadata: {
          sessionId: this.config.workspaceSessionId || payload.session_id,  // workspace sessionId
          requestId: payload.prompt_id,
          state: payload.stop_reason === "end_turn" ? "completed" : payload.stop_reason,
        },
      };

      const url = `${this.config.httpBaseUrl}/v2/backgroundagent/wecom/local-proxy/receive`;
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.config.httpAccessToken}`,
        },
        body: JSON.stringify(httpPayload),
        signal: AbortSignal.timeout(30_000),
      }).then(async (res) => {
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          console.error(`${this.logPrefix} HTTP COPILOT_RESPONSE 失败: ${res.status} ${body.substring(0, 200)}`);
        }
      }).catch((err) => {
        console.error(`${this.logPrefix} HTTP COPILOT_RESPONSE 异常:`, err);
      });
      return;
    }

    this.sendEnvelope("session.promptResponse", payload, guid, userId);
  };

  // ============================================
  // 内部方法
  // ============================================

  private handlePublication = (data: unknown): void => {
    try {
      const raw = data as Record<string, unknown>;

      // AGP 格式消息（来自 QClaw 网关）
      if (raw?.method && raw?.msg_id) {
        const envelope = raw as AGPEnvelope;
        if (this.processedMsgIds.has(envelope.msg_id)) {
          console.log(`${this.logPrefix} 重复消息，跳过: ${envelope.msg_id}`);
          return;
        }
        this.processedMsgIds.add(envelope.msg_id);
        this.cleanMsgIdCache();
        console.log(`${this.logPrefix} 收到 AGP 消息: method=${envelope.method}, msg_id=${envelope.msg_id}`);

        switch (envelope.method) {
          case "session.prompt":
            this.callbacks.onPrompt?.(envelope as PromptMessage);
            break;
          case "session.cancel":
            this.callbacks.onCancel?.(envelope as CancelMessage);
            break;
          default:
            console.warn(`${this.logPrefix} 未知 AGP 消息类型: ${envelope.method}`);
        }
        return;
      }

      // WeChat KF 格式消息（来自 WorkBuddy Centrifuge）
      // 格式: { chatId, msgId, content, msgType, user, timestamp, ... }
      if (raw?.chatId && raw?.msgId) {
        const msgId = String(raw.msgId);
        if (this.processedMsgIds.has(msgId)) {
          console.log(`${this.logPrefix} 重复消息，跳过: ${msgId}`);
          return;
        }
        this.processedMsgIds.add(msgId);
        this.cleanMsgIdCache();

        const content = String(raw.content ?? "");
        const chatId = String(raw.chatId);
        console.log(`${this.logPrefix} 收到 WeChat KF 消息: msgId=${msgId}, chatId=${chatId}, content=${content.substring(0, 50)}`);

        // 转换为 AGP PromptMessage 格式
        const envelope: PromptMessage = {
          msg_id: msgId,
          guid: this.config.guid,
          user_id: this.config.userId,
          method: "session.prompt",
          payload: {
            session_id: chatId,
            prompt_id: msgId,
            agent_app: "default",
            content: [{ type: "text", text: content }],
          },
        };
        // 附加原始消息数据，供响应时使用
        (envelope as any)._wechatKf = { chatId, msgId, raw };
        this.callbacks.onPrompt?.(envelope);
        return;
      }

      const preview = JSON.stringify(data).substring(0, 500);
      console.warn(`${this.logPrefix} 收到未知格式消息: ${preview}`);
    } catch (error) {
      console.error(`${this.logPrefix} 消息处理失败:`, error);
      this.callbacks.onError?.(
        error instanceof Error ? error : new Error(`消息处理失败: ${String(error)}`)
      );
    }
  };

  private sendEnvelope = <T>(method: AGPMethod, payload: T, guid?: string, userId?: string): void => {
    if (!this.client || this.state !== "connected") {
      console.warn(`${this.logPrefix} 无法发送消息，当前状态: ${this.state}`);
      return;
    }

    const envelope: AGPEnvelope<T> = {
      msg_id: randomUUID(),
      guid: guid ?? this.config.guid,
      user_id: userId ?? this.config.userId,
      method,
      payload,
    };

    try {
      // 通过 Centrifuge publish 将消息发布到 channel
      this.client.publish(this.config.channel, envelope).catch((err) => {
        console.error(`${this.logPrefix} 消息发送失败:`, err);
        this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
      });

      const json = JSON.stringify(envelope);
      const preview = json.length > 500 ? json.substring(0, 500) + `...(truncated)` : json;
      console.log(`${this.logPrefix} 发送消息: method=${method}, msg_id=${envelope.msg_id}, json=${preview}`);
    } catch (error) {
      console.error(`${this.logPrefix} 消息发送失败:`, error);
      this.callbacks.onError?.(
        error instanceof Error ? error : new Error(`消息发送失败: ${String(error)}`)
      );
    }
  };

  private cleanMsgIdCache = (): void => {
    if (this.processedMsgIds.size > CentrifugeGatewayClient.MAX_MSG_ID_CACHE) {
      const entries = [...this.processedMsgIds];
      this.processedMsgIds.clear();
      entries.slice(-CentrifugeGatewayClient.MAX_MSG_ID_CACHE / 2).forEach((id) => {
        this.processedMsgIds.add(id);
      });
    }
  };
}
