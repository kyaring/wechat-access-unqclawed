// ============================================
// WebSocket 模块导出
// ============================================

// 类型定义
export type {
  AGPEnvelope,
  AGPMethod,
  ContentBlock,
  ToolCall,
  ToolCallKind,
  ToolCallStatus,
  ToolLocation,
  PromptPayload,
  CancelPayload,
  UpdatePayload,
  UpdateType,
  PromptResponsePayload,
  StopReason,
  PromptMessage,
  CancelMessage,
  UpdateMessage,
  PromptResponseMessage,
  WebSocketClientConfig,
  ConnectionState,
  WebSocketClientCallbacks,
  GatewayClient,
} from "./types.js";

// WebSocket 客户端
export { WechatAccessWebSocketClient } from "./websocket-client.js";
export { CentrifugeGatewayClient } from "./centrifuge-client.js";
export type { CentrifugeClientConfig } from "./centrifuge-client.js";

// 消息处理器
export { handlePrompt, handleCancel } from "./message-handler.js";

// 可靠发送队列
export {
  sendPromptResponseReliable,
  registerTerminalClient,
  unregisterTerminalClient,
  flushPendingTerminalMessages,
} from "./terminal-response-queue.js";
export type { ReliablePromptResponseInput } from "./terminal-response-queue.js";

// 消息适配器
export {
  extractTextFromContent,
  promptPayloadToFuwuhaoMessage,
  buildWebSocketMessageContext,
} from "./message-adapter.js";
