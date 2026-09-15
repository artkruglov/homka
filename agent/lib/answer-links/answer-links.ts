/**
 * Ссылка в ответе должна откуда-то взяться.
 *
 * Экспорт:
 * - `extractLinks`: адреса, названные в тексте.
 * - `createAnswerLinkAudit`: учёт по ходу и вывод о ссылках, которые взяться было неоткуда.
 *
 * Критерий поиска требует, чтобы бот не выдумывал подтверждений и ссылок. Проверить это целиком
 * нельзя: провайдер выполняет `web_search` у себя, и его источники приложению не видны. Поэтому
 * проверяется однозначный случай — ход **не искал и не открывал ничего**, а в ответе стоит адрес,
 * которого не было ни в сообщении человека, ни в его вложениях. Такую ссылку модель сочинила.
 *
 * Ответ при этом не правится: вырезать адрес значило бы менять сказанное человеку задним числом,
 * а ссылка могла прийти из памяти, куда её сохранил он сам. Случай считается и называется.
 */
const LINK_PATTERN = /https?:\/\/[^\s<>()"'`]+/giu;

/** Хост без пути: в журнал не должен попадать адрес, который человек считает своим. */
export function linkHost(link: string): string {
  try {
    return new URL(link).host.toLowerCase();
  } catch {
    return "";
  }
}

export function extractLinks(text: string): string[] {
  const found = text.match(LINK_PATTERN) ?? [];
  return [...new Set(found.map((link) => link.replace(/[.,;:!?)»]+$/u, "")))];
}

interface TurnLinkState {
  given: Set<string>;
  searched: boolean;
}

export interface AnswerLinkVerdict {
  /** Хосты ссылок, которые ход не искал, не открывал и не получал от человека. */
  readonly unsourcedHosts: readonly string[];
}

const MAX_TRACKED_TURNS = 200;

export function createAnswerLinkAudit() {
  const turns = new Map<string, TurnLinkState>();
  const state = (key: string): TurnLinkState => {
    const existing = turns.get(key);
    if (existing) return existing;
    // Ход живёт минуты, а процесс — дни: без потолка карта росла бы вместе с аптаймом.
    if (turns.size >= MAX_TRACKED_TURNS) turns.delete(turns.keys().next().value!);
    const created: TurnLinkState = { given: new Set(), searched: false };
    turns.set(key, created);
    return created;
  };
  return {
    /** Адреса из сообщения человека: то, что он принёс сам, сочинять не нужно было. */
    received(key: string, text: string): void {
      const turn = state(key);
      for (const link of extractLinks(text)) turn.given.add(link);
    },
    /** Ход искал или открывал страницу: его источники приложению не видны, и судить не о чем. */
    searched(key: string): void {
      state(key).searched = true;
    },
    /** Открытая страница известна точно и считается источником. */
    fetched(key: string, link: string): void {
      const turn = state(key);
      turn.searched = true;
      turn.given.add(link);
    },
    completed(key: string, answer: string): AnswerLinkVerdict {
      // Хода нет в карте, когда он ничего не получал и ничего не звал — например, запуск по
      // расписанию. Судить о нём можно так же: источников у него тоже не было.
      const turn = turns.get(key) ?? { given: new Set<string>(), searched: false };
      turns.delete(key);
      if (turn.searched) return { unsourcedHosts: [] };
      const unsourced = extractLinks(answer).filter((link) => !turn.given.has(link));
      return { unsourcedHosts: [...new Set(unsourced.map(linkHost).filter(Boolean))] };
    },
  };
}
