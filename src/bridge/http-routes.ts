function trimSlash(input: string): string {
  return input.replace(/\/+$/, "");
}

function ensureLeadingSlash(input: string): string {
  return input.startsWith("/") ? input : `/${input}`;
}

function normalizePath(input: string): string {
  return ensureLeadingSlash(input).replace(/\/{2,}/g, "/");
}

const BRIDGE_API_PREFIX = normalizePath(
  process.env.WEIXIN_BRIDGE_API_PREFIX?.trim() || "/api/weixin",
);

const CHAT_CALLBACK_BASE_URL = trimSlash(
  process.env.WEIXIN_CHAT_CALLBACK_BASE_URL?.trim() || "http://127.0.0.1:8081",
);
const CHAT_CALLBACK_PATH = normalizePath(
  process.env.WEIXIN_CHAT_CALLBACK_PATH?.trim() || "/service/chat",
);

export const BRIDGE_PATHS = {
  apiPrefix: BRIDGE_API_PREFIX,
  mediaPrefix: `${BRIDGE_API_PREFIX}/media/`,
  sendMessage: `${BRIDGE_API_PREFIX}/send-message`,
  sendTyping: `${BRIDGE_API_PREFIX}/send-typing`,
} as const;

export const CHAT_CALLBACK_URL = `${CHAT_CALLBACK_BASE_URL}${CHAT_CALLBACK_PATH}`;

