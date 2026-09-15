/**
 * Full webhook -> durable queue -> native Eve -> sandbox -> model -> Telegram, through rotation.
 *
 * Script: an external group where a human and another bot alternate for SESSION_MAX_COMPLETED_TURNS
 * plus four messages (one of them fails inside the model), then one private message from the owner
 * and one message in the family group. Each message must become exactly one Eve turn that probes
 * the right workspace and answers once; the failed turn answers nothing, shared chats stay silent.
 *
 * Затем приёмка вдвоём (W23): свободное дело в семейной группе, напоминание в личке владельца и
 * список дел в личке второго взрослого — настоящими инструментами, а не пробой workspace. Доставку
 * напоминания проверяет минутный диспетчер, вызванный отдельно: он ничего не помнит между
 * вызовами, поэтому это и есть проверка «сигнал переживает перезапуск процесса».
 */
import assert from "node:assert/strict";
import { defineEval } from "eve/evals";
import { database, closeDatabase } from "../../../agent/lib/database.js";
import { SESSION_MAX_COMPLETED_TURNS } from "../../../agent/config.js";
import { dispatchDueReminders } from "../../../agent/lib/reminders/reminder-dispatcher.js";
import { reminderRepository } from "../../../agent/lib/reminders/reminder-repository.js";
import { dispatchErrands } from "../../../agent/lib/errands/errand-dispatcher.js";
import { EXTERNAL_TURN_COUNT, FAILING_ORDINAL } from "../agent/agent.js";

const OWNER_TELEGRAM_ID = 902;
const SPOUSE_TELEGRAM_ID = 903;
const PEER_BOT_ID = 901;
const EXTERNAL_CHAT_ID = -900_000_101;
const FAMILY_CHAT_ID = -900_000_102;
const FIRST_UPDATE_ID = 900_000_000;

