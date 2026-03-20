/**
 * @file terminal-response-queue.ts
 * @description 终态消息可靠发送队列
 *
 * 移植自 QClaw 内置插件的 terminal-response-queue，适配 GatewayClient 接口。
 *
 * 核心机制：
 *   - session.promptResponse 是终态消息，丢失会导致服务端认为 Turn 未结束
 *   - 当 WebSocket 断线时，sendPromptResponse 会失败
 *   - 本模块将失败的终态消息写入内存队列 + 磁盘持久化（WAL）
 *   - 连接恢复后定时 flush 队列，确保终态消息最终送达
 *
 * 使用方式：
 *   1. 插件启动时调用 registerTerminalClient(client, accountId) 注册客户端
 *   2. 发送终态消息时调用 sendPromptResponseReliable() 代替 client.sendPromptResponse()
 *   3. 连接恢复后调用 flushPendingTerminalMessages(client) 补发排队消息
 *   4. 插件停止时调用 unregisterTerminalClient(client) 清理资源
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PromptResponsePayload, ConnectionState, GatewayClient } from "./types.js";

// ============================================
// 类型定义
// ============================================

interface PendingPromptResponse {
  key: string;
  accountId: string;
  label: string;
  payload: PromptResponsePayload;
  guid?: string;
  userId?: string;
  queuedAt: number;
  updatedAt: number;
  attempts: number;
}

export interface ReliablePromptResponseInput {
  client: GatewayClient;
  label: string;
  payload: PromptResponsePayload;
  guid?: string;
  userId?: string;
}

// ============================================
// 常量
// ============================================

/** 定时 flush 间隔（毫秒） */
const FLUSH_INTERVAL_MS = 2000;

/** 持久化存储目录 */
const STORAGE_DIR = path.join(os.homedir(), ".openclaw", "wechat-access");

/** 持久化存储文件 */
const STORAGE_FILE = path.join(STORAGE_DIR, "pending-prompt-responses.json");

// ============================================
// 状态
// ============================================

/** 注册的客户端（按 accountId） */
const accountClients = new Map<string, GatewayClient>();

/** 定时 flush 定时器（按 accountId） */
const accountFlushTimers = new Map<string, ReturnType<typeof setInterval>>();

/** 客户端 → accountId 的反查表 */
const clientAccountIds = new WeakMap<GatewayClient, string>();

/** 待补发的终态消息队列 */
const pendingPromptResponses = loadPendingPromptResponses();

// ============================================
// 持久化
// ============================================

function loadPendingPromptResponses(): Map<string, PendingPromptResponse> {
  try {
    if (!fs.existsSync(STORAGE_FILE)) {
      return new Map();
    }
    const raw = fs.readFileSync(STORAGE_FILE, "utf8");
    if (!raw.trim()) {
      return new Map();
    }
    const list = JSON.parse(raw) as PendingPromptResponse[];
    return new Map(list.map((item) => [item.key, item]));
  } catch (err) {
    console.error("[wechat-access] 加载终态消息 WAL 失败，忽略旧数据", err);
    return new Map();
  }
}

function persistPendingPromptResponses(): void {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    const tmpFile = `${STORAGE_FILE}.tmp`;
    const content = JSON.stringify(
      Array.from(pendingPromptResponses.values()),
      null,
      2
    );
    fs.writeFileSync(tmpFile, content, "utf8");
    fs.renameSync(tmpFile, STORAGE_FILE);
  } catch (err) {
    console.error("[wechat-access] 持久化终态消息 WAL 失败", err);
  }
}

// ============================================
// 辅助函数
// ============================================

const getAccountIdByClient = (client: GatewayClient): string => {
  return clientAccountIds.get(client) ?? "default";
};

const getPendingItemsByAccount = (accountId: string): PendingPromptResponse[] => {
  return Array.from(pendingPromptResponses.values())
    .filter((item) => item.accountId === accountId)
    .sort((a, b) => a.queuedAt - b.queuedAt);
};

const makePendingKey = (accountId: string, promptId: string): string => {
  return `${accountId}:${promptId}`;
};

const ensureFlushTimer = (accountId: string): void => {
  if (accountFlushTimers.has(accountId)) {
    return;
  }
  const timer = setInterval(() => {
    flushPendingPromptResponsesByAccount(accountId);
  }, FLUSH_INTERVAL_MS);
  accountFlushTimers.set(accountId, timer);
};

const clearFlushTimer = (accountId: string): void => {
  const timer = accountFlushTimers.get(accountId);
  if (timer) {
    clearInterval(timer);
    accountFlushTimers.delete(accountId);
  }
};

