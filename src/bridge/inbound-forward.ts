import fs from "node:fs";
import path from "node:path";

import { MessageItemType } from "../api/types.js";
import type { MessageItem, WeixinMessage } from "../api/types.js";
import { downloadMediaFromItem } from "../media/media-download.js";
import type { WeixinInboundMediaOpts } from "../messaging/inbound.js";
import { getContextTokenFromMsgContext, isMediaItem, setContextToken, weixinMessageToMsgContext } from "../messaging/inbound.js";
import { getExtensionFromMime } from "../media/mime.js";
import { resolveStateDir } from "../storage/state-dir.js";
import { logger } from "../util/logger.js";
import { tempFileName } from "../util/random.js";
import { registerDecryptedMediaFile } from "./bridge-server.js";
import { BRIDGE_PATHS, CHAT_CALLBACK_URL } from "./http-routes.js";

type SaveMediaFn = (
  buffer: Buffer,
  contentType?: string,
  subdir?: string,
  maxBytes?: number,
  originalFilename?: string,
) => Promise<{ path: string }>;

const INBOUND_MEDIA_DIR = path.join(resolveStateDir(), "chat-weixin", "bridge", "inbound-media");
function extractTextBody(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

function selectFirstMediaItem(full: WeixinMessage): MessageItem | undefined {
  const hasDownloadableMedia = (m?: { encrypt_query_param?: string; full_url?: string }) =>
    Boolean(m?.encrypt_query_param || m?.full_url);

  const mainMediaItem =
    full.item_list?.find(
      (i) => i.type === MessageItemType.IMAGE && hasDownloadableMedia(i.image_item?.media),
    ) ??
    full.item_list?.find(
      (i) => i.type === MessageItemType.VIDEO && hasDownloadableMedia(i.video_item?.media),
    ) ??
    full.item_list?.find(
      (i) => i.type === MessageItemType.FILE && hasDownloadableMedia(i.file_item?.media),
    ) ??
    full.item_list?.find(
      (i) =>
        i.type === MessageItemType.VOICE &&
        hasDownloadableMedia(i.voice_item?.media) &&
        !i.voice_item?.text,
    );

  if (mainMediaItem) return mainMediaItem;

  const refItem = full.item_list?.find(
    (i) => i.type === MessageItemType.TEXT && i.ref_msg?.message_item && isMediaItem(i.ref_msg.message_item),
  );
  return refItem?.ref_msg?.message_item;
}

function getMediaTempUrl(item?: MessageItem): string | undefined {
  if (!item) return undefined;
  if (item.type === MessageItemType.IMAGE) return item.image_item?.media?.full_url;
  if (item.type === MessageItemType.VIDEO) return item.video_item?.media?.full_url;
  if (item.type === MessageItemType.FILE) return item.file_item?.media?.full_url;
  if (item.type === MessageItemType.VOICE) return item.voice_item?.media?.full_url;
  return undefined;
}

function extractMediaIdFromLocalUrl(localMediaUrl?: string): string | undefined {
  if (!localMediaUrl) return undefined;
  try {
    const u = new URL(localMediaUrl);
    const prefix = BRIDGE_PATHS.mediaPrefix;
    if (!u.pathname.startsWith(prefix)) return undefined;
    return decodeURIComponent(u.pathname.slice(prefix.length));
  } catch {
    return undefined;
  }
}

function buildLocalSaveMediaFn(): SaveMediaFn {
  return async (buffer, contentType, _subdir, maxBytes, originalFilename) => {
    if (maxBytes != null && maxBytes > 0 && buffer.length > maxBytes) {
      throw new Error(`media too large: ${buffer.length} > ${maxBytes}`);
    }
    fs.mkdirSync(INBOUND_MEDIA_DIR, { recursive: true });
    const extFromName = originalFilename ? path.extname(originalFilename) : "";
    const ext = extFromName || (contentType ? getExtensionFromMime(contentType) : ".bin");
    const filePath = path.join(INBOUND_MEDIA_DIR, tempFileName("wm", ext));
    fs.writeFileSync(filePath, buffer);
    return { path: filePath };
  };
}

async function buildInboundMedia(full: WeixinMessage, cdnBaseUrl: string): Promise<{
  opts: WeixinInboundMediaOpts;
  mediaType?: "image" | "video" | "file" | "voice";
}> {
  const mediaItem = selectFirstMediaItem(full);
  if (!mediaItem) return { opts: {} };

  const opts = await downloadMediaFromItem(mediaItem, {
    cdnBaseUrl,
    saveMedia: buildLocalSaveMediaFn(),
    log: () => {},
    errLog: (msg) => logger.warn(msg),
    label: "bridge-inbound",
  });

  if (opts.decryptedPicPath) return { opts, mediaType: "image" };
  if (opts.decryptedVideoPath) return { opts, mediaType: "video" };
  if (opts.decryptedFilePath) return { opts, mediaType: "file" };
  if (opts.decryptedVoicePath) return { opts, mediaType: "voice" };
  return { opts };
}

export async function forwardInboundMessageToChatService(params: {
  accountId: string;
  cdnBaseUrl: string;
  message: WeixinMessage;
}): Promise<void> {
  const { accountId, cdnBaseUrl, message } = params;
  const selectedMediaItem = selectFirstMediaItem(message);
  const upstreamTempMediaUrl = getMediaTempUrl(selectedMediaItem);
  const media = await buildInboundMedia(message, cdnBaseUrl);
  const ctx = weixinMessageToMsgContext(message, accountId, media.opts);
  const contextToken = getContextTokenFromMsgContext(ctx);
  const fromUserId = message.from_user_id ?? "";

  if (contextToken && fromUserId) {
    setContextToken(accountId, fromUserId, contextToken);
  }

  const mediaPath = ctx.MediaPath;
  const mediaType = ctx.MediaType;
  const localMediaUrl = mediaPath
    ? registerDecryptedMediaFile(mediaPath, mediaType ?? "application/octet-stream")
    : undefined;

  const mediaId = extractMediaIdFromLocalUrl(localMediaUrl);

  const payload = {
    accountId,
    fromUserId,
    toUserId: message.to_user_id ?? "",
    messageId: message.message_id ?? null,
    messageSid: ctx.MessageSid,
    createTimeMs: message.create_time_ms ?? Date.now(),
    contextToken: contextToken ?? null,
    text: ctx.Body || extractTextBody(message.item_list),
    media: mediaPath
      ? {
          type: media.mediaType ?? "file",
          mediaId: mediaId ?? null,
          path: mediaPath,
          url: upstreamTempMediaUrl || localMediaUrl,
          mimeType: mediaType ?? "application/octet-stream",
        }
      : null,
  };

  const res = await fetch(CHAT_CALLBACK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`chat callback failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
}
