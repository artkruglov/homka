import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ text: vi.fn(), file: vi.fn() }));
vi.mock("../relay/chat-relay-transport.js", () => ({ relayChatMessage: mocks.text }));
vi.mock("../attachments/telegram-workspace-file-delivery.js", () => ({ deliverWorkspaceFile: mocks.file }));
import { deliverErrandResult } from "./errand-result-delivery.js";

describe("researched selection presentation", () => {
  beforeEach(() => { vi.resetAllMocks(); });
  it("sends a fitting result as one ordinary message", async () => {
    mocks.text.mockResolvedValue("91");
    const input = { chatId: "123", text: "а".repeat(4096) };
    expect(await deliverErrandResult(input)).toBe("91");
    expect(mocks.text).toHaveBeenCalledExactlyOnceWith(input);
    expect(mocks.file).not.toHaveBeenCalled();
  });
  it("preserves every byte and source in one document beyond the text limit", async () => {
    mocks.file.mockResolvedValue({ telegramMessageId: "92" });
    const text = "Содержательная подборка. ".repeat(250) + "\nhttps://example.org/" + "x".repeat(1800);
    expect(await deliverErrandResult({ chatId: "123", text })).toBe("92");
    expect(mocks.file).toHaveBeenCalledTimes(1);
    const sent = mocks.file.mock.calls[0]![0];
    expect(sent).toMatchObject({ chatId: "123", presentation: "document", fileName: "Подборка.txt" });
    expect(new TextDecoder().decode(sent.bytes)).toBe(text);
    expect(sent.caption.length).toBeLessThan(1024);
    expect(mocks.text).not.toHaveBeenCalled();
  });
  it("does not make another request when a document receipt is uncertain", async () => {
    mocks.file.mockRejectedValue(new Error("receipt lost"));
    await expect(deliverErrandResult({ chatId: "123", text: "а".repeat(4097) })).rejects.toThrow("receipt lost");
    expect(mocks.file).toHaveBeenCalledTimes(1);
    expect(mocks.text).not.toHaveBeenCalled();
  });
});
