import { describe, expect, it } from "vitest";
import { toUpstreamMessages } from "./routes.js";

describe("toUpstreamMessages", () => {
  it("prepends the folder description as project context", () => {
    const messages = toUpstreamMessages("Ops runbook lives in /srv/ops.", [
      { role: "user", content: "what's the deploy step?" },
    ]);
    expect(messages[0]).toEqual({
      role: "system",
      content: "Project context for this conversation:\nOps runbook lives in /srv/ops.",
    });
    expect(messages[1]).toEqual({ role: "user", content: "what's the deploy step?" });
  });

  it("omits the system message when the folder has no description", () => {
    const messages = toUpstreamMessages("   ", [{ role: "user", content: "hi" }]);
    expect(messages).toEqual([{ role: "user", content: "hi" }]);
    expect(toUpstreamMessages(null, [{ role: "user", content: "hi" }])).toHaveLength(1);
  });

  it("turns images into vision content parts", () => {
    const messages = toUpstreamMessages(null, [
      {
        role: "user",
        content: "what is this?",
        images: [{ mime: "image/png", base64: "AAEC" }],
      },
    ]);
    expect(messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAEC" } },
      ],
    });
  });

  it("drops empty assistant turns (failed requests) from history", () => {
    const messages = toUpstreamMessages(null, [
      { role: "user", content: "first" },
      { role: "assistant", content: "" },
      { role: "user", content: "retry" },
    ]);
    expect(messages.map((m) => m.role)).toEqual(["user", "user"]);
  });
});
