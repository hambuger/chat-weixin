import fs from "node:fs";
import path from "node:path";
import http from "node:http";

import { getConfig, sendTyping } from "../api/api.js";
import { TypingStatus } from "../api/types.js";
import { listIndexedWeixinAccountIds, loadWeixinAccount, CDN_BASE_URL, DEFAULT_BASE_URL } from "../auth/accounts.js";
import { downloadRemoteImageToTemp } from "../cdn/upload.js";
import { getContextToken } from "../messaging/inbound.js";
import { sendWeixinMediaFile } from "../messaging/send-media.js";
import { sendMessageWeixin } from "../messaging/send.js";
import { getExtensionFromMime } from "../media/mime.js";
import { resolveStateDir } from "../storage/state-dir.js";
import { logger } from "../util/logger.js";
import { generateId } from "../util/random.js";
import { BRIDGE_PATHS } from "./http-routes.js";

type ActiveAccount = {
  accountId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
};

type MediaRecord = {
  path: string;
  mimeType: string;
  createdAt: number;
};

const BRIDGE_HOST = process.env.WEIXIN_BRIDGE_HOST?.trim() || "127.0.0.1";
const BRIDGE_PORT = Number(process.env.WEIXIN_BRIDGE_PORT || "8082");
const BRIDGE_MEDIA_TTL_MS = 24 * 60 * 60 * 1000;
const BRIDGE_TEMP_DIR = path.join(resolveStateDir(), "chat-weixin", "bridge", "outbound-temp");

const activeAccounts = new Map<string, ActiveAccount>();
const mediaStore = new Map<string, MediaRecord>();
let serverStarted = false;
let server: http.Server | null = null;

function resolvePublicBaseUrl(): string {
  return `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;
}

function cleanupExpiredMedia(now = Date.now()): void {
  for (const [id, rec] of mediaStore.entries()) {
    if (now - rec.createdAt > BRIDGE_MEDIA_TTL_MS) {
      mediaStore.delete(id);
    }
  }
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(text);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const size = chunks.reduce((n, b) => n + b.length, 0);
    if (size > 5 * 1024 * 1024) {
      throw new Error("request body too large");
    }
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("invalid json body");
  return parsed as Record<string, unknown>;
}

function getString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function resolveRuntimeAccount(accountId?: string): ActiveAccount {
  const specified = accountId?.trim() || "";

  if (specified) {
    const rt = activeAccounts.get(specified);
    if (rt) return rt;

    const stored = loadWeixinAccount(specified);
    if (!stored?.token?.trim()) throw new Error(`account not configured: ${specified}`);
    return {
      accountId: specified,
      baseUrl: stored.baseUrl?.trim() || DEFAULT_BASE_URL,
      cdnBaseUrl: CDN_BASE_URL,
      token: stored.token.trim(),
    };
  }

  if (activeAccounts.size === 1) {
    return [...activeAccounts.values()][0];
  }

  const ids = listIndexedWeixinAccountIds();
  if (ids.length === 1) {
    const onlyId = ids[0];
    const stored = loadWeixinAccount(onlyId);
    if (!stored?.token?.trim()) throw new Error(`account not configured: ${onlyId}`);
    return {
      accountId: onlyId,
      baseUrl: stored.baseUrl?.trim() || DEFAULT_BASE_URL,
      cdnBaseUrl: CDN_BASE_URL,
      token: stored.token.trim(),
    };
  }

  throw new Error("accountId is required when multiple accounts exist");
}

async function handleSendMessage(body: Record<string, unknown>): Promise<{ messageId: string }> {
  const account = resolveRuntimeAccount(getString(body.accountId));
  const to = getString(body.to);
  const text = getString(body.text);
  const mediaPath = getString(body.mediaPath);
  const mediaUrl = getString(body.mediaUrl);
  const encryptedQuery = getString(body.encrypt_query_param);
  const encryptedAesKey = getString(body.aes_key);

  if (!to) throw new Error("`to` is required");
  if (!text && !mediaPath && !mediaUrl) {
    throw new Error("`text` or (`mediaPath`/`mediaUrl`) is required");
  }
  if (encryptedQuery || encryptedAesKey) {
    throw new Error("encrypted media payload is not accepted; provide plaintext mediaPath/mediaUrl only");
  }

  const contextToken = getContextToken(account.accountId, to);
  if (mediaPath || mediaUrl) {
    const filePath = mediaPath || (await downloadRemoteImageToTemp(mediaUrl, BRIDGE_TEMP_DIR));
    return sendWeixinMediaFile({
      filePath,
      to,
      text,
      opts: { baseUrl: account.baseUrl, token: account.token, contextToken },
      cdnBaseUrl: account.cdnBaseUrl,
    });
  }

  return sendMessageWeixin({
    to,
    text,
    opts: { baseUrl: account.baseUrl, token: account.token, contextToken },
  });
}

async function handleSendTyping(body: Record<string, unknown>): Promise<void> {
  const account = resolveRuntimeAccount(getString(body.accountId));
  const to = getString(body.to);
  const statusRaw = body.status;
  if (!to) throw new Error("`to` is required");

  const status = (() => {
    if (statusRaw === TypingStatus.CANCEL || statusRaw === "cancel") return TypingStatus.CANCEL;
    return TypingStatus.TYPING;
  })();

  const contextToken = getContextToken(account.accountId, to);
  const cfg = await getConfig({
    baseUrl: account.baseUrl,
    token: account.token,
    ilinkUserId: to,
    contextToken,
  });
  const typingTicket = cfg.typing_ticket?.trim() || "";
  if (!typingTicket) throw new Error("typing_ticket is empty");

  await sendTyping({
    baseUrl: account.baseUrl,
    token: account.token,
    body: {
      ilink_user_id: to,
      typing_ticket: typingTicket,
      status,
    },
  });
}

function handleServeMedia(req: http.IncomingMessage, res: http.ServerResponse): void {
  cleanupExpiredMedia();
  const requestUrl = new URL(req.url || "/", resolvePublicBaseUrl());
  const mediaIdRaw = requestUrl.pathname.slice(BRIDGE_PATHS.mediaPrefix.length);
  let mediaIdDecoded = mediaIdRaw;
  try {
    mediaIdDecoded = decodeURIComponent(mediaIdRaw);
  } catch {
    res.statusCode = 400;
    res.end("invalid media id");
    return;
  }
  let rec = mediaStore.get(mediaIdDecoded);
  let mediaId = mediaIdDecoded;
  if (!rec) {
    const dot = mediaIdDecoded.lastIndexOf(".");
    if (dot > 0) {
      const baseId = mediaIdDecoded.slice(0, dot);
      rec = mediaStore.get(baseId);
      if (rec) mediaId = baseId;
    }
  }
  if (!rec) {
    res.statusCode = 404;
    res.end("media not found");
    return;
  }
  if (!fs.existsSync(rec.path)) {
    mediaStore.delete(mediaId);
    res.statusCode = 404;
    res.end("media file missing");
    return;
  }
  res.statusCode = 200;
  res.setHeader("content-type", rec.mimeType || "application/octet-stream");
  const name = path.basename(rec.path || `${mediaId}${getExtensionFromMime(rec.mimeType || "application/octet-stream")}`);
  res.setHeader("content-disposition", `inline; filename="${name.replace(/"/g, "")}"`);
  fs.createReadStream(rec.path).pipe(res);
}

