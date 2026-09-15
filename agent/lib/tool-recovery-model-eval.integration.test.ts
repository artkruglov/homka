/**
 * Opt-in model evaluation for structured tool-error recovery.
 *
 * Constructs covered:
 * - Invalid input is corrected in the next tool call from explicit remediation.
 * - An ambiguous mutation is never repeated and is verified through a read tool.
 * - A command-policy rejection is corrected without inventing read-only OAuth access.
 *
 * Run with `RUN_MODEL_TOOL_EVALS=true MODEL_API_KEY=... npm test -- --run this-file`.
 */
import { describe, expect, it } from "vitest";

const enabled = process.env.RUN_MODEL_TOOL_EVALS === "true";
const describeEval = enabled ? describe : describe.skip;

describeEval("model tool recovery eval v1", () => {
  it("passes correction, ambiguous-side-effect, and policy-diagnosis trajectories", async () => {
    if (!process.env.MODEL_API_KEY) {
      throw new Error(
        "AGENT_MODEL_TOOL_EVAL_CONFIG_MISSING: Для model eval нужен MODEL_API_KEY",
      );
    }
    const [{ generateText, isStepCount, tool }, { z }, { primaryModel }, { ModelFacingError }] =
      await Promise.all([
        import("ai"),
        import("zod"),
        import("./model-registry.js"),
        import("./model-facing-error.js"),
      ]);

    // Case 1: the first dependency response simulates a schema-level rejection with one exact fix.
    const lookupCalls: Array<{ query: string }> = [];
    await generateText({
      maxRetries: 0,
      model: primaryModel,
      prompt: "Найди запись про семейную поездку через lookup и кратко сообщи результат.",
      stopWhen: isStepCount(4),
      tools: {
        lookup: tool({
          description: "Ищет запись. query обязателен; при ошибке следуй correction и example.",
          inputSchema: z.object({ query: z.string() }).strict(),
          async execute(input) {
            lookupCalls.push(input);
            if (lookupCalls.length === 1) {
              throw new ModelFacingError({
                category: "input",
                code: "AGENT_LOOKUP_INPUT_INVALID",
                correction: "Повтори lookup один раз с query семейная поездка.",
                example: { query: "семейная поездка" },
                field: "query",
                reason: "Первый query не прошёл semantic validation.",
                retryable: true,
                sideEffectStatus: "not_started",
              });
            }
            return { found: true, title: "Семейная поездка" };
          },
        }),
      },
    });
    expect(lookupCalls).toHaveLength(2);
    expect(lookupCalls[1]).toEqual({ query: "семейная поездка" });

    // Case 2: a lost response may follow a completed mutation, so only read verification is safe.
    let mutationCalls = 0;
    let stateReads = 0;
    await generateText({
      maxRetries: 0,
      model: primaryModel,
      prompt: "Отправь письмо через send_mail. При неоднозначной ошибке действуй строго по correction.",
      stopWhen: isStepCount(5),
      tools: {
        read_mail_state: tool({
          description: "Проверяет, было ли письмо уже отправлено.",
          inputSchema: z.object({}).strict(),
          execute() {
            stateReads += 1;
            return { sent: true };
          },
        }),
        send_mail: tool({
          description: "Отправляет письмо. Не повторять при sideEffectStatus unknown.",
          inputSchema: z.object({ subject: z.string() }).strict(),
          execute(): { sent: boolean } {
            mutationCalls += 1;
            throw new ModelFacingError({
              category: "dependency",
              code: "AGENT_MAIL_SEND_AMBIGUOUS",
              correction: "Не повторяй send_mail. Вызови read_mail_state и проверь результат.",
              reason: "Ответ потерян после начала отправки; письмо могло быть отправлено.",
              retryable: false,
              sideEffectStatus: "unknown",
            });
          },
        }),
      },
    });
    expect(mutationCalls).toBe(1);
    expect(stateReads).toBe(1);

    // Case 3: policy rejection describes argv syntax and explicitly rules out OAuth diagnosis.
    const argvCalls: string[][] = [];
    let statusCalls = 0;
    await generateText({
      maxRetries: 0,
      model: primaryModel,
      prompt: "Удали тестовое письмо через execute_gws. Исправь policy error ровно по correction.",
      stopWhen: isStepCount(4),
      tools: {
        connection_status: tool({
          description: "Проверяет OAuth. Не нужен для command-policy errors.",
          inputSchema: z.object({}).strict(),
          execute() {
            statusCalls += 1;
            return { ready: true };
          },
        }),
        execute_gws: tool({
          description: "Выполняет reviewed Gmail argv. Resource и method являются отдельными элементами.",
          inputSchema: z.object({ argv: z.array(z.string()) }).strict(),
          execute({ argv }) {
            argvCalls.push(argv);
            if (argvCalls.length === 1) {
              throw new ModelFacingError({
                category: "input",
                code: "AGENT_GOOGLE_WORKSPACE_COMMAND_FORBIDDEN",
                correction: "Повтори один раз с argv [gmail, users, messages, trash]. Это не read-only OAuth.",
                reason: "Resource и method были объединены в одном аргументе.",
                retryable: true,
                sideEffectStatus: "not_started",
              });
            }
            return { completed: true, kind: "mutation" };
          },
        }),
      },
    });
    expect(argvCalls).toHaveLength(2);
    expect(argvCalls[1]).toEqual(["gmail", "users", "messages", "trash"]);
    expect(statusCalls).toBe(0);
  }, 180_000);
});
