// Верификация новичков: принять правила + простая проверка «нажми нужную кнопку» против ботов.
// Слишком новые аккаунты Discord не проходят автоматически — о них сообщается модераторам.

import crypto from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { BotError } from '../core.js';
import { buildLinkSummary, linkManual, steamModal } from './steam.js';
import { LEVEL, embed, ts } from '../util.js';

const CHOICES = [
  ['☢️', 'знак радиации'],
  ['🔦', 'фонарик'],
  ['🎒', 'рюкзак'],
  ['🧭', 'компас'],
  ['🔫', 'оружие'],
  ['🍞', 'хлеб'],
];
const challenges = new Map(); // token -> { userId, answer, expires }

export function verifyPanel() {
  return {
    embeds: [
      embed(
        'info',
        '☢️ Вход в Зону',
        'Прочитай правила сервера. Нажимая кнопку, ты подтверждаешь, что согласен с ними. Затем впиши свой Steam — и получишь доступ к каналам.',
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('verify:start').setLabel('Я прочитал правила').setEmoji('✅').setStyle(ButtonStyle.Success),
      ),
    ],
  };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function grant(member, ctx, reason) {
  const { verified, unverified } = ctx.cfg.roles;
  await member.roles.add(verified, reason);
  if (unverified) await member.roles.remove(unverified, reason).catch(() => {});
}

// Заявки, ждущие решения модератора: { [userId]: { at, steamId } }.
const pendingGet = (ctx) => ctx.db.kv.get('verify.pending', {});
const pendingSet = (ctx, v) => ctx.db.kv.set('verify.pending', v);

const reviewButtons = (userId, disabled = false) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`verify:approve:${userId}`).setLabel('Принять').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`verify:reject:${userId}`).setLabel('Отклонить').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );

// После проверки и Steam: либо сразу доступ, либо заявка модераторам (verify.manualApproval).
async function complete(i, ctx, steamId) {
  if (!ctx.cfg.verify.manualApproval) {
    await grant(i.member, ctx, 'Верификация');
    return '✅ Добро пожаловать! Теперь можно подать анкету.';
  }
  const pending = pendingGet(ctx);
  pending[i.user.id] = { at: Date.now(), steamId: steamId ?? null };
  pendingSet(ctx, pending);
  // Сводку собираем в фоне: проверка банов может занять пару секунд.
  (async () => {
    const summary = steamId
      ? await buildLinkSummary(ctx, i.member, steamId, ctx.links.get(i.user.id)?.method, '📋 Заявка на верификацию')
      : { embed: embed('info', '📋 Заявка на верификацию', `<@${i.user.id}> · Steam не указан`) };
    await ctx.post(ctx.cfg.channels.verifyReview ? 'verifyReview' : 'modLog', { embeds: [summary.embed], components: [reviewButtons(i.user.id)] });
  })().catch((e) => ctx.log.warn(`заявка на верификацию: ${e.message}`));
  return '📨 Заявка отправлена. Модераторы проверят её, ответ придёт в личные сообщения.';
}

