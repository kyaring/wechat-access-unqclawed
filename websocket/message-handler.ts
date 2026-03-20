/**
 * @file message-handler.ts
 * @description WebSocket 消息处理器
 *
 * 负责处理从 AGP 服务端收到的下行消息，核心流程：
 *   1. 收到 session.prompt → 调用 OpenClaw Agent 处理用户指令
 *   2. 通过 runtime.events.onAgentEvent 监听 Agent 的流式输出
 *   3. 将流式输出实时通过 WebSocket 推送给服务端（session.update）
 *   4. Agent 处理完成后发送最终结果（session.promptResponse）
 *   5. 收到 session.cancel → 中断正在处理的 Turn
 */

import type {
  PromptMessage,
  CancelMessage,
  ContentBlock,
  ToolCall,
} from "./types.js";
import { onAgentEvent, type AgentEventPayload } from "../common/agent-events.js";
import type { GatewayClient } from "./types.js";
import { sendPromptResponseReliable } from "./terminal-response-queue.js";

import { getWecomRuntime } from "../common/runtime.js";
import {
  extractTextFromContent,
  buildWebSocketMessageContext,
} from "./message-adapter.js";

// ============================================
// WebSocket 消息处理器
// ============================================

interface ActiveTurn {
  sessionId: string;
  promptId: string;
  cancelled: boolean;
  unsubscribe?: () => void;
}

// ============================================
// 回复文本合并工具函数
// ============================================
// 移植自 QClaw 内置插件，处理 BufferedBlockDispatcher 回复分裂问题。
// 线上观察到 final deliver 可能产生 "NO" + "_REPLY" 这样的分裂片段，
// 需要按扩展/重叠/片段拼接规则合并，避免最后一个 final 把前面的文本覆盖掉。

const mergeOverlappedReplyText = (
  current: string,
  next: string
): string | null => {
  const max = Math.min(current.length, next.length);
  for (let size = max; size > 0; size -= 1) {
    if (current.endsWith(next.slice(0, size))) {
      return `${current}${next.slice(size)}`;
    }
  }
  return null;
};

const mergeFinalReplyText = (
  current: string | null,
  next: string
): string => {
  if (!current) return next;
  if (!next) return current;
  if (current === next) return current;
  if (next.startsWith(current)) return next;
  if (current.startsWith(next)) return current;

  const merged = mergeOverlappedReplyText(current, next);
  if (merged) return merged;

  const trimmedCurrent = current.trim();
  const trimmedNext = next.trim();
  const bothTokenLike =
    /^[A-Z_]+$/.test(trimmedCurrent) && /^[A-Z_]+$/.test(trimmedNext);
  const punctLike = /^[!！?？,，.。:：;；、_)}\]】）》」』]+/;
  const nextWithoutLeadingSpace = next.replace(/^\s+/, "");

  if (bothTokenLike) {
    return `${current}${nextWithoutLeadingSpace}`;
  }

  if (punctLike.test(trimmedNext)) {
    return `${current.replace(/\s+$/, "")}${nextWithoutLeadingSpace}`;
  }

  return `${current}${next}`;
};

const activeTurns = new Map<string, ActiveTurn>();

/**
 * 处理 session.prompt 消息 — 接收用户指令并调用 Agent
 */
