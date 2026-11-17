/**
 * Guided models per specs/user-interface.md Section 1: the parser reads a model guidance
 * text and the session branch reader takes the latest one. No network, no host, no clock.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { guidedModels, parseModelGuidance, type BranchEntry } from "../lib/guidance.ts";

const GUIDANCE = [
  "Model guidance:",
  "- deepseek/deepseek-flash: Use for implementation next to llm-dralban68. [$0.3/$1.2, ×0.5]",
  "- tl/claude-opus-5-5: Review work done by agents with other models. [$4/$20]",
  "",
  "Choose by stated use first; among models suited to a task, prefer the cheaper one.",
].join("\n");

function message(content: unknown, type = "custom_message"): BranchEntry {
  return { type, content };
}

test("guidance: reads provider and model from each model line", () => {
  assert.deepEqual(parseModelGuidance(GUIDANCE), [
    { provider: "deepseek", id: "deepseek-flash" },
    { provider: "tl", id: "claude-opus-5-5" },
  ]);
});

test("guidance: a thinking level ends the model id", () => {
  const text = "Model guidance:\n- anthropic/claude-opus-4-5:high: design and code review\n";
  assert.deepEqual(parseModelGuidance(text), [{ provider: "anthropic", id: "claude-opus-4-5" }]);
});

test("guidance: duplicates collapse and other lines are ignored", () => {
  const text = [
    "Model guidance:",
    "- zai/glm-5.3: first",
    "not a model line",
    "- zai/glm-5.3: again",
    "- no-provider: nothing",
    "- /empty: nothing",
  ].join("\n");
  assert.deepEqual(parseModelGuidance(text), [{ provider: "zai", id: "glm-5.3" }]);
});

test("guidance: a text without the prefix is not a model guidance", () => {
  assert.equal(parseModelGuidance("purse\n- zai/glm-5.3: x"), undefined);
});

test("guidance: the latest model guidance on the branch wins", () => {
  const branch: BranchEntry[] = [
    message("Model guidance:\n- zai/glm-5.3: old\n"),
    message("a user turn", "message"),
    message("Model guidance:\n- google/gemini-3.8-flash: new\n"),
    message("purse: no guidance here"),
  ];
  assert.deepEqual(guidedModels(branch), [{ provider: "google", id: "gemini-3.8-flash" }]);
});

test("guidance: content parts are joined and non-guidance entries skipped", () => {
  const branch: BranchEntry[] = [
    message("Model guidance:\n- zai/glm-5.3: from parts\n", "custom_message"),
    {
      type: "custom_message",
      content: [
        { type: "text", text: "Model guidance:" },
        { type: "text", text: "- tl/claude-opus-5-5: x" },
      ],
    },
  ];
  assert.deepEqual(guidedModels(branch), [{ provider: "tl", id: "claude-opus-5-5" }]);
  assert.deepEqual(guidedModels([{ type: "custom_message" }, message(42)]), []);
});
