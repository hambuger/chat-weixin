import { normalizeAccountId } from "./util/account-id.js";
import { logger } from "./util/logger.js";
import {
  DEFAULT_BASE_URL,
  clearStaleAccountsForUserId,
  listIndexedWeixinAccountIds,
  loadWeixinAccount,
  registerWeixinAccountId,
  saveWeixinAccount,
} from "./auth/accounts.js";
import { clearContextTokensForAccount, restoreContextTokens } from "./messaging/inbound.js";
import { DEFAULT_ILINK_BOT_TYPE, startWeixinLoginWithQr, waitForWeixinLogin } from "./auth/login-qr.js";
import { monitorWeixinProvider } from "./monitor/monitor.js";
import { registerActiveAccount, startBridgeHttpServer } from "./bridge/bridge-server.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    out[k] = v;
  }
  return out;
}

async function doLogin(args: Record<string, string>): Promise<void> {
  const accountIdInput = args.accountId?.trim();
  const savedBaseUrl = accountIdInput ? loadWeixinAccount(normalizeAccountId(accountIdInput))?.baseUrl?.trim() : "";
  const start = await startWeixinLoginWithQr({
    accountId: accountIdInput || undefined,
    apiBaseUrl: savedBaseUrl || DEFAULT_BASE_URL,
    botType: DEFAULT_ILINK_BOT_TYPE,
    force: args.force === "true",
    timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined,
    verbose: args.verbose === "true",
  });
  if (!start.qrcodeUrl) throw new Error(start.message);

  try {
    const qrcodeterminal = await import("qrcode-terminal");
    await new Promise<void>((resolve) => {
      qrcodeterminal.default.generate(start.qrcodeUrl!, { small: true }, (qr: string) => {
        console.log(qr);
        resolve();
      });
    });
  } catch {
    console.log(`请扫码: ${start.qrcodeUrl}`);
  }

  const wait = await waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: savedBaseUrl || DEFAULT_BASE_URL,
    timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : 480_000,
    botType: DEFAULT_ILINK_BOT_TYPE,
    verbose: args.verbose === "true",
  });
  if (!wait.connected || !wait.botToken || !wait.accountId) {
    throw new Error(wait.message || "login failed");
  }

  const normalizedId = normalizeAccountId(wait.accountId);
  saveWeixinAccount(normalizedId, {
    token: wait.botToken,
    baseUrl: wait.baseUrl,
    userId: wait.userId,
  });
  registerWeixinAccountId(normalizedId);
  if (wait.userId) {
    clearStaleAccountsForUserId(normalizedId, wait.userId, clearContextTokensForAccount);
  }
  console.log(`登录成功 accountId=${normalizedId}`);
}

function resolveStartAccountId(args: Record<string, string>): string {
  const fromArg = args.accountId?.trim();
  if (fromArg) return normalizeAccountId(fromArg);
  const ids = listIndexedWeixinAccountIds();
  if (ids.length === 1) return ids[0];
  if (ids.length === 0) throw new Error("未找到已登录账号，请先运行 login");
  throw new Error("存在多个账号，请使用 --accountId 指定");
}

async function doStart(args: Record<string, string>): Promise<void> {
  const accountId = resolveStartAccountId(args);
  const account = loadWeixinAccount(accountId);
  if (!account?.token?.trim()) throw new Error(`账号未配置 token: ${accountId}`);

  startBridgeHttpServer();
  registerActiveAccount({
    accountId,
    baseUrl: account.baseUrl?.trim() || DEFAULT_BASE_URL,
    cdnBaseUrl: args.cdnBaseUrl?.trim() || "https://novac2c.cdn.weixin.qq.com/c2c",
    token: account.token.trim(),
  });
  restoreContextTokens(accountId);

  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());
  process.on("SIGTERM", () => ac.abort());

  logger.info(`standalone start accountId=${accountId}`);
  await monitorWeixinProvider({
    baseUrl: account.baseUrl?.trim() || DEFAULT_BASE_URL,
    cdnBaseUrl: args.cdnBaseUrl?.trim() || "https://novac2c.cdn.weixin.qq.com/c2c",
    token: account.token.trim(),
    accountId,
    abortSignal: ac.signal,
    runtime: {
      log: (m) => logger.info(m),
      error: (m) => logger.error(m),
    },
  });
}

async function main(): Promise<void> {
  const [cmd = "start", ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (cmd === "login") return doLogin(args);
  if (cmd === "start") return doStart(args);
  if (cmd === "help") {
    console.log("Usage:");
    console.log("  node dist/standalone.js login [--accountId xxx] [--force true]");
    console.log("  node dist/standalone.js start [--accountId xxx]");
    return;
  }
  throw new Error(`unknown command: ${cmd}`);
}

void main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
