require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType
} = require("discord.js");

/* =========================================================
   ENV (Railway-friendly)
========================================================= */

const pick = (...keys) => {
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
};

const TOKEN = pick("DISCORD_TOKEN", "DISCORD_BOT_TOKEN", "DISCORD_BOT", "BOT_TOKEN");
const APP_ID = pick("DISCORD_APP_ID", "DISCORD_CLIENT_ID", "CLIENT_ID", "APP_ID");
const GUILD_ID = pick("DISCORD_GUILD_ID", "DISCORD_GUILD", "GUILD_ID");
const ADMIN_ROLE_ID = pick("ADMIN_ROLE_ID", "DISCORD_ADMIN_ROLE_ID");
const PORT = Number(process.env.PORT || 3000);

// optional default password (can be changed with /apanel_set)
const DEFAULT_APANEL_PASSWORD = pick("APANEL_PASSWORD", "DISCORD_APANEL_PASSWORD", "ADMIN_PANEL_PASSWORD");

if (!TOKEN) {
  console.error("❌ Missing env token. Add one of: DISCORD_TOKEN / DISCORD_BOT_TOKEN");
  process.exit(1);
}
if (!APP_ID) {
  console.error("❌ Missing env app id. Add one of: DISCORD_APP_ID / DISCORD_CLIENT_ID");
  process.exit(1);
}

/* =========================================================
   SIMPLE FILE DB (for apanel password + small configs)
========================================================= */

const DB_FILE = path.join(__dirname, "data.json");

function safeReadJson(p, fallback) {
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeWriteJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function dbGet() {
  return safeReadJson(DB_FILE, { apanel: {} });
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s ?? "")).digest("hex");
}

function getApanelHash(guildId) {
  const db = dbGet();
  const gid = String(guildId || "");
  const rec = db.apanel?.[gid];
  if (rec?.password_hash) return String(rec.password_hash);
  if (DEFAULT_APANEL_PASSWORD) return sha256Hex(DEFAULT_APANEL_PASSWORD);
  return "";
}

function setApanelHash(guildId, password) {
  const db = dbGet();
  const gid = String(guildId || "");
  db.apanel = db.apanel || {};
  db.apanel[gid] = { password_hash: sha256Hex(password), updatedAt: Date.now() };
  safeWriteJson(DB_FILE, db);
}

/* =========================================================
   AUTH HELPERS
========================================================= */

function hasAdminAccess(interaction) {
  const member = interaction.member;
  if (!member) return false;

  // role from env
  if (ADMIN_ROLE_ID && member?.roles?.cache?.has(ADMIN_ROLE_ID)) return true;

  // server admin permission
  if (member?.permissions?.has(PermissionFlagsBits.Administrator)) return true;

  // fallback: role named "admin"
  if (member?.roles?.cache?.some((r) => String(r.name || "").toLowerCase() === "admin")) return true;

  return false;
}

/* =========================================================
   APANEL SESSION (password -> 5 minutes)
========================================================= */

const APANEL_SESSIONS = new Map(); // userId -> { guildId, expiresAtMs }

function apanelIsActive(interaction) {
  const uid = interaction.user?.id;
  const gid = interaction.guild?.id;
  if (!uid || !gid) return false;
  const s = APANEL_SESSIONS.get(uid);
  if (!s) return false;
  if (s.guildId !== gid) return false;
  if (Date.now() > s.expiresAtMs) {
    APANEL_SESSIONS.delete(uid);
    return false;
  }
  return true;
}

function apanelGrant(uid, gid) {
  APANEL_SESSIONS.set(String(uid), {
    guildId: String(gid),
    expiresAtMs: Date.now() + 5 * 60 * 1000
  });
}

/* =========================================================
   PANEL UI (buttons + modals)
========================================================= */

const PANEL_STATE = new Map(); // adminUserId -> state

function getState(adminUserId) {
  const uid = String(adminUserId);
  const existing = PANEL_STATE.get(uid);
  if (existing) return existing;

  const s = {
    mode: "home",
    broadcast: {
      title: "🚀 NightCoreX: обновление",
      desc: "Текст рассылки…",
      channelIds: [],
      pin: false
    },
    cleanup: {
      count: 50,
      days: 0
    }
  };
  PANEL_STATE.set(uid, s);
  return s;
}

