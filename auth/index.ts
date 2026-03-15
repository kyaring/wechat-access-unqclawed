/**
 * @file auth/index.ts
 * @description 认证模块导出
 */

export type {
  QClawEnvironment,
  LoginCredentials,
  QClawApiResponse,
  LoginMode,
  QClawCredentials,
  WorkBuddyCredentials,
} from "./types.js";
export { TokenExpiredError } from "./types.js";

export { getEnvironment } from "./environments.js";
export { getDeviceGuid } from "./device-guid.js";
export { QClawAPI } from "./qclaw-api.js";
export { CodeBuddyAPI } from "./codebuddy-api.js";
export { performLogin } from "./wechat-login.js";
export type { PerformLoginOptions } from "./wechat-login.js";
export { performDeviceBinding } from "./device-bind.js";
export type { DeviceBindOptions, DeviceBindResult } from "./device-bind.js";
export { buildAuthUrl, fetchQrUuid, fetchQrImageDataUrl, pollQrStatus } from "./wechat-qr-poll.js";
export type { QrPollResult } from "./wechat-qr-poll.js";
