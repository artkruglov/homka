/**
 * Atomic Docker seed archive construction.
 *
 * Export:
 * - `writeSandboxSeedArchive`: uploads all validated seed files through one Docker archive stream.
 */
import type Docker from "dockerode";
import tar from "tar-stream";

import type { SandboxRunnerSeedFile } from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";

const SEED_FILE_MODE = 0o600;

async function addEntry(pack: tar.Pack, file: SandboxRunnerSeedFile): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    pack.entry({
      mode: SEED_FILE_MODE,
      name: file.path.slice(1),
      type: "file",
    }, Buffer.from(file.contentBase64, "base64"), (error) => error ? reject(error) : resolve());
  });
}

export async function writeSandboxSeedArchive(
  container: Docker.Container,
  files: readonly SandboxRunnerSeedFile[],
): Promise<void> {
  if (files.length === 0) return;

  // Docker consumes the stream while entries are produced, avoiding a second in-memory archive copy.
  const pack = tar.pack();
  const upload = container.putArchive(pack, { path: "/" });
  for (const file of files) await addEntry(pack, file);
  pack.finalize();
  await upload;
}