function color() {
  return 0x8b5cf6;
}

function buildHomeEmbed() {
  return new EmbedBuilder()
    .setTitle("🛠️ Admin Panel")
    .setDescription(
      "Выбери модуль кнопками снизу.\n\n" +
      "• Broadcast — рассылка embed в каналы\n" +
      "• Moderation — send/kick/ban\n" +
      "• Cleanup — очистка сообщений\n\n" +
      "Для опасных действий нужен вход через **/apanel** или модалка в панели."
    )
    .setColor(color())
    .setTimestamp(new Date());
}

function buildBroadcastEmbed(state) {
  const ch = state.broadcast.channelIds?.length
    ? state.broadcast.channelIds.map((id) => `<#${id}>`).join(", ")
    : "не выбраны";

  return new EmbedBuilder()
    .setTitle("📣 Broadcast")
    .setDescription(
      `**Заголовок:** ${state.broadcast.title}\n` +
      `**Текст:** ${state.broadcast.desc.slice(0, 2500)}\n\n` +
      `**Каналы:** ${ch}\n` +
      `**Pin:** ${state.broadcast.pin ? "да" : "нет"}`
    )
    .setColor(color())
    .setTimestamp(new Date());
}

function buildModerationEmbed() {
  return new EmbedBuilder()
    .setTitle("🛡️ Moderation")
    .setDescription(
      "Кнопки действий (требуется активная /apanel сессия):\n" +
      "• Send message\n• Kick\n• Ban (можно временный)\n\n" +
      "Открывай модалки кнопками ниже."
    )
    .setColor(color())
    .setTimestamp(new Date());
}

function buildCleanupEmbed(state) {
  return new EmbedBuilder()
    .setTitle("🧹 Cleanup")
    .setDescription(
      "Удаление сообщений в ТЕКУЩЕМ канале.\n" +
      "Discord ограничение: bulk delete только для сообщений моложе 14 дней.\n\n" +
      `Текущее:\n• count: **${state.cleanup.count || 0}**\n• days: **${state.cleanup.days || 0}**`
    )
    .setColor(color())
    .setTimestamp(new Date());
}

function navRow(state) {
  const mk = (id, label, active) =>
    new ButtonBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setStyle(active ? ButtonStyle.Primary : ButtonStyle.Secondary);

  return new ActionRowBuilder().addComponents(
    mk("panel_nav_home", "Home", state.mode === "home"),
    mk("panel_nav_broadcast", "Broadcast", state.mode === "broadcast"),
    mk("panel_nav_moderation", "Moderation", state.mode === "moderation"),
    mk("panel_nav_cleanup", "Cleanup", state.mode === "cleanup")
  );
}

function broadcastComponents(state) {
  const row1 = navRow(state);
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("broadcast_edit").setLabel("✏️ Edit").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("broadcast_channels").setLabel("📌 Channels").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("broadcast_toggle_pin").setLabel(state.broadcast.pin ? "Unpin mode" : "Pin mode").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("broadcast_send").setLabel("📤 Send").setStyle(ButtonStyle.Danger)
  );
  return [row1, row2];
}

function moderationComponents(state) {
  const row1 = navRow(state);
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("mod_send").setLabel("💬 Send").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mod_kick").setLabel("👢 Kick").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("mod_ban").setLabel("⛔ Ban").setStyle(ButtonStyle.Danger)
  );
  return [row1, row2];
}

function cleanupComponents(state) {
  const row1 = navRow(state);
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("cleanup_edit").setLabel("⚙️ Setup").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("cleanup_run").setLabel("🧹 Run").setStyle(ButtonStyle.Danger)
  );
  return [row1, row2];
}

