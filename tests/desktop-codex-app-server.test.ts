import { describe, expect, it } from "vitest";
import { codexAppServerInvocation, codexCliInvocation } from "../desktop/src/codex-app-server";

describe("Codex app-server invocation", () => {
  it("prefers the native Windows binary so the read-only child can be terminated cleanly", () => {
    const native = "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
    const invocation = codexAppServerInvocation(
      "win32",
      {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        APPDATA: "C:\\Users\\test\\AppData\\Roaming",
      },
      (path) => path === native || path === "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd",
    );

    expect(invocation.command).toBe(native);
    expect(invocation.args).toEqual(["app-server", "--listen", "stdio://"]);
  });

  it("uses the same packaged-safe resolver for isolated login", () => {
    const invocation = codexCliInvocation(
      ["login"],
      "win32",
      { APPDATA: "C:\\Users\\test\\AppData\\Roaming" },
      (path) => path.endsWith("codex.exe"),
    );

    expect(invocation.command).toMatch(/codex\.exe$/i);
    expect(invocation.args).toEqual(["login"]);
  });
});
