/**
 * Telegram attachment validation tests.
 *
 * Constructs covered:
 * - `validateAttachmentContent`: safe names and content-derived MIME for arbitrary documents.
 * - Native Telegram photos remain restricted to actual image bytes.
 * - UTF-8 structured text remains recognizable without trusting arbitrary binary declarations.
 */
import { describe, expect, it } from "vitest";

import {
  validateAttachmentContent,
  validateReadableTextAttachmentContent,
} from "./attachment-policy.js";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
    "0000000d49444154789c6360000000020001e221bc330000000049454e44ae426082",
  "hex",
);

describe("validateAttachmentContent", () => {
  it("accepts actual image bytes through Telegram's native photo transport", async () => {
    await expect(validateAttachmentContent({
      bytes: PNG_BYTES,
      declaredMediaType: "image/png",
      fileName: "Снимок.png",
      kind: "photo",
    })).resolves.toEqual({ fileName: "Снимок.png", mediaType: "image/png" });
  });

  it("accepts a renamed document while retaining its detected content type", async () => {
    await expect(validateAttachmentContent({
      bytes: PNG_BYTES,
      declaredMediaType: "application/pdf",
      fileName: "договор.pdf",
      kind: "document",
    })).resolves.toEqual({ fileName: "договор.pdf", mediaType: "image/png" });
  });

  it("accepts supported UTF-8 text documents when binary detection is absent", async () => {
    await expect(validateAttachmentContent({
      bytes: Buffer.from("name,value\nчай,2\n", "utf8"),
      declaredMediaType: "text/csv",
      fileName: "покупки.csv",
      kind: "document",
    })).resolves.toEqual({ fileName: "покупки.csv", mediaType: "text/csv" });
  });

  it("accepts an APK-like archive regardless of the generic Telegram MIME", async () => {
    const emptyZip = Buffer.from("504b0506000000000000000000000000000000000000", "hex");

    await expect(validateAttachmentContent({
      bytes: emptyZip,
      declaredMediaType: "application/octet-stream",
      fileName: "application.apk",
      kind: "document",
    })).resolves.toEqual({ fileName: "application.apk", mediaType: "application/zip" });
  });

  it("stores an opaque unknown document with a conservative binary media type", async () => {
    await expect(validateAttachmentContent({
      bytes: Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]),
      declaredMediaType: "application/x-user-defined",
      fileName: "payload.custom",
      kind: "document",
    })).resolves.toEqual({
      fileName: "payload.custom",
      mediaType: "application/octet-stream",
    });
  });

  it("rejects non-image bytes sent through Telegram's native photo transport", async () => {
    const emptyZip = Buffer.from("504b0506000000000000000000000000000000000000", "hex");

    await expect(validateAttachmentContent({
      bytes: emptyZip,
      fileName: "photo.jpg",
      kind: "photo",
    })).rejects.toThrowError(/AGENT_ATTACHMENT_TYPE_MISMATCH/);
  });
});

describe("validateReadableTextAttachmentContent", () => {
  it.each([
    ["notes.txt", "text/plain", "Обычная заметка\n"],
    ["README.md", "text/markdown", "# Решение\n\nВыпустить безопасно.\n"],
    ["payload.json", "application/json", '{"ключ":"значение"}\n'],
    ["report.csv", "text/csv", "ключ,значение\nчай,2\n"],
    ["report.tsv", "text/tab-separated-values", "ключ\tзначение\nчай\t2\n"],
    ["page.HTML", "text/html", "<!doctype html><html><body>Текст</body></html>\n"],
    ["feed.Xml", "application/xml", '<?xml version="1.0"?><root>Текст</root>\n'],
    ["settings.YAML", "application/yaml", "ключ: значение\n"],
    ["config.yml", "application/yaml", "enabled: true\n"],
  ])("accepts strict UTF-8 %s as %s", async (fileName, mediaType, text) => {
    await expect(validateReadableTextAttachmentContent({
      bytes: Buffer.from(text, "utf8"),
      declaredMediaType: "application/octet-stream",
      fileName,
      kind: "document",
    })).resolves.toEqual({ fileName, mediaType });
  });

  it.each(["document.pdf", "document.docx", "archive.zip"])(
    "rejects unsupported external document %s",
    async (fileName) => {
      await expect(validateReadableTextAttachmentContent({
        bytes: Buffer.from("readable text", "utf8"),
        fileName,
        kind: "document",
      })).rejects.toThrowError(/AGENT_ATTACHMENT_TEXT_REQUIRED/u);
    },
  );

  it("rejects valid UTF-8 containing NUL", async () => {
    await expect(validateReadableTextAttachmentContent({
      bytes: Buffer.from("before\0after", "utf8"),
      fileName: "notes.txt",
      kind: "document",
    })).rejects.toThrowError(/AGENT_ATTACHMENT_TEXT_REQUIRED/u);
  });

  it("rejects invalid UTF-8 without relying on NUL detection", async () => {
    await expect(validateReadableTextAttachmentContent({
      bytes: Buffer.from([0xc3, 0x28]),
      fileName: "notes.txt",
      kind: "document",
    })).rejects.toThrowError(/AGENT_ATTACHMENT_TEXT_REQUIRED/u);
  });

  it("rejects detected binary magic under a readable extension", async () => {
    await expect(validateReadableTextAttachmentContent({
      bytes: Buffer.from("504b0506000000000000000000000000000000000000", "hex"),
      fileName: "notes.txt",
      kind: "document",
    })).rejects.toThrowError(/AGENT_ATTACHMENT_TEXT_REQUIRED/u);
  });

  it("rejects a detected text format hidden under another allowlisted extension", async () => {
    await expect(validateReadableTextAttachmentContent({
      bytes: Buffer.from('<?xml version="1.0"?><root>text</root>', "utf8"),
      fileName: "notes.txt",
      kind: "document",
    })).rejects.toThrowError(/AGENT_ATTACHMENT_TEXT_REQUIRED/u);
  });
});
