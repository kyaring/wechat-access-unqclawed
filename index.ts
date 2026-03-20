import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { WechatAccessWebSocketClient, CentrifugeGatewayClient, handlePrompt, handleCancel, registerTerminalClient, unregisterTerminalClient, flushPendingTerminalMessages } from "./websocket/index.js";
import { setWecomRuntime, getWecomRuntime } from "./common/runtime.js";
import { performLogin, performDeviceBinding, getDeviceGuid, getEnvironment, QClawAPI, CodeBuddyAPI, TokenExpiredError } from "./auth/index.js";
import type { LoginMode, QClawCredentials, WorkBuddyCredentials } from "./auth/index.js";
import { join } from "node:path";
import { homedir } from "node:os";

// 类型定义
type NormalizedChatType = "direct" | "group" | "channel";

// WebSocket 客户端实例（按 accountId 存储，支持两种客户端类型）
const wsClients = new Map<string, WechatAccessWebSocketClient | CentrifugeGatewayClient>();

// WorkBuddy HTTP 回复上下文（sendText outbound 用）
let wbHttpContext: {
  baseUrl: string;
  accessToken: string;
  sessionId: string;  // workspace sessionId for metadata
} | null = null;

// 最近收到的 WeChat KF chatId 缓存（用于 sendText outbound 回复）
const lastChatIdByTo = new Map<string, string>();

// ── 配置读写 helpers ──

/** 从 openclaw.json 读取当前渠道配置 */
function readChannelConfig(): {
  loginMode?: LoginMode;
  qclaw?: QClawCredentials;
  workbuddy?: WorkBuddyCredentials;
  environment?: string;
  [key: string]: unknown;
} {
  const runtime = getWecomRuntime();
  const cfg = runtime.config.loadConfig();
  return cfg?.channels?.["wechat-openclaw-channel"] ?? {};
}

/** 写入凭证到 openclaw.json（合并更新） */
async function writeChannelConfig(update: Record<string, unknown>): Promise<void> {
  const runtime = getWecomRuntime();
  const cfg = runtime.config.loadConfig();
  const channels = { ...(cfg.channels ?? {}) } as Record<string, any>;
  channels["wechat-openclaw-channel"] = {
    ...(channels["wechat-openclaw-channel"] ?? {}),
    ...update,
  };
  await runtime.config.writeConfigFile({ ...cfg, channels });
}

// 渠道元数据
const meta = {
  id: "wechat-openclaw-channel",
  label: "腾讯通路",
  selectionLabel: "腾讯通路",
  detailLabel: "腾讯通路",
  docsPath: "/channels/wechat-access",
  docsLabel: "wechat-openclaw-channel",
  blurb: "通用通路",
  systemImage: "message.fill",
  order: 85,
};

