/**
 * Секрет не должен попадать в журнал.
 *
 * Экспорт:
 * - `redactSecrets`: текст с вырезанными секретами.
 * - `installSecretRedaction`: подмена console на время жизни процесса.
 *
 * Журналы это сырой `console.error(JSON.stringify(...))` из четырёхсот мест; проверять каждое
 * значит однажды пропустить одно. Поэтому вырезание стоит на самом выходе и работает по двум
 * правилам сразу.
 *
 * Первое — точные значения из окружения: токен бота, ключ модели, пароль базы, подписывающий
 * секрет. У них нет ложных срабатываний, и они ловят случайную интерполяцию в любом сообщении,
 * включая чужое, из библиотеки.
 *
 * Второе — формы известных секретов: токен Telegram, ключ вида `sk-…`, пароль внутри URL
 * подключения. Оно ловит значение, которого в окружении этого процесса нет: пришедшее из базы,
 * из ответа провайдера или из чужого конфига.
 *
 * Короткие значения пропускаются: секрет из четырёх символов не бывает, а вырезание такого
 * сделало бы журнал нечитаемым.
 */
const MIN_SECRET_LENGTH = 12;

/** Переменные, значение которых в журнале всегда ошибка. */
const SECRET_ENVIRONMENT_KEYS = [
  "CLI_PROXY_API_KEY",
  "CLOUDFLARE_AI_TOKEN",
  "GIGAAM_API_KEY",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GROQ_API_KEY",
  "INTEGRATION_TOKEN_ENCRYPTION_KEY",
  "INVITATION_SIGNING_SECRET",
  "MODEL_API_KEY",
  "NEURALDEEP_IMAGE_API_KEY",
  "OPENROUTER_IMAGE_API_KEY",
  "OPENROUTER_VIDEO_API_KEY",
  "POSTGRES_PASSWORD",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET_TOKEN",
] as const;

const SHAPES: readonly RegExp[] = [
  // Токен Telegram: числовой id бота, двоеточие и 35 символов.
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}/gu,
  // Ключи провайдеров и GitHub.
  /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/gu,
  // Пароль внутри строки подключения.
  /(?<=:\/\/[^\s:@/]{1,64}:)[^\s@/]{4,}(?=@)/gu,
];

export const REDACTED = "[redacted]";

function environmentSecrets(environment: NodeJS.ProcessEnv): string[] {
  return SECRET_ENVIRONMENT_KEYS
    .map((key) => environment[key])
    .filter((value): value is string => typeof value === "string" && value.length >= MIN_SECRET_LENGTH)
    // Длинные значения вырезаются первыми: иначе короткое совпадение разрежет длинное пополам.
    .sort((left, right) => right.length - left.length);
}

export function redactSecrets(text: string, environment = process.env): string {
  let safe = text;
  for (const secret of environmentSecrets(environment)) safe = safe.split(secret).join(REDACTED);
  for (const shape of SHAPES) safe = safe.replace(shape, REDACTED);
  return safe;
}

/**
 * Подменяет вывод на время жизни процесса. Возвращает функцию отмены — она нужна тестам, а в
 * production отменять нечего: процесс живёт до перезапуска.
 */
export function installSecretRedaction(target: Console = console): () => void {
  const methods = ["debug", "error", "info", "log", "warn"] as const;
  const original = methods.map((name) => [name, target[name]] as const);
  for (const [name, write] of original) {
    target[name] = (...args: unknown[]) => {
      write(...args.map((value) => typeof value === "string" ? redactSecrets(value) : value));
    };
  }
  return () => {
    for (const [name, write] of original) target[name] = write;
  };
}
