// Last verified working with Pi v1.1.0
/**
 * ask_user - Ask one or more multiple-choice questions in a bounded wizard.
 *
 * - 1 to 10 questions per call
 * - 2 to 5 model-provided options per question
 * - An always-present "Write my own answer" option
 * - Bounded, width-aware tab navigation with a final review/submit page
 * - Abort-aware custom UI that distinguishes dismissal from cancellation
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 10;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const MAX_TAB_LABEL_WIDTH = 14;

const ASK_USER_PARAMETER_DESCRIPTIONS = {
  optionValue: "Stable machine-readable value returned when this option is selected",
  optionLabel: "Short display label for this option",
  optionDescription: "Optional one-line description shown below the option label",
  questionId: "Unique stable identifier for this question within the call",
  questionLabel:
    "Optional short navigation label, such as 'Scope' or 'Priority' (defaults to Q1, Q2, and so on)",
  questionPrompt: "The full question text to display",
  options:
    "Between 2 and 5 answer options. A free-form 'write my own answer' option is always appended automatically; never include one yourself.",
  questions: "Between 1 and 10 related questions to ask the user",
};

const ASK_USER_TOOL_DESCRIPTION =
  "Ask the user between 1 and 10 multiple-choice questions in an interactive wizard. Each question must provide 2-5 options, and a free-form answer is always available automatically. Use one question for a simple decision or several related questions when requirements can be collected together.";

const ASK_USER_PROMPT_SNIPPET =
  "Ask the user 1-10 related multiple-choice questions with automatic free-form answers";

const ASK_USER_PROMPT_GUIDELINES = [
  "When asking the user questions whose likely answers can be enumerated, use the ask_user tool instead of asking in plain text.",
  "Use one ask_user call for up to 10 related questions that can be answered together; ask adaptive follow-up questions in a subsequent call after seeing the earlier answers.",
  "For each ask_user question, provide 2-5 meaningful options and do not add a free-form option because ask_user appends it automatically.",
];

// Spread keeps this source compatible with Pi versions that predate tool exposure.
const ASK_USER_TOOL_EXPOSURE = { exposure: "model-only" as const };

export function buildAskUserResultMessage(
  outcome:
    | { kind: "no-ui" }
    | { kind: "aborted" }
    | { kind: "dismissed" }
    | { kind: "submitted"; answers: string[] },
): string {
  switch (outcome.kind) {
    case "no-ui":
      return "No interactive TUI is available, so the questions could not be shown. Ask the user in plain text instead.";
    case "aborted":
      return "Cancelled";
    case "dismissed":
      return "User dismissed the questions without submitting answers. Do not assume answers; proceed accordingly or ask differently.";
    case "submitted":
      return outcome.answers.join("\n");
  }
}

const QuestionOptionSchema = Type.Object(
  {
    value: Type.String({
      minLength: 1,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.optionValue,
    }),
    label: Type.String({
      minLength: 1,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel,
    }),
    description: Type.Optional(
      Type.String({
        description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription,
      }),
    ),
  },
  { additionalProperties: false },
);

const QuestionSchema = Type.Object(
  {
    id: Type.String({
      minLength: 1,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.questionId,
    }),
    label: Type.Optional(
      Type.String({
        minLength: 1,
        description: ASK_USER_PARAMETER_DESCRIPTIONS.questionLabel,
      }),
    ),
    prompt: Type.String({
      minLength: 1,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.questionPrompt,
    }),
    options: Type.Array(QuestionOptionSchema, {
      minItems: MIN_OPTIONS,
      maxItems: MAX_OPTIONS,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
    }),
  },
  { additionalProperties: false },
);

const AskUserParams = Type.Object(
  {
    questions: Type.Array(QuestionSchema, {
      minItems: MIN_QUESTIONS,
      maxItems: MAX_QUESTIONS,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.questions,
    }),
  },
  { additionalProperties: false },
);

export type AskUserInput = Static<typeof AskUserParams>;

type InputQuestion = AskUserInput["questions"][number];
type InputOption = InputQuestion["options"][number];

type AskUserOutcome = "submitted" | "dismissed" | "aborted" | "no-ui";

interface Question extends Omit<InputQuestion, "label"> {
  label: string;
}

interface Answer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
}

export interface AskUserDetails {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
  outcome: AskUserOutcome;
}

type RenderOption = InputOption & { isOther?: boolean };

function validateAndNormalizeQuestions(input: AskUserInput): Question[] {
  const { questions } = input;

  if (
    questions.length < MIN_QUESTIONS ||
    questions.length > MAX_QUESTIONS
  ) {
    throw new Error(
      `ask_user requires between ${MIN_QUESTIONS} and ${MAX_QUESTIONS} questions (got ${questions.length}).`,
    );
  }

  const seenIds = new Set<string>();

  return questions.map((question, index) => {
    const id = question.id.trim();
    if (!id) {
      throw new Error(`ask_user question ${index + 1} requires a non-empty id.`);
    }
    if (seenIds.has(id)) {
      throw new Error(`ask_user question ids must be unique (duplicate: ${id}).`);
    }
    seenIds.add(id);

    const prompt = question.prompt.trim();
    if (!prompt) {
      throw new Error(`ask_user question ${id} requires a non-empty prompt.`);
    }

    if (
      question.options.length < MIN_OPTIONS ||
      question.options.length > MAX_OPTIONS
    ) {
      throw new Error(
        `ask_user question ${id} requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options (got ${question.options.length}).`,
      );
    }

    const seenValues = new Set<string>();
    const options = question.options.map((option, optionIndex) => {
      const value = option.value.trim();
      const label = option.label.replace(/\s+/g, " ").trim();
      if (!value) {
        throw new Error(
          `ask_user option ${optionIndex + 1} for question ${id} requires a non-empty value.`,
        );
      }
      if (!label) {
        throw new Error(
          `ask_user option ${optionIndex + 1} for question ${id} requires a non-empty label.`,
        );
      }
      if (seenValues.has(value)) {
        throw new Error(
          `ask_user option values must be unique within question ${id} (duplicate: ${value}).`,
        );
      }
      seenValues.add(value);

      const description = option.description?.replace(/\s+/g, " ").trim();
      return {
        value,
        label,
        ...(description ? { description } : {}),
      };
    });

    return {
      id,
      label:
        question.label?.replace(/\s+/g, " ").trim() || `Q${index + 1}`,
      prompt,
      options,
    };
  });
}

function resultWithOutcome(
  questions: Question[],
  answers: Iterable<Answer>,
  outcome: AskUserOutcome,
): AskUserDetails {
  const answersById = new Map(
    Array.from(answers, (answer) => [answer.id, answer]),
  );

  return {
    questions,
    answers: questions.flatMap((question) => {
      const answer = answersById.get(question.id);
      return answer ? [answer] : [];
    }),
    cancelled: outcome !== "submitted",
    outcome,
  };
}

function optionsForQuestion(question: Question | undefined): RenderOption[] {
  if (!question) return [];
  return [
    ...question.options,
    {
      value: "__other__",
      label: "Write my own answer…",
      isOther: true,
    },
  ];
}

function selectedOptionIndex(
  question: Question | undefined,
  answer: Answer | undefined,
): number | undefined {
  if (!question || !answer) return undefined;

  const options = optionsForQuestion(question);
  if (answer.wasCustom) {
    const index = options.findIndex((option) => option.isOther === true);
    return index >= 0 ? index : undefined;
  }

  if (typeof answer.index === "number") {
    const index = answer.index - 1;
    const option = options[index];
    if (option && !option.isOther && option.value === answer.value) {
      return index;
    }
  }

  const index = options.findIndex(
    (option) => !option.isOther && option.value === answer.value,
  );
  return index >= 0 ? index : undefined;
}

export default function askUser(pi: ExtensionAPI) {
  pi.registerTool({
    ...ASK_USER_TOOL_EXPOSURE,
    name: "ask_user",
    label: "Ask User",
    description: ASK_USER_TOOL_DESCRIPTION,
    promptSnippet: ASK_USER_PROMPT_SNIPPET,
    promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
    parameters: AskUserParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const questions = validateAndNormalizeQuestions(params);

      if (ctx.mode !== "tui") {
        const details = resultWithOutcome(questions, [], "no-ui");
        return {
          content: [
            {
              type: "text" as const,
              text: buildAskUserResultMessage({ kind: "no-ui" }),
            },
          ],
          details,
        };
      }

      if (signal?.aborted) {
        const details = resultWithOutcome(questions, [], "aborted");
        return {
          content: [
            {
              type: "text" as const,
              text: buildAskUserResultMessage({ kind: "aborted" }),
            },
          ],
          details,
        };
      }

      const result = await ctx.ui.custom<AskUserDetails>(
        (tui, theme, keybindings, done) => {
          const answers = new Map<string, Answer>();
          const isMulti = questions.length > 1;
          const submitTab = questions.length;
          const totalTabs = questions.length + 1;

          let currentTab = 0;
          let optionIndex = 0;
          let inputMode = false;
          let inputQuestionId: string | null = null;
          let cachedLines: string[] | undefined;
          let cachedWidth: number | undefined;
          let settled = false;
          let componentFocused = false;

          const editorTheme: EditorTheme = {
            borderColor: (text) => theme.fg("accent", text),
            selectList: {
              selectedPrefix: (text) => theme.fg("accent", text),
              selectedText: (text) => theme.fg("accent", text),
              description: (text) => theme.fg("muted", text),
              scrollInfo: (text) => theme.fg("dim", text),
              noMatch: (text) => theme.fg("warning", text),
            },
          };
          const editor = new Editor(tui, editorTheme);

          function finish(outcome: AskUserOutcome) {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", abortFromSignal);
            done(resultWithOutcome(questions, answers.values(), outcome));
          }

          function abortFromSignal() {
            finish("aborted");
          }

          signal?.addEventListener("abort", abortFromSignal, { once: true });
          if (signal?.aborted) queueMicrotask(abortFromSignal);

          function refresh() {
            cachedLines = undefined;
            cachedWidth = undefined;
            tui.requestRender();
          }

          function currentQuestion(): Question | undefined {
            return questions[currentTab];
          }

          function currentOptions(): RenderOption[] {
            return optionsForQuestion(currentQuestion());
          }

          function allAnswered(): boolean {
            return questions.every((question) => answers.has(question.id));
          }

          function syncOptionIndex() {
            const question = currentQuestion();
            const options = currentOptions();
            if (!question || options.length === 0) {
              optionIndex = 0;
              return;
            }

            const savedIndex = selectedOptionIndex(
              question,
              answers.get(question.id),
            );
            optionIndex = Math.max(
              0,
              Math.min(options.length - 1, savedIndex ?? 0),
            );
          }

          function navigateTo(tab: number) {
            currentTab = (tab + totalTabs) % totalTabs;
            inputMode = false;
            inputQuestionId = null;
            editor.setText("");
            syncOptionIndex();
            refresh();
          }

          function advanceAfterAnswer() {
            if (!isMulti) {
              finish("submitted");
              return;
            }

            navigateTo(
              currentTab < questions.length - 1
                ? currentTab + 1
                : submitTab,
            );
          }

          function saveAnswer(
            questionId: string,
            value: string,
            label: string,
            wasCustom: boolean,
            index?: number,
          ) {
            answers.set(questionId, {
              id: questionId,
              value,
              label,
              wasCustom,
              index,
            });
          }

          function selectOption(index: number) {
            const question = currentQuestion();
            const option = currentOptions()[index];
            if (!question || !option) return;

            optionIndex = index;
            if (option.isOther) {
              const previous = answers.get(question.id);
              inputMode = true;
              inputQuestionId = question.id;
              editor.setText(previous?.wasCustom ? previous.label : "");
              editor.focused = componentFocused;
              refresh();
              return;
            }

            saveAnswer(
              question.id,
              option.value,
              option.label,
              false,
              index + 1,
            );
            advanceAfterAnswer();
          }

          editor.onSubmit = (value) => {
            if (!inputQuestionId) return;
            const trimmed = value.trim();
            if (!trimmed) {
              inputMode = false;
              inputQuestionId = null;
              editor.setText("");
              refresh();
              return;
            }

            saveAnswer(inputQuestionId, trimmed, trimmed, true);
            inputMode = false;
            inputQuestionId = null;
            editor.setText("");
            advanceAfterAnswer();
          };

          function handleInput(data: string) {
            if (inputMode) {
              if (keybindings.matches(data, "tui.select.cancel")) {
                inputMode = false;
                inputQuestionId = null;
                editor.setText("");
                refresh();
                return;
              }
              editor.handleInput(data);
              refresh();
              return;
            }

            if (
              isMulti &&
              (matchesKey(data, Key.tab) || matchesKey(data, Key.right))
            ) {
              navigateTo(currentTab + 1);
              return;
            }
            if (
              isMulti &&
              (matchesKey(data, Key.shift("tab")) ||
                matchesKey(data, Key.left))
            ) {
              navigateTo(currentTab - 1);
              return;
            }

            if (currentTab === submitTab) {
              if (
                keybindings.matches(data, "tui.select.confirm") &&
                allAnswered()
              ) {
                finish("submitted");
              } else if (keybindings.matches(data, "tui.select.cancel")) {
                finish("dismissed");
              }
              return;
            }

            const options = currentOptions();
            if (keybindings.matches(data, "tui.select.up")) {
              optionIndex =
                (optionIndex - 1 + options.length) % options.length;
              refresh();
              return;
            }
            if (keybindings.matches(data, "tui.select.down")) {
              optionIndex = (optionIndex + 1) % options.length;
              refresh();
              return;
            }

            if (/^[1-9]$/.test(data)) {
              const index = Number(data) - 1;
              if (index < options.length) {
                selectOption(index);
                return;
              }
            }

            if (keybindings.matches(data, "tui.select.confirm")) {
              selectOption(optionIndex);
              return;
            }

            if (keybindings.matches(data, "tui.select.cancel")) {
              finish("dismissed");
            }
          }

          function render(width: number): string[] {
            const renderWidth = Math.max(1, width);
            if (cachedLines && cachedWidth === renderWidth) {
              return cachedLines;
            }

            const lines: string[] = [];
            const question = currentQuestion();
            const options = currentOptions();

            function add(text: string) {
              lines.push(truncateToWidth(text, renderWidth, ""));
            }

            function addWrapped(text: string, prefix = "") {
              const prefixWidth = visibleWidth(prefix);
              if (prefixWidth >= renderWidth) {
                add(prefix + text);
                return;
              }

              const availableWidth = Math.max(1, renderWidth - prefixWidth);
              const wrapped = wrapTextWithAnsi(text, availableWidth);
              const continuationPrefix = " ".repeat(prefixWidth);
              if (wrapped.length === 0) {
                add(prefix);
                return;
              }

              for (let index = 0; index < wrapped.length; index++) {
                add(
                  `${index === 0 ? prefix : continuationPrefix}${wrapped[index]}`,
                );
              }
            }

            function renderTabStrip() {
              const questionTabs = questions.map((item, index) => {
                const answered = answers.has(item.id);
                const compactLabel = truncateToWidth(
                  item.label.replace(/\s+/g, " ").trim() || `Q${index + 1}`,
                  MAX_TAB_LABEL_WIDTH,
                  "…",
                );
                return {
                  answered,
                  label: `${index + 1}:${compactLabel}`,
                };
              });
              const tabEntries = [
                ...questionTabs,
                ...(isMulti
                  ? [{ answered: allAnswered(), label: "Submit" }]
                  : []),
              ].map((entry, index) => ({
                ...entry,
                active: index === currentTab,
                plain: ` ${entry.answered ? "■" : "□"} ${entry.label} `,
              }));

              const availableWidth = Math.max(1, renderWidth - 2);
              let start = 0;
              let end = tabEntries.length - 1;

              const windowWidth = () => {
                let result = start > 0 ? 2 : 0;
                result += end < tabEntries.length - 1 ? 2 : 0;
                for (let index = start; index <= end; index++) {
                  result += visibleWidth(tabEntries[index].plain);
                  if (index > start) result += 1;
                }
                return result;
              };

              while (start < end && windowWidth() > availableWidth) {
                const distanceLeft = currentTab - start;
                const distanceRight = end - currentTab;
                if (distanceLeft > distanceRight) {
                  start++;
                } else {
                  end--;
                }
              }

              const rendered: string[] = [];
              if (start > 0) rendered.push(theme.fg("dim", "‹"));

              for (let index = start; index <= end; index++) {
                const entry = tabEntries[index];
                const styled = entry.active
                  ? theme.bg("selectedBg", theme.fg("text", entry.plain))
                  : theme.fg(entry.answered ? "success" : "muted", entry.plain);
                rendered.push(styled);
              }

              if (end < tabEntries.length - 1) {
                rendered.push(theme.fg("dim", "›"));
              }

              add(` ${rendered.join(" ")}`);
            }

            function renderOptions() {
              const answer = question
                ? answers.get(question.id)
                : undefined;
              const answeredIndex = selectedOptionIndex(question, answer);

              for (let index = 0; index < options.length; index++) {
                const option = options[index];
                const selected = index === optionIndex;
                const answered = index === answeredIndex;
                const customAnswer =
                  option.isOther && answered && answer?.wasCustom
                    ? ` (${answer.label.replace(/\s+/g, " ").trim()})`
                    : "";
                const label = `${index + 1}. ${option.label}${customAnswer}`;
                const cursor = selected
                  ? theme.fg("accent", "❯ ")
                  : "  ";
                const marker = answered
                  ? theme.fg("success", "✓ ")
                  : "  ";
                const color = selected
                  ? "accent"
                  : answered
                    ? "success"
                    : option.isOther
                      ? "muted"
                      : "text";

                addWrapped(theme.fg(color, label), `${cursor}${marker}`);
                if (option.description) {
                  addWrapped(theme.fg("muted", option.description), "      ");
                }
              }
            }

            add(theme.fg("accent", "─".repeat(renderWidth)));
            addWrapped(
              theme.fg(
                "dim",
                `${answers.size}/${questions.length} answered`,
              ),
              " ",
            );
            renderTabStrip();
            lines.push("");

            if (inputMode && question) {
              addWrapped(theme.fg("text", theme.bold(question.prompt)), " ");
              lines.push("");
              renderOptions();
              lines.push("");
              addWrapped(theme.fg("muted", "Your answer:"), " ");
              for (const line of editor.render(Math.max(1, renderWidth - 2))) {
                add(` ${line}`);
              }
              lines.push("");
              addWrapped(
                theme.fg("dim", "Enter submit • Esc return to options"),
                " ",
              );
            } else if (currentTab === submitTab) {
              addWrapped(
                theme.fg("accent", theme.bold("Review answers")),
                " ",
              );
              lines.push("");

              for (const item of questions) {
                const answer = answers.get(item.id);
                if (!answer) continue;
                const prefix = answer.wasCustom ? "(wrote) " : "";
                addWrapped(
                  `${theme.fg("muted", `${item.label}: `)}${theme.fg(
                    "text",
                    prefix + answer.label,
                  )}`,
                  " ",
                );
              }

              lines.push("");
              if (allAnswered()) {
                addWrapped(
                  theme.fg("success", "Press Enter to submit"),
                  " ",
                );
              } else {
                const missing = questions
                  .filter((item) => !answers.has(item.id))
                  .map((item) => item.label)
                  .join(", ");
                addWrapped(
                  theme.fg("warning", `Unanswered: ${missing}`),
                  " ",
                );
              }
            } else if (question) {
              addWrapped(theme.fg("text", theme.bold(question.prompt)), " ");
              lines.push("");
              renderOptions();
            }

            lines.push("");
            if (!inputMode) {
              const help = isMulti
                ? "Tab/←→ questions • ↑↓ options • number/Enter choose • Esc dismiss"
                : "↑↓ options • number/Enter choose • Esc dismiss";
              addWrapped(theme.fg("dim", help), " ");
            }
            add(theme.fg("accent", "─".repeat(renderWidth)));

            cachedWidth = renderWidth;
            cachedLines = lines;
            return lines;
          }

          return {
            get focused() {
              return componentFocused;
            },
            set focused(value: boolean) {
              componentFocused = value;
              editor.focused = value;
            },
            render,
            invalidate() {
              cachedLines = undefined;
              cachedWidth = undefined;
              editor.invalidate();
            },
            handleInput,
            dispose() {
              signal?.removeEventListener("abort", abortFromSignal);
            },
          };
        },
      );

      if (result.outcome !== "submitted") {
        return {
          content: [
            {
              type: "text" as const,
              text: buildAskUserResultMessage({ kind: result.outcome }),
            },
          ],
          details: result,
        };
      }

      const answersById = new Map(
        result.answers.map((answer) => [answer.id, answer]),
      );
      const answerLines = questions.map((question) => {
        const answer = answersById.get(question.id);
        if (!answer) return `${question.label}: unanswered`;
        if (answer.wasCustom) {
          return `${question.label}: user wrote: ${answer.label}`;
        }
        return `${question.label}: user selected option ${answer.index}: ${answer.label} (value: ${answer.value})`;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: buildAskUserResultMessage({
              kind: "submitted",
              answers: answerLines,
            }),
          },
        ],
        details: result,
      };
    },

    renderCall(args, theme, _context) {
      const count = Array.isArray(args.questions) ? args.questions.length : 0;
      const text =
        theme.fg("toolTitle", theme.bold("ask_user ")) +
        theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as AskUserDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }

      if (details.outcome === "aborted") {
        return new Text(theme.fg("warning", "✗ cancelled"), 0, 0);
      }
      if (details.outcome === "no-ui") {
        return new Text(theme.fg("warning", "✗ UI unavailable"), 0, 0);
      }
      if (details.outcome === "dismissed") {
        return new Text(theme.fg("warning", "✗ dismissed"), 0, 0);
      }

      const questionsById = new Map(
        details.questions.map((question) => [question.id, question]),
      );
      const lines = details.answers.map((answer) => {
        const question = questionsById.get(answer.id);
        const label = question?.label || answer.id;
        const prompt = question?.prompt.replace(/\s+/g, " ").trim();
        const questionLine = `${theme.fg("success", "✓ ")}${theme.fg(
          "accent",
          label,
        )}${prompt ? `: ${theme.fg("text", prompt)}` : ""}`;

        const display = answer.wasCustom
          ? `${theme.fg("muted", "(wrote) ")}${answer.label}`
          : answer.index
            ? `${answer.index}. ${answer.label}`
            : answer.label;
        return `${questionLine}\n  ${theme.fg("muted", "Answer: ")}${display}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
