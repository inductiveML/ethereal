import { describe, expect, it, vi } from "vite-plus/test";

import { initialClaudeTranscriptCursor } from "./ClaudePtyProtocol.ts";
import { pollClaudeTranscript, startClaudeTranscriptTailer } from "./ClaudeTranscriptTailer.ts";

describe("pollClaudeTranscript", () => {
  it("reads only bytes appended after the durable offset", async () => {
    const encoder = new TextEncoder();
    let file = encoder.encode('{"type":"system","n":1}\n');
    const reads: Array<[number, number]> = [];
    const reader = {
      size: vi.fn(async () => file.byteLength),
      read: vi.fn(async (_path: string, offset: number, length: number) => {
        reads.push([offset, length]);
        return file.slice(offset, offset + length);
      }),
    };

    const first = await pollClaudeTranscript(reader, "/home/.claude/session.jsonl", {
      ...initialClaudeTranscriptCursor,
    });
    file = encoder.encode(
      '{"type":"system","n":1}\n{"type":"assistant","message":{"content":[]}}\n',
    );
    const second = await pollClaudeTranscript(reader, "/home/.claude/session.jsonl", first.cursor);

    expect(first.records).toEqual([{ type: "system", n: 1 }]);
    expect(second.records).toEqual([{ type: "assistant", message: { content: [] } }]);
    expect(reads).toEqual([
      [0, 24],
      [24, file.byteLength - 24],
    ]);
  });

  it("resets its offset when Claude replaces or truncates a transcript", async () => {
    const bytes = new TextEncoder().encode('{"type":"system","fresh":true}\n');
    const reader = {
      size: vi.fn(async () => bytes.byteLength),
      read: vi.fn(async (_path: string, offset: number, length: number) =>
        bytes.slice(offset, offset + length),
      ),
    };

    const result = await pollClaudeTranscript(reader, "/transcript", {
      offset: 500,
      pending: new TextEncoder().encode("stale partial"),
    });

    expect(reader.read).toHaveBeenCalledWith("/transcript", 0, bytes.byteLength);
    expect(result.records).toEqual([{ type: "system", fresh: true }]);
    expect(result.truncated).toBe(true);
  });

  it("detects replacement by file identity even when the new file is larger", async () => {
    const bytes = new TextEncoder().encode('{"type":"system","replacement":true}\n');
    const reader = {
      size: vi.fn(async () => bytes.byteLength),
      identity: vi.fn(async () => "new-file"),
      read: vi.fn(async (_path: string, offset: number, length: number) =>
        bytes.slice(offset, offset + length),
      ),
    };

    const result = await pollClaudeTranscript(reader, "/transcript", {
      offset: 5,
      pending: new Uint8Array(),
      fileId: "old-file",
    });

    expect(result.replaced).toBe(true);
    expect(reader.read).toHaveBeenCalledWith("/transcript", 0, bytes.byteLength);
    expect(result.records).toEqual([{ type: "system", replacement: true }]);
  });

  it("bounds each native read to one MiB for large transcripts", async () => {
    const size = 3 * 1024 * 1024;
    const reader = {
      size: vi.fn(async () => size),
      read: vi.fn(async (_path: string, _offset: number, length: number) => new Uint8Array(length)),
    };

    const result = await pollClaudeTranscript(reader, "/large", initialClaudeTranscriptCursor);

    expect(reader.read).toHaveBeenCalledWith("/large", 0, 1024 * 1024);
    expect(result.cursor.offset).toBe(1024 * 1024);
  });

  it("coalesces duplicate filesystem notifications while a poll is active", async () => {
    const bytes = new TextEncoder().encode('{"type":"system"}\n');
    let notify = () => {};
    let releaseRead = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const reader = {
      size: vi.fn(async () => bytes.byteLength),
      read: vi.fn(async () => {
        await blocked;
        return bytes;
      }),
    };
    const records: Record<string, unknown>[] = [];
    const tailer = startClaudeTranscriptTailer({
      path: "/watched",
      reader,
      pollIntervalMs: 60_000,
      watcherFactory: (_path, onChange) => {
        notify = onChange;
        return { close: () => {} };
      },
      onRecord: (record) => {
        records.push(record);
      },
    });

    notify();
    notify();
    releaseRead();
    await tailer.pollNow();
    tailer.close();

    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(records).toEqual([{ type: "system" }]);
  });

  it("does not publish unchanged cursors during idle correctness polls", async () => {
    const bytes = new TextEncoder().encode('{"type":"system"}\n');
    const reader = {
      size: vi.fn(async () => bytes.byteLength),
      read: vi.fn(async (_path: string, offset: number, length: number) =>
        bytes.slice(offset, offset + length),
      ),
    };
    const cursors: number[] = [];
    const tailer = startClaudeTranscriptTailer({
      path: "/watched",
      reader,
      pollIntervalMs: 60_000,
      watcherFactory: null,
      onRecord: () => {},
      onCursor: (cursor) => {
        cursors.push(cursor.offset);
      },
    });

    await tailer.pollNow();
    await tailer.pollNow();
    tailer.close();

    expect(cursors).toEqual([bytes.byteLength]);
    expect(reader.read).toHaveBeenCalledTimes(1);
  });

  it("drains bytes appended while a poll is active before resolving pollNow", async () => {
    const encoder = new TextEncoder();
    let file = encoder.encode('{"type":"assistant","n":1}\n');
    let notify = () => {};
    let releaseEofCheck = () => {};
    let eofCheckStarted = () => {};
    const eofCheckPending = new Promise<void>((resolve) => {
      eofCheckStarted = resolve;
    });
    const eofCheckBlocked = new Promise<void>((resolve) => {
      releaseEofCheck = resolve;
    });
    let sizeCount = 0;
    const reader = {
      size: vi.fn(async () => {
        sizeCount += 1;
        const size = file.byteLength;
        if (sizeCount === 2) {
          eofCheckStarted();
          await eofCheckBlocked;
        }
        return size;
      }),
      read: vi.fn(async (_path: string, offset: number, length: number) =>
        file.slice(offset, offset + length),
      ),
    };
    const records: Record<string, unknown>[] = [];
    const tailer = startClaudeTranscriptTailer({
      path: "/watched",
      reader,
      pollIntervalMs: 60_000,
      watcherFactory: (_path, onChange) => {
        notify = onChange;
        return { close: () => {} };
      },
      onRecord: (record) => {
        records.push(record);
      },
    });

    await eofCheckPending;
    file = encoder.encode('{"type":"assistant","n":1}\n{"type":"assistant","n":2}\n');
    notify();
    const drained = tailer.pollNow();
    releaseEofCheck();
    await drained;
    tailer.close();

    expect(records).toEqual([
      { type: "assistant", n: 1 },
      { type: "assistant", n: 2 },
    ]);
    expect(reader.read).toHaveBeenCalledTimes(2);
  });
});
