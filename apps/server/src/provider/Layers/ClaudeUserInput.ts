import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";

export interface ParsedClaudeUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseClaudeAskUserQuestionInput(
  input: Record<string, unknown> | undefined,
): ParsedClaudeUserInput | undefined {
  if (!Array.isArray(input?.questions) || input.questions.length === 0) return undefined;

  const questions: UserInputQuestion[] = [];
  for (const rawQuestion of input.questions) {
    if (!rawQuestion || typeof rawQuestion !== "object" || Array.isArray(rawQuestion)) {
      return undefined;
    }
    const record = rawQuestion as Record<string, unknown>;
    const question = nonEmptyString(record.question);
    const header = nonEmptyString(record.header);
    if (!question || !header || !Array.isArray(record.options)) return undefined;

    const options: UserInputQuestion["options"][number][] = [];
    for (const rawOption of record.options) {
      if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) {
        return undefined;
      }
      const option = rawOption as Record<string, unknown>;
      const label = nonEmptyString(option.label);
      if (!label) return undefined;
      options.push({
        label,
        description: nonEmptyString(option.description) ?? label,
      });
    }

    questions.push({
      id: question,
      header,
      question,
      options,
      multiSelect: record.multiSelect === true,
    });
  }

  return { questions };
}

function normalizeAnswer(value: unknown): string | undefined {
  if (typeof value === "string") return nonEmptyString(value);
  if (!Array.isArray(value)) return undefined;
  const values = value.flatMap((candidate) => {
    const normalized = nonEmptyString(candidate);
    return normalized ? [normalized] : [];
  });
  if (values.length === 0) return undefined;
  return [...new Set(values)].join(", ");
}

export function normalizeClaudeAskUserQuestionAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  answers: ProviderUserInputAnswers,
): Record<string, string> | undefined {
  const normalized: Record<string, string> = {};
  for (const question of questions) {
    const answer = normalizeAnswer(answers[question.id]);
    if (!answer) return undefined;
    normalized[question.id] = answer;
  }
  return normalized;
}
