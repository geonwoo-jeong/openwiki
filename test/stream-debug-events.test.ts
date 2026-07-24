import { afterEach, describe, expect, test, vi } from "vitest";
import { emitModelStreamDiagnostic } from "../src/agent/index.ts";
import type { OpenWikiRunEvent } from "../src/agent/types.ts";

function messageEvent(data: Record<string, unknown>): unknown {
  return {
    method: "messages",
    params: {
      data,
      namespace: [],
      timestamp: Date.now(),
    },
    seq: 1,
    type: "event",
  };
}

describe("emitModelStreamDiagnostic", () => {
  test("reports invalid tool-call metadata without exposing its arguments", () => {
    const args = '{"file_path":"/openwiki/secret.md","content":"sensitive"}';
    const onEvent = vi.fn<(event: OpenWikiRunEvent) => void>();

    emitModelStreamDiagnostic(
      { debug: true, onEvent },
      messageEvent({
        content: {
          args,
          error: "Failed to parse tool call arguments as JSON",
          id: "tooluse_1",
          name: "write_file",
          type: "invalid_tool_call",
        },
        event: "content-block-finish",
        index: 1,
        run_id: "run-1",
      }),
    );

    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith({
      message: `model.invalidToolCall=true runId="run-1" name="write_file" argsChars=${args.length}`,
      type: "debug",
    });
    expect(onEvent.mock.calls[0]?.[0]?.message).not.toContain(args);
    expect(onEvent.mock.calls[0]?.[0]?.message).not.toContain(
      "Failed to parse",
    );
    expect(onEvent.mock.calls[0]?.[0]?.message).not.toContain("tooluse_1");
  });

  test("reports the normalized finish reason from the matching stream event", () => {
    const onEvent = vi.fn<(event: OpenWikiRunEvent) => void>();

    emitModelStreamDiagnostic(
      { debug: true, onEvent },
      messageEvent({
        event: "message-finish",
        reason: "length",
        run_id: "run-1",
      }),
    );

    expect(onEvent).toHaveBeenCalledWith({
      message: 'model.messageFinish=true runId="run-1" finishReason="length"',
      type: "debug",
    });
  });

  test("stays silent when debug mode is disabled or the event is unrelated", () => {
    const onEvent = vi.fn<(event: OpenWikiRunEvent) => void>();
    const invalidToolCall = messageEvent({
      content: {
        args: '{"a":',
        name: "write_file",
        type: "invalid_tool_call",
      },
      event: "content-block-finish",
      run_id: "run-1",
    });

    emitModelStreamDiagnostic({ debug: false, onEvent }, invalidToolCall);
    emitModelStreamDiagnostic(
      { debug: true, onEvent },
      messageEvent({
        delta: { text: "hello", type: "text-delta" },
        event: "content-block-delta",
        run_id: "run-1",
      }),
    );
    emitModelStreamDiagnostic(
      { debug: true, onEvent },
      messageEvent({
        event: "message-finish",
        run_id: "run-1",
        usage: { output_tokens: 10 },
      }),
    );

    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe("--print debug output", () => {
  const originalArgv = process.argv;
  const originalDebug = process.env.OPENWIKI_DEBUG;
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;

    if (originalDebug === undefined) {
      delete process.env.OPENWIKI_DEBUG;
    } else {
      process.env.OPENWIKI_DEBUG = originalDebug;
    }

    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("../src/agent/index.ts");
    vi.doUnmock("../src/code-mode.ts");
    vi.doUnmock("../src/env.ts");
    vi.doUnmock("../src/startup.ts");
    vi.doUnmock("../src/telemetry/index.ts");
  });

  test("writes debug events to stderr without polluting stdout", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    vi.doMock("../src/agent/index.ts", () => ({
      createOpenWikiThreadId: () => "thread-1",
      runOpenWikiAgent: vi.fn(
        (
          _command: unknown,
          _cwd: unknown,
          options: {
            onEvent?: (event: unknown) => void;
          },
        ) => {
          options.onEvent?.({
            message: "model.invalidToolCall=true argsChars=12",
            type: "debug",
          });
          options.onEvent?.({
            source: "main",
            text: "done",
            type: "text",
          });

          return Promise.resolve({ command: "chat", model: "test-model" });
        },
      ),
    }));
    vi.doMock("../src/code-mode.ts", () => ({
      ensureCodeModeRepoSetup: vi.fn(),
      runCodeModeConnectors: vi.fn(),
    }));
    vi.doMock("../src/env.ts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/env.ts")>()),
      loadOpenWikiEnv: vi.fn(),
    }));
    vi.doMock("../src/startup.ts", () => ({
      resolveStartupCommand: vi.fn((command: unknown) =>
        Promise.resolve(command),
      ),
    }));
    vi.doMock("../src/telemetry/index.ts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/telemetry/index.ts")>()),
      firstRunNoticePending: vi.fn(() => Promise.resolve(false)),
    }));

    process.argv = ["node", "openwiki", "code", "--print", "--debug", "hello"];

    await import("../src/cli.tsx");

    expect(stderr).toHaveBeenCalledWith(
      "[debug] model.invalidToolCall=true argsChars=12\n",
    );
    const stdoutText = stdout.mock.calls
      .map(([value]) => String(value))
      .join("");

    expect(stdoutText).toBe("done\n");
  });
});