export const handlePrompt = async (
  message: PromptMessage,
  client: GatewayClient
): Promise<void> => {
  const { payload } = message;
  const { session_id: sessionId, prompt_id: promptId } = payload;
  const userId = message.user_id ?? "";
  const guid = message.guid ?? "";
  const turnTag = `${sessionId.slice(0, 8)}/${promptId.slice(0, 8)}`;

  const textContent = extractTextFromContent(payload.content);
  console.log("[wechat-access-ws] 收到 prompt:", payload);

  // 1. 注册活跃 Turn
  const turn: ActiveTurn = {
    sessionId,
    promptId,
    cancelled: false,
  };
  activeTurns.set(promptId, turn);

  try {
    const runtime = getWecomRuntime();
    const cfg = runtime.config.loadConfig();

    // 2. 构建消息上下文
    const { ctx, route, storePath } = buildWebSocketMessageContext(payload, userId);

    console.log("[wechat-access-ws] 路由信息:", {
      sessionKey: route.sessionKey,
      agentId: route.agentId,
      accountId: route.accountId,
    });

    // 3. 记录会话元数据
    void runtime.channel.session
      .recordSessionMetaFromInbound({
        storePath,
        sessionKey: (ctx.SessionKey as string) ?? route.sessionKey,
        ctx,
      })
      .catch((err: unknown) => {
        console.log(`[wechat-access-ws] 记录会话元数据失败: ${String(err)}`);
      });

    // 4. 记录入站活动
    runtime.channel.activity.record({
      channel: "wechat-openclaw-channel",
      accountId: route.accountId ?? "default",
      direction: "inbound",
    });

    // 5. 订阅 Agent 事件（流式输出）
    let lastEmittedText = "";
    let toolCallCounter = 0;

    const unsubscribe = await onAgentEvent((evt: AgentEventPayload) => {
      if (turn.cancelled) return;
      if (evt.sessionKey && evt.sessionKey !== route.sessionKey) return;

      const data = evt.data as Record<string, unknown>;

      // --- 处理流式文本（assistant 流）---
      if (evt.stream === "assistant") {
        const delta = data.delta as string | undefined;
        const text = data.text as string | undefined;

        let textToSend = delta;
        if (!textToSend && text && text !== lastEmittedText) {
          textToSend = text.slice(lastEmittedText.length);
          lastEmittedText = text;
        } else if (delta) {
          lastEmittedText += delta;
        }

        if (textToSend) {
          client.sendMessageChunk(sessionId, promptId, {
            type: "text",
            text: textToSend,
          }, guid, userId);
        }
        return;
      }

      // --- 处理工具调用事件（tool 流）---
      if (evt.stream === "tool") {
        const phase = data.phase as string | undefined;
        const toolName = data.name as string | undefined;
        const toolCallId = (data.toolCallId as string) || `tc-${++toolCallCounter}`;

        if (phase === "start") {
          const toolCall: ToolCall = {
            tool_call_id: toolCallId,
            title: toolName,
            kind: mapToolKind(toolName),
            status: "in_progress",
          };
          client.sendToolCall(sessionId, promptId, toolCall, guid, userId);
        } else if (phase === "update") {
          const toolCall: ToolCall = {
            tool_call_id: toolCallId,
            title: toolName,
            status: "in_progress",
            content: data.text
              ? [{ type: "text" as const, text: data.text as string }]
              : undefined,
          };
          client.sendToolCallUpdate(sessionId, promptId, toolCall, guid, userId);
        } else if (phase === "result") {
          const isError = data.isError as boolean | undefined;
          const toolCall: ToolCall = {
            tool_call_id: toolCallId,
            title: toolName,
            status: isError ? "failed" : "completed",
            content: data.result
              ? [{ type: "text" as const, text: data.result as string }]
              : undefined,
          };
          client.sendToolCallUpdate(sessionId, promptId, toolCall, guid, userId);
        }
        return;
      }
    });

    turn.unsubscribe = unsubscribe;

    // 6. 调用 Agent 处理消息
    const messagesConfig = runtime.channel.reply.resolveEffectiveMessagesConfig(
      cfg,
      route.agentId
    );

    let finalText: string | null = null;
    const finalTextCandidates: string[] = [];

    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        responsePrefix: messagesConfig.responsePrefix,
        deliver: async (
          payload: {
            text?: string;
            mediaUrl?: string;
            mediaUrls?: string[];
            isError?: boolean;
            channelData?: unknown;
          },
          info: { kind: string }
        ) => {
          if (turn.cancelled) return;

          console.log(`[wechat-access-ws] Agent ${info.kind} 回复:`,
            payload.text ? JSON.stringify(payload.text.slice(0, 80)) : payload.text
          );

          // 只在 kind=final 时更新 finalText
          // BufferedBlockDispatcher 的 final 可能出现分裂片段（如 "NO" + "_REPLY"），
          // 通过 mergeFinalReplyText 按扩展/重叠/片段拼接规则合并
          if (payload.text && info.kind === "final") {
            finalTextCandidates.push(payload.text);
            finalText = mergeFinalReplyText(finalText, payload.text);
          }

          runtime.channel.activity.record({
            channel: "wechat-openclaw-channel",
            accountId: route.accountId ?? "default",
            direction: "outbound",
          });
        },
        onError: (err: unknown, info: { kind: string }) => {
          console.error(`[wechat-access-ws] Agent ${info.kind} 回复失败:`, err);
        },
      },
      replyOptions: {},
    });

    // 7. 发送最终结果
    unsubscribe();
    activeTurns.delete(promptId);

    if (turn.cancelled) {
      sendPromptResponseReliable({
        client,
        label: `${turnTag} cancelled_response(${promptId})`,
        payload: {
          session_id: sessionId,
          prompt_id: promptId,
          stop_reason: "cancelled",
        },
        guid,
        userId,
      });
      return;
    }

    let replyText =
      finalText || (lastEmittedText.trim() ? lastEmittedText : null);

    // 过滤 NO_REPLY 占位符
    const normalizedReplyText = replyText?.trim() === "NO_REPLY" ? null : replyText;
    const responseContent: ContentBlock[] = normalizedReplyText
      ? [{ type: "text", text: normalizedReplyText }]
      : [];

    sendPromptResponseReliable({
      client,
      label: `${turnTag} prompt_response(${promptId})`,
      payload: {
        session_id: sessionId,
        prompt_id: promptId,
        stop_reason: "end_turn",
        content: responseContent,
      },
      guid,
      userId,
    });

    console.log("[wechat-access-ws] prompt 处理完成:", {
      turnTag,
      promptId,
      hasReply: !!normalizedReplyText,
      finalText: !!finalText,
      finalCandidates: finalTextCandidates,
      lastEmittedTextLength: lastEmittedText.length,
    });
  } catch (err) {
    console.error("[wechat-access-ws] prompt 处理失败:", err);

    const currentTurn = activeTurns.get(promptId);
    currentTurn?.unsubscribe?.();
    activeTurns.delete(promptId);

    sendPromptResponseReliable({
      client,
      label: `${turnTag} error_response(${promptId})`,
      payload: {
        session_id: sessionId,
        prompt_id: promptId,
        stop_reason: "error",
        error: err instanceof Error ? err.message : String(err),
      },
      guid,
      userId,
    });
  }
};