export default defineEval({
  timeoutMs: 480_000,
  async test(t) {
    assert.equal(process.env.RUN_DATABASE_INTEGRATION_TESTS, "true");
    assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/osinara_test");
    const db = database();
    await db.query("TRUNCATE users, families CASCADE");
    const totalMessages = EXTERNAL_TURN_COUNT + 2;
    const cursors = new Map<string, number>();
    try {
      await db.query(`CREATE TABLE telegram_conversation_test_deliveries (
        id integer GENERATED ALWAYS AS IDENTITY (START WITH 10000), body jsonb NOT NULL)`);
      await db.query("CREATE TABLE telegram_conversation_test_sandboxes (eve_session_id text NOT NULL, mounts jsonb NOT NULL)");
      const family = (await db.query<{ id: string }>("INSERT INTO families(name) VALUES ('Telegram conversation test') RETURNING id")).rows[0]!;
      const owner = (await db.query<{ id: string }>(
        "INSERT INTO users(telegram_user_id,display_name) VALUES($1,'Human') RETURNING id", [String(OWNER_TELEGRAM_ID)],
      )).rows[0]!;
      await db.query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')", [family.id, owner.id]);
      await db.query(
        "INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode) VALUES($1,$2,'Family test','family_private','all')",
        [family.id, String(FAMILY_CHAT_ID)],
      );
      const spouse = (await db.query<{ id: string }>(
        "INSERT INTO users(telegram_user_id,display_name) VALUES($1,'Spouse') RETURNING id", [String(SPOUSE_TELEGRAM_ID)],
      )).rows[0]!;
      await db.query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'member')", [family.id, spouse.id]);
      // Напоминание требует настроенного пояса: без него первый же вызов ответил бы отказом.
      await db.query(
        `INSERT INTO user_notification_settings(user_id,timezone,quiet_start,quiet_end)
         VALUES($1,'UTC',NULL,NULL),($2,'UTC',NULL,NULL)`,
        [owner.id, spouse.id],
      );
      const group = (await db.query<{ id: string }>(
        `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
         VALUES ($1, $2, 'Bot arena test', 'external', 'all', ARRAY['remember']) RETURNING id`,
        [family.id, String(EXTERNAL_CHAT_ID)],
      )).rows[0]!;

      for (let ordinal = 1; ordinal <= totalMessages; ordinal += 1) {
        const marker = `conversation-probe-${ordinal}`;
        const external = ordinal <= EXTERNAL_TURN_COUNT;
        const fromBot = external && ordinal % 2 === 1;
        const chatId = external ? EXTERNAL_CHAT_ID : ordinal === EXTERNAL_TURN_COUNT + 1 ? OWNER_TELEGRAM_ID : FAMILY_CHAT_ID;
        const message = {
          message_id: ordinal,
          chat: { id: chatId, type: chatId > 0 ? "private" : "supergroup", title: "Conversation test" },
          date: Math.floor(Date.now() / 1_000),
          from: { id: fromBot ? PEER_BOT_ID : OWNER_TELEGRAM_ID, first_name: fromBot ? "Peer bot" : "Human", is_bot: fromBot },
          ...(ordinal % 3 === 0
            ? { rich_message: { blocks: [{ type: "paragraph", text: `Осинара, ${marker}` }] } }
            : { text: `Осинара, ${marker}` }),
        };
        const response = await t.target.fetch("/eve/v1/telegram", {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": "conversation-test-secret" },
          body: JSON.stringify({ update_id: FIRST_UPDATE_ID + ordinal, message }),
        });
        assert.equal(response.status, 200);
        let completed = false;
        for (let poll = 0; poll < 600; poll += 1) {
          const row = (await db.query<{ status: string; eve_session_id: string | null; last_error_code: string | null }>(
            "SELECT status,eve_session_id,last_error_code FROM telegram_ingress_updates WHERE update_id = $1",
            [FIRST_UPDATE_ID + ordinal],
          )).rows[0];
          if (row?.status === "failed") throw new Error(`TEST_INGRESS_FAILED at ${marker}: ${row.last_error_code}`);
          if (row?.status === "completed") {
            assert.ok(row.eve_session_id, `No Eve turn for ${marker}`);
            const session = await t.target.attachSession(row.eve_session_id, { startIndex: cursors.get(row.eve_session_id) ?? 0 });
            if (ordinal === FAILING_ORDINAL) {
              session.event("turn.failed");
            } else {
              session.succeeded();
              session.messageIncludes(`reply-${marker}`);
              session.calledTool("probe_workspace");
              if (!external) {
                session.calledTool("bash");
                session.calledSubagent("agent");
              }
            }
            const cursor = (await db.query<{ next_event_index: number }>(
              "SELECT next_event_index FROM eve_session_event_cursors WHERE eve_session_id = $1", [row.eve_session_id],
            )).rows[0]!;
            cursors.set(row.eve_session_id, Number(cursor.next_event_index));
            completed = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(completed, `Conversation stalled at ${marker}`);
      }

      // Приёмка вдвоём: те же настоящие пути, но прикладными инструментами и от двух людей.
      const acceptance = [
        { chatId: FAMILY_CHAT_ID, from: OWNER_TELEGRAM_ID, marker: "conversation-task-1" },
        // Личное дело владельца: оно не должно попасть в чужой список ни при каком виде выдачи.
        { chatId: OWNER_TELEGRAM_ID, from: OWNER_TELEGRAM_ID, marker: "conversation-personal-1" },
        // Поручение второму взрослому: принять его может только он сам.
        { chatId: FAMILY_CHAT_ID, from: OWNER_TELEGRAM_ID, marker: "conversation-assign-1" },
        { chatId: SPOUSE_TELEGRAM_ID, from: SPOUSE_TELEGRAM_ID, marker: "conversation-list-1" },
        // Покупка из двух личных чатов одновременно: оба пункта обязаны сохраниться.
        { chatId: OWNER_TELEGRAM_ID, from: OWNER_TELEGRAM_ID, marker: "conversation-buy-1" },
        { chatId: SPOUSE_TELEGRAM_ID, from: SPOUSE_TELEGRAM_ID, marker: "conversation-buy-2" },
        // Повторяющееся дело и закрытие одного его вхождения.
        { chatId: OWNER_TELEGRAM_ID, from: OWNER_TELEGRAM_ID, marker: "conversation-repeat-1" },
        { chatId: OWNER_TELEGRAM_ID, from: OWNER_TELEGRAM_ID, marker: "conversation-done-1" },
        { chatId: OWNER_TELEGRAM_ID, from: OWNER_TELEGRAM_ID, marker: "conversation-errand-1" },
        { chatId: SPOUSE_TELEGRAM_ID, from: SPOUSE_TELEGRAM_ID, marker: "conversation-answer-1" },
        { chatId: OWNER_TELEGRAM_ID, from: OWNER_TELEGRAM_ID, marker: "conversation-status-1" },
        { chatId: FAMILY_CHAT_ID, from: OWNER_TELEGRAM_ID, marker: "conversation-decision-1" },
        { chatId: FAMILY_CHAT_ID, from: OWNER_TELEGRAM_ID, marker: "conversation-consent-1" },
        { chatId: FAMILY_CHAT_ID, from: SPOUSE_TELEGRAM_ID, marker: "conversation-consent-2" },
        { chatId: FAMILY_CHAT_ID, from: SPOUSE_TELEGRAM_ID, marker: "conversation-feedback-1" },
      ];
      // Напоминание создаётся репозиторием, а не ходом модели: `manage_reminder` всегда требует
      // подтверждения кнопкой, а возобновление припаркованного хода проверяется отдельными
      // интеграционными тестами HITL. Здесь важно другое — что готовый сигнал доживает до срока и
      // уходит без всякого состояния в процессе.
      async function waitFor<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
        for (let poll = 0; poll < 600; poll += 1) {
          const value = await probe();
          if (value !== undefined) return value;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`TEST_ACCEPTANCE_TIMEOUT: ${what}`);
      }

      let deliveredErrandReply: {message_id:number;text:string;chat:{id:number;type:string};from:{id:number;is_bot:boolean;username:string};date:number}|undefined;
      for (const [index, step] of acceptance.entries()) {
        if(step.marker === "conversation-answer-1")assert.ok(deliveredErrandReply,"reply requires the real delivery receipt");
        const updateId = FIRST_UPDATE_ID + totalMessages + index + 1;
        const response = await t.target.fetch("/eve/v1/telegram", {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": "conversation-test-secret" },
          body: JSON.stringify({ update_id: updateId, message: {
            message_id: totalMessages + index + 1,
            chat: { id: step.chatId, type: step.chatId > 0 ? "private" : "supergroup", title: "Acceptance" },
            date: Math.floor(Date.now() / 1_000),
            from: { id: step.from, first_name: "Human", is_bot: false },
            text: `Осинара, ${step.marker}`,
            ...(step.marker === "conversation-answer-1" ? {reply_to_message:deliveredErrandReply} : {}),
          } }),
        });
        assert.equal(response.status, 200);

        const delivered = await waitFor(`ingress of ${step.marker}`, async () => {
          const row = (await db.query<{ eve_session_id: string | null; last_error_code: string | null; status: string }>(
            "SELECT status,eve_session_id,last_error_code FROM telegram_ingress_updates WHERE update_id = $1", [updateId],
          )).rows[0];
          if (row?.status === "failed") throw new Error(`TEST_ACCEPTANCE_FAILED at ${step.marker}: ${row.last_error_code}`);
          return row?.status === "completed" && row.eve_session_id ? row.eve_session_id : undefined;
        });

        const session = await t.target.attachSession(delivered, { startIndex: cursors.get(delivered) ?? 0 });
        session.succeeded();
        session.messageIncludes(`reply-${step.marker}`);
        // Курсор сессии двигается и здесь: в одном чате ходов несколько, и без этого проверка
        // читала бы ответ первого из них снова и снова.
        const acceptanceCursor = (await db.query<{ next_event_index: number }>(
          "SELECT next_event_index FROM eve_session_event_cursors WHERE eve_session_id = $1", [delivered],
        )).rows[0]!;
        cursors.set(delivered, Number(acceptanceCursor.next_event_index));
        if(step.marker === "conversation-decision-1"){
          session.calledTool("manage_joint_decision");
          assert.equal((await db.query("SELECT 1 FROM joint_decisions WHERE family_id=$1",[family.id])).rowCount,1);
          assert.equal((await db.query("SELECT 1 FROM joint_decision_answers")).rowCount,0,"proposal is not consent");
        }
        if(step.marker === "conversation-consent-1"){
          session.messageIncludes("open");
          assert.equal((await db.query("SELECT 1 FROM joint_decision_answers")).rowCount,1,"one human is not a quorum");
        }
        if(step.marker === "conversation-consent-2"){
          session.messageIncludes("agreed");
          const actors=(await db.query<{telegram_user_id:string;choice:string}>(`SELECT u.telegram_user_id,a.choice FROM joint_decision_answers a
            JOIN users u ON u.id=a.actor_user_id ORDER BY u.telegram_user_id`)).rows;
          assert.deepEqual(actors.map(a=>a.telegram_user_id).sort(),[String(OWNER_TELEGRAM_ID),String(SPOUSE_TELEGRAM_ID)].sort());
          assert.ok(actors.every(a=>a.choice==='agree'));
        }
        if(step.marker === "conversation-feedback-1"){
          const feedback=(await db.query<{telegram_user_id:string;text:string}>(`SELECT u.telegram_user_id,f.text FROM joint_decision_feedback f
            JOIN users u ON u.id=f.actor_user_id`)).rows;
          assert.deepEqual(feedback,[{telegram_user_id:String(SPOUSE_TELEGRAM_ID),text:"Хочу прогулку без спешки"}]);
        }
        if (step.marker === "conversation-errand-1") {
          session.calledTool("manage_errand");
          const stored = (await db.query("SELECT private_query,state FROM errands WHERE family_id=$1",[family.id])).rows;
          assert.equal(stored.length,1);
          assert.ok(stored[0].private_query.includes(step.marker),"source came from the verified Telegram turn");
          await dispatchErrands(new Date());
          await dispatchErrands(new Date());
          const sent = (await db.query<{body:{chat_id:string|number;text:string}}>(
            "SELECT body FROM telegram_conversation_test_deliveries WHERE body->>'text' LIKE '%Парк у реки%'")).rows;
          assert.equal(sent.length,1,"one result despite repeated dispatcher calls");
          assert.equal(String(sent[0]!.body.chat_id),String(SPOUSE_TELEGRAM_ID));
          assert.ok(!sent[0]!.body.text.includes(step.marker),"private source is not disclosed");
          const receipt=(await db.query<{telegram_message_id:string}>("SELECT telegram_message_id FROM errand_deliveries WHERE state='sent'")).rows[0]!;
          deliveredErrandReply={message_id:Number(receipt.telegram_message_id),text:sent[0]!.body.text,
            chat:{id:SPOUSE_TELEGRAM_ID,type:"private"},from:{id:904,is_bot:true,username:"osinara_test_bot"},date:Math.floor(Date.now()/1000)};
        }
        if (step.marker === "conversation-answer-1") {
          const authorSession = (await db.query<{eve_session_id:string}>(
            "SELECT eve_session_id FROM errand_operations WHERE action='create' AND family_id=$1",[family.id])).rows[0]!;
          assert.notEqual(delivered,authorSession.eve_session_id,"recipient answers in their own session");
          assert.equal((await db.query("SELECT 1 FROM errand_answers")).rowCount,1);
          const reply=(await db.query<{reply_to_message_id:string;owner_user_id:string}>(`SELECT m.reply_to_message_id::text,c.owner_user_id
            FROM telegram_group_messages m JOIN application_conversations c ON c.id=m.conversation_id
            WHERE m.telegram_user_id=$1 AND m.content_text LIKE '%conversation-answer-1%'
            ORDER BY m.sequence_id DESC LIMIT 1`,[String(SPOUSE_TELEGRAM_ID)])).rows[0]!;
          assert.equal(reply.reply_to_message_id,String(deliveredErrandReply!.message_id));
          const spouse=(await db.query<{id:string}>("SELECT id FROM users WHERE telegram_user_id=$1",[String(SPOUSE_TELEGRAM_ID)])).rows[0]!;
          assert.equal(reply.owner_user_id,spouse.id,"reply journal belongs to the recipient, not the initiator");
          const mounts=(await db.query<{mounts:unknown}>("SELECT mounts FROM telegram_conversation_test_sandboxes WHERE eve_session_id=$1",[delivered])).rows;
          const original=(await db.query<{mounts:unknown}>(`SELECT s.mounts FROM telegram_conversation_test_sandboxes s
            JOIN telegram_ingress_updates i ON i.eve_session_id=s.eve_session_id WHERE i.update_id=$1`,
            [FIRST_UPDATE_ID+totalMessages+4])).rows;
          assert.ok(mounts.length>0 && original.length>0,"both recipient sessions initialized their sandbox");
          assert.deepEqual(mounts[0]!.mounts,original[0]!.mounts,"reply branch has exactly the recipient's original mounts");
        }
        if (step.marker === "conversation-status-1") {
          session.messageIncludes("Выбираю парк у реки");
          session.messageIncludes("sent");
        }
        if (step.marker === "conversation-list-1") {
          // Список судится по доставленному тексту: пустая выдача прошла бы проверку ответа.
          session.messageIncludes("Записать сына к врачу");
          const delivery = (await db.query<{ body: { text?: string } }>(
            `SELECT body FROM telegram_conversation_test_deliveries
              WHERE body->>'text' LIKE '%titles=%' AND body->>'chat_id' = $1`, [String(SPOUSE_TELEGRAM_ID)],
          )).rows;
          assert.equal(delivery.length, 1, "one list answer reached the second adult");
          const text = delivery[0]!.body.text ?? "";
          assert.ok(!text.includes("Сходить к стоматологу"), "a private task of the other adult stays invisible");
        }
      }

      const reminderAuth = {
        familyId: family.id, forumTopicId: null, groupId: null, groupType: null,
        messageThreadId: null, role: "owner" as const, telegramChatId: String(OWNER_TELEGRAM_ID),
        telegramChatType: "private" as const, userId: owner.id,
      };
      await reminderRepository.create(reminderAuth, {
        content: "Забрать заказ",
        firstRunAt: new Date(Date.now() + 120_000),
        operationKey: "acceptance-reminder",
        recurrence: null,
        scope: "personal",
        timezone: "UTC",
      });

      // «Кто возьмёт» не назначает автора: дело осталось свободным и видно обоим взрослым.
      const task = (await db.query<{ assignee_telegram_id: string | null; status: string; title: string }>(
        "SELECT assignee_telegram_id,status,title FROM shared_tasks WHERE family_id=$1 ORDER BY title", [family.id],
      )).rows;
      assert.deepEqual(task.find((row) => row.title === "Кто заберёт посылку"),
        { assignee_telegram_id: null, status: "open", title: "Кто заберёт посылку" });
      // Принятие возникает только от действия получателя: поручение ждёт его согласия.
      assert.deepEqual(task.find((row) => row.title === "Записать сына к врачу"),
        { assignee_telegram_id: String(SPOUSE_TELEGRAM_ID), status: "proposed", title: "Записать сына к врачу" });
      // Личное дело владельца принято им самим и остаётся личным.
      assert.deepEqual(task.find((row) => row.title === "Сходить к стоматологу"),
        { assignee_telegram_id: String(OWNER_TELEGRAM_ID), status: "accepted", title: "Сходить к стоматологу" });

      // Два параллельных добавления покупки: оба пункта сохранились, ни один не перезаписал другой.
      const items = (await db.query<{ added_by_telegram_id: string }>(
        "SELECT added_by_telegram_id FROM shopping_items WHERE family_id=$1 ORDER BY added_by_telegram_id",
        [family.id],
      )).rows;
      assert.deepEqual(items.map((row) => row.added_by_telegram_id),
        [String(OWNER_TELEGRAM_ID), String(SPOUSE_TELEGRAM_ID)]);

      // Закрытие сегодняшнего вхождения не закрывает будущее: дело живо и получило новую дату.
      const repeated = (await db.query<{ due_on: string; status: string }>(
        `SELECT due_on::text,status FROM shared_tasks
          WHERE family_id=$1 AND title='Полить цветы'`, [family.id],
      )).rows;
      assert.equal(repeated.length, 1, "one repeating task survived its own completion");
      assert.equal(repeated[0]!.status, "accepted");
      assert.ok(repeated[0]!.due_on > new Date().toISOString().slice(0, 10), "the occurrence moved forward");
      const occurrences = (await db.query(
        `SELECT 1 FROM shared_ritual_occurrences occurrence
           JOIN shared_tasks task ON task.id = occurrence.task_id
          WHERE task.family_id=$1 AND task.title='Полить цветы'`, [family.id],
      )).rowCount;
      assert.equal(occurrences, 1, "the closed occurrence is recorded once");

      // Сигнал переживает перезапуск: диспетчер вызывается отдельно и ничего не помнит о ходе.
      const reminder = (await db.query<{ due_at: Date }>(
        "SELECT due_at FROM reminders WHERE family_id=$1", [family.id],
      )).rows;
      assert.equal(reminder.length, 1, "one reminder from the private turn");
      const delivered = await dispatchDueReminders(new Date(reminder[0]!.due_at.getTime() + 1_000));
      assert.equal(delivered, 1, "the minute dispatcher delivered exactly one reminder");
      const reminderDelivery = (await db.query<{ body: { chat_id: number | string; text?: string } }>(
        "SELECT body FROM telegram_conversation_test_deliveries WHERE body->>'text' LIKE '%Забрать заказ%'",
      )).rows;
      assert.equal(reminderDelivery.length, 1, "the reminder reached exactly one chat");
      assert.equal(String(reminderDelivery[0]!.body.chat_id), String(OWNER_TELEGRAM_ID));

      // Scenario 11: membership disappears after creation, before the independent dispatcher.
      await reminderRepository.create(reminderAuth, {
        content: "Не отправлять после выхода",
        firstRunAt: new Date(Date.now() + 120_000), operationKey: "acceptance-revoked-reminder",
        recurrence: null, scope: "personal", timezone: "UTC",
      });
      await db.query("DELETE FROM family_memberships WHERE family_id=$1 AND user_id=$2",
        [family.id, owner.id]);
      await dispatchDueReminders(new Date(Date.now() + 180_000));
      const revoked = (await db.query<{ status: string; last_error_code: string }>(
        "SELECT status,last_error_code FROM reminders WHERE family_id=$1 AND content=$2",
        [family.id, "Не отправлять после выхода"],
      )).rows;
      assert.deepEqual(revoked, [{ status: "failed", last_error_code: "AGENT_REMINDER_DESTINATION_REVOKED" }]);
      assert.equal((await db.query(
        "SELECT 1 FROM telegram_conversation_test_deliveries WHERE body->>'text' LIKE '%Не отправлять после выхода%'",
      )).rowCount, 0, "a revoked reminder never reaches Telegram");

      const sessions = (await db.query<{ completed_turns: number; generation: number }>(
        "SELECT completed_turns,generation FROM conversation_sessions WHERE group_id=$1 ORDER BY generation", [group.id],
      )).rows;
      assert.deepEqual(sessions.map((s) => s.completed_turns), [SESSION_MAX_COMPLETED_TURNS, EXTERNAL_TURN_COUNT - SESSION_MAX_COMPLETED_TURNS - 1]);
      // Reply на доставленную подборку открывает шестую ветку: её mounts выше сверены
      // с исходной личной сессией получателя, а автор журнала — с его verified identity.
      assert.equal((await db.query("SELECT DISTINCT eve_session_id FROM telegram_conversation_test_sandboxes")).rowCount, 6);
      assert.equal((await db.query("SELECT 1 FROM memory_review_owner_alerts WHERE family_id=$1", [family.id])).rowCount, 0);
      const deliveries = (await db.query<{ body: { chat_id: number | string; text?: string } }>(
        "SELECT body FROM telegram_conversation_test_deliveries",
      )).rows;
      // Terminal diagnostics are private-only: a turn that fails in a shared chat stays silent there.
      const failures = deliveries.filter((d) => (d.body.text ?? "").startsWith("Не удалось выполнить запрос"));
      assert.equal(failures.length, 0, "no failure notice in a shared chat");
      for (let ordinal = 1; ordinal <= totalMessages; ordinal += 1) {
        const replies = deliveries.filter((d) => JSON.stringify(d.body).includes(`reply-conversation-probe-${ordinal}"`));
        assert.equal(replies.length, ordinal === FAILING_ORDINAL ? 0 : 1, `Delivery count for turn ${ordinal}`);
      }
      t.log(`CONVERSATION_SUMMARY ${JSON.stringify({
        acceptanceTurns: acceptance.length,
        openTasks: task.length,
        shoppingItems: items.length,
        reminderChatId: String(reminderDelivery[0]!.body.chat_id),
        remindersDelivered: delivered,
        sandboxSessions: 6,
        sessions: sessions.length,
        turns: totalMessages + acceptance.length,
      })}`);
    } finally {
      await db.query("TRUNCATE users, families CASCADE");
      await db.query("DELETE FROM telegram_ingress_updates WHERE update_id BETWEEN $1 AND $2", [
        FIRST_UPDATE_ID + 1, FIRST_UPDATE_ID + totalMessages + 100,
      ]);
      await db.query("DROP TABLE IF EXISTS telegram_conversation_test_deliveries, telegram_conversation_test_sandboxes");
      await closeDatabase();
    }
  },
});
