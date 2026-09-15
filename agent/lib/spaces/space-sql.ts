/**
 * Общая SQL-оговорка «строку можно читать в этом чате».
 *
 * Экспорт:
 * - `SpaceReadClauseParameters`: имена позиционных параметров вызывающего запроса.
 * - `spaceReadClause`: фрагмент условия для любой таблицы с колонкой `space_id`.
 *
 * Групповой чат читает ровно привязанную к нему область: его аудитория шире одного человека, и
 * показать там соседнюю область значит раскрыть её всем присутствующим.
 *
 * Личный чат читает **все свои** области. Его аудитория — один человек, и он состоит в каждой из
 * них: личное, «Мы вдвоём», работа — это разделение, которое он держит в собственной голове, а не
 * стена внутри неё. Чужое личное и чужая работа сюда не попадают: членства в них нет. Записи это
 * не касается — она идёт ровно в ту область, которую ход доказал.
 *
 * Позиции задаёт вызывающий, потому что запросы разной формы занимают разные номера: предикат
 * памяти исторически держит семью, человека и группу в `$1`, `$3` и `$4`, а непамятные репозитории
 * такой нумерации не имеют и иначе не смогли бы пользоваться той же проверкой.
 *
 * Имена параметров это авторский SQL, а не значения от модели или человека, и всё равно
 * проверяются: подставить сюда произвольный текст нельзя.
 */

export interface SpaceReadClauseParameters {
  /** Область, доказанная ходом. NULL отключает оговорку: так работает прежний режим. */
  readonly spaceId: string;
  /** Версия политики области на момент доказательства. */
  readonly version: string;
  readonly family: string;
  readonly user: string;
  /** Группа текущего чата; NULL означает личный чат. */
  readonly group: string;
}

function positional(value: string): string {
  if (!/^\$\d{1,3}$/u.test(value)) {
    throw new Error("AGENT_SPACE_SQL_PARAMETER_INVALID: ожидается позиционный параметр вида $1");
  }
  return value;
}

export function spaceReadClause(input: {
  alias: string;
  parameters: SpaceReadClauseParameters;
  /**
   * Изменение адресует ровно ту область, которую ход доказал: читать своё из соседней области
   * можно, а править её из чата, который её не подтверждал, — нет. Для этого есть переключатель.
   */
  pinned?: boolean;
}): string {
  if (!/^[a-z_][a-z_0-9]*$/u.test(input.alias)) {
    throw new Error("AGENT_SPACE_SQL_ALIAS_INVALID: недопустимый псевдоним таблицы");
  }
  const record = input.alias;
  const space = positional(input.parameters.spaceId);
  const version = positional(input.parameters.version);
  const family = positional(input.parameters.family);
  const user = positional(input.parameters.user);
  const group = positional(input.parameters.group);

  // Групповой чат читает только привязанную область: его аудитория шире одного человека.
  const boundToThisChat = `((${group}::uuid IS NULL AND live_space.kind <> 'group') OR EXISTS (
    SELECT 1 FROM space_bindings live_binding
     WHERE live_binding.family_id=${family} AND live_binding.space_id=live_space.id
       AND live_binding.group_id=${group} AND live_binding.state='active'
  ))`;

  // Внешняя группа не имеет членства в смысле семьи: её аудиторию доказывает только привязка.
  const readerBelongs = `(live_space.kind='group' OR EXISTS (
    SELECT 1 FROM space_memberships live_space_member
     WHERE live_space_member.family_id=${family} AND live_space_member.space_id=live_space.id
       AND live_space_member.user_id=${user} AND live_space_member.state='active'
  ))`;

  // Доказанная область проверяется на свежесть: если её политика изменилась, ход устарел целиком.
  // Остальные свои области человека это не касается — их аудиторию подтверждает живое членство.
  //
  // Групповой чат читает только доказанную область и в режиме объединения: его аудитория шире
  // одного человека, поэтому «своё» там ничего не значит.
  const pinned = input.pinned === true
    ? `${record}.space_id = ${space}::uuid AND `
    : `(${group}::uuid IS NULL OR ${record}.space_id = ${space}::uuid) AND `;
  return `(${space}::uuid IS NULL OR (${pinned}EXISTS (
    SELECT 1 FROM spaces live_space
     WHERE live_space.id=${record}.space_id AND live_space.family_id=${family}
       AND live_space.state='active'
       AND (live_space.id <> ${space}::uuid OR live_space.policy_version=${version}::integer)
       AND ${boundToThisChat}
       AND ${readerBelongs}
  )))`;
}
