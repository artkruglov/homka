# Как запустить свою Хомку: пошаговая инструкция

Хомка живёт на вашем сервере и разговаривает с семьёй через Telegram. Ниже путь от пустой
виртуальной машины до бота, который отвечает в личке и в семейной группе. На всё уходит около
часа, из них 20–30 минут — первая сборка образов.

## 0. Что понадобится

| Что | Зачем | Сколько стоит |
| --- | --- | --- |
| Сервер Linux x86_64 с Docker и Docker Compose v2: 2 vCPU, 8 ГБ памяти, от 50 ГБ диска | Бот, база, песочница для файлов и браузера | От ~1 000 ₽ в месяц у любого облака |
| Домен или бесплатный адрес вида `1-2-3-4.sslip.io` | Telegram отправляет сообщения только на HTTPS | Бесплатно |
| Аккаунт Telegram | Создать бота и стать его владельцем | Бесплатно |
| Ключ [DeepSeek](https://platform.deepseek.com) | Основная модель: разговор, поиск в интернете, разбор фото | Оплата по факту; семья тратит порядка $3–10 в месяц, стартово положите $5 |
| Ключ [Groq](https://console.groq.com/keys) (по желанию) | Расшифровка голосовых | Бесплатного лимита обычно хватает |
| Ключ [OpenRouter](https://openrouter.ai/keys) (по желанию) | Картинки и видео | Оплата по факту; видео ограничено $30 на человека в месяц |

## 1. Создайте бота в Telegram

1. Откройте [@BotFather](https://t.me/BotFather) и отправьте `/newbot`.
2. Придумайте имя (его видят люди, например «Хомка») и username, оканчивающийся на `bot`.
3. Сохраните **токен** вида `123456789:AA…` и **username без @**.
4. Там же выполните:
   - `/setprivacy` → выберите бота → **Disable**. Иначе в группах бот увидит только команды и
     прямые обращения через @, а не «Хомка, напомни…» и не историю разговора.
   - `/setjoingroups` → **Enable**, чтобы бота можно было добавить в группу.

## 2. Получите ключи моделей

**DeepSeek (обязательно).** На [platform.deepseek.com](https://platform.deepseek.com) создайте
API key и пополните баланс. Когда баланс опускается ниже $2, Хомка сама предупредит владельца;
при нуле модель отвечает ошибкой и бот замолкает, пока счёт не пополнят.

**Голос (по желанию).** Ключ [Groq](https://console.groq.com/keys). Если голос не нужен, откройте
`config/agent-model-providers.json` и замените блок `"voice"` на `"voice": { "enabled": false }`.
Без ключа и с включённым голосом бот не запустится (`AGENT_GROQ_API_KEY_REQUIRED`).

**Картинки и видео (по желанию).** Ключ [OpenRouter](https://openrouter.ai/keys).
- Картинки: выберите модель в [каталоге image-моделей](https://openrouter.ai/models?output_modalities=image),
  которая принимает `aspect_ratio`, и запишите её точный идентификатор.
- Видео: тот же ключ включает `generate_video` (Seedance 2.5 и другие); у каждого человека
  лимит $30 в календарный месяц на все его чаты.

## 3. Подготовьте сервер

```bash
# Docker и Compose v2, если их ещё нет (Ubuntu/Debian)
curl -fsSL https://get.docker.com | sh

git clone https://github.com/artkruglov/homka.git
cd homka
cp .env.example .env
```

Сгенерируйте секреты:

```bash
openssl rand -hex 24   # POSTGRES_PASSWORD
openssl rand -hex 24   # пароль для WORKFLOW_POSTGRES_URL
openssl rand -hex 32   # INVITATION_SIGNING_SECRET
openssl rand -hex 32   # TELEGRAM_WEBHOOK_SECRET_TOKEN
```

Откройте `.env` и заполните:

```dotenv
POSTGRES_PASSWORD=<первый секрет>
WORKFLOW_POSTGRES_URL=postgresql://osinara_workflow:<второй секрет>@postgres:5432/osinara_workflow
INVITATION_SIGNING_SECRET=<третий секрет>
TELEGRAM_BOT_TOKEN=<токен от BotFather>
TELEGRAM_BOT_USERNAME=<username без @>
TELEGRAM_WEBHOOK_SECRET_TOKEN=<четвёртый секрет>
MODEL_API_KEY=<ключ DeepSeek>
GROQ_API_KEY=<ключ Groq или пусто, если голос выключен>

# По желанию
OPENROUTER_IMAGE_API_KEY=<ключ OpenRouter>
OPENROUTER_IMAGE_MODEL=<идентификатор image-модели>
OPENROUTER_VIDEO_API_KEY=<ключ OpenRouter>
```

`DATABASE_URL` для `compose.yaml` оставьте пустым: адрес базы собирается из `POSTGRES_PASSWORD`.
Имя бота меняется строкой `TELEGRAM_AGENT_NAME` (по умолчанию Хомка).

## 4. Запустите

```bash
docker compose up -d --build
docker compose ps                       # agent, sandbox-runner и memory-embedding должны стать healthy
curl -s http://localhost:8080/eve/v1/health   # {"ok":true,"status":"ready"}
```

Первая сборка качает браузер для песочницы и модель эмбеддингов, это 20–30 минут. Логи:
`docker compose logs -f agent`.

## 5. Включите HTTPS

Нужен адрес, который указывает на сервер. Свой домен — A-запись на IP сервера. Без домена
подойдёт `1-2-3-4.sslip.io`, где 1-2-3-4 — IP сервера через дефисы. Откройте порты 80 и 443 и
поставьте [Caddy](https://caddyserver.com/docs/install), он сам получит сертификат:

```bash
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
homka.example.com {
  reverse_proxy localhost:8080
}
EOF
sudo systemctl reload caddy
curl -s https://homka.example.com/eve/v1/health
```

Наружу проксируются только маршрут Telegram, проверка здоровья и callback Google; базу и
агента напрямую не публикуйте.

## 6. Подключите Telegram к серверу

```bash
source .env
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'content-type: application/json' \
  -d "{\"url\":\"https://homka.example.com/eve/v1/telegram\",\"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET_TOKEN}\",\"allowed_updates\":[\"message\",\"callback_query\"]}"
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

`callback_query` нужен для кнопок подтверждения. В `getWebhookInfo` не должно быть
`last_error_message`.

## 7. Станьте владельцем

```bash
docker compose run --rm --no-deps --entrypoint node agent .runtime/scripts/create-bootstrap-code.js
```

Команда выдаст код на 15 минут. Откройте `https://t.me/<username бота>?start=<код>` и нажмите
«Старт». Бот ответит, что владелец создан. Код одноразовый; после появления владельца новый
не выдаётся.

## 8. Позовите семью

1. В личке с ботом напишите: «создай приглашение в семью» и нажмите «Да, подтвердить». Хомка
   пришлёт одноразовую ссылку на 24 часа — перешлите её.
2. Приглашённый открывает ссылку и нажимает «Старт». Бот отвечает, что заявка отправлена владельцу.
   Отдельного уведомления владельцу не приходит.
3. В личке с ботом напишите: «покажи ожидающие приглашения», затем «подтверди заявку» и нажмите
   «Да, подтвердить». После этого у нового участника своя личная память и доступ к семейному.

## 9. Подключите группы

1. Добавьте бота в группу и напишите там: `@<username бота> привет`.
2. Бот промолчит, потому что группа ещё не подключена, но оставит её id в логе:
   ```bash
   docker compose logs agent | grep AGENT_TELEGRAM_GROUP_UNREGISTERED
   # {"chatId":"-1001234567890","chatType":"supergroup","code":"AGENT_TELEGRAM_GROUP_UNREGISTERED"}
   ```
3. В личке с ботом скажите, что это за группа:
   - «Подключи группу -1001234567890 как семейную, отвечай на все сообщения» — закрытая
     семейная группа: только подтверждённые участники, общая семейная память.
   - «Подключи группу -1001234567890 как внешнюю, отвечай только когда зовут, разреши поиск в
     интернете» — рабочий или дружеский чат: своя изолированная память, никакого доступа к
     личному и семейному, права выдаются по одному.

## 10. Проверьте, что всё работает

В личке по очереди:

- «Привет! Что ты умеешь?»
- «Мой часовой пояс Москва, тихие часы с 23 до 8» — без часового пояса напоминания не создаются.
- «Напомни мне через 2 минуты выпить воды» — после кнопки подтверждения напоминание придёт через 2 минуты.
- «Найди, во сколько сегодня закрывается ближайший ИКЕА» — ответ со ссылкой на источник.
- Голосовое сообщение — Хомка его расшифрует (если включён голос).
- Фото чека: «что здесь купили и на сколько?»
- «Нарисуй открытку ко дню рождения бабушки» (если настроены картинки).
- «Запомни, что у Маши аллергия на орехи» → через день «на что у Маши аллергия?».

## Необязательное

- **Разбор фото моделью DeepSeek.** В `config/agent-model-providers.json` для `vision` задайте
  `{"supportsImageInput": true, "id": "deepseek-v4-flash-vision-exp", "maxOutputTokens": 8192}`
  и пересоздайте агента: `docker compose up -d agent`.
- **Google Календарь, Почта, Диск.** Создайте OAuth-клиент в Google Cloud с redirect
  `https://<ваш адрес>/eve/v1/google-oauth/callback` и задайте `GOOGLE_OAUTH_CLIENT_ID`,
  `GOOGLE_OAUTH_CLIENT_SECRET`, `PUBLIC_BASE_URL=https://<ваш адрес>` и
  `INTEGRATION_TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)`.
- **Корзина ВкусВилла.** `GROCERY_MCP_URL=https://mcp.vkusvill.ru/mcp`: бот собирает корзину и
  отдаёт ссылку, заказ и оплата остаются у человека.
- **Другое имя.** `TELEGRAM_AGENT_NAME=Кнопка` и `TELEGRAM_AGENT_ALIASES='["Кнопки","Кнопке","Кнопку","Кнопкой"]'`.

## Обновление и резервные копии

```bash
git pull
docker compose up -d --build        # миграции базы применяются сами перед стартом агента
```

Копия базы перед обновлением:

```bash
docker compose exec -T postgres pg_dumpall -U osinara | gzip > backup-$(date +%F).sql.gz
```

Храните копии не на том же сервере. Файлы семьи лежат в Docker-томе `workspace-data`.

## Если что-то не так

| Симптом | Что проверить |
| --- | --- |
| Бот не отвечает совсем | `getWebhookInfo`: адрес, `last_error_message`; `docker compose ps`; `docker compose logs agent` |
| `AGENT_MODEL_BALANCE_EXHAUSTED` или 402 | Пополните баланс DeepSeek |
| Агент не стартует, `AGENT_GROQ_API_KEY_REQUIRED` | Задайте `GROQ_API_KEY` или выключите голос в конфиге |
| Webhook отвечает 401 | `secret_token` в `setWebhook` не совпадает с `TELEGRAM_WEBHOOK_SECRET_TOKEN` |
| В группе бот молчит | Отключён ли privacy mode у BotFather, подключена ли группа (шаг 9), зовут ли бота по имени |
| Нет картинок | Заданы обе переменные OpenRouter и модель принимает `aspect_ratio` |
| Место на диске кончается | `docker image prune` после обновлений; `docker system df` |
