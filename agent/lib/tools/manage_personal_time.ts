/**
 * Личное время: окна, которые принадлежат человеку.
 *
 * Инструмент выдаётся только в личном чате: в общем чате окно стало бы объявлением, а отказаться
 * от своего вечера при всех труднее, чем поставить окно молча.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireMemoryAuthorization } from "../memory-context.js";
import { personalTimeRepository } from "../personal-time/personal-time-repository.js";
import { AppError } from "../app-error.js";

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export const personalTimeInput = z.object({
  action: z.enum(["list", "add", "remove"]),
  endsAt: z.string().optional(),
  id: z.uuid().optional(),
  startsAt: z.string().optional(),
  title: z.string().trim().min(1).max(100).optional(),
  /** 0 — воскресенье, 1 — понедельник и так далее; без поля окно действует каждый день. */
  weekday: z.number().int().min(0).max(6).optional(),
}).strict();

export default defineTool({
  description: [
    "Личное время человека: окна, в которые я не пишу первым и на которые нельзя поставить чужое дело.",
    "list возвращает окна с их id. add: title, startsAt и endsAt в формате ЧЧ:ММ местного времени,",
    "weekday 0-6 (0 воскресенье) для одного дня недели или без него для каждого дня; окно внутри",
    "суток, «с вечера до утра» это два окна. remove: id из list.",
    "Своё дело человек ставит на своё время сам: окно защищает от чужих планов, а не от его собственных.",
  ].join(" "),
  inputSchema: personalTimeInput,
  async execute(input, ctx) {
    const parsed = personalTimeInput.parse(input);
    const auth = requireMemoryAuthorization(ctx);
    if (parsed.action === "list") return { windows: await personalTimeRepository.list(auth) };
    if (parsed.action === "remove") {
      if (!parsed.id) {
        throw new AppError("AGENT_PERSONAL_TIME_INPUT_INVALID", "Для remove нужен id окна из list");
      }
      return { removed: await personalTimeRepository.remove(auth, parsed.id) };
    }
    if (!parsed.title || !parsed.startsAt || !parsed.endsAt ||
      !TIME.test(parsed.startsAt) || !TIME.test(parsed.endsAt) || parsed.startsAt >= parsed.endsAt) {
      throw new AppError(
        "AGENT_PERSONAL_TIME_INPUT_INVALID",
        "Для add нужны title, startsAt и endsAt в формате ЧЧ:ММ, начало раньше конца",
      );
    }
    return {
      window: await personalTimeRepository.add(auth, {
        endsAt: parsed.endsAt,
        startsAt: parsed.startsAt,
        title: parsed.title,
        weekday: parsed.weekday ?? null,
      }),
    };
  },
});
