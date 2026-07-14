import { describe, expect, it } from "@effect/vitest";

import {
  normalizeClaudeAskUserQuestionAnswers,
  parseClaudeAskUserQuestionInput,
} from "./ClaudeUserInput.ts";

describe("ClaudeUserInput", () => {
  it("parses Claude AskUserQuestion input without changing question identity", () => {
    const original = [
      {
        question: "Which checks should I run?",
        header: "Checks",
        options: [{ label: "Focused", description: "Run focused tests" }, { label: "Full" }],
        multiSelect: true,
      },
    ];
    const parsed = parseClaudeAskUserQuestionInput({ questions: original });

    expect(parsed).toEqual({
      questions: [
        {
          id: "Which checks should I run?",
          question: "Which checks should I run?",
          header: "Checks",
          options: [
            { label: "Focused", description: "Run focused tests" },
            { label: "Full", description: "Full" },
          ],
          multiSelect: true,
        },
      ],
    });
  });

  it("rejects malformed question payloads", () => {
    expect(parseClaudeAskUserQuestionInput(undefined)).toBeUndefined();
    expect(parseClaudeAskUserQuestionInput({ questions: [] })).toBeUndefined();
    expect(
      parseClaudeAskUserQuestionInput({
        questions: [{ header: "Scope", options: [] }],
      }),
    ).toBeUndefined();
  });

  it("normalizes single and multi-select answers for Claude", () => {
    const parsed = parseClaudeAskUserQuestionInput({
      questions: [
        { question: "Scope?", header: "Scope", options: [] },
        { question: "Checks?", header: "Checks", options: [], multiSelect: true },
      ],
    });
    expect(parsed).toBeDefined();
    expect(
      normalizeClaudeAskUserQuestionAnswers(parsed!.questions, {
        "Scope?": " Workspace ",
        "Checks?": ["Typecheck", "Tests", "Typecheck"],
      }),
    ).toEqual({
      "Scope?": "Workspace",
      "Checks?": "Typecheck, Tests",
    });
  });

  it("requires an answer for every question", () => {
    const parsed = parseClaudeAskUserQuestionInput({
      questions: [{ question: "Scope?", header: "Scope", options: [] }],
    });
    expect(parsed).toBeDefined();
    expect(normalizeClaudeAskUserQuestionAnswers(parsed!.questions, {})).toBeUndefined();
  });
});