// 渠道插件
const tencentAccessPlugin = {
  id: "wechat-openclaw-channel",
  meta,

  capabilities: {
    chatTypes: ["direct"] as NormalizedChatType[],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: false,
  },

  reload: {
    configPrefixes: ["channels.wechat-openclaw-channel.token", "channels.wechat-openclaw-channel.wsUrl"],
  },

  config: {
    listAccountIds: (cfg: any) => {
      const accounts = cfg.channels?.["wechat-openclaw-channel"]?.accounts;
      if (accounts && typeof accounts === "object") {
        return Object.keys(accounts);
      }
      return ["default"];
    },
    resolveAccount: (cfg: any, accountId: string) => {
      const accounts = cfg.channels?.["wechat-openclaw-channel"]?.accounts;
      const account = accounts?.[accountId ?? "default"];
      return account ?? { accountId: accountId ?? "default" };
    },
    resolveAllowFrom: () => ["*"],
  },

  // 认证适配器：提示用户使用 CLI
  auth: {
    login: async ({ runtime }: { cfg: any; accountId?: string; runtime: any; verbose?: boolean; channelInput?: string }) => {
      runtime.log("[wechat-access] 请使用 'openclaw wechat login' 命令登录");
    },
  },

  // 出站适配器
  outbound: {
    deliveryMode: "direct" as const,
    sendText: async (ctx: { to: string; text: string; replyToId?: string | null; accountId?: string | null }) => {
      // WorkBuddy 模式：通过 HTTP COPILOT_RESPONSE 发送
      if (wbHttpContext) {
        const chatId = lastChatIdByTo.get(ctx.to) || lastChatIdByTo.get(ctx.to.split(":").pop() || "");
        if (!chatId) {
          console.warn(`[wechat-access] sendText: 未找到 chatId for to=${ctx.to}, 跳过`);
          return { ok: true };
        }

        const httpPayload = {
          type: "COPILOT_RESPONSE",
          msgId: ctx.replyToId || `outbound-${Date.now()}`,
          chatId,
          success: true,
          message: ctx.text,
          metadata: {
            sessionId: wbHttpContext.sessionId,
            state: "completed",
          },
        };

        const url = `${wbHttpContext.baseUrl}/v2/backgroundagent/wecom/local-proxy/receive`;
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${wbHttpContext.accessToken}`,
            },
            body: JSON.stringify(httpPayload),
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            console.error(`[wechat-access] sendText HTTP 失败: ${res.status} ${body.substring(0, 200)}`);
          } else {
            console.log(`[wechat-access] sendText HTTP 发送成功: to=${ctx.to}`);
          }
        } catch (err) {
          console.error(`[wechat-access] sendText HTTP 异常:`, err);
        }
        return { ok: true };
      }

      return { ok: true };
    },
  },

  // 状态适配器
  status: {
    buildAccountSnapshot: ({ accountId }: { accountId?: string; cfg: any; runtime?: any }) => {
      const client = wsClients.get(accountId ?? "default");
      const running = client?.getState() === "connected";
      return { running };
    },
  },

  // Gateway 适配器
  gateway: {
    startAccount: async (ctx: any) => {
      const { cfg, accountId, abortSignal, log } = ctx;
      log?.info(`[wechat-access] >>> startAccount 被调用, accountId=${accountId}`);
      try {

      const channelCfg = readChannelConfig();
      const gatewayPort = cfg?.gateway?.port ? String(cfg.gateway.port) : "unknown";
      const guid = getDeviceGuid();

      const loginMode: LoginMode = channelCfg.loginMode || "qclaw";
      log?.info(`[wechat-access] 启动账号 ${accountId}, loginMode=${loginMode}`);

      // ── WorkBuddy 模式 ──
      if (loginMode === "workbuddy") {
        const creds = channelCfg.workbuddy;
        log?.info(`[wechat-access] WorkBuddy 模式, hasCredentials=${!!creds}, hasAccessToken=${!!creds?.accessToken}`);
        if (!creds?.accessToken) {
          log?.warn(`[wechat-access] WorkBuddy 模式未找到 accessToken，请运行 "openclaw wechat login" 完成登录`);
          return;
        }

        const cbApi = new CodeBuddyAPI(creds.baseUrl);
        cbApi.accessToken = creds.accessToken;
        cbApi.refreshToken = creds.refreshToken || "";
        cbApi.userId = creds.userId
          || String((creds.userInfo as Record<string, unknown>)?.userId ?? "")
          || String((creds.userInfo as Record<string, unknown>)?.user_id ?? "")
          || String((creds.userInfo as Record<string, unknown>)?.uid ?? "");
        cbApi.hostId = creds.hostId || cbApi.hostId;
        log?.info(`[wechat-access] CodeBuddy API 初始化完成, userId=${cbApi.userId}, hostId=${cbApi.hostId}`);

        if (!cbApi.userId) {
          log?.warn(`[wechat-access] userId 为空，请重新运行 "openclaw wechat login" 登录`);
          return;
        }

        // 刷新 access token（仅在内存中使用，不写回配置以避免触发 gateway 重启）
        try {
          log?.info(`[wechat-access] 正在刷新 accessToken...`);
          await cbApi.doRefreshToken();
          log?.info(`[wechat-access] accessToken 已刷新`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log?.warn(`[wechat-access] token 刷新异常: ${msg}`);
          if (msg.includes("过期") || msg.includes("401") || msg.includes("403")) {
            log?.warn(`[wechat-access] token 已过期，请重新运行 "openclaw wechat login"`);
            return;
          }
          log?.warn(`[wechat-access] token 刷新失败，使用旧 token 继续`);
        }

        // 注册 host channel
        log?.info(`[wechat-access] 正在注册 Host Channel...`);
        let centrifugeParams: { channel: string; url: string; connectionToken: string; subscriptionToken: string };
        try {
          centrifugeParams = await cbApi.registerWorkspace({
            userId: cbApi.userId,
            hostId: cbApi.hostId,
            workspaceId: "",
            workspaceName: `Host Channel (${cbApi.hostId})`,
          });
          log?.info(`[wechat-access] Host Channel 注册成功, channel=${centrifugeParams.channel}, url=${centrifugeParams.url}`);
        } catch (e) {
          log?.error(`[wechat-access] Workspace 注册失败: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }

        const client = new CentrifugeGatewayClient(
          {
            url: centrifugeParams.url,
            connectionToken: centrifugeParams.connectionToken,
            channel: centrifugeParams.channel,
            subscriptionToken: centrifugeParams.subscriptionToken,
            guid,
            userId: cbApi.userId,
            gatewayPort,
            httpBaseUrl: creds.baseUrl || "https://copilot.tencent.com",
            httpAccessToken: cbApi.accessToken,
            workspaceSessionId: cbApi.buildSessionId(),
          },
          {
            onConnected: () => {
              log?.info(`[wechat-access] Centrifuge 连接成功`);
              ctx.setStatus({ running: true });
              registerTerminalClient(client, accountId);
              flushPendingTerminalMessages(client);

              // 注册 Claw workspace channel（与 WorkBuddy 保持一致，WeChat KF 消息路由到此 channel）
              const clawPath = join(homedir(), "WorkBuddy", "Claw");
              cbApi.registerWorkspace({
                userId: cbApi.userId,
                hostId: cbApi.hostId,
                workspaceId: clawPath,
                workspaceName: "Claw",
              }).then((clawParams) => {
                log?.info(`[wechat-access] Claw workspace 注册成功, channel=${clawParams.channel}`);
                client.subscribeChannel(clawParams.channel, clawParams.subscriptionToken);
              }).catch((e) => {
                log?.warn(`[wechat-access] Claw workspace 注册失败: ${e instanceof Error ? e.message : String(e)}`);
              });
            },
            onDisconnected: (reason?: string) => {
              log?.warn(`[wechat-access] Centrifuge 连接断开: ${reason}`);
              ctx.setStatus({ running: false });
            },
            onPrompt: (message: any) => {
              // 缓存 WeChat KF chatId，供 sendText outbound 回复时使用
              if (message._wechatKf?.chatId) {
                const sessionKey = `agent:main:wechat-access:direct:${cbApi.userId}`;
                lastChatIdByTo.set(sessionKey, message._wechatKf.chatId);
                lastChatIdByTo.set(cbApi.userId, message._wechatKf.chatId);
              }
              void handlePrompt(message, client).catch((err: Error) => {
                log?.error(`[wechat-access] 处理 prompt 失败: ${err.message}`);
              });
            },
            onCancel: (message: any) => {
              handleCancel(message, client);
            },
            onError: (error: Error) => {
              log?.error(`[wechat-access] Centrifuge 错误: ${error.message}`);
            },
          },
        );

        wsClients.set(accountId, client);
        client.start();

        // 设置 HTTP 回复上下文（供 sendText outbound 使用）
        wbHttpContext = {
          baseUrl: creds.baseUrl || "https://copilot.tencent.com",
          accessToken: cbApi.accessToken,
          sessionId: cbApi.buildSessionId(),
        };

        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => {
            log?.info(`[wechat-access] 停止账号 ${accountId}`);
            client.stop();
            unregisterTerminalClient(client);
            if (wsClients.get(accountId) === client) {
              wsClients.delete(accountId);
              ctx.setStatus({ running: false });
            }
            resolve();
          });
        });
        return;
      }

      // ── QClaw 模式 ──
      const qclawCreds = channelCfg.qclaw;
      const envName: string = channelCfg.environment ? String(channelCfg.environment) : "production";
      const env = getEnvironment(envName);
      const wsUrl = (qclawCreds?.wsUrl || env.wechatWsUrl);

      let token = qclawCreds?.channelToken || "";

      log?.info(`[wechat-access] QClaw 模式启动`, {
        platform: process.platform,
        nodeVersion: process.version,
        hasToken: !!token,
        hasUrl: !!wsUrl,
        url: wsUrl || "(未配置)",
        tokenPrefix: token ? token.substring(0, 6) + "..." : "(未配置)",
      });

      if (!token) {
        log?.warn(`[wechat-access] 未找到 token，请运行 "openclaw wechat login" 完成扫码登录，然后重启 Gateway`);
        return;
      }

      // Token 刷新
      const jwtToken = qclawCreds?.jwtToken || "";
      if (jwtToken) {
        const api = new QClawAPI(env, guid, jwtToken);
        api.userId = qclawCreds?.userId || "";
        const savedLoginKey = (qclawCreds?.userInfo as Record<string, unknown>)?.loginKey as string | undefined;
        if (savedLoginKey) api.loginKey = savedLoginKey;

        let refreshed = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const newToken = await api.refreshChannelToken();
            if (newToken) {
              token = newToken;
              log?.info(`[wechat-access] channel_token 已刷新: ${token.substring(0, 6)}...`);
              refreshed = true;
              break;
            }
          } catch (e) {
            if (e instanceof TokenExpiredError) {
              log?.warn(`[wechat-access] jwt_token 已过期，请重新运行 "openclaw wechat login"`);
              return;
            }
            log?.warn(`[wechat-access] token 刷新失败 (${attempt + 1}/3): ${e instanceof Error ? e.message : String(e)}`);
          }
          if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
        }
        if (!refreshed) {
          log?.info(`[wechat-access] token 刷新失败，使用旧 token 尝试连接`);
        }
      }

      const userId = qclawCreds?.userId || "";

      const wsConfig = {
        url: wsUrl,
        token,
        guid,
        userId,
        gatewayPort,
        reconnectInterval: 3000,
        maxReconnectAttempts: 10,
        heartbeatInterval: 20000,
      };

      const qclawClient = new WechatAccessWebSocketClient(wsConfig, {
        onConnected: () => {
          log?.info(`[wechat-access] WebSocket 连接成功`);
          ctx.setStatus({ running: true });
          registerTerminalClient(qclawClient, accountId);
          flushPendingTerminalMessages(qclawClient);
        },
        onDisconnected: (reason?: string) => {
          log?.warn(`[wechat-access] WebSocket 连接断开: ${reason}`);
          ctx.setStatus({ running: false });
        },
        onPrompt: (message: any) => {
          void handlePrompt(message, qclawClient).catch((err: Error) => {
            log?.error(`[wechat-access] 处理 prompt 失败: ${err.message}`);
          });
        },
        onCancel: (message: any) => {
          handleCancel(message, qclawClient);
        },
        onError: (error: Error) => {
          log?.error(`[wechat-access] WebSocket 错误: ${error.message}`);
        },
      });

      wsClients.set(accountId, qclawClient);
      qclawClient.start();

      await new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => {
          log?.info(`[wechat-access] 停止账号 ${accountId}`);
          qclawClient.stop();
          unregisterTerminalClient(qclawClient);
          if (wsClients.get(accountId) === qclawClient) {
            wsClients.delete(accountId);
            ctx.setStatus({ running: false });
          }
          resolve();
        });
      });
      } catch (e: any) {
        log?.error(`[wechat-access] startAccount 未捕获异常: ${e?.message ?? e}\n${e?.stack ?? ""}`);
      }
    },

    stopAccount: async (ctx: any) => {
      const { accountId, log } = ctx;
      log?.info(`[wechat-access] stopAccount 钩子触发，停止账号 ${accountId}`);
      const client = wsClients.get(accountId);
      if (client) {
        client.stop();
        unregisterTerminalClient(client);
        wsClients.delete(accountId);
        ctx.setStatus({ running: false });
        log?.info(`[wechat-access] 账号 ${accountId} 已停止`);
      } else {
        log?.warn(`[wechat-access] stopAccount: 未找到账号 ${accountId} 的客户端`);
      }
    },
  },
};

