/**
 * Confined workspace filesystem boundary tests.
 *
 * Constructs covered:
 * - Directly created nested files are immediately discoverable and readable.
 * - One Telegram inbox directory can be listed without scanning unrelated workspace files.
 * - Symlinks cannot be followed by trusted application file operations.
 */
import { mkdir, mkdtemp, readFile as readDiskFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  listWorkspaceStoredFiles,
  listWorkspaceStoredFilesUnder,
  readWorkspaceFile,
  writeWorkspaceFile,
  deleteWorkspaceFile,
  getWorkspaceStoredFile,
  workspaceDirectory,
} from "./workspace-storage.js";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("workspace storage", () => {
  it.each(["read", "write", "delete", "metadata", "list", "listUnder"] as const)(
    "rejects %s when the workspace root is a symlink to another audience",
    async (operation) => {
      const root = await mkdtemp(join(tmpdir(), "osinara-root-boundary-"));
      roots.push(root);
      const other = join(root, "00000000-0000-4000-8000-000000000002");
      await mkdir(join(other, "nested"), { recursive: true });
      const target = join(other, "nested", "private.txt");
      await writeFile(target, "other audience");
      await symlink(other, workspaceDirectory(root, WORKSPACE_ID));
      const operations = {
        read: () => readWorkspaceFile(root, WORKSPACE_ID, "nested/private.txt"),
        write: () => writeWorkspaceFile(root, WORKSPACE_ID, "nested/private.txt", Buffer.from("changed")),
        delete: () => deleteWorkspaceFile(root, WORKSPACE_ID, "nested/private.txt"),
        metadata: () => getWorkspaceStoredFile(root, WORKSPACE_ID, "nested/private.txt"),
        list: () => listWorkspaceStoredFiles(root, WORKSPACE_ID),
        listUnder: () => listWorkspaceStoredFilesUnder(root, WORKSPACE_ID, "nested"),
      };
      await expect(operations[operation]()).rejects.toMatchObject({ code: "AGENT_WORKSPACE_SYMLINK_FORBIDDEN" });
      expect(await readDiskFile(target, "utf8")).toBe("other audience");
    },
  );

  it("uses files created directly in the mounted workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-storage-"));
    roots.push(root);
    const directory = workspaceDirectory(root, WORKSPACE_ID);
    await mkdir(join(directory, "output"), { recursive: true });
    await writeFile(join(directory, "output", "report.txt"), "готово");

    await expect(listWorkspaceStoredFiles(root, WORKSPACE_ID)).resolves.toEqual([
      expect.objectContaining({ path: "output/report.txt" }),
    ]);
    await expect(readWorkspaceFile(root, WORKSPACE_ID, "output/report.txt"))
      .resolves.toEqual(Buffer.from("готово"));
  });

  it("rejects a symlink instead of resolving it outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-storage-"));
    roots.push(root);
    const directory = workspaceDirectory(root, WORKSPACE_ID);
    await mkdir(directory, { recursive: true });
    await symlink("/etc/passwd", join(directory, "secret.txt"));

    await expect(readWorkspaceFile(root, WORKSPACE_ID, "secret.txt"))
      .rejects.toThrowError(/AGENT_WORKSPACE_SYMLINK_FORBIDDEN/);
  });

  it("lists only files under one Telegram inbox directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-storage-"));
    roots.push(root);
    const directory = workspaceDirectory(root, WORKSPACE_ID);
    await mkdir(join(directory, "inbox", "773"), { recursive: true });
    await mkdir(join(directory, "inbox", "775"), { recursive: true });
    await writeFile(join(directory, "inbox", "773", "image.jpg"), "image");
    await writeFile(join(directory, "inbox", "775", "other.jpg"), "other");

    await expect(listWorkspaceStoredFilesUnder(root, WORKSPACE_ID, "inbox/773"))
      .resolves.toEqual([expect.objectContaining({ path: "inbox/773/image.jpg" })]);
  });
});
