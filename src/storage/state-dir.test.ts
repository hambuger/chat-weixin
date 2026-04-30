import { describe, it, expect, vi, afterEach } from "vitest";
import os from "node:os";
import { resolveStateDir } from "./state-dir.js";

describe("resolveStateDir", () => {
  afterEach(() => {
    delete process.env.WEIXIN_STATE_DIR;
  });

  it("returns WEIXIN_STATE_DIR when set", () => {
    process.env.WEIXIN_STATE_DIR = "/weixin/state";
    expect(resolveStateDir()).toBe("/weixin/state");
  });

  it("falls back to ~/.chat-weixin when no env var is set", () => {
    delete process.env.WEIXIN_STATE_DIR;
    const expected = `${os.homedir()}/.chat-weixin`;
    expect(resolveStateDir()).toBe(expected);
  });

  it("trims whitespace from env vars", () => {
    process.env.WEIXIN_STATE_DIR = " /trimmed ";
    expect(resolveStateDir()).toBe("/trimmed");
  });
});