const index = {
  id: "wechat-openclaw-channel",
  name: "通用通路插件",
  description: "腾讯通用通路插件",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    setWecomRuntime(api.runtime);
    api.registerChannel({ plugin: tencentAccessPlugin as any });

    // CLI 命令
    api.registerCli(
      ({ program, config }) => {
        const wechat = program.command("wechat").description("微信通路登录管理");

        // ── wechat login（交互式选择） ──
        wechat
          .command("login")
          .description("登录（交互式选择 QClaw 或 WorkBuddy）")
          .action(async () => {
            const { createInterface } = await import("node:readline");
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            const ask = (q: string) => new Promise<string>(r => rl.question(q, a => { r(a.trim()); }));

            console.log("\n请选择登录方式：");
            console.log("  1. QClaw（微信扫码 → JPRX 网关）");
            console.log("  2. WorkBuddy（CodeBuddy OAuth → Centrifuge）");
            const choice = await ask("\n请输入 1 或 2: ");
            rl.close();

            if (choice === "2") {
              // ── WorkBuddy 流程 ──
              console.log("[wechat login] 使用 WorkBuddy 模式登录...");
              const channelCfg = config?.channels?.["wechat-openclaw-channel"];
              const cbBaseUrl = channelCfg?.codebuddyBaseUrl ? String(channelCfg.codebuddyBaseUrl) : undefined;
              const cbApi = new CodeBuddyAPI(cbBaseUrl);

              try {
                const { authUrl, state } = await cbApi.fetchAuthState();
                console.log("\n" + "=".repeat(64));
                console.log("请在浏览器中打开以下链接完成登录：");
                console.log("");
                console.log(authUrl);
                console.log("");
                console.log("等待登录...");
                console.log("=".repeat(64));

                const tokenResult = await cbApi.pollToken(state);
                console.log("[wechat login] OAuth 登录成功!");

                let userInfo: Record<string, unknown> = {};
                try {
                  userInfo = await cbApi.getAccount(state);
                  cbApi.userId = String(userInfo.uid ?? userInfo.userId ?? userInfo.user_id ?? "");
                } catch (e) {
                  console.warn(`[wechat login] 获取账号信息失败: ${e instanceof Error ? e.message : String(e)}`);
                }

                const wbCreds: WorkBuddyCredentials = {
                  accessToken: tokenResult.accessToken,
                  refreshToken: tokenResult.refreshToken,
                  userId: cbApi.userId,
                  hostId: cbApi.hostId,
                  baseUrl: cbBaseUrl,
                  userInfo,
                };
                await writeChannelConfig({ loginMode: "workbuddy" as LoginMode, workbuddy: wbCreds });

                const nickname = String(userInfo.nickName ?? userInfo.nickname ?? "用户");
                console.log(`\nWorkBuddy 登录成功! 欢迎 ${nickname}`);
                console.log("请运行 openclaw gateway restart 启动通路。");
                console.log("首次使用请在 gateway 启动后运行 openclaw wechat bind 获取微信客服绑定链接。");
              } catch (err) {
                console.error(`\nWorkBuddy 登录失败: ${err instanceof Error ? err.message : String(err)}`);
                process.exit(1);
              }
            } else {
              // ── QClaw 流程 ──
              const channelCfg = config?.channels?.["wechat-openclaw-channel"];
              const envName = channelCfg?.environment ? String(channelCfg.environment) : "production";
              const env = getEnvironment(envName);
              const guid = getDeviceGuid();

              try {
                const credentials = await performLogin({ guid, env });

                // 保存到 openclaw.json
                const qclawCreds: QClawCredentials = {
                  jwtToken: credentials.jwtToken,
                  channelToken: credentials.channelToken,
                  apiKey: credentials.apiKey,
                  guid: credentials.guid,
                  userId: String((credentials.userInfo as Record<string, unknown>)?.user_id ?? ""),
                  wsUrl: env.wechatWsUrl,
                  userInfo: credentials.userInfo,
                };
                await writeChannelConfig({ loginMode: "qclaw" as LoginMode, qclaw: qclawCreds });

                // apiKey 写入 models.providers
                if (credentials.apiKey) {
                  try {
                    const wRuntime = getWecomRuntime();
                    const fullCfg = wRuntime.config.loadConfig();
                    const models = { ...(fullCfg.models ?? {}) } as Record<string, any>;
                    const providers = { ...(models.providers ?? {}) } as Record<string, any>;
                    providers.qclaw = { ...(providers.qclaw ?? {}), apiKey: credentials.apiKey };
                    models.providers = providers;
                    await wRuntime.config.writeConfigFile({ ...fullCfg, models });
                  } catch { /* non-fatal */ }
                }

                console.log(`\n登录成功! token: ${credentials.channelToken.substring(0, 6)}...`);
                console.log("请运行 openclaw gateway restart 启动通路。");
                console.log("首次使用请在 gateway 启动后运行 openclaw wechat bind 完成设备绑定。");
              } catch (err) {
                console.error(`\n登录失败: ${err instanceof Error ? err.message : String(err)}`);
                process.exit(1);
              }
            }
          });

        // ── wechat logout ──
        wechat
          .command("logout")
          .description("清除已保存的微信登录态")
          .action(async () => {
            await writeChannelConfig({ loginMode: undefined, qclaw: undefined, workbuddy: undefined });
            console.log("已清除登录态。");
          });

        // ── wechat bind ──
        wechat
          .command("bind")
          .description("获取设备绑定链接（需先登录）")
          .action(async () => {
            const channelCfg = readChannelConfig();

            // ── WorkBuddy 模式 ──
            if (channelCfg.loginMode === "workbuddy") {
              const creds = channelCfg.workbuddy;
              if (!creds?.accessToken) {
                console.error("请先登录: openclaw wechat login（选择 2）");
                process.exit(1);
              }

              const cbApi = new CodeBuddyAPI(creds.baseUrl);
              cbApi.accessToken = creds.accessToken;
              cbApi.refreshToken = creds.refreshToken || "";
              cbApi.userId = creds.userId || "";
              cbApi.hostId = creds.hostId || cbApi.hostId;

              try {
                const refreshed = await cbApi.doRefreshToken();
                await writeChannelConfig({
                  workbuddy: { ...creds, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken },
                });
              } catch {
                console.warn("token 刷新失败，使用旧 token 继续...");
              }

              const sessionId = cbApi.buildSessionId();
              try {
                const linkResult = await cbApi.wechatkfGetLink(sessionId);
                if (linkResult.success && linkResult.url) {
                  console.log("\n" + "=".repeat(64));
                  console.log("请在微信中打开以下链接绑定微信客服号：");
                  console.log("");
                  console.log(linkResult.url);
                  console.log("");
                  console.log("绑定完成后即可通过微信客服号对话。");
                  console.log("=".repeat(64));
                } else {
                  console.error(`获取绑定链接失败: ${linkResult.message ?? "未知错误"}`);
                }
              } catch (err) {
                console.error(`获取绑定链接失败: ${err instanceof Error ? err.message : String(err)}`);
                process.exit(1);
              }
              return;
            }

            // ── QClaw 模式 ──
            if (channelCfg.loginMode === "qclaw") {
              const creds = channelCfg.qclaw;
              if (!creds?.channelToken) {
                console.error("请先登录: openclaw wechat login（选择 1）");
                process.exit(1);
              }

              const envName = channelCfg.environment ? String(channelCfg.environment) : "production";
              const env = getEnvironment(envName);
              const api = new QClawAPI(env, creds.guid, creds.jwtToken);
              api.userId = creds.userId || "";
              const loginKey = (creds.userInfo as Record<string, unknown>)?.loginKey as string | undefined;
              if (loginKey) api.loginKey = loginKey;

              const bindResult = await performDeviceBinding({ api });
              if (!bindResult.success) {
                console.error(bindResult.message);
                process.exit(1);
              }
              return;
            }

            console.error("请先登录: openclaw wechat login");
            process.exit(1);
          });
      },
      { commands: ["wechat"] },
    );

    // 注册 /wechat-login 命令（聊天渠道内触发）
    api.registerCommand?.({
      name: "wechat-login",
      description: "手动执行微信扫码登录，获取 channel token",
      handler: async ({ config }) => {
        const channelCfg = config?.channels?.["wechat-openclaw-channel"];
        const envName = channelCfg?.environment ? String(channelCfg.environment) : "production";
        const env = getEnvironment(envName);
        const guid = getDeviceGuid();

        try {
          const credentials = await performLogin({ guid, env });
          const qclawCreds: QClawCredentials = {
            jwtToken: credentials.jwtToken,
            channelToken: credentials.channelToken,
            apiKey: credentials.apiKey,
            guid: credentials.guid,
            userId: String((credentials.userInfo as Record<string, unknown>)?.user_id ?? ""),
            wsUrl: env.wechatWsUrl,
            userInfo: credentials.userInfo,
          };
          await writeChannelConfig({ loginMode: "qclaw" as LoginMode, qclaw: qclawCreds });
          return { text: `登录成功! token: ${credentials.channelToken.substring(0, 6)}... (已保存，重启 Gateway 生效)` };
        } catch (err) {
          return { text: `登录失败: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    });

    // 注册 /wechat-logout 命令（聊天渠道内触发）
    api.registerCommand?.({
      name: "wechat-logout",
      description: "清除已保存的微信登录态",
      handler: async () => {
        await writeChannelConfig({ loginMode: undefined, qclaw: undefined, workbuddy: undefined });
        return { text: "已清除登录态，下次启动将重新登录。" };
      },
    });

    console.log("[wechat-access] 腾讯通路插件已注册");
  },
};

export default index;