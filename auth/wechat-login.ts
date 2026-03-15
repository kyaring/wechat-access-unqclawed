/**
 * @file wechat-login.ts
 * @description 微信扫码登录流程编排
 *
 * 对应 Python demo 的 WeChatLogin 类和 do_login 函数。
 * 流程：获取 state → 生成二维码 → 等待 code → 换 token → (邀请码) → 保存
 */

import { createInterface } from "node:readline";
import type { QClawEnvironment, LoginCredentials } from "./types.js";
import { QClawAPI } from "./qclaw-api.js";
import { buildAuthUrl } from "./wechat-qr-poll.js";
import { nested } from "./utils.js";

export interface PerformLoginOptions {
  guid: string;
  env: QClawEnvironment;
  /** 邀请码（留空尝试跳过验证） */
  inviteCode?: string;
  /** 日志函数 */
  log?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}

/** 通过 readline 交互式等待用户输入 */
const askInput = (prompt: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
};

/**
 * 执行完整的微信扫码登录流程
 *
 * 步骤：
 * 1. 获取 OAuth state
 * 2. 生成二维码并展示
 * 3. 等待用户输入 code（通过文件轮询）
 * 4. 用 code 换 token
 * 5. 创建 API Key（非致命）
 * 6. 邀请码检查
 * 7. 保存登录态
 */
export const performLogin = async (options: PerformLoginOptions): Promise<LoginCredentials> => {
  const { guid, env, inviteCode, log } = options;
  const info = (...args: unknown[]) => log?.info?.(...args) ?? console.log(...args);
  const warn = (...args: unknown[]) => log?.warn?.(...args) ?? console.warn(...args);

  const api = new QClawAPI(env, guid);

  // 1. 获取 OAuth state
  info("[Login] 步骤 1/5: 获取登录 state...");
  let state = String(Math.floor(Math.random() * 10000)); // 随机兜底
  const stateResult = await api.getWxLoginState();
  if (stateResult.success) {
    const s = nested(stateResult.data, "state") as string | undefined;
    if (s) state = s;
  }
  info(`[Login] state=${state}`);

  // 2. 生成二维码 URL
  info("[Login] 步骤 2/5: 请在浏览器中打开以下链接，并用手机微信扫码登录...");
  const authUrl = buildAuthUrl(state, env);
  info("");
  info(authUrl);
  info("");
  // 3. 等待 code（交互式输入）
  info("[Login] 步骤 3/5: 等待微信扫码授权...");
  info("");
  info("扫码并在手机上确认后，浏览器会跳转到新页面。");
  info("地址栏 URL 形如：");
  info("");
  info("  https://security.guanjia.qq.com/login?code=0a1B2c...&state=xxx");
  info("");
  info("请复制 code= 后面的值（到 & 之前），或直接粘贴完整 URL。");

  let code = "";
  const raw = await askInput("\n请粘贴 code 或完整 URL: ");

  if (!raw) {
    throw new Error("未获取到授权 code");
  }

  // 去掉 shell 转义残留的反斜杠
  const cleaned = raw.replace(/\\([?=&#])/g, "$1");

  // 检查是否误粘贴了扫码页面 URL（而非回调 URL）
  if (cleaned.includes("open.weixin.qq.com/connect/qrconnect")) {
    throw new Error("这是扫码页面的 URL，不是回调 URL。请先在浏览器中打开此链接扫码，扫码确认后浏览器会跳转到新页面，再复制新页面地址栏中的 URL。");
  }

  // 从 URL 或裸 code 中提取 code
  if (cleaned.includes("code=")) {
    try {
      const url = new URL(cleaned);
      const c = url.searchParams.get("code");
      if (c) code = c;
    } catch {
      const match = cleaned.match(/[?&#]code=([^&#]+)/);
      if (match?.[1]) code = match[1];
    }
  }

  if (!code) code = cleaned;

  // 基本校验：code 不应该是 URL
  if (code.startsWith("http")) {
    throw new Error("无法从 URL 中提取 code。请确认粘贴的是扫码确认后跳转页面的 URL。");
  }

  // 4. 用 code 换 token
  info(`[Login] 步骤 4/5: 用授权码登录 (code=${code.substring(0, 10)}...)`);
  const loginResult = await api.wxLogin(code, state);
  if (!loginResult.success) {
    throw new Error(`登录失败: ${loginResult.message ?? "未知错误"}`);
  }

  const loginData = loginResult.data as Record<string, unknown>;
  const jwtToken = (loginData.token as string) || "";
  const channelToken = (loginData.openclaw_channel_token as string) || "";
  const userInfo = (loginData.user_info as Record<string, unknown>) || {};

  api.jwtToken = jwtToken;
  api.userId = String(userInfo.user_id ?? "");
  // 更新 loginKey（服务端可能返回新值，后续 API 调用需要使用）
  const loginKey = userInfo.loginKey as string | undefined;
  if (loginKey) {
    api.loginKey = loginKey;
  }

  info(`[Login] 登录成功! 用户: ${(userInfo.nickname as string) ?? "unknown"}`);

  // 5. 创建 API Key（非致命）
  info("[Login] 步骤 5/5: 创建 API Key...");
  let apiKey = "";
  try {
    const keyResult = await api.createApiKey();
    if (keyResult.success) {
      apiKey =
        (nested(keyResult.data, "key") as string) ??
        (nested(keyResult.data, "resp", "data", "key") as string) ??
        "";
      if (apiKey) info(`[Login] API Key: ${apiKey.substring(0, 8)}...`);
    }
  } catch (e) {
    warn(`[Login] 创建 API Key 失败（非致命）: ${e}`);
  }

  // 邀请码检查
  const userId = String(userInfo.user_id ?? "");
  if (userId) {
    try {
      const check = await api.checkInviteCode(userId);
      if (check.success) {
        const verified = nested(check.data, "already_verified");
        if (!verified) {
          let codeToSubmit = inviteCode;
          if (codeToSubmit === undefined) {
            info("");
            info("需要邀请码验证。没有邀请码可按回车跳过。");
            codeToSubmit = await askInput("请输入邀请码: ");
          }
          const submitResult = await api.submitInviteCode(userId, codeToSubmit ?? "");
          if (!submitResult.success) {
            throw new Error(`邀请码验证失败: ${submitResult.message}`);
          }
          info("[Login] 邀请码验证通过!");
        }
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("邀请码验证失败")) throw e;
      warn(`[Login] 邀请码检查失败（非致命）: ${e}`);
    }
  }

  // 返回登录凭证（由调用方负责持久化到 openclaw.json）
  const credentials: LoginCredentials = {
    jwtToken,
    channelToken,
    userInfo,
    apiKey,
    guid,
  };

  info("[Login] 登录完成");

  return credentials;
};
