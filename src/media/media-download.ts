import type { WeixinInboundMediaOpts } from "../messaging/inbound.js";
import { logger } from "../util/logger.js";
import { getMimeFromFilename } from "./mime.js";
import {
  downloadAndDecryptBuffer,
  downloadPlainCdnBuffer,
} from "../cdn/pic-decrypt.js";
import { silkToWav } from "./silk-transcode.js";
import type { WeixinMessage } from "../api/types.js";
import { MessageItemType } from "../api/types.js";

const WEIXIN_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

function isLikelyImageBuffer(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  // PNG
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return true;
  }
  // GIF
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return true;
  }
  // WEBP (RIFF....WEBP)
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return true;
  }
  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true;
  return false;
}

/** Persist a buffer via the framework's unified media store. */
type SaveMediaFn = (
  buffer: Buffer,
  contentType?: string,
  subdir?: string,
  maxBytes?: number,
  originalFilename?: string,
) => Promise<{ path: string }>;

/**
 * Download and decrypt media from a single MessageItem.
 * Returns the populated WeixinInboundMediaOpts fields; empty object on unsupported type or failure.
 */
export async function downloadMediaFromItem(
  item: WeixinMessage["item_list"] extends (infer T)[] | undefined ? T : never,
  deps: {
    cdnBaseUrl: string;
    saveMedia: SaveMediaFn;
    log: (msg: string) => void;
    errLog: (msg: string) => void;
    label: string;
  },
): Promise<WeixinInboundMediaOpts> {
  const { cdnBaseUrl, saveMedia, log, errLog, label } = deps;
  const result: WeixinInboundMediaOpts = {};
  const ensureNonEmpty = (buf: Buffer, mediaLabel: string): Buffer => {
    if (buf.length === 0) {
      throw new Error(`${label} ${mediaLabel}: downloaded empty buffer`);
    }
    return buf;
  };

  if (item.type === MessageItemType.IMAGE) {
    const img = item.image_item;
    if (!img) return result;
    const fullUrl = img.media?.full_url ?? img.url;
    if (!img.media?.encrypt_query_param && !fullUrl) return result;
    const aesKeyBase64 = img.aeskey
      ? Buffer.from(img.aeskey, "hex").toString("base64")
      : img.media?.aes_key;

    logger.debug(
      `${label} image: encrypt_query_param=${(img.media?.encrypt_query_param ?? "").slice(0, 40)}... hasAesKey=${Boolean(aesKeyBase64)} aeskeySource=${img.aeskey ? "image_item.aeskey" : "media.aes_key"} full_url=${Boolean(fullUrl)}`,
    );
    try {
      let buf: Buffer;
      if (aesKeyBase64) {
        try {
          buf = ensureNonEmpty(
            await downloadAndDecryptBuffer(
              img.media?.encrypt_query_param ?? "",
              aesKeyBase64,
              cdnBaseUrl,
              `${label} image`,
              fullUrl,
            ),
            "image decrypt",
          );
          if (!isLikelyImageBuffer(buf)) {
            throw new Error(`${label} image decrypt: payload is not a recognized image`);
          }
        } catch (decryptErr) {
          logger.warn(`${label} image decrypt failed, fallback to plain download: ${String(decryptErr)}`);
          buf = ensureNonEmpty(
            await downloadPlainCdnBuffer(
              img.media?.encrypt_query_param ?? "",
              cdnBaseUrl,
              `${label} image-plain-fallback`,
              fullUrl,
            ),
            "image plain fallback",
          );
          if (!isLikelyImageBuffer(buf)) {
            throw new Error(`${label} image plain fallback: payload is not a recognized image`);
          }
        }
      } else {
        buf = ensureNonEmpty(
          await downloadPlainCdnBuffer(
            img.media?.encrypt_query_param ?? "",
            cdnBaseUrl,
            `${label} image-plain`,
            fullUrl,
          ),
          "image plain",
        );
        if (!isLikelyImageBuffer(buf)) {
          throw new Error(`${label} image plain: payload is not a recognized image`);
        }
      }
      // Preserve image semantics for downstream routing by saving with image MIME.
      const saved = await saveMedia(buf, "image/*", "inbound", WEIXIN_MEDIA_MAX_BYTES);
      result.decryptedPicPath = saved.path;
      logger.debug(`${label} image saved: ${saved.path}`);
    } catch (err) {
      logger.error(`${label} image download/decrypt failed: ${String(err)}`);
      errLog(`weixin ${label} image download/decrypt failed: ${String(err)}`);
    }
  } else if (item.type === MessageItemType.VOICE) {
    const voice = item.voice_item;
    if ((!voice?.media?.encrypt_query_param && !voice?.media?.full_url) || !voice?.media?.aes_key)
      return result;
    try {
      const silkBuf = ensureNonEmpty(
        await downloadAndDecryptBuffer(
          voice.media.encrypt_query_param ?? "",
          voice.media.aes_key,
          cdnBaseUrl,
          `${label} voice`,
          voice.media.full_url,
        ),
        "voice decrypt",
      );
      logger.debug(`${label} voice: decrypted ${silkBuf.length} bytes, attempting silk transcode`);
      const wavBuf = await silkToWav(silkBuf);
      if (wavBuf) {
        const saved = await saveMedia(wavBuf, "audio/wav", "inbound", WEIXIN_MEDIA_MAX_BYTES);
        result.decryptedVoicePath = saved.path;
        result.voiceMediaType = "audio/wav";
        logger.debug(`${label} voice: saved WAV to ${saved.path}`);
      } else {
        const saved = await saveMedia(silkBuf, "audio/silk", "inbound", WEIXIN_MEDIA_MAX_BYTES);
        result.decryptedVoicePath = saved.path;
        result.voiceMediaType = "audio/silk";
        logger.debug(`${label} voice: silk transcode unavailable, saved raw SILK to ${saved.path}`);
      }
    } catch (err) {
      logger.error(`${label} voice download/transcode failed: ${String(err)}`);
      errLog(`weixin ${label} voice download/transcode failed: ${String(err)}`);
    }
  } else if (item.type === MessageItemType.FILE) {
    const fileItem = item.file_item;
    if ((!fileItem?.media?.encrypt_query_param && !fileItem?.media?.full_url) || !fileItem?.media?.aes_key)
      return result;
    try {
      const buf = ensureNonEmpty(
        await downloadAndDecryptBuffer(
          fileItem.media.encrypt_query_param ?? "",
          fileItem.media.aes_key,
          cdnBaseUrl,
          `${label} file`,
          fileItem.media.full_url,
        ),
        "file decrypt",
      );
      const mime = getMimeFromFilename(fileItem.file_name ?? "file.bin");
      const saved = await saveMedia(
        buf,
        mime,
        "inbound",
        WEIXIN_MEDIA_MAX_BYTES,
        fileItem.file_name ?? undefined,
      );
      result.decryptedFilePath = saved.path;
      result.fileMediaType = mime;
      logger.debug(`${label} file: saved to ${saved.path} mime=${mime}`);
    } catch (err) {
      logger.error(`${label} file download failed: ${String(err)}`);
      errLog(`weixin ${label} file download failed: ${String(err)}`);
    }
  } else if (item.type === MessageItemType.VIDEO) {
    const videoItem = item.video_item;
    if ((!videoItem?.media?.encrypt_query_param && !videoItem?.media?.full_url) || !videoItem?.media?.aes_key)
      return result;
    try {
      const buf = ensureNonEmpty(
        await downloadAndDecryptBuffer(
          videoItem.media.encrypt_query_param ?? "",
          videoItem.media.aes_key,
          cdnBaseUrl,
          `${label} video`,
          videoItem.media.full_url,
        ),
        "video decrypt",
      );
      const saved = await saveMedia(buf, "video/mp4", "inbound", WEIXIN_MEDIA_MAX_BYTES);
      result.decryptedVideoPath = saved.path;
      logger.debug(`${label} video: saved to ${saved.path}`);
    } catch (err) {
      logger.error(`${label} video download failed: ${String(err)}`);
      errLog(`weixin ${label} video download failed: ${String(err)}`);
    }
  }

  return result;
}
