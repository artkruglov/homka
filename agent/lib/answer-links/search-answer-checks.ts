/**
 * Машинные проверки ответа с поиском.
 *
 * Экспорт:
 * - `SearchAnswerRule`: что именно требуется от ответа на этот вопрос.
 * - `checkSearchAnswer`: какие требования ответ не выполнил.
 *
 * Восемь сценариев реестра проверяют не «понравился ли ответ», а вещи, которые видно машиной:
 * названа ли ссылка, признан ли недоступный сайт недоступным, назван ли срок у старой афиши,
 * названы ли оба источника при их расхождении. Смысл ответа по-прежнему судит человек — эти
 * правила ловят то, что человек обычно не замечает: уверенный тон без единого источника.
 *
 * Проверки нарочно грубые. Ложное «сошлось» здесь дороже ложного «не сошлось»: набор нужен, чтобы
 * заметить ухудшение, а не чтобы поставить оценку.
 */
import { extractLinks, linkHost } from "./answer-links.js";

export type SearchAnswerRule =
  /** В ответе должен стоять хотя бы один адрес. */
  | "names_link"
  /** Недоступный источник назван недоступным, а не пересказан. */
  | "admits_unavailable"
  /** У сведений, которые стареют, назван их срок или оговорка о свежести. */
  | "dates_the_answer"
  /** При расхождении источников названы оба, а не выбран один молча. */
  | "names_two_sources";

const UNAVAILABLE = /(не (?:удалось|смогла|получилось)|недоступ|не откры|не отвеча|ошибк)/iu;
const DATED = /(\b20\d{2}\b|\d{1,2}\s+(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)|сегодня|вчера|на этой неделе|устарел|может быть неактуал|проверьте на сайте)/iu;
const DISAGREEMENT = /(расход|противореч|по одним|по другим|разн[ыо]|источники не сход)/iu;

export interface SearchAnswerReport {
  readonly failed: readonly SearchAnswerRule[];
  readonly hosts: readonly string[];
}

export function checkSearchAnswer(
  answer: string,
  rules: readonly SearchAnswerRule[],
): SearchAnswerReport {
  const links = extractLinks(answer);
  const hosts = [...new Set(links.map(linkHost).filter(Boolean))];
  const failed = rules.filter((rule) => {
    if (rule === "names_link") return links.length === 0;
    if (rule === "admits_unavailable") return !UNAVAILABLE.test(answer);
    if (rule === "dates_the_answer") return !DATED.test(answer);
    return hosts.length < 2 && !DISAGREEMENT.test(answer);
  });
  return { failed, hosts };
}