export default {
  name: 'verify',

  init(ctx) {
    const { unverified } = ctx.cfg.roles;
    if (unverified) {
      ctx.client.on(Events.GuildMemberAdd, (m) => {
        if (m.guild.id === ctx.cfg.guildId && !m.user.bot) m.roles.add(unverified, 'Новый участник').catch(() => {});
      });
    }
  },

  async onComponent(i, ctx, [action, token, choice]) {
    const { verified } = ctx.cfg.roles;
    if (!verified) throw new BotError('Роль после верификации не настроена: /setup roles');

    if (action === 'start') {
      if (i.member.roles.cache.has(verified)) throw new BotError('Ты уже прошёл верификацию');
      if (pendingGet(ctx)[i.user.id]) throw new BotError('Твоя заявка уже на рассмотрении — дождись ответа модераторов');
      const minAge = ctx.cfg.verify.minAccountAgeDays * 86400e3;
      if (Date.now() - i.user.createdTimestamp < minAge) {
        ctx.audit('🕵️ Новый аккаунт не прошёл верификацию', { Участник: `<@${i.user.id}>`, 'Аккаунт создан': ts(i.user.createdTimestamp) }, 'warn');
        throw new BotError('Твой аккаунт Discord слишком новый. Создай тикет — администрация проверит вручную.');
      }
      const options = shuffle([...CHOICES]).slice(0, 4);
      const answer = options[crypto.randomInt(options.length)];
      const t = crypto.randomBytes(6).toString('hex');
      challenges.set(t, { userId: i.user.id, answer: answer[0], expires: Date.now() + 120_000 });
      setTimeout(() => challenges.delete(t), 120_000).unref?.();
      const row = new ActionRowBuilder().addComponents(
        options.map(([emoji], n) => new ButtonBuilder().setCustomId(`verify:answer:${t}:${n}`).setEmoji(emoji).setStyle(ButtonStyle.Secondary)),
      );
      // Варианты запоминаем по порядку, чтобы не передавать ответ в customId.
      challenges.get(t).options = options.map(([e]) => e);
      return i.reply({ embeds: [embed('info', null, `Нажми на **${answer[1]}**`)], components: [row], flags: MessageFlags.Ephemeral });
    }

    if (action === 'answer') {
      const c = challenges.get(token);
      challenges.delete(token);
      if (!c || c.userId !== i.user.id || c.expires < Date.now()) {
        return i.update({ embeds: [embed('neutral', null, 'Проверка устарела — нажми кнопку ещё раз')], components: [] });
      }
      if (c.options[Number(choice)] !== c.answer) {
        return i.update({ embeds: [embed('bad', null, 'Неверно. Нажми кнопку на панели ещё раз.')], components: [] });
      }
      // Дальше — вписать свой Steam (если включено), потом роль.
      if (ctx.cfg.verify.askSteam !== false && !ctx.links.get(i.user.id)) return i.showModal(steamModal('verify:steam'));
      const text = await complete(i, ctx, ctx.links.get(i.user.id)?.steam_id);
      return i.update({ embeds: [embed('ok', null, text)], components: [] });
    }

    if (action === 'steam') {
      const r = await linkManual(ctx, i.member, i.fields.getTextInputValue('steam'), { silent: ctx.cfg.verify.manualApproval });
      if (!r.ok) {
        // Окно можно открыть снова — кнопкой «Я прочитал правила».
        throw new BotError(`${r.message}\nНажми «Я прочитал правила» ещё раз.`);
      }
      const text = await complete(i, ctx, r.steamId);
      const done = embed('ok', null, `Steam сохранён: \`${r.steamId}\`\n${text}`);
      return i.isFromMessage() ? i.update({ embeds: [done], components: [] }) : i.reply({ embeds: [done], flags: MessageFlags.Ephemeral });
    }

    // ---------- Решение модератора ----------
    if (action === 'approve' || action === 'reject' || action === 'rejectReason') {
      ctx.require(i, LEVEL.moderator);
      const userId = token;
      if (!/^\d{17,20}$/.test(userId)) throw new BotError('Неверная заявка');
      const pending = pendingGet(ctx);
      if (!pending[userId]) throw new BotError('Заявка уже рассмотрена');

      if (action === 'reject') {
        return i.showModal(
          new ModalBuilder()
            .setCustomId(`verify:rejectReason:${userId}`)
            .setTitle('Отклонить заявку')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('reason').setLabel('Причина (увидит игрок)').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true),
              ),
            ),
        );
      }

      delete pending[userId];
      pendingSet(ctx, pending);
      await i.deferUpdate();
      const member = await i.guild.members.fetch(userId).catch(() => null);
      let decision;
      if (action === 'approve') {
        if (member) {
          await grant(member, ctx, `Верификация одобрена: ${i.user.tag}`);
          member.send({ embeds: [embed('ok', '✅ Верификация пройдена', 'Добро пожаловать на сервер Blackout! Теперь можно подать анкету персонажа.')] }).catch(() => {});
        }
        decision = embed('ok', null, `✅ Принято — <@${i.user.id}>${member ? '' : ' · участник уже покинул сервер'}`);
        ctx.audit('✅ Верификация одобрена', { Участник: `<@${userId}>`, Кто: `<@${i.user.id}>` }, 'ok');
      } else {
        const reason = i.fields.getTextInputValue('reason');
        member?.send({ embeds: [embed('bad', '❌ Верификация отклонена', `Причина: ${reason}\n\nЕсли это ошибка — напиши в поддержку.`)] }).catch(() => {});
        decision = embed('bad', null, `❌ Отклонено — <@${i.user.id}>: ${reason}`);
        ctx.audit('❌ Верификация отклонена', { Участник: `<@${userId}>`, Кто: `<@${i.user.id}>`, Причина: reason }, 'warn');
      }
      return i.update({ embeds: [...i.message.embeds, decision], components: [reviewButtons(userId, true)] });
    }
  },
};
