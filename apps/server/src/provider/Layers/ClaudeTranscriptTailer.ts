// @effect-diagnostics nodeBuiltinImport:off - The transcript tailer performs explicit byte-range reads at the Node filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import {
  consumeClaudeTranscriptBytes,
  initialClaudeTranscriptCursor,
  type ClaudeTranscriptCursor,
} from "./ClaudePtyProtocol.ts";

export interface ClaudeTranscriptFileReader {
  readonly size: (path: string) => Promise<number>;
  readonly read: (path: string, offset: number, length: number) => Promise<Uint8Array>;
  readonly identity?: (path: string) => Promise<string>;
}

export const nodeClaudeTranscriptFileReader: ClaudeTranscriptFileReader = {
  size: async (path) => (await NodeFSP.stat(path)).size,
  identity: async (path) => {
    const stat = await NodeFSP.stat(path);
    return `${stat.dev}:${stat.ino}`;
  },
  read: async (path, offset, length) => {
    const file = await NodeFSP.open(path, "r");
    try {
      const buffer = Buffer.allocUnsafe(length);
      const result = await file.read(buffer, 0, length, offset);
      return buffer.subarray(0, result.bytesRead);
    } finally {
      await file.close();
    }
  },
};

export async function pollClaudeTranscript(
  reader: ClaudeTranscriptFileReader,
  path: string,
  current: ClaudeTranscriptCursor,
): Promise<{
  readonly cursor: ClaudeTranscriptCursor;
  readonly records: readonly Record<string, unknown>[];
  readonly invalidLines: readonly string[];
  readonly truncated: boolean;
  readonly replaced: boolean;
}> {
  const size = await reader.size(path);
  const fileId = reader.identity ? await reader.identity(path) : current.fileId;
  const replaced =
    current.fileId !== undefined && fileId !== undefined && current.fileId !== fileId;
  const truncated = !replaced && size < current.offset;
  const cursor =
    truncated || replaced
      ? { ...initialClaudeTranscriptCursor, ...(fileId ? { fileId } : {}) }
      : { ...current, ...(fileId ? { fileId } : {}) };
  if (size === cursor.offset) {
    return { cursor, records: [], invalidLines: [], truncated, replaced };
  }
  const bytes = await reader.read(path, cursor.offset, Math.min(size - cursor.offset, 1024 * 1024));
  const consumed = consumeClaudeTranscriptBytes(cursor, bytes);
  return { ...consumed, truncated, replaced };
}

export interface ClaudeTranscriptTailer {
  readonly close: () => void;
  readonly pollNow: () => Promise<void>;
  readonly getCursor: () => ClaudeTranscriptCursor;
}

export type ClaudeTranscriptWatcherFactory = (
  path: string,
  onChange: () => void,
) => { readonly close: () => void };

const nodeWatcherFactory: ClaudeTranscriptWatcherFactory = (path, onChange) => {
  const watcher = NodeFS.watch(path, { persistent: false }, onChange);
  return { close: () => watcher.close() };
};

export function startClaudeTranscriptTailer(input: {
  readonly path: string;
  readonly onRecord: (record: Record<string, unknown>) => void | Promise<void>;
  readonly onWarning?: (message: string, cause?: unknown) => void | Promise<void>;
  readonly pollIntervalMs?: number;
  readonly reader?: ClaudeTranscriptFileReader;
  readonly initialCursor?: ClaudeTranscriptCursor;
  readonly onCursor?: (cursor: ClaudeTranscriptCursor) => void | Promise<void>;
  readonly watcherFactory?: ClaudeTranscriptWatcherFactory | null;
}): ClaudeTranscriptTailer {
  const reader = input.reader ?? nodeClaudeTranscriptFileReader;
  let cursor = input.initialCursor ?? initialClaudeTranscriptCursor;
  let closed = false;
  let active: Promise<void> | null = null;

  const pollOnce = async (): Promise<boolean> => {
    if (closed) return false;
    try {
      const result = await pollClaudeTranscript(reader, input.path, cursor);
      cursor = result.cursor;
      if (result.truncated || result.replaced) {
        await input.onWarning?.("Claude transcript was replaced; tailing restarted at byte zero.");
      }
      for (const invalidLine of result.invalidLines) {
        await input.onWarning?.("Claude transcript contained invalid JSONL.", invalidLine);
      }
      for (const record of result.records) {
        await input.onRecord(record);
      }
      await input.onCursor?.(cursor);
      return result.cursor.offset < (await reader.size(input.path));
    } catch (cause) {
      const code =
        cause && typeof cause === "object" && "code" in cause
          ? (cause as { readonly code?: unknown }).code
          : undefined;
      if (code !== "ENOENT") {
        await input.onWarning?.("Failed to tail Claude transcript.", cause);
      }
      return false;
    }
  };

  const pollNow = () => {
    if (active) return active;
    active = (async () => {
      // Drain bounded 1 MiB chunks without one unbounded allocation. Yielding
      // between chunks keeps a large existing transcript off the event loop.
      for (let chunk = 0; chunk < 64; chunk++) {
        if (closed) break;
        const hasMore = await pollOnce();
        if (!hasMore) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })().finally(() => {
      active = null;
    });
    return active;
  };

  // @effect-diagnostics-next-line globalTimers:off - Tailer exposes an explicit close handle and is not itself an Effect service.
  const interval = setInterval(() => {
    void pollNow();
  }, input.pollIntervalMs ?? 75);
  interval.unref?.();
  let watcher: { readonly close: () => void } | undefined;
  try {
    watcher = (input.watcherFactory === undefined ? nodeWatcherFactory : input.watcherFactory)?.(
      input.path,
      () => void pollNow(),
    );
  } catch {
    // The transcript may not exist on a new session. Polling remains the
    // correctness path; a later hook can replace this tailer once it exists.
  }
  void pollNow();

  return {
    close: () => {
      closed = true;
      clearInterval(interval);
      watcher?.close();
    },
    pollNow,
    getCursor: () => cursor,
  };
}
