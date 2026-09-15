/**
 * Области заботы: кто ведёт целое направление, а не отдельное поручение.
 */
import { defineTool } from "eve/tools";

import { careAreaInput, careAreaRepository } from "../care-areas/care-area-repository.js";
import { requireMemoryAuthorization } from "../memory-context.js";

export default defineTool({
  description: [
    "Области заботы: «машина», «садик», «здоровье родителей» — то, что человек ведёт целиком.",
    "list возвращает области области разговора с хозяином, ожидающим согласия и version.",
    "create: title и необязательный details; новая область ничья, пока кто-то её не возьмёт.",
    "propose: id, version, ownerRef из participants инструмента дел — это предложение, а не назначение.",
    "accept и decline доступны тому, кому предложили; decline может и предложивший. release это отказ",
    "хозяина вести дальше: область снова становится ничьей, и это видно. retire убирает область.",
    "Область не отчёт и не рейтинг: кто сколько сделал, я не считаю.",
  ].join(" "),
  inputSchema: careAreaInput,
  async execute(input, ctx) {
    return careAreaRepository.execute(requireMemoryAuthorization(ctx), input);
  },
});
