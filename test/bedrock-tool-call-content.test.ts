import type {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { ChatBedrockConverse } from "@langchain/aws";
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, test, vi } from "vitest";

const BEDROCK_RESPONSE = {
  $metadata: {},
  metrics: {
    latencyMs: 1,
  },
  output: {
    message: {
      content: [{ text: "ok" }],
      role: "assistant",
    },
  },
  stopReason: "end_turn",
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
  },
} satisfies ConverseCommandOutput;

async function convertAssistantMessage(message: AIMessage): Promise<unknown> {
  let capturedCommand: ConverseCommand | undefined;
  const send = vi.fn((command: ConverseCommand) => {
    capturedCommand = command;
    return Promise.resolve(BEDROCK_RESPONSE);
  });
  const model = new ChatBedrockConverse({
    client: { send } as unknown as BedrockRuntimeClient,
    model: "global.anthropic.claude-sonnet-5",
    region: "us-east-1",
  });

  await model.invoke([message]);

  expect(send).toHaveBeenCalledOnce();
  if (capturedCommand === undefined) {
    throw new Error("Expected ChatBedrockConverse to send a command.");
  }

  return capturedCommand.input.messages;
}

describe("ChatBedrockConverse unstamped v1 tool-call content", () => {
  test("converts a tool_call content block without an output-version stamp", async () => {
    const message = new AIMessage({
      content: [
        {
          args: { a: 1 },
          id: "t1",
          name: "write_file",
          type: "tool_call",
        },
      ],
    });

    expect(message.response_metadata.output_version).toBeUndefined();
    await expect(convertAssistantMessage(message)).resolves.toEqual([
      {
        content: [
          {
            toolUse: {
              input: { a: 1 },
              name: "write_file",
              toolUseId: "t1",
            },
          },
        ],
        role: "assistant",
      },
    ]);
  });

  test("does not duplicate a tool call present in both content and tool_calls", async () => {
    const message = new AIMessage({
      content: [
        {
          args: { a: 1 },
          id: "t1",
          name: "write_file",
          type: "tool_call",
        },
      ],
      tool_calls: [
        {
          args: { a: 1 },
          id: "t1",
          name: "write_file",
          type: "tool_call",
        },
      ],
    });

    expect(message.response_metadata.output_version).toBeUndefined();
    await expect(convertAssistantMessage(message)).resolves.toEqual([
      {
        content: [
          {
            toolUse: {
              input: { a: 1 },
              name: "write_file",
              toolUseId: "t1",
            },
          },
        ],
        role: "assistant",
      },
    ]);
  });

  test("keeps text-only assistant messages unchanged", async () => {
    const message = new AIMessage({
      content: [{ text: "Finished.", type: "text" }],
    });

    await expect(convertAssistantMessage(message)).resolves.toEqual([
      {
        content: [{ text: "Finished." }],
        role: "assistant",
      },
    ]);
  });

  test("skips an invalid_tool_call content block without an output-version stamp", async () => {
    const message = new AIMessage({
      content: [
        { text: "The tool call could not be parsed.", type: "text" },
        {
          args: '{"a":',
          error: "Malformed args.",
          id: "t1",
          name: "write_file",
          type: "invalid_tool_call",
        },
      ],
    });

    expect(message.response_metadata.output_version).toBeUndefined();
    await expect(convertAssistantMessage(message)).resolves.toEqual([
      {
        content: [{ text: "The tool call could not be parsed." }],
        role: "assistant",
      },
    ]);
  });
});
