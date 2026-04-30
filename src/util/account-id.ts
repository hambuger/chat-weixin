/**
 * Normalize account id into a filesystem-safe key.
 * Example: "abc@im.bot" -> "abc-im-bot"
 */
export function normalizeAccountId(raw: string): string {
  const trimmed = String(raw ?? "").trim().toLowerCase();
  if (!trimmed) throw new Error("accountId is required");
  return trimmed
    .replace(/@/g, "-")
    .replace(/[^\w.-]+/g, "-")
    .replace(/\.+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

