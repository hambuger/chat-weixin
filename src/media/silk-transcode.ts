import { logger } from "../util/logger.js";

/** Default sample rate for Weixin voice messages. */
const SILK_SAMPLE_RATE = 24_000;

/**
 * Wrap raw pcm_s16le bytes in a WAV container.
 * Mono channel, 16-bit signed little-endian.
 */
function pcmBytesToWav(pcm: Uint8Array, sampleRate: number): Buffer {
  const pcmBytes = pcm.byteLength;
  const totalSize = 44 + pcmBytes;
  const buf = Buffer.allocUnsafe(totalSize);
  let offset = 0;

  buf.write("RIFF", offset);
  offset += 4;
  buf.writeUInt32LE(totalSize - 8, offset);
  offset += 4;
  buf.write("WAVE", offset);
  offset += 4;

  buf.write("fmt ", offset);
  offset += 4;
  buf.writeUInt32LE(16, offset);
  offset += 4; // fmt chunk size
  buf.writeUInt16LE(1, offset);
  offset += 2; // PCM format
  buf.writeUInt16LE(1, offset);
  offset += 2; // mono
  buf.writeUInt32LE(sampleRate, offset);
  offset += 4;
  buf.writeUInt32LE(sampleRate * 2, offset);
  offset += 4; // byte rate (mono 16-bit)
  buf.writeUInt16LE(2, offset);
  offset += 2; // block align
  buf.writeUInt16LE(16, offset);
  offset += 2; // bits per sample

  buf.write("data", offset);
  offset += 4;
  buf.writeUInt32LE(pcmBytes, offset);
  offset += 4;

  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, offset);

  return buf;
}

/**
 * Try to transcode a SILK audio buffer to WAV using silk-wasm.
 * silk-wasm's decode() returns { data: Uint8Array (pcm_s16le), duration: number }.
 *
 * Returns a WAV Buffer on success, or null if silk-wasm is unavailable or decoding fails.
 * Callers should fall back to passing the raw SILK file when null is returned.
 */
export async function silkToWav(silkBuf: Buffer): Promise<Buffer | null> {
  try {
    const { decode } = await import("silk-wasm");

    logger.debug(`silkToWav: decoding ${silkBuf.length} bytes of SILK`);
    const result = await decode(silkBuf, SILK_SAMPLE_RATE);
    logger.debug(
      `silkToWav: decoded duration=${result.duration}ms pcmBytes=${result.data.byteLength}`,
    );

    const wav = pcmBytesToWav(result.data, SILK_SAMPLE_RATE);
    logger.debug(`silkToWav: WAV size=${wav.length}`);
    return wav;
  } catch (err) {
    logger.warn(`silkToWav: transcode failed, will use raw silk err=${String(err)}`);
    return null;
  }
}

export type SilkEncodeResult = {
  silk: Buffer;
  durationMs?: number;
};

function isLikelySilk(buf: Buffer): boolean {
  if (buf.length < 7) return false;
  return buf.subarray(0, 7).toString("utf-8").includes("#!SILK");
}

/**
 * Encode audio bytes to SILK using silk-wasm.
 * - If input is already SILK, returns it directly.
 * - For WAV, silk-wasm will parse WAV and extract PCM automatically.
 * - For other audio formats, silk-wasm may fail; caller should decide fallback behavior.
 */
export async function audioToSilk(input: Buffer): Promise<SilkEncodeResult | null> {
  try {
    if (!input.length) {
      logger.warn("audioToSilk: empty input buffer");
      return null;
    }
    if (isLikelySilk(input)) {
      logger.debug(`audioToSilk: input already silk, bytes=${input.length}`);
      return { silk: input };
    }

    const { encode, getDuration } = await import("silk-wasm");
    const encoded = await encode(input, SILK_SAMPLE_RATE);
    const silk = Buffer.from(encoded.data);
    if (!silk.length) {
      logger.warn("audioToSilk: silk-wasm returned empty output");
      return null;
    }

    let durationMs: number | undefined = encoded.duration;
    if (!durationMs || durationMs <= 0) {
      try {
        durationMs = getDuration(silk);
      } catch {
        // best-effort only
      }
    }
    logger.debug(`audioToSilk: encoded silk bytes=${silk.length} durationMs=${durationMs ?? -1}`);
    return { silk, durationMs };
  } catch (err) {
    logger.warn(`audioToSilk: encode failed err=${String(err)}`);
    return null;
  }
}