/**
 * 处理 session.cancel 消息 — 取消正在处理的 Prompt Turn
 */
export const handleCancel = (
  message: CancelMessage,
  client: GatewayClient
): void => {
  const { session_id: sessionId, prompt_id: promptId } = message.payload;

  console.log("[wechat-access-ws] 收到 cancel:", { sessionId, promptId });

  const turn = activeTurns.get(promptId);
  if (!turn) {
    console.warn(`[wechat-access-ws] 未找到活跃 Turn: ${promptId}`);
    sendPromptResponseReliable({
      client,
      label: `${sessionId.slice(0, 8)}/${promptId.slice(0, 8)} cancelled_response(${promptId})`,
      payload: {
        session_id: sessionId,
        prompt_id: promptId,
        stop_reason: "cancelled",
      },
    });
    return;
  }

  turn.cancelled = true;
  turn.unsubscribe?.();
  activeTurns.delete(promptId);

  sendPromptResponseReliable({
    client,
    label: `${sessionId.slice(0, 8)}/${promptId.slice(0, 8)} cancelled_response(${promptId})`,
    payload: {
      session_id: sessionId,
      prompt_id: promptId,
      stop_reason: "cancelled",
    },
  });

  console.log("[wechat-access-ws] Turn 已取消:", promptId);
};

// ============================================
// 辅助函数
// ============================================

const mapToolKind = (toolName?: string): ToolCall["kind"] => {
  if (!toolName) return "other";

  const name = toolName.toLowerCase();
  if (name.includes("read") || name.includes("get") || name.includes("view")) return "read";
  if (name.includes("write") || name.includes("edit") || name.includes("replace")) return "edit";
  if (name.includes("delete") || name.includes("remove")) return "delete";
  if (name.includes("search") || name.includes("find") || name.includes("grep")) return "search";
  if (name.includes("fetch") || name.includes("request") || name.includes("http")) return "fetch";
  if (name.includes("think") || name.includes("reason")) return "think";
  if (name.includes("exec") || name.includes("run") || name.includes("terminal")) return "execute";
  return "other";
};