async function showPanel(interaction, { update = false } = {}) {
  const state = getState(interaction.user.id);

  let embed = buildHomeEmbed();
  let components = [navRow({ mode: "home" })];

  if (state.mode === "broadcast") {
    embed = buildBroadcastEmbed(state);
    components = broadcastComponents(state);
  } else if (state.mode === "moderation") {
    embed = buildModerationEmbed();
    components = moderationComponents(state);
  } else if (state.mode === "cleanup") {
    embed = buildCleanupEmbed(state);
    components = cleanupComponents(state);
  }

  const payload = { embeds: [embed], components, flags: 64 }; // ephemeral

  if (update) {
    if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
    return interaction.update(payload);
  }
  return interaction.reply(payload);
}

/* =========================================================
   SLASH COMMANDS (как в старом: /panel + /apanel ...)
========================================================= */

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName("panel").setDescription("Открыть админ‑панель (админ)"),

    new SlashCommandBuilder()
      .setName("apanel")
      .setDescription("Войти в админ‑панель по паролю (5 минут)")
      .addStringOption((o) => o.setName("password").setDescription("Пароль админ‑панели").setRequired(true)),

    new SlashCommandBuilder()
      .setName("apanel_set")
      .setDescription("Задать пароль админ‑панели (админ)")
      .addStringOption((o) => o.setName("password").setDescription("Новый пароль").setRequired(true)),

    new SlashCommandBuilder()
      .setName("s")
      .setDescription("Отправить сообщение от имени бота (нужна /apanel)")
      .addStringOption((o) => o.setName("text").setDescription("Текст").setRequired(true))
      .addChannelOption((o) => o.setName("channel").setDescription("Канал (опц., по умолчанию текущий)").setRequired(false)),

    new SlashCommandBuilder()
      .setName("kick")
      .setDescription("Кикнуть пользователя (нужна /apanel)")
      .addUserOption((o) => o.setName("user").setDescription("Кого кикнуть").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Причина (опц.)").setRequired(false)),

    new SlashCommandBuilder()
      .setName("ban")
      .setDescription("Забанить пользователя (нужна /apanel)")
      .addUserOption((o) => o.setName("user").setDescription("Кого банить").setRequired(true))
      .addIntegerOption((o) => o.setName("minutes").setDescription("Бан на время (минуты, опц.)").setRequired(false))
      .addStringOption((o) => o.setName("reason").setDescription("Причина (опц.)").setRequired(false)),

    new SlashCommandBuilder()
      .setName("clear")
      .setDescription("Очистить сообщения в канале (нужна /apanel)")
      .addIntegerOption((o) => o.setName("count").setDescription("Сколько удалить (1-100)").setRequired(false).setMinValue(1).setMaxValue(100))
      .addIntegerOption((o) => o.setName("days").setDescription("Удалить за последние X дней (1-14)").setRequired(false).setMinValue(1).setMaxValue(14)),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
    console.log("✅ Slash commands registered (guild)");
  } else {
    await rest.put(Routes.applicationCommands(APP_ID), { body: commands });
    console.log("✅ Slash commands registered (global)");
  }
}

