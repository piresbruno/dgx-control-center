import { describe, expect, it } from "vitest";
import { SseAccumulator, parseCompletionBody } from "./sse.js";

const frame = (content: string) => `data: {"choices":[{"delta":{"content":"${content}"}}]}\n\n`;

describe("SseAccumulator", () => {
  it("reassembles deltas split across chunk boundaries", () => {
    const acc = new SseAccumulator();
    acc.push('data: {"choices":[{"delta":{"cont');
    acc.push('ent":"Hel"}}]}\n\n' + frame("lo"));
    acc.push("\n");
    acc.push(frame(" there"));
    acc.push("data: [DONE]\n\n");
    expect(acc.content).toBe("Hello there");
  });

  it("sniffs usage from a trailing frame and ignores keep-alives and junk", () => {
    const acc = new SseAccumulator();
    acc.push(": ping\n\n");
    acc.push(frame("x"));
    acc.push('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12}}\n\n');
    acc.push("data: {malformed\n\n");
    expect(acc.content).toBe("x");
    expect(acc.usage).toEqual({ promptTokens: 9, completionTokens: 3, totalTokens: 12 });
  });

  it("accepts non-delta message content (engines that answer without streaming)", () => {
    const acc = new SseAccumulator();
    acc.push('data: {"choices":[{"message":{"content":"full"}}]}\n\n');
    expect(acc.content).toBe("full");
    expect(acc.usage).toBeNull();
  });
});

describe("parseCompletionBody", () => {
  it("parses a buffered JSON completion", () => {
    expect(
      parseCompletionBody('{"choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":1,"completion_tokens":2}}'),
    ).toEqual({ content: "hi", usage: { promptTokens: 1, completionTokens: 2 } });
  });

  it("returns null for unparsable bodies", () => {
    expect(parseCompletionBody("not json")).toBeNull();
    expect(parseCompletionBody(null)).toBeNull();
  });
});
