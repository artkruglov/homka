/**
 * Structured memory write observability without memory content or internal database identifiers.
 *
 * Export:
 * - `logMemoryWriteEvent`: emits aggregatable success/failure and thread-action events.
 */
export interface MemoryWriteEvent {
  code: "AGENT_MEMORY_WRITE_FAILED" | "AGENT_MEMORY_WRITE_SUCCEEDED";
  errorCode?: string;
  scope: "family" | "group" | "personal";
  sourceKind: "current" | "delta";
  threadAction: "attach" | "attached" | "create" | "created" | "none";
}

export function logMemoryWriteEvent(event: MemoryWriteEvent): void {
  const serialized = JSON.stringify(event);
  if (event.code === "AGENT_MEMORY_WRITE_FAILED") {
    console.error(serialized);
    return;
  }
  console.info(serialized);
}
