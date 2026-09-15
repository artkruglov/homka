/**
 * Sandbox runner engine boundary.
 *
 * Export:
 * - `SandboxEngine`: operations the authenticated internal HTTP server may delegate to Docker.
 */
import type {
  GoogleWorkspaceExecutionRequest,
  SandboxRunnerCreateRequest,
  SandboxRunnerProcessRequest,
  SandboxRunnerProcessResponse,
  SandboxRunnerRemovePathRequest,
  SandboxRunnerSessionResponse,
} from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";
import type { SandboxReconciliationResult } from "./docker-sandbox-reconciliation.js";

export interface SandboxEngine {
  createSession(request: SandboxRunnerCreateRequest): Promise<SandboxRunnerSessionResponse>;
  deleteToolEnvironment(workspaceId: string): Promise<void>;
  health(): Promise<void>;
  runGoogleWorkspace(
    request: GoogleWorkspaceExecutionRequest,
    signal?: AbortSignal,
  ): Promise<SandboxRunnerProcessResponse>;
  readFile(sessionId: string, path: string): Promise<Uint8Array | null>;
  removePath(sessionId: string, request: SandboxRunnerRemovePathRequest): Promise<void>;
  runProcess(
    sessionId: string,
    request: SandboxRunnerProcessRequest,
    signal?: AbortSignal,
  ): Promise<SandboxRunnerProcessResponse>;
  reconcileIdleSessions(now: Date): Promise<SandboxReconciliationResult>;
  stopAllSessions(): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  writeFile(sessionId: string, path: string, content: Uint8Array): Promise<void>;
}