const enqueuePromptResponse = (
  accountId: string,
  label: string,
  payload: PromptResponsePayload,
  guid?: string,
  userId?: string
): boolean => {
  const key = makePendingKey(accountId, payload.prompt_id);
  const prev = pendingPromptResponses.get(key);
  const now = Date.now();
  pendingPromptResponses.set(key, {
    key,
    accountId,
    label,
    payload,
    guid,
    userId,
    queuedAt: prev?.queuedAt ?? now,
    updatedAt: now,
    attempts: (prev?.attempts ?? 0) + 1,
  });
  persistPendingPromptResponses();
  console.warn("[wechat-access] 终态消息已写入补发队列", {
    accountId,
    key,
    label,
    pending: getPendingItemsByAccount(accountId).length,
  });
  return true;
};

// ============================================
// 公共 API
// ============================================

/**
 * 注册客户端到可靠发送队列
 * 插件启动 / 连接建立后调用
 */
export const registerTerminalClient = (
  client: GatewayClient,
  accountId: string
): void => {
  accountClients.set(accountId, client);
  clientAccountIds.set(client, accountId);
  ensureFlushTimer(accountId);
  const pending = getPendingItemsByAccount(accountId).length;
  if (pending > 0) {
    console.log("[wechat-access] 检测到历史终态消息待补发", {
      accountId,
      pending,
    });
  }
};

/**
 * 注销客户端
 * 插件停止 / 连接断开后调用
 */
export const unregisterTerminalClient = (client: GatewayClient): void => {
  const accountId = clientAccountIds.get(client);
  if (!accountId) {
    return;
  }
  if (accountClients.get(accountId) === client) {
    accountClients.delete(accountId);
    clearFlushTimer(accountId);
  }
  clientAccountIds.delete(client);
};

/**
 * 可靠发送 session.promptResponse
 * 先尝试直接发送，失败则入队等待补发
 */
export const sendPromptResponseReliable = ({
  client,
  label,
  payload,
  guid,
  userId,
}: ReliablePromptResponseInput): boolean => {
  const accountId = getAccountIdByClient(client);
  try {
    const state = client.getState();
    console.log(
      `[wechat-access-ws] ${label} 尝试发送: state=${state}`
    );
    if (state !== "connected") {
      // 未连接时直接入队，不尝试发送（避免触发无意义的 warn 日志）
      return enqueuePromptResponse(accountId, label, payload, guid, userId);
    }
    client.sendPromptResponse(payload, guid, userId);
    return true;
  } catch (err) {
    console.warn(
      `[wechat-access-ws] ${label} 发送失败，写入补发队列`,
      err
    );
    return enqueuePromptResponse(accountId, label, payload, guid, userId);
  }
};

/**
 * 手动触发补发（连接恢复后调用）
 */
export const flushPendingTerminalMessages = (
  client: GatewayClient
): void => {
  flushPendingPromptResponsesByAccount(getAccountIdByClient(client));
};

// ============================================
// 内部补发逻辑
// ============================================

function flushPendingPromptResponsesByAccount(accountId: string): void {
  const client = accountClients.get(accountId);
  if (!client) {
    return;
  }
  if (client.getState() !== "connected") {
    return;
  }
  const items = getPendingItemsByAccount(accountId);
  if (items.length === 0) {
    return;
  }

  console.log("[wechat-access] 开始补发终态消息", {
    accountId,
    pending: items.length,
  });

  let dirty = false;
  for (const item of items) {
    try {
      client.sendPromptResponse(item.payload, item.guid, item.userId);
      pendingPromptResponses.delete(item.key);
      dirty = true;
      console.log("[wechat-access] 终态消息补发成功", {
        accountId,
        key: item.key,
        label: item.label,
        queuedForMs: Date.now() - item.queuedAt,
        pending: getPendingItemsByAccount(accountId).length,
      });
    } catch (err) {
      pendingPromptResponses.set(item.key, {
        ...item,
        attempts: item.attempts + 1,
        updatedAt: Date.now(),
      });
      dirty = true;
      console.warn("[wechat-access] 终态消息补发失败，等待下一轮重试", {
        accountId,
        key: item.key,
        label: item.label,
        attempts: item.attempts + 1,
        error: err instanceof Error ? err.message : String(err),
      });
      break; // 一条失败则停止本轮，等下次 flush
    }
  }

  if (dirty) {
    persistPendingPromptResponses();
  }
}
