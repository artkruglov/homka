# Image Generation

Use `generate_image` when the user asks for a new raster image or an edit to a supplied photograph.

Do not use it for SVG assets, simple diagrams that should be code, an existing vector system, or an
vector edit. Never generate an image merely to decorate an answer.

## Editing a photograph

1. Locate the supplied image in the current chat workspace. Inspect it with
   `inspect_workspace_image` before deciding how to edit it. For photos from the group journal,
   pass `referenceAttachmentIds` instead of `referencePaths`; no file import is needed. Never invent a path,
   fetch a private photo from another scope, or replace a missing photo with a text description.
2. Pass its path in `referencePaths` (up to four). Editing currently requires OpenRouter.
3. Name the requested change and the details to preserve: the person's identity, pose, surrounding
   objects, lighting, and text when relevant. For multiple inputs, assign each numbered image a role.
4. For follow-up edits, use the previous output as input and repeat the important constraints.
   Request one specific revision at a time. Inspect the result; do not promise pixel-identical
   preservation or flawless lettering.

Reference: https://developers.openai.com/api/docs/guides/image-prompting
Transport: https://openrouter.ai/docs/guides/overview/multimodal/image-generation

## Prompt workflow

1. Preserve a detailed user prompt without inventing new characters, objects, brands, slogans, or
   story elements.
2. For a generic request, add only details that materially improve the requested result.
3. Structure the prompt in this order: purpose, scene, subject, composition, visual style, lighting,
   exact text, constraints.
4. Put exact in-image text in straight quotes and require verbatim rendering with no extra text.
5. State important exclusions explicitly, including no watermark, no logo, or no additional objects
   when applicable.
6. Use `size=auto`, `quality=auto`, and `background=auto` unless the user or intended layout requires
   an explicit value.
7. Use one `generate_image` call for one requested final. For variants, make one call per variant.

The tool saves a non-overwriting image file (WebP, PNG or JPEG depending on the provider) in the
authorized workspace and sends it to the current Telegram chat. Report the returned path after successful delivery.

If the tool reports an unknown status, stop. Do not call it again automatically because the
provider may already have been charged.
