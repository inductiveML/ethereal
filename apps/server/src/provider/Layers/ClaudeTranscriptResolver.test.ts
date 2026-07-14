import { describe, expect, it, vi } from "vite-plus/test";

import {
  claudeProjectDirectoryName,
  expectedClaudeTranscriptPath,
  isAllowedClaudeTranscriptPath,
  resolveClaudeTranscriptPath,
  type ClaudeTranscriptResolverFileSystem,
} from "./ClaudeTranscriptResolver.ts";

function fakeFileSystem(files: Record<string, number>, directories: readonly string[]) {
  return {
    listDirectories: vi.fn(async () => directories),
    stat: vi.fn(async (path: string) =>
      path in files ? { isFile: true, modifiedAtMs: files[path]! } : undefined,
    ),
  } satisfies ClaudeTranscriptResolverFileSystem;
}

describe("ClaudeTranscriptResolver", () => {
  const input = {
    homePath: "/accounts/work",
    cwd: "/repo/project",
    sessionId: "11111111-1111-4111-8111-111111111111",
  };

  it("builds the expected path from the selected Claude HOME and cwd", () => {
    expect(claudeProjectDirectoryName("/repo/project")).toBe("-repo-project");
    expect(expectedClaudeTranscriptPath(input)).toBe(
      "/accounts/work/.claude/projects/-repo-project/11111111-1111-4111-8111-111111111111.jsonl",
    );
  });

  it("prefers the expected cwd path and does not scan fallback directories", async () => {
    const expected = expectedClaudeTranscriptPath(input);
    const fileSystem = fakeFileSystem({ [expected]: 1 }, ["other"]);

    await expect(resolveClaudeTranscriptPath(input, fileSystem)).resolves.toBe(expected);
    expect(fileSystem.listDirectories).not.toHaveBeenCalled();
  });

  it("uses a bounded fallback by session id and selects the newest match", async () => {
    const oldPath = `${input.homePath}/.claude/projects/old/${input.sessionId}.jsonl`;
    const newPath = `${input.homePath}/.claude/projects/new/${input.sessionId}.jsonl`;
    const fileSystem = fakeFileSystem({ [oldPath]: 10, [newPath]: 20 }, ["old", "new"]);

    await expect(resolveClaudeTranscriptPath(input, fileSystem)).resolves.toBe(newPath);
  });

  it("returns undefined when a new session has no transcript yet", async () => {
    const fileSystem = fakeFileSystem({}, []);
    await expect(resolveClaudeTranscriptPath(input, fileSystem)).resolves.toBeUndefined();
  });

  it("accepts only this session's JSONL below the selected HOME", () => {
    const valid = expectedClaudeTranscriptPath(input);
    expect(isAllowedClaudeTranscriptPath({ ...input, candidatePath: valid })).toBe(true);
    expect(
      isAllowedClaudeTranscriptPath({
        ...input,
        candidatePath: `/accounts/other/.claude/projects/repo/${input.sessionId}.jsonl`,
      }),
    ).toBe(false);
    expect(
      isAllowedClaudeTranscriptPath({
        ...input,
        candidatePath: `${input.homePath}/.claude/projects/repo/another-session.jsonl`,
      }),
    ).toBe(false);
  });
});
