// @effect-diagnostics nodeBuiltinImport:off - Transcript discovery is a bounded Node filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const MAX_PROJECT_DIRECTORIES = 256;

export interface ClaudeTranscriptCandidateStat {
  readonly isFile: boolean;
  readonly modifiedAtMs: number;
}

export interface ClaudeTranscriptResolverFileSystem {
  readonly listDirectories: (path: string) => Promise<readonly string[]>;
  readonly stat: (path: string) => Promise<ClaudeTranscriptCandidateStat | undefined>;
}

export const nodeClaudeTranscriptResolverFileSystem: ClaudeTranscriptResolverFileSystem = {
  listDirectories: async (path) => {
    const entries = await NodeFSP.readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  },
  stat: async (path) => {
    try {
      const stat = await NodeFSP.stat(path);
      return { isFile: stat.isFile(), modifiedAtMs: stat.mtimeMs };
    } catch (cause) {
      if (
        cause &&
        typeof cause === "object" &&
        "code" in cause &&
        (cause as { readonly code?: unknown }).code === "ENOENT"
      ) {
        return undefined;
      }
      throw cause;
    }
  },
};

export function claudeProjectDirectoryName(cwd: string): string {
  return cwd.replaceAll(NodePath.sep, "-").replaceAll("/", "-");
}

export function expectedClaudeTranscriptPath(input: {
  readonly homePath: string;
  readonly cwd: string;
  readonly sessionId: string;
}): string {
  return NodePath.join(
    input.homePath,
    ".claude",
    "projects",
    claudeProjectDirectoryName(input.cwd),
    `${input.sessionId}.jsonl`,
  );
}

export function isAllowedClaudeTranscriptPath(input: {
  readonly homePath: string;
  readonly sessionId: string;
  readonly candidatePath: string;
}): boolean {
  const projectsRoot = NodePath.resolve(input.homePath, ".claude", "projects");
  const candidate = NodePath.resolve(input.candidatePath);
  const relative = NodePath.relative(projectsRoot, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !NodePath.isAbsolute(relative) &&
    NodePath.basename(candidate) === `${input.sessionId}.jsonl`
  );
}

/**
 * Resolves one transcript without recursive home scans. The expected cwd path
 * wins; the fallback checks at most one session filename in a bounded number
 * of immediate Claude project directories and selects the newest match.
 */
export async function resolveClaudeTranscriptPath(
  input: {
    readonly homePath: string;
    readonly cwd: string;
    readonly sessionId: string;
  },
  fileSystem: ClaudeTranscriptResolverFileSystem = nodeClaudeTranscriptResolverFileSystem,
): Promise<string | undefined> {
  const expected = expectedClaudeTranscriptPath(input);
  const expectedStat = await fileSystem.stat(expected);
  if (expectedStat?.isFile) return expected;

  const projectsRoot = NodePath.join(input.homePath, ".claude", "projects");
  let directories: readonly string[];
  try {
    directories = await fileSystem.listDirectories(projectsRoot);
  } catch (cause) {
    if (
      cause &&
      typeof cause === "object" &&
      "code" in cause &&
      (cause as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw cause;
  }

  const matches: Array<{ readonly path: string; readonly modifiedAtMs: number }> = [];
  for (const directory of directories.slice(0, MAX_PROJECT_DIRECTORIES)) {
    const candidate = NodePath.join(projectsRoot, directory, `${input.sessionId}.jsonl`);
    const candidateStat = await fileSystem.stat(candidate);
    if (candidateStat?.isFile) {
      matches.push({ path: candidate, modifiedAtMs: candidateStat.modifiedAtMs });
    }
  }
  matches.sort(
    (left, right) => right.modifiedAtMs - left.modifiedAtMs || left.path.localeCompare(right.path),
  );
  return matches[0]?.path;
}
