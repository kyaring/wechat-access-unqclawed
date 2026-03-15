/**
 * @file codebuddy-api.ts
 * @description CodeBuddy (copilot.tencent.com) API 客户端
 *
 * 覆盖：OAuth 登录、WeChat KF 绑定、Workspace/Channel 注册。
 * 逆向自 WorkBuddy.app (Tencent CodeBuddy IDE)。
 */

import { randomUUID } from "node:crypto";
import { hostname, homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_BASE_URL = "https://copilot.tencent.com";
const PREFIX_PATH = "/plugin";
const PLATFORM = "ide";

export class CodeBuddyAPI {
  private baseUrl: string;
  private prefixPath = PREFIX_PATH;

  /** OAuth access token */
  accessToken = "";
  /** OAuth refresh token */
  refreshToken = "";
  /** 用户 ID */
  userId = "";
  /** 机器标识 */
  hostId: string;

  constructor(baseUrl = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.hostId = hostname();
  }

  private getHeaders(auth = true): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (auth && this.accessToken) {
      h["Authorization"] = `Bearer ${this.accessToken}`;
    }
    return h;
  }

  // ==================== OAuth 登录 ====================

  /** 获取登录页 URL 和 state */
  async fetchAuthState(): Promise<{ authUrl: string; state: string }> {
    const url = `${this.baseUrl}/v2${this.prefixPath}/auth/state?platform=${PLATFORM}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { ...this.getHeaders(false), "X-No-Authorization": "true", "X-No-User-Id": "true", "X-No-Enterprise-Id": "true" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`fetchAuthState failed: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as any;
    const result = data?.data;
    if (!result?.authUrl || !result?.state) {
      throw new Error("fetchAuthState: missing authUrl or state in response");
    }
    return { authUrl: result.authUrl, state: result.state };
  }

  /**
   * 轮询获取 token（用户在浏览器中完成登录后返回）
   * @param state - fetchAuthState 返回的 state
   * @param signal - 可选的 AbortSignal
   * @param timeoutMs - 超时时间，默认 5 分钟
   */
  async pollToken(
    state: string,
    signal?: AbortSignal,
    timeoutMs = 5 * 60 * 1000,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn?: number }> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (signal?.aborted) throw new Error("登录已取消");
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const url = `${this.baseUrl}/v2${this.prefixPath}/auth/token?state=${state}`;
        const res = await fetch(url, {
          method: "GET",
          headers: { ...this.getHeaders(false), "X-No-Authorization": "true" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          // code 11217 = still waiting
          if (body.includes("11217")) continue;
          throw new Error(`pollToken: ${res.status} ${body}`);
        }
        const data = (await res.json()) as any;
        const token = data?.data;
        if (token?.accessToken) {
          this.accessToken = token.accessToken;
          this.refreshToken = token.refreshToken || "";
          return {
            accessToken: token.accessToken,
            refreshToken: token.refreshToken || "",
            expiresIn: token.expiresIn,
          };
        }
      } catch (e: any) {
        // code 11217 = still waiting, continue polling
        if (e?.message?.includes("11217")) continue;
        // network errors: retry
        if (e?.code === "UND_ERR_CONNECT_TIMEOUT" || e?.code === "ECONNREFUSED") continue;
        throw e;
      }
    }
    throw new Error("登录超时（5 分钟）");
  }

  /** 获取账号信息 */
  async getAccount(state: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const start = Date.now();
    const timeoutMs = 5 * 60 * 1000;
    while (Date.now() - start < timeoutMs) {
      if (signal?.aborted) throw new Error("操作已取消");
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const url = `${this.baseUrl}/v2${this.prefixPath}/login/account?state=${state}`;
        const res = await fetch(url, {
          method: "GET",
          headers: { ...this.getHeaders(), "X-No-User-Id": "true", "X-No-Enterprise-Id": "true" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          if (body.includes("12151")) continue;
          throw new Error(`getAccount: ${res.status} ${body}`);
        }
        const data = (await res.json()) as any;
        if (data?.data) return data.data;
      } catch (e: any) {
        if (e?.message?.includes("12151")) continue;
        throw e;
      }
    }
    throw new Error("获取账号信息超时");
  }

  /** 刷新 access token */
  async doRefreshToken(): Promise<{ accessToken: string; refreshToken: string }> {
    const url = `${this.baseUrl}/v2${this.prefixPath}/auth/token/refresh`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...this.getHeaders(),
        "X-Refresh-Token": this.refreshToken,
        "X-Auth-Refresh-Source": "ide-main",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const status = res.status;
      if (status === 401 || status === 403) {
        throw new Error("Token 已过期，请重新登录");
      }
      throw new Error(`refreshToken failed: ${status} ${res.statusText}`);
    }
    const data = (await res.json()) as any;
    const token = data?.data;
    if (token?.accessToken) {
      this.accessToken = token.accessToken;
      if (token.refreshToken) this.refreshToken = token.refreshToken;
      return { accessToken: token.accessToken, refreshToken: token.refreshToken || this.refreshToken };
    }
    throw new Error("refreshToken: missing accessToken in response");
  }

  // ==================== WeChat KF 绑定 ====================

  /** 构造 sessionId（与 WorkBuddy 保持一致） */
  buildSessionId(workspacePath?: string): string {
    const wp = workspacePath ?? join(homedir(), "WorkBuddy", "Claw");
    return `${this.userId}_${this.hostId}_${wp}`;
  }

  /** 获取微信客服绑定链接 (QR 码) */
  async wechatkfGetLink(sessionId: string, userId?: string): Promise<{
    success: boolean;
    url?: string;
    expiresIn?: number;
    message?: string;
  }> {
    const url = `${this.baseUrl}/v2/backgroundagent/wechatkfProxy/link`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ sessionId, userId: userId || this.userId }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { success: false, message: `获取链接失败: ${res.status} ${body}` };
    }
    return (await res.json()) as any;
  }

  /** 查询微信客服绑定状态 */
  async wechatkfGetBindStatus(sessionId: string): Promise<{
    success: boolean;
    bound: boolean;
    externalUserId?: string;
    boundAt?: string;
    nickname?: string;
    avatar?: string;
    message?: string;
  }> {
    const url = `${this.baseUrl}/v2/backgroundagent/wechatkfProxy/bindStatus?sessionId=${encodeURIComponent(sessionId)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: this.getHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      return { success: false, bound: false, message: `查询状态失败: ${res.status}` };
    }
    return (await res.json()) as any;
  }

  /** 解除微信客服绑定 */
  async wechatkfUnbind(sessionId: string): Promise<{ success: boolean; message?: string }> {
    const url = `${this.baseUrl}/v2/backgroundagent/wechatkfProxy/bind?sessionId=${encodeURIComponent(sessionId)}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: this.getHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      return { success: false, message: `解绑失败: ${res.status}` };
    }
    return (await res.json()) as any;
  }

  /**
   * 轮询绑定状态直到绑定成功
   * @param sessionId - 会话 ID
   * @param intervalMs - 轮询间隔，默认 10 秒
   * @param timeoutMs - 超时时间，默认 5 分钟
   */
  async pollBindStatus(
    sessionId: string,
    intervalMs = 10_000,
    timeoutMs = 5 * 60 * 1000,
  ): Promise<{ bound: boolean; nickname?: string; avatar?: string; externalUserId?: string }> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const result = await this.wechatkfGetBindStatus(sessionId);
      if (result.success && result.bound) {
        return { bound: true, nickname: result.nickname, avatar: result.avatar, externalUserId: result.externalUserId };
      }
    }
    return { bound: false };
  }

  // ==================== Workspace/Channel 注册 ====================

  /** 注册 Workspace，获取 Centrifuge 连接凭证 */
  async registerWorkspace(params: {
    userId: string;
    hostId: string;
    workspaceId: string;
    workspaceName: string;
  }): Promise<{
    channel: string;
    url: string;
    connectionToken: string;
    subscriptionToken: string;
  }> {
    const url = `${this.baseUrl}/v2/agentos/localagent/registerWorkspace`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({
        ...params,
        localAgentType: "ide",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`registerWorkspace failed: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as any;
    if (!data?.data) throw new Error("registerWorkspace: missing data field");
    return data.data;
  }

  /** 注册 Channel */
  async registerChannel(params: {
    type: string;
    sessionId: string;
    channelId?: string;
    [key: string]: unknown;
  }): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/v2/backgroundagent/localProxy/register`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`registerChannel failed: ${res.status} ${body}`);
    }
    return (await res.json()) as any;
  }

  /** 发送回复（COPILOT_RESPONSE） */
  async sendResponse(payload: { msgId: string; [key: string]: unknown }): Promise<void> {
    const url = `${this.baseUrl}/v2/backgroundagent/wecom/local-proxy/receive`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`sendResponse failed: ${res.status} ${res.statusText}`);
  }
}
