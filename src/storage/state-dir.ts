import os from "node:os";
import path from "node:path";

/** Resolve local state directory for chat-weixin standalone mode. */
export function resolveStateDir(): string {
  return (
    process.env.WEIXIN_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".chat-weixin")
  );
}