async function routeRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const method = (req.method || "GET").toUpperCase();
  const requestUrl = new URL(req.url || "/", resolvePublicBaseUrl());

  if (method === "GET" && requestUrl.pathname.startsWith(BRIDGE_PATHS.mediaPrefix)) {
    handleServeMedia(req, res);
    return;
  }

  if (method === "POST" && requestUrl.pathname === BRIDGE_PATHS.sendMessage) {
    const body = await readJsonBody(req);
    const result = await handleSendMessage(body);
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  if (method === "POST" && requestUrl.pathname === BRIDGE_PATHS.sendTyping) {
    const body = await readJsonBody(req);
    await handleSendTyping(body);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
}

export function registerActiveAccount(account: ActiveAccount): void {
  activeAccounts.set(account.accountId, account);
}

export function unregisterActiveAccount(accountId: string): void {
  activeAccounts.delete(accountId);
}

export function registerDecryptedMediaFile(filePath: string, mimeType: string): string {
  const mediaId = generateId("wxm");
  mediaStore.set(mediaId, { path: filePath, mimeType, createdAt: Date.now() });
  const extFromPath = path.extname(filePath || "");
  const ext =
    extFromPath && extFromPath !== ".bin"
      ? extFromPath
      : getExtensionFromMime(mimeType || "application/octet-stream");
  return `${resolvePublicBaseUrl()}${BRIDGE_PATHS.mediaPrefix}${encodeURIComponent(mediaId)}${ext}`;
}

export function startBridgeHttpServer(): void {
  if (serverStarted) return;
  serverStarted = true;

  server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    void routeRequest(req, res).catch((err) => {
      logger.error(`bridge http error: ${String(err)}`);
      sendJson(res, 500, { ok: false, error: String(err) });
    });
  });

  server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
    logger.info(`bridge http server listening at ${resolvePublicBaseUrl()}`);
  });
}