/* =========================================================
   DISCORD CLIENT
========================================================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel]
});

client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

async function ensureApanel(interaction) {
  if (apanelIsActive(interaction)) return true;

  const modal = new ModalBuilder()
    .setCustomId("panel_login_modal")
    .setTitle("Вход в админ‑панель");

  const pw = new TextInputBuilder()
    .setCustomId("panel_pw")
    .setLabel("Пароль")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(pw));
  await interaction.showModal(modal);
  return false;
}

async function doClearMessages(channel, { count, days }) {
  const limit = Math.min(100, Math.max(1, Number(count || 100)));
  const msgs = await channel.messages.fetch({ limit });

  const now = Date.now();
  const maxAgeMs = 14 * 24 * 60 * 60 * 1000;
  const daysMs = days ? Number(days) * 24 * 60 * 60 * 1000 : null;

  const toDelete = [];
  for (const m of msgs.values()) {
    const age = now - m.createdTimestamp;
    if (age > maxAgeMs) continue;
    if (daysMs != null && age > daysMs) continue;
    toDelete.push(m);
  }

  const ids = toDelete.map((m) => m.id);
  if (!ids.length) return 0;

  await channel.bulkDelete(ids, true);
  return ids.length;
}

client.on("interactionCreate", async (interaction) => {
  try {
    // ====== MODALS ======
    if (interaction.isModalSubmit()) {
      if (!hasAdminAccess(interaction)) return interaction.reply({ content: "❌ Нет доступа.", flags: 64 });

      if (interaction.customId === "panel_login_modal") {
        const pw = String(interaction.fields.getTextInputValue("panel_pw") || "");
        const expected = getApanelHash(interaction.guild?.id);

        if (!expected) {
          return interaction.reply({ content: "❌ Пароль не задан. Админ должен сделать /apanel_set.", flags: 64 });
        }

        const ok = sha256Hex(pw) === expected;
        if (!ok) return interaction.reply({ content: "❌ Неверный пароль.", flags: 64 });

        apanelGrant(interaction.user.id, interaction.guild.id);

        // если это модалка из кнопок — просто покажем панель
        const state = getState(interaction.user.id);
        if (!state.mode) state.mode = "home";
        return showPanel(interaction, { update: false });
      }

      if (interaction.customId === "broadcast_modal") {
        const state = getState(interaction.user.id);
        state.broadcast.title = String(interaction.fields.getTextInputValue("m_title") || "").slice(0, 100);
        state.broadcast.desc = String(interaction.fields.getTextInputValue("m_desc") || "").slice(0, 4000);
        return showPanel(interaction, { update: true });
      }

      if (interaction.customId === "broadcast_channels_modal") {
        const state = getState(interaction.user.id);
        const raw = String(interaction.fields.getTextInputValue("m_channels") || "");
        const ids = raw
          .split(/[\s,]+/g)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => s.replace(/[<#>]/g, ""))
          .filter((s) => /^\d{10,20}$/.test(s));

        state.broadcast.channelIds = Array.from(new Set(ids)).slice(0, 10);
        return showPanel(interaction, { update: true });
      }

      if (interaction.customId === "mod_send_modal") {
        if (!apanelIsActive(interaction)) return interaction.reply({ content: "❌ Нужен вход (/apanel).", flags: 64 });

        const ch = interaction.channel;
        if (!ch?.isTextBased?.()) return interaction.reply({ content: "❌ Это не текстовый канал.", flags: 64 });

        const text = String(interaction.fields.getTextInputValue("m_text") || "").trim().slice(0, 1800);
        if (!text) return interaction.reply({ content: "❌ Пусто.", flags: 64 });

        await ch.send({ content: text });
        return interaction.reply({ content: "✅ Отправлено.", flags: 64 });
      }

      if (interaction.customId === "mod_kick_modal") {
        if (!apanelIsActive(interaction)) return interaction.reply({ content: "❌ Нужен вход (/apanel).", flags: 64 });

        const userId = String(interaction.fields.getTextInputValue("m_user") || "").replace(/[<@!>]/g, "").trim();
        const reason = String(interaction.fields.getTextInputValue("m_reason") || "").trim().slice(0, 250);

        if (!/^\d{10,20}$/.test(userId)) return interaction.reply({ content: "❌ Неверный user id.", flags: 64 });

        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (!member) return interaction.reply({ content: "❌ Не нашёл участника.", flags: 64 });

        await member.kick(reason || "Kick via panel");
        return interaction.reply({ content: `✅ Kick: <@${userId}>`, flags: 64 });
      }

      if (interaction.customId === "mod_ban_modal") {
        if (!apanelIsActive(interaction)) return interaction.reply({ content: "❌ Нужен вход (/apanel).", flags: 64 });

        const userId = String(interaction.fields.getTextInputValue("m_user") || "").replace(/[<@!>]/g, "").trim();
        const minsRaw = String(interaction.fields.getTextInputValue("m_minutes") || "").trim();
        const reason = String(interaction.fields.getTextInputValue("m_reason") || "").trim().slice(0, 250);

        if (!/^\d{10,20}$/.test(userId)) return interaction.reply({ content: "❌ Неверный user id.", flags: 64 });

        const mins = minsRaw ? Math.max(1, Math.min(60 * 24 * 7, Math.floor(Number(minsRaw)))) : 0;

        await interaction.guild.members.ban(userId, { reason: reason || "Ban via panel" });

        if (mins > 0) {
          setTimeout(async () => {
            try { await interaction.guild.bans.remove(userId, "Temp ban expired"); } catch {}
          }, mins * 60 * 1000);
        }

        return interaction.reply({ content: `✅ Ban: <@${userId}>${mins > 0 ? ` на ${mins} мин.` : ""}`, flags: 64 });
      }

      if (interaction.customId === "cleanup_modal") {
        if (!apanelIsActive(interaction)) return interaction.reply({ content: "❌ Нужен вход (/apanel).", flags: 64 });

        const state = getState(interaction.user.id);
        const rawCount = String(interaction.fields.getTextInputValue("cleanup_count") || "").trim();
        const rawDays = String(interaction.fields.getTextInputValue("cleanup_days") || "").trim();

        state.cleanup.count = rawCount ? Math.min(100, Math.max(1, Math.floor(Number(rawCount)))) : 50;
        state.cleanup.days = rawDays ? Math.min(14, Math.max(0, Math.floor(Number(rawDays)))) : 0;

        return showPanel(interaction, { update: true });
      }
    }

    // ====== BUTTONS ======
    if (interaction.isButton()) {
      if (!hasAdminAccess(interaction)) return interaction.reply({ content: "❌ Нет доступа.", flags: 64 });

      const state = getState(interaction.user.id);

      const navMap = {
        panel_nav_home: "home",
        panel_nav_broadcast: "broadcast",
        panel_nav_moderation: "moderation",
        panel_nav_cleanup: "cleanup"
      };
      if (navMap[interaction.customId]) {
        state.mode = navMap[interaction.customId];
        return showPanel(interaction, { update: true });
      }

      // Broadcast
      if (interaction.customId === "broadcast_toggle_pin") {
        state.broadcast.pin = !state.broadcast.pin;
        return showPanel(interaction, { update: true });
      }
      if (interaction.customId === "broadcast_edit") {
        const modal = new ModalBuilder().setCustomId("broadcast_modal").setTitle("Редактор рассылки");

        const titleInput = new TextInputBuilder()
          .setCustomId("m_title")
          .setLabel("Заголовок")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
          .setValue(String(state.broadcast.title || "").slice(0, 100));

        const descInput = new TextInputBuilder()
          .setCustomId("m_desc")
          .setLabel("Текст")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(4000)
          .setValue(String(state.broadcast.desc || "").slice(0, 4000));

        modal.addComponents(
          new ActionRowBuilder().addComponents(titleInput),
          new ActionRowBuilder().addComponents(descInput)
        );

        return interaction.showModal(modal);
      }
      if (interaction.customId === "broadcast_channels") {
        const modal = new ModalBuilder().setCustomId("broadcast_channels_modal").setTitle("Каналы рассылки");

        const inp = new TextInputBuilder()
          .setCustomId("m_channels")
          .setLabel("ID каналов через пробел/запятую (можно <#id>)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(800)
          .setValue((state.broadcast.channelIds || []).join(" "));

        modal.addComponents(new ActionRowBuilder().addComponents(inp));
        return interaction.showModal(modal);
      }
      if (interaction.customId === "broadcast_send") {
        if (!(await ensureApanel(interaction))) return;

        if (!state.broadcast.channelIds?.length) {
          return interaction.reply({ content: "❌ Выбери хотя бы один канал.", flags: 64 });
        }

        const embed = new EmbedBuilder()
          .setTitle(state.broadcast.title || "Broadcast")
          .setDescription(state.broadcast.desc || "")
          .setColor(color())
          .setTimestamp(new Date());

        const results = [];
        for (const channelId of state.broadcast.channelIds) {
          try {
            const ch = await interaction.guild.channels.fetch(channelId);
            if (!ch || ch.type !== ChannelType.GuildText) { results.push(`❌ <#${channelId}> (не текстовый)`); continue; }
            const msg = await ch.send({ embeds: [embed] });
            if (state.broadcast.pin) await msg.pin().catch(() => {});
            results.push(`✅ <#${channelId}>`);
          } catch (e) {
            results.push(`❌ <#${channelId}> (${String(e?.message || e).slice(0, 80)})`);
          }
        }

        return interaction.reply({ content: "Результат:\n" + results.join("\n"), flags: 64 });
      }

      // Moderation
      if (interaction.customId === "mod_send") {
        if (!(await ensureApanel(interaction))) return;

        const modal = new ModalBuilder().setCustomId("mod_send_modal").setTitle("Send message");
        const text = new TextInputBuilder()
          .setCustomId("m_text")
          .setLabel("Текст")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1800);

        modal.addComponents(new ActionRowBuilder().addComponents(text));
        return interaction.showModal(modal);
      }

      if (interaction.customId === "mod_kick") {
        if (!(await ensureApanel(interaction))) return;

        const modal = new ModalBuilder().setCustomId("mod_kick_modal").setTitle("Kick user");
        const user = new TextInputBuilder()
          .setCustomId("m_user")
          .setLabel("User ID или <@mention>")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const reason = new TextInputBuilder()
          .setCustomId("m_reason")
          .setLabel("Причина (опц.)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false);

        modal.addComponents(new ActionRowBuilder().addComponents(user), new ActionRowBuilder().addComponents(reason));
        return interaction.showModal(modal);
      }

      if (interaction.customId === "mod_ban") {
        if (!(await ensureApanel(interaction))) return;

        const modal = new ModalBuilder().setCustomId("mod_ban_modal").setTitle("Ban user");

        const user = new TextInputBuilder()
          .setCustomId("m_user")
          .setLabel("User ID или <@mention>")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const minutes = new TextInputBuilder()
          .setCustomId("m_minutes")
          .setLabel("Minutes (опц., пусто = навсегда)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false);

        const reason = new TextInputBuilder()
          .setCustomId("m_reason")
          .setLabel("Причина (опц.)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false);

        modal.addComponents(
          new ActionRowBuilder().addComponents(user),
          new ActionRowBuilder().addComponents(minutes),
          new ActionRowBuilder().addComponents(reason)
        );
        return interaction.showModal(modal);
      }

      // Cleanup
      if (interaction.customId === "cleanup_edit") {
        if (!(await ensureApanel(interaction))) return;

        const modal = new ModalBuilder().setCustomId("cleanup_modal").setTitle("Cleanup settings");

        const count = new TextInputBuilder()
          .setCustomId("cleanup_count")
          .setLabel("count (1-100)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(String(state.cleanup.count || 50));

        const days = new TextInputBuilder()
          .setCustomId("cleanup_days")
          .setLabel("days (0-14, 0 = ignore)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(String(state.cleanup.days || 0));

        modal.addComponents(new ActionRowBuilder().addComponents(count), new ActionRowBuilder().addComponents(days));
        return interaction.showModal(modal);
      }

      if (interaction.customId === "cleanup_run") {
        if (!(await ensureApanel(interaction))) return;

        const ch = interaction.channel;
        if (!ch || ch.type !== ChannelType.GuildText) {
          return interaction.reply({ content: "❌ Это работает только в текстовом канале.", flags: 64 });
        }

        await interaction.reply({ content: "🧹 Удаляю…", flags: 64 });

        const deleted = await doClearMessages(ch, { count: state.cleanup.count, days: state.cleanup.days || null });

        return interaction.editReply({ content: `✅ Удалено: ${deleted}`, flags: 64 });
      }

      return;
    }

    // ====== Slash commands ======
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "panel") {
      if (!hasAdminAccess(interaction)) return interaction.reply({ content: "❌ Нет доступа.", flags: 64 });

      if (!apanelIsActive(interaction)) {
        const modal = new ModalBuilder().setCustomId("panel_login_modal").setTitle("Вход в админ‑панель");
        const pw = new TextInputBuilder().setCustomId("panel_pw").setLabel("Пароль").setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(pw));
        return interaction.showModal(modal);
      }

      const state = getState(interaction.user.id);
      state.mode = "home";
      return showPanel(interaction);
    }

    if (interaction.commandName === "apanel_set") {
      if (!hasAdminAccess(interaction)) return interaction.reply({ content: "⛔ Нет прав.", flags: 64 });
      const pw = interaction.options.getString("password", true).trim();
      if (pw.length < 4) return interaction.reply({ content: "❌ Пароль слишком короткий.", flags: 64 });
      setApanelHash(interaction.guild.id, pw);
      return interaction.reply({ content: "✅ Пароль сохранён.", flags: 64 });
    }

    if (interaction.commandName === "apanel") {
      if (!hasAdminAccess(interaction)) return interaction.reply({ content: "⛔ Нет прав.", flags: 64 });

      const pw = interaction.options.getString("password", true);
      const expected = getApanelHash(interaction.guild.id);

      if (!expected) return interaction.reply({ content: "❌ Пароль не задан. Сделай /apanel_set.", flags: 64 });
      if (sha256Hex(pw) !== expected) return interaction.reply({ content: "❌ Неверный пароль.", flags: 64 });

      apanelGrant(interaction.user.id, interaction.guild.id);
      return interaction.reply({ content: "✅ Вход выполнен (5 минут).", flags: 64 });
    }

    // require session helpers
    const needSession = async () => {
      if (!hasAdminAccess(interaction)) {
        await interaction.reply({ content: "⛔ Нет прав.", flags: 64 });
        return false;
      }
      if (!apanelIsActive(interaction)) {
        await interaction.reply({ content: "❌ Нужен вход через /apanel или /panel (пароль).", flags: 64 });
        return false;
      }
      return true;
    };

    if (interaction.commandName === "s") {
      if (!(await needSession())) return;
      const text = interaction.options.getString("text", true);
      const channel = interaction.options.getChannel("channel", false) || interaction.channel;
      if (!channel?.isTextBased?.()) return interaction.reply({ content: "❌ Это не текстовый канал.", flags: 64 });
      await channel.send({ content: text });
      return interaction.reply({ content: "✅ Отправлено.", flags: 64 });
    }

    if (interaction.commandName === "kick") {
      if (!(await needSession())) return;
      const user = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason") || "Kick via /kick";
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return interaction.reply({ content: "❌ Не нашёл участника.", flags: 64 });
      await member.kick(reason);
      return interaction.reply({ content: `✅ Kick: <@${user.id}>`, flags: 64 });
    }

    if (interaction.commandName === "ban") {
      if (!(await needSession())) return;
      const user = interaction.options.getUser("user", true);
      const minutes = interaction.options.getInteger("minutes") || 0;
      const reason = interaction.options.getString("reason") || "Ban via /ban";
      await interaction.guild.members.ban(user.id, { reason });
      if (minutes > 0) {
        setTimeout(async () => {
          try { await interaction.guild.bans.remove(user.id, "Temp ban expired"); } catch {}
        }, minutes * 60 * 1000);
      }
      return interaction.reply({ content: `✅ Ban: <@${user.id}>${minutes > 0 ? ` на ${minutes} мин.` : ""}`, flags: 64 });
    }

    if (interaction.commandName === "clear") {
      if (!(await needSession())) return;
      const ch = interaction.channel;
      if (!ch || ch.type !== ChannelType.GuildText) {
        return interaction.reply({ content: "❌ Это работает только в текстовом канале.", flags: 64 });
      }
      const count = interaction.options.getInteger("count") || 100;
      const days = interaction.options.getInteger("days") || null;
      await interaction.reply({ content: "🧹 Удаляю…", flags: 64 });
      const deleted = await doClearMessages(ch, { count, days });
      return interaction.editReply({ content: `✅ Удалено: ${deleted}`, flags: 64 });
    }
  } catch (e) {
    console.error("interaction error:", e);
    try {
      if (interaction?.replied || interaction?.deferred) {
        await interaction.followUp({ content: "❌ Ошибка.", flags: 64 });
      } else {
        await interaction.reply({ content: "❌ Ошибка.", flags: 64 });
      }
    } catch {}
  }
});

/* =========================================================
   HEALTH SERVER (Railway)
========================================================= */

const app = express();
app.get("/", (req, res) => res.status(200).send("OK"));
app.listen(PORT, () => console.log(`🌐 Health server on :${PORT}`));

/* =========================================================
   START
========================================================= */

(async () => {
  await registerCommands().catch((e) => console.error("❌ registerCommands error:", e));
  await client.login(TOKEN);
})();
