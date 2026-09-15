import type { LanguageModelV4 } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { evaluateSearchModel, evaluationFingerprint } from "./model-run.js";

function fake(content: unknown[], finish = "stop") {
  const doGenerate = vi.fn().mockResolvedValue({ content, finishReason: { unified: finish } });
  return { doGenerate, model: { doGenerate } as unknown as LanguageModelV4 };
}
const search = { type: "tool-call", toolName: "web_search", providerExecuted: true };
describe("search evaluation evidence", () => {
  it("records only safe provider error codes instead of raw error payloads", async () => {
    const { model } = fake([search,
      { type: "tool-result", isError: true, result: { errorCode: "max_uses_exceeded" } },
      { type: "tool-result", isError: true, result: { errorCode: "secret-provider-token" } },
    ]);
    const result = await evaluateSearchModel(model, "question", "rules");
    expect(result.searchErrorCodes).toEqual(["max_uses_exceeded", "unknown_error"]);
    expect(JSON.stringify(result)).not.toContain("secret-provider-token");
  });
  it("does not accept plausible text and a URL without provider search", async () => {
    const { model, doGenerate } = fake([{ type: "text", text: "Ответ https://example.org" }]);
    expect(await evaluateSearchModel(model, "question", "rules")).toMatchObject({ searchCalls: 0, evidenceFailure: "search_not_executed" });
    expect(doGenerate).toHaveBeenCalledOnce();
    expect(doGenerate.mock.calls[0][0].tools[0].id).toBe("anthropic.web_search_20250305");
  });
  it("keeps provider sources separate from authored URLs", async () => {
    const { model } = fake([search, { type: "text", text: "Ответ https://invented.example" },
      { type: "source", sourceType: "url", url: "https://official.example" }]);
    expect(await evaluateSearchModel(model, "question", "rules")).toMatchObject({
      evidenceFailure: null, sources: ["https://official.example"], searchCalls: 1,
    });
  });
  it.each([
    [[search, { type: "tool-result", isError: true }], "stop", "provider_search_failed"],
    [[search], "stop", "empty_answer"],
    [[search, { type: "text", text: "unfinished" }], "length", "incomplete_answer"],
  ])("does not count incomplete/failed evidence as success", async (content, finish, evidenceFailure) => {
    const { model } = fake(content as unknown[], finish as string);
    expect((await evaluateSearchModel(model, "question", "rules")).evidenceFailure).toBe(evidenceFailure);
  });
  it("does not retry a failed physical request", async () => {
    const { model, doGenerate } = fake([]);
    doGenerate.mockRejectedValue(new Error("network failed"));
    await expect(evaluateSearchModel(model, "question", "rules")).rejects.toThrow("network failed");
    expect(doGenerate).toHaveBeenCalledOnce();
  });
  it("changes the report identity when the model, questions or prompt change", () => {
    const original = { model: "flash", prompt: "old", questions: ["one"] };
    for (const updated of [{ ...original, model: "other" }, { ...original, prompt: "new" }, { ...original, questions: ["two"] }]) {
      expect(evaluationFingerprint(updated)).not.toBe(evaluationFingerprint(original));
    }
    expect(evaluationFingerprint(original)).toBe(evaluationFingerprint({ ...original }));
  });
});
