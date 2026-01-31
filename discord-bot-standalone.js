import "dotenv/config";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Client as DiscordClient, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits, ChannelType } from "discord.js";

// Supabase service client (required for role sync / access updates)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Discord env helpers
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || "";
const DISCORD_APP_ID = process.env.DISCORD_APP_ID || process.env.DISCORD_CLIENT_ID || "";
let DISCORD_CLIENT_REF = null;

// Local in-memory app.locals replacement (this bot runs standalone, without Express)
const appLocals = {};

async function registerDiscordCommands() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const appId = process.env.DISCORD_APP_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !appId || !guildId) {
    console.log("[discord] commands registered: /panel, /apanel_set, /clear");
    return;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName("panel")
      .setDescription("Открыть админ-панель (пароль + функции)")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("clear")
      .setDescription("Очистить сообщения в текущем канале")
      .addIntegerOption((o) => o.setName("count").setDescription("Сколько последних сообщений удалить (1-100)").setMinValue(1).setMaxValue(100))
      .addIntegerOption((o) => o.setName("days").setDescription("Удалить сообщения только за последние X дней (1-14)").setMinValue(1).setMaxValue(14))
      .toJSON(),
  ];

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });
  console.log("[discord] /panel command registered");
}

async function logModAction(client, guild, action, targetId, byId, reason) {
    const logId = String(process.env.MOD_LOG_CHANNEL_ID || "");
    if (!logId) return;
    try {
      const ch = await client.channels.fetch(logId);
      if (!ch || ch.type !== ChannelType.GuildText) return;
      const e = new EmbedBuilder()
        .setTitle("🧑‍⚖️ Mod action: " + action)
        .setColor(color())
        .addFields(
          { name: "Target", value: targetId ? `<@${targetId}> (${targetId})` : "n/a", inline: false },
          { name: "By", value: byId ? `<@${byId}> (${byId})` : "n/a", inline: false },
          { name: "Reason", value: reason || "—", inline: false }
        )
        .setTimestamp(new Date());
      await ch.send({ embeds: [e] });
    } catch { }
  }

async function setAccessStatusByDiscordId() { }

async function setUserRoleInDbByDiscordId(supabase, discordId, nextRole, vipUntilIso) {
    // Find the user row first (some DBs don't have discord_id filled until first login)
    const { data: u, error: selErr } = await supabase
      .from("users")
      .select("id, role, discord_id")
      .eq("discord_id", String(discordId))
      .maybeSingle();

    if (selErr) return { ok: false, error: selErr.message };
    if (!u?.id) return { ok: false, error: "USER_NOT_LINKED" };

    const patch = { role: nextRole, updated_at: new Date().toISOString() };
    if (vipUntilIso !== undefined) patch.vip_until = vipUntilIso;

    const { error: upErr } = await supabase.from("users").update(patch).eq("id", u.id);
    if (upErr) return { ok: false, error: upErr.message };

    return { ok: true, userId: u.id };
  }

async function ensureMember(guild, userId) {
    if (!guild || !userId) return null;
    try { return await guild.members.fetch(userId); } catch { return null; }
  }

async function syncVipRoleForUser(guild, discordId, role) {
    const vipRoleId = String(process.env.DISCORD_ROLE_VIP_ID || "");
    const goldRoleId = String(process.env.DISCORD_ROLE_GOLD_ID || "");
    const m = await ensureMember(guild, discordId);
    if (!m) return { ok: false, reason: "member_not_found" };

    // role in DB: "vip" | "gold" | "user"
    try {
      if (role === "gold") {
        if (vipRoleId) await m.roles.remove(vipRoleId).catch(() => { });
        if (goldRoleId) await m.roles.add(goldRoleId).catch(() => { });
      } else if (role === "vip") {
        if (goldRoleId) await m.roles.remove(goldRoleId).catch(() => { });
        if (vipRoleId) await m.roles.add(vipRoleId).catch(() => { });
      } else {
        if (vipRoleId) await m.roles.remove(vipRoleId).catch(() => { });
        if (goldRoleId) await m.roles.remove(goldRoleId).catch(() => { });
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e?.message || String(e) };
    }
  }

async function requireApanel(interaction) {
    if (!interaction.guild) {
      await interaction.reply({ content: "Эта команда работает только на сервере.", flags: 64 }).catch(() => { });
      return false;
    }
    if (!apanelIsActive(interaction)) {
      await interaction.reply({ content: "🔒 Сессия админ-панели не активна. Открой: `/panel` и введи пароль", flags: 64 }).catch(() => { });
      return false;
    }
    if (!hasAdminAccess(interaction)) {
      apanelRevoke(interaction.user.id);
      await interaction.reply({ content: "❌ У тебя больше нет роли/прав Admin. Доступ закрыт.", flags: 64 }).catch(() => { });
      return false;
    }
    return true;
  }

async function getApanelPasswordHash(guildId) {
    const gid = String(guildId || "");
    const now = Date.now();
    const cached = APANEL_PW_CACHE.get(gid);
    if (cached && (now - cached.cachedAtMs) < 30_000) return cached.hash;

    // 1) Supabase table (preferred)
    try {
      const { data, error } = await supabase
        .from("apanel_settings")
        .select("password_hash")
        .eq("guild_id", gid)
        .maybeSingle();

      if (!error && data?.password_hash) {
        const h = String(data.password_hash).trim();
        APANEL_PW_CACHE.set(gid, { hash: h, cachedAtMs: now });
        return h;
      }
    } catch { }

    // 2) ENV fallback
    const envHash = String(process.env.APANEL_PASSWORD_HASH || "").trim();
    const envPlain = String(process.env.APANEL_PASSWORD || "").trim();
    const h2 = envHash || (envPlain ? sha256Hex(envPlain) : null);
    APANEL_PW_CACHE.set(gid, { hash: h2 || null, cachedAtMs: now });
    return h2 || null;
  }

async function listTextChannelOptions(guild) {
    const chans = await guild.channels.fetch();
    const textChans = chans
      .filter((c) => c && c.type === ChannelType.GuildText)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .first(25);
    return textChans.map((c) => ({ label: "#" + c.name, value: c.id }));
  }

async function buildStatsEmbed(state, guild, supabase) {
    const e = baseEmbed("📊 Статистика", "Короткая сводка по серверу и базе.");
    const members = guild ? (guild.memberCount ?? null) : null;

    let vipCount = null, goldCount = null, activeCount = null;
    try {
      const r1 = await supabase.from("users").select("id", { count: "exact", head: true }).eq("role", "vip");
      vipCount = r1?.count ?? null;
      const r2 = await supabase.from("users").select("id", { count: "exact", head: true }).eq("role", "gold");
      goldCount = r2?.count ?? null;
      const r3 = await supabase.from("users").select("id", { count: "exact", head: true }).not("discord_id", "is", null);
      activeCount = r3?.count ?? null;
    } catch { }

    e.addFields(
      { name: "Discord members", value: members == null ? "n/a" : String(members), inline: true },
      { name: "DB active", value: activeCount == null ? "n/a" : String(activeCount), inline: true },
      { name: "VIP / GOLD", value: `${vipCount == null ? "n/a" : vipCount} / ${goldCount == null ? "n/a" : goldCount}`, inline: true }
    );
    return e;
  }

async function buildHistoryEmbed(state, guild, supabase) {
    const discordId = state?.history?.discordId || null;
    const e = baseEmbed("🕘 История", discordId ? `История действий по пользователю <@${discordId}>` : "Выбери пользователя, чтобы увидеть историю действий.");

    if (!discordId) return e;

    try {
      const { data: u, error: uErr } = await supabase
        .from("users")
        .select("id, role, discord_id")
        .eq("discord_id", String(discordId))
        .maybeSingle();

      if (uErr) throw new Error(uErr.message);
      if (!u?.id) {
        e.setDescription("Этот пользователь ещё не связан с аккаунтом в приложении (нет discord_id в users).");
        return e;
      }

      const { data: rows, error } = await supabase
        .from("admin_audit")
        .select("created_at, admin_id, action, meta")
        .eq("target_user_id", u.id)
        .order("created_at", { ascending: false })
        .limit(15);

      if (error) throw new Error(error.message);

      if (!rows?.length) {
        e.setDescription(`По <@${discordId}> пока нет записей.`);
        return e;
      }

      const lines = rows.map((r) => {
        const t = r.created_at ? new Date(r.created_at).toLocaleString("ru-RU") : "—";
        const a = String(r.action || "—");
        const admin = r.admin_id ? String(r.admin_id).slice(0, 8) : "—";
        return `• **${a}** | ${t} | admin: \`${admin}\``;
      });

      e.setDescription(lines.join("\n"));
      return e;
    } catch (err) {
      e.setDescription("Не смог загрузить историю из базы. Проверь Supabase / users / admin_audit.");
      return e;
    }
  }

async function buildLogsEmbed(state, guild, supabase) {
    const e = baseEmbed("🧾 Логи", "Последние действия (admin_audit).");
    const MOD_LOG_CHANNEL_ID = process.env.MOD_LOG_CHANNEL_ID || "";
    if (MOD_LOG_CHANNEL_ID) e.addFields({ name: "Канал логов", value: `<#${MOD_LOG_CHANNEL_ID}>`, inline: false });

    try {
      const { data: rows, error } = await supabase
        .from("admin_audit")
        .select("created_at, admin_id, target_user_id, action")
        .order("created_at", { ascending: false })
        .limit(12);

      if (error) throw new Error(error.message);

      if (!rows?.length) {
        e.setDescription("Логов пока нет.");
        return e;
      }

      const lines = rows.map((r) => {
        const t = r.created_at ? new Date(r.created_at).toLocaleString("ru-RU") : "—";
        const a = String(r.action || "—");
        const admin = r.admin_id ? String(r.admin_id).slice(0, 8) : "—";
        const target = r.target_user_id ? String(r.target_user_id).slice(0, 8) : "—";
        return `• **${a}** | ${t}\n  admin: \`${admin}\` → target: \`${target}\``;
      });

      e.setDescription(lines.join("\n"));
      return e;
    } catch (err) {
      e.setDescription("Не смог загрузить логи из базы. Проверь Supabase / таблицу admin_audit.");
      return e;
    }
  }

async function upsertPinnedEmbed(channel, embed) {
  // Ищем закреплённое сообщение бота в этом канале и обновляем его.
  const pins = await channel.messages.fetchPinned();
  const mine = pins.find((msg) => msg.author?.id === channel.client.user.id);

  if (mine) {
    await mine.edit({ embeds: [embed] });
    return mine;
  }

  const msg = await channel.send({ embeds: [embed] });
  try {
    await msg.pin();
  } catch (e) {
    console.log("[discord] pin failed in #" + channel.name + ":", e?.message || e);
  }
  return msg;
}

async function upsertLastEmbed(channel, embed) {
  // Чтобы не спамить, если "закреплять" выключено: обновляем последнее сообщение бота в канале.
  const msgs = await channel.messages.fetch({ limit: 50 });
  const mine = msgs.find((m) => m.author?.id === channel.client.user.id);

  if (mine) {
    await mine.edit({ embeds: [embed] });
    return mine;
  }
  return channel.send({ embeds: [embed] });
}

async function closeTicket(interaction) {
    const ch = interaction.channel;
    if (!ch || ch.type !== ChannelType.GuildText) return { ok: false, error: "not_text_channel" };

    try {
      await ch.send({ content: "✅ Тикет закрыт. Канал будет удалён через 10 секунд." });
    } catch { }

    // best-effort db
    try {
      await supabase.from("tickets").update({ status: "closed", closed_at: new Date().toISOString() }).eq("channel_id", ch.id);
    } catch { }

    setTimeout(async () => {
      try { await ch.delete("Ticket closed"); } catch { }
    }, 10_000);

    return { ok: true };
  }

async function startDiscordBot() {
  const BOT_ENABLED = String(process.env.DISCORD_BOT_ENABLED ?? "").trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(BOT_ENABLED)) {
    console.log("[discord] bot disabled (DISCORD_BOT_ENABLED)");
    return;
  }
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) {
    console.log("[discord] bot disabled (missing DISCORD_BOT_TOKEN or DISCORD_GUILD_ID)");
    return;
  }

  const client = new DiscordClient({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildBans],
    partials: [Partials.GuildMember, Partials.User],
  });

  DISCORD_CLIENT_REF = client;

  client.once("ready", async () => {
    console.log(`[discord] logged in as ${client.user?.tag || client.user?.id}`);

    // регаем /setup при старте (нужны DISCORD_APP_ID и DISCORD_GUILD_ID в .env)
    try {
      await registerDiscordCommands();
    } catch (e) {
      console.error("[discord] command register failed:", e?.message || e);
    }

    // тестовое сообщение (если указан DISCORD_TEST_CHANNEL_ID)
    const testChannelId = process.env.DISCORD_TEST_CHANNEL_ID;
    if (testChannelId) {
      try {
        const ch = await client.channels.fetch(testChannelId);
        await ch.send("✅ Бот подключён и может писать сообщения.");
      } catch (e) {
        console.error("[discord] failed to send test message:", e?.message || e);
      }
    }

    // каждые 10 сек: выкидываем из /apanel если истекло 5 минут или забрали роль/права
    setInterval(async () => {
      try {
        for (const [userId, s] of APANEL_SESSIONS.entries()) {
          if (!s || Date.now() > Number(s.expiresAtMs || 0)) {
            APANEL_SESSIONS.delete(userId);
            continue;
          }
          const gid = String(s.guildId || "");
          const guild = gid ? await client.guilds.fetch(gid).catch(() => null) : null;
          if (!guild) { APANEL_SESSIONS.delete(userId); continue; }
          const member = await guild.members.fetch(userId).catch(() => null);
          if (!member) { APANEL_SESSIONS.delete(userId); continue; }

          // проверяем админ права/роль (логика как в hasAdminAccess)
          const envRoleId = String(process.env.ADMIN_ROLE_ID || "");
          const ok =
            member.permissions?.has(PermissionFlagsBits.Administrator)
            || (envRoleId && member.roles?.cache?.has(envRoleId))
            || !!member.roles?.cache?.some((r) => String(r.name || "").toLowerCase() === "admin");

          if (!ok) APANEL_SESSIONS.delete(userId);
        }
      } catch { }
    }, 10_000);

    // каждые 20 сек: авто-разбан по таймеру (если используешь temp ban)
    setInterval(async () => {
      try {
        const nowIso = new Date().toISOString();
        const { data: rows, error } = await supabase
          .from("temp_bans")
          .select("id,guild_id,user_id")
          .lte("unban_at", nowIso)
          .is("processed_at", null)
          .limit(50);

        if (error || !rows?.length) return;

        for (const r of rows) {
          const guild = await client.guilds.fetch(String(r.guild_id)).catch(() => null);
          if (!guild) {
            await supabase.from("temp_bans").update({ processed_at: nowIso, processed_error: "no_guild" }).eq("id", r.id).catch(() => { });
            continue;
          }

          const uid = String(r.user_id);
          await guild.bans.remove(uid, "Temp ban expired").catch(async (e) => {
            await supabase.from("temp_bans").update({ processed_at: nowIso, processed_error: String(e?.message || e) }).eq("id", r.id).catch(() => { });
          });
          await supabase.from("temp_bans").update({ processed_at: nowIso }).eq("id", r.id).catch(() => { });
        }
      } catch { }
    }, 20_000);
  });


  // =======================
  // PANEL (home + modules)
  // =======================
  // In-memory state per admin user (ephemeral UI)
  const PANEL_STATE = new Map();

  // =======================
  // APANEL (password + short session)
  // =======================
  // userId -> { guildId, expiresAtMs }
  const APANEL_SESSIONS = new Map();
  // cache password hash per guild for a short time
  const APANEL_PW_CACHE = new Map(); // guildId -> { hash: string|null, cachedAtMs: number }

  function sha256Hex(s) {
    return crypto.createHash("sha256").update(String(s ?? "")).digest("hex");
  }

  async function getApanelPasswordHash(guildId) {
    const gid = String(guildId || "");
    const now = Date.now();
    const cached = APANEL_PW_CACHE.get(gid);
    if (cached && (now - cached.cachedAtMs) < 30_000) return cached.hash;

    // 1) Supabase table (preferred)
    try {
      const { data, error } = await supabase
        .from("apanel_settings")
        .select("password_hash")
        .eq("guild_id", gid)
        .maybeSingle();

      if (!error && data?.password_hash) {
        const h = String(data.password_hash).trim();
        APANEL_PW_CACHE.set(gid, { hash: h, cachedAtMs: now });
        return h;
      }
    } catch { }

    // 2) ENV fallback
    const envHash = String(process.env.APANEL_PASSWORD_HASH || "").trim();
    const envPlain = String(process.env.APANEL_PASSWORD || "").trim();
    const h2 = envHash || (envPlain ? sha256Hex(envPlain) : null);
    APANEL_PW_CACHE.set(gid, { hash: h2 || null, cachedAtMs: now });
    return h2 || null;
  }

  function apanelGrant(guildId, userId) {
    const expiresAtMs = Date.now() + 5 * 60 * 1000; // 5 minutes
    APANEL_SESSIONS.set(String(userId), { guildId: String(guildId), expiresAtMs });
  }

  function apanelRevoke(userId) {
    APANEL_SESSIONS.delete(String(userId));
  }

  function apanelIsActive(interaction) {
    const s = APANEL_SESSIONS.get(String(interaction.user.id));
    if (!s) return false;
    if (String(s.guildId) !== String(interaction.guild?.id || "")) return false;
    if (Date.now() > Number(s.expiresAtMs || 0)) return false;
    return true;
  }

  async function requireApanel(interaction) {
    if (!interaction.guild) {
      await interaction.reply({ content: "Эта команда работает только на сервере.", flags: 64 }).catch(() => { });
      return false;
    }
    if (!apanelIsActive(interaction)) {
      await interaction.reply({ content: "🔒 Сессия админ-панели не активна. Открой: `/panel` и введи пароль", flags: 64 }).catch(() => { });
      return false;
    }
    if (!hasAdminAccess(interaction)) {
      apanelRevoke(interaction.user.id);
      await interaction.reply({ content: "❌ У тебя больше нет роли/прав Admin. Доступ закрыт.", flags: 64 }).catch(() => { });
      return false;
    }
    return true;
  }
  // userId -> {
  //   mode: "home" | "broadcast" | "moderation" | "vip" | "presets" | "tickets" | "automod" | "stats" | "settings",
  //   broadcast: { channelIds: string[], title: string, desc: string, pin: boolean },
  //   moderation: { targetId: string|null, action: "kick"|"ban"|"mute"|"unmute"|null },
  //   vip: { targetId: string|null, action: "give_vip"|"give_gold"|"remove_roles"|null, days: number|null },
  //   presets: { preset: "welcome"|"rules"|"download"|"news"|"links"|null, channelId: string|null, pin: boolean },
  //   tickets: { action: "create"|"close"|null, targetChannelId: string|null },
  //   automod: { antiInvite: boolean, antiSpam: boolean },
  // }

  function hasAdminAccess(interaction) {
    // 1) Discord permission "Administrator"
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;

    // 2) role id from env (optional)
    const envRoleId = String(process.env.ADMIN_ROLE_ID || "");
    const roles = interaction.member?.roles;
    if (roles?.cache) {
      if (envRoleId && roles.cache.has(envRoleId)) return true;

      // 3) role name "admin"
      const ok = roles.cache.some((r) => String(r.name || "").toLowerCase() === "admin");
      if (ok) return true;
    }
    return false;
  }

  function getState(userId) {
    if (!PANEL_STATE.has(userId)) {
      PANEL_STATE.set(userId, {
        mode: "home",
        broadcast: { channelIds: [], title: "Night Core", desc: "Напиши текст через кнопку ✍️ Текст", pin: true },
        moderation: { targetId: null, action: null },
        vip: { targetId: null, action: null, days: 30 },
        history: { discordId: null },
        logs: {},
        cleanup: { count: 50, days: null },
        automod: { antiInvite: true, antiSpam: true },
      });
    }
    return PANEL_STATE.get(userId);
  }

  function color() {
    return 0x111827;
  }

  function baseEmbed(title, desc) {
    return new EmbedBuilder().setTitle(title).setDescription(desc || "").setColor(color()).setFooter({ text: "Night Core Panel" });
  }

  function buildHomeEmbed(state) {
    const e = baseEmbed("🧩 Night Core — Панель", "Выбери раздел ниже.");
    e.addFields(
      {
        name: "Модули",
        value: `📤 Рассылка
🧑‍⚖️ Модерация
🧹 Clear
📜 Логи
👤 История
💎 VIP/GOLD`,
        inline: false
      },

      { name: "Закреплять", value: (state?.broadcast?.pin ? "✅ Да" : "❌ Нет"), inline: true }
    );
    return e;
  }

  function buildModerationEmbed(state) {
    const t = state.moderation.targetId ? `<@${state.moderation.targetId}>` : "не выбран";
    const e = baseEmbed("🧑‍⚖️ Модерация", "Выбери пользователя и действие.");
    e.addFields(
      { name: "Цель", value: t, inline: false },
      { name: "Действия", value: "👢 Kick • 🔨 Ban • 🔇 Mute (timeout) • 🔊 Unmute", inline: false }
    );
    return e;
  }

  function buildVipEmbed(state) {
    const t = state.vip.targetId ? `<@${state.vip.targetId}>` : "не выбран";
    const e = baseEmbed("💎 VIP / GOLD", "Выбери пользователя и действие с ролями + статусом в базе.");
    e.addFields(
      { name: "Цель", value: t, inline: false },
      { name: "Действия", value: "💎 Дать VIP • 🥇 Дать GOLD • 🧹 Снять VIP/GOLD", inline: false },
      { name: "Дни (если нужно)", value: state.vip.days == null ? "lifetime" : String(state.vip.days), inline: true }
    );
    return e;
  }

  function buildTicketsEmbed(state) {
    const e = baseEmbed("🎫 Тикеты", "Управление тикетами (создание — командой /ticket у пользователей).");
    e.addFields(
      { name: "Создание", value: "Пользователь пишет **/ticket** — бот создаёт приватный канал.", inline: false },
      { name: "Закрытие", value: "Внутри тикета будет кнопка «Закрыть тикет».", inline: false }
    );
    return e;
  }

  function buildAutomodEmbed(state) {
    const e = baseEmbed("🛡️ Автомод", "Переключай базовые защиты сервера.");
    e.addFields(
      { name: "Anti-Invite", value: state.automod.antiInvite ? "✅ Включено" : "❌ Выключено", inline: true },
      { name: "Anti-Spam", value: state.automod.antiSpam ? "✅ Включено" : "❌ Выключено", inline: true }
    );
    return e;
  }

  async function buildStatsEmbed(state, guild, supabase) {
    const e = baseEmbed("📊 Статистика", "Короткая сводка по серверу и базе.");
    const members = guild ? (guild.memberCount ?? null) : null;

    let vipCount = null, goldCount = null, activeCount = null;
    try {
      const r1 = await supabase.from("users").select("id", { count: "exact", head: true }).eq("role", "vip");
      vipCount = r1?.count ?? null;
      const r2 = await supabase.from("users").select("id", { count: "exact", head: true }).eq("role", "gold");
      goldCount = r2?.count ?? null;
      const r3 = await supabase.from("users").select("id", { count: "exact", head: true }).not("discord_id", "is", null);
      activeCount = r3?.count ?? null;
    } catch { }

    e.addFields(
      { name: "Discord members", value: members == null ? "n/a" : String(members), inline: true },
      { name: "DB active", value: activeCount == null ? "n/a" : String(activeCount), inline: true },
      { name: "VIP / GOLD", value: `${vipCount == null ? "n/a" : vipCount} / ${goldCount == null ? "n/a" : goldCount}`, inline: true }
    );
    return e;
  }

  function buildSettingsEmbed() {
    const e = baseEmbed("⚙️ Настройки", "Быстрые настройки панели/сервера.");
    e.addFields(
      { name: "Роли", value: "DISCORD_ROLE_VIP_ID, DISCORD_ROLE_GOLD_ID", inline: false },
      { name: "Тикеты", value: "TICKETS_CATEGORY_ID, SUPPORT_ROLE_ID (опц.)", inline: false },
      { name: "Логи", value: "MOD_LOG_CHANNEL_ID (опц.)", inline: false }
    );
    return e;
  }


  async function buildLogsEmbed(state, guild, supabase) {
    const e = baseEmbed("🧾 Логи", "Последние действия (admin_audit).");
    const MOD_LOG_CHANNEL_ID = process.env.MOD_LOG_CHANNEL_ID || "";
    if (MOD_LOG_CHANNEL_ID) e.addFields({ name: "Канал логов", value: `<#${MOD_LOG_CHANNEL_ID}>`, inline: false });

    try {
      const { data: rows, error } = await supabase
        .from("admin_audit")
        .select("created_at, admin_id, target_user_id, action")
        .order("created_at", { ascending: false })
        .limit(12);

      if (error) throw new Error(error.message);

      if (!rows?.length) {
        e.setDescription("Логов пока нет.");
        return e;
      }

      const lines = rows.map((r) => {
        const t = r.created_at ? new Date(r.created_at).toLocaleString("ru-RU") : "—";
        const a = String(r.action || "—");
        const admin = r.admin_id ? String(r.admin_id).slice(0, 8) : "—";
        const target = r.target_user_id ? String(r.target_user_id).slice(0, 8) : "—";
        return `• **${a}** | ${t}\n  admin: \`${admin}\` → target: \`${target}\``;
      });

      e.setDescription(lines.join("\n"));
      return e;
    } catch (err) {
      e.setDescription("Не смог загрузить логи из базы. Проверь Supabase / таблицу admin_audit.");
      return e;
    }
  }

  async function buildHistoryEmbed(state, guild, supabase) {
    const discordId = state?.history?.discordId || null;
    const e = baseEmbed("🕘 История", discordId ? `История действий по пользователю <@${discordId}>` : "Выбери пользователя, чтобы увидеть историю действий.");

    if (!discordId) return e;

    try {
      const { data: u, error: uErr } = await supabase
        .from("users")
        .select("id, role, discord_id")
        .eq("discord_id", String(discordId))
        .maybeSingle();

      if (uErr) throw new Error(uErr.message);
      if (!u?.id) {
        e.setDescription("Этот пользователь ещё не связан с аккаунтом в приложении (нет discord_id в users).");
        return e;
      }

      const { data: rows, error } = await supabase
        .from("admin_audit")
        .select("created_at, admin_id, action, meta")
        .eq("target_user_id", u.id)
        .order("created_at", { ascending: false })
        .limit(15);

      if (error) throw new Error(error.message);

      if (!rows?.length) {
        e.setDescription(`По <@${discordId}> пока нет записей.`);
        return e;
      }

      const lines = rows.map((r) => {
        const t = r.created_at ? new Date(r.created_at).toLocaleString("ru-RU") : "—";
        const a = String(r.action || "—");
        const admin = r.admin_id ? String(r.admin_id).slice(0, 8) : "—";
        return `• **${a}** | ${t} | admin: \`${admin}\``;
      });

      e.setDescription(lines.join("\n"));
      return e;
    } catch (err) {
      e.setDescription("Не смог загрузить историю из базы. Проверь Supabase / users / admin_audit.");
      return e;
    }
  }

  function buildCleanupEmbed(state) {
    const s = state?.cleanup || {};
    const count = Number(s.count || 50);
    const days = s.days != null ? Number(s.days) : null;

    const e = baseEmbed(
      "🧹 Clear",
      `Удаление сообщений в текущем канале.

⚠️ Discord не удаляет сообщения старше 14 дней через bulkDelete.`
    );

    e.addFields(
      { name: "Параметры", value: `count: **${count}**` + (days ? ` | days: **${days}**` : ""), inline: false },
      { name: "Как работает", value: "Нажми **Настроить / Удалить** → введи `count` (1-100) или `days` (1-14). Можно заполнить оба, тогда удалит максимум из `count`, но только за эти дни.", inline: false }
    );
    return e;
  }

  async function listTextChannelOptions(guild) {
    const chans = await guild.channels.fetch();
    const textChans = chans
      .filter((c) => c && c.type === ChannelType.GuildText)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .first(25);
    return textChans.map((c) => ({ label: "#" + c.name, value: c.id }));
  }

  function homeComponents() {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel_nav_broadcast").setLabel("📤 Рассылка").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("panel_nav_moderation").setLabel("🧑‍⚖️ Модерация").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("panel_nav_vip").setLabel("💎 VIP/GOLD").setStyle(ButtonStyle.Secondary),
    );

    // Второй ряд: полезное (без автомода/тикетов/настроек)
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel_nav_stats").setLabel("📊 Статистика").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("panel_nav_logs").setLabel("🧾 Логи").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("panel_nav_history").setLabel("🕘 История").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("panel_nav_cleanup").setLabel("🧹 Clear").setStyle(ButtonStyle.Secondary),
    );

    return [row, row2];
  }

  function backRow() {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel_nav_home").setLabel("⬅️ Назад").setStyle(ButtonStyle.Secondary)
    );
  }


  function broadcastComponents(state, channelOptions) {
    const s = state.broadcast;

    const templateRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("broadcast_template")
        .setPlaceholder("Шаблон (опционально)")
        .setMinValues(0)
        .setMaxValues(1)
        .addOptions(
          { label: "— Без шаблона —", value: "none" },
          { label: "👋 Welcome", value: "welcome" },
          { label: "📜 Rules", value: "rules" },
          { label: "⏬ Download", value: "download" },
          { label: "📰 News", value: "news" },
          { label: "🔗 Links", value: "links" }
        )
    );

    const row1 = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("broadcast_channels")
        .setPlaceholder("Выбери каналы для рассылки")
        .setMinValues(1)
        .setMaxValues(Math.min(10, channelOptions.length || 1))
        .addOptions(channelOptions)
    );

    const pinLabel = (state?.broadcast?.pin ? "📌 Закреп: ВКЛ" : "📌 Закреп: ВЫК");

    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("broadcast_edit").setLabel("✍️ Текст").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("broadcast_preview").setLabel("👀 Превью").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("broadcast_toggle_pin").setLabel(pinLabel).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("broadcast_send").setLabel("📤 Разослать").setStyle(ButtonStyle.Success)
    );

    return [templateRow, row1, row2, backRow()];
  }

  function moderationComponents(state) {
    const targetRow = new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId("mod_user_select")
        .setPlaceholder("Выбери пользователя")
        .setMinValues(1)
        .setMaxValues(1)
    );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mod_kick").setLabel("👢 Kick").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("mod_ban").setLabel("🔨 Ban").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("mod_mute").setLabel("🔇 Mute").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("mod_unmute").setLabel("🔊 Unmute").setStyle(ButtonStyle.Success)
    );

    return [targetRow, row, backRow()];
  }

  function vipComponents(state) {
    const targetRow = new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId("vip_user_select")
        .setPlaceholder("Выбери пользователя")
        .setMinValues(1)
        .setMaxValues(1)
    );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("vip_give_vip").setLabel("💎 Дать VIP").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("vip_give_gold").setLabel("🥇 Дать GOLD").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("vip_remove").setLabel("🧹 Снять роли").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("vip_set_days").setLabel("🗓️ Дни").setStyle(ButtonStyle.Secondary),
    );

    return [targetRow, row, backRow()];
  }


  function logsComponents() {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("logs_refresh").setLabel("🔄 Обновить").setStyle(ButtonStyle.Secondary),
    );
    return [row, backRow()];
  }

  function historyComponents(state) {
    const targetRow = new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId("history_user_select")
        .setPlaceholder("Выбери пользователя (Discord)")
        .setMinValues(1)
        .setMaxValues(1)
    );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("history_refresh").setLabel("🔄 Обновить").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("history_clear_selection").setLabel("🧽 Сбросить").setStyle(ButtonStyle.Secondary),
    );

    return [targetRow, row, backRow()];
  }

  function cleanupComponents(state) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("cleanup_open_modal").setLabel("🧹 Настроить / Удалить").setStyle(ButtonStyle.Danger),
    );
    return [row, backRow()];
  }

  function statsComponents() {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("stats_refresh").setLabel("🔄 Обновить").setStyle(ButtonStyle.Secondary),
    );
    return [row, backRow()];
  }
  // ---- posting helpers ----
  async function upsertPinnedEmbed(channel, embed) {
    const pins = await channel.messages.fetchPinned();
    const mine = pins.find((msg) => msg.author?.id === channel.client.user.id);
    if (mine) {
      await mine.edit({ embeds: [embed] });
      return mine;
    }
    const msg = await channel.send({ embeds: [embed] });
    try { await msg.pin(); } catch { }
    return msg;
  }

  async function upsertLastEmbed(channel, embed) {
    const msgs = await channel.messages.fetch({ limit: 50 });
    const mine = msgs.find((m) => m.author?.id === channel.client.user.id);
    if (mine) {
      await mine.edit({ embeds: [embed] });
      return mine;
    }
    return channel.send({ embeds: [embed] });
  }

  function buildPostEmbed(title, desc) {
    return new EmbedBuilder().setTitle(title || "Night Core").setDescription(desc || "").setColor(color()).setFooter({ text: "Night Core" });
  }

  function presetPayload(presetKey) {
    const mk = (title, desc) => ({ title, desc });
    switch (presetKey) {
      case "welcome": return mk("👋 Добро пожаловать в Night Core", "Начни с **#download**.\nПоддержка: **#support**\nОбновления: **#news**");
      case "rules": return mk("📜 Правила", "1) Не передавать программу третьим лицам\n2) Запрещён слив/реверс\n3) Баги — в #support\n4) Уважение в чате");
      case "download": return mk("⏬ Download", "Скачай последнюю версию в этом канале.\nЕсли что-то не работает — пиши в **#support**.");
      case "news": return mk("📰 News", "Здесь будут обновления, фиксы и анонсы.");
      case "links": return mk("🔗 Links", "🤖 Telegram-бот: @midnightalertsbot\n🆘 Support: #support\n⏬ Download: #download");
      default: return mk("Night Core", "—");
    }
  }

  // ---- DB + Discord role helpers ----
  async function logModAction(client, guild, action, targetId, byId, reason) {
    const logId = String(process.env.MOD_LOG_CHANNEL_ID || "");
    if (!logId) return;
    try {
      const ch = await client.channels.fetch(logId);
      if (!ch || ch.type !== ChannelType.GuildText) return;
      const e = new EmbedBuilder()
        .setTitle("🧑‍⚖️ Mod action: " + action)
        .setColor(color())
        .addFields(
          { name: "Target", value: targetId ? `<@${targetId}> (${targetId})` : "n/a", inline: false },
          { name: "By", value: byId ? `<@${byId}> (${byId})` : "n/a", inline: false },
          { name: "Reason", value: reason || "—", inline: false }
        )
        .setTimestamp(new Date());
      await ch.send({ embeds: [e] });
    } catch { }
  }

  async function ensureMember(guild, userId) {
    if (!guild || !userId) return null;
    try { return await guild.members.fetch(userId); } catch { return null; }
  }

  async function syncVipRoleForUser(guild, discordId, role) {
    const vipRoleId = String(process.env.DISCORD_ROLE_VIP_ID || "");
    const goldRoleId = String(process.env.DISCORD_ROLE_GOLD_ID || "");
    const m = await ensureMember(guild, discordId);
    if (!m) return { ok: false, reason: "member_not_found" };

    // role in DB: "vip" | "gold" | "user"
    try {
      if (role === "gold") {
        if (vipRoleId) await m.roles.remove(vipRoleId).catch(() => { });
        if (goldRoleId) await m.roles.add(goldRoleId).catch(() => { });
      } else if (role === "vip") {
        if (goldRoleId) await m.roles.remove(goldRoleId).catch(() => { });
        if (vipRoleId) await m.roles.add(vipRoleId).catch(() => { });
      } else {
        if (vipRoleId) await m.roles.remove(vipRoleId).catch(() => { });
        if (goldRoleId) await m.roles.remove(goldRoleId).catch(() => { });
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e?.message || String(e) };
    }
  }

  async function setUserRoleInDbByDiscordId(supabase, discordId, nextRole, vipUntilIso) {
    // Find the user row first (some DBs don't have discord_id filled until first login)
    const { data: u, error: selErr } = await supabase
      .from("users")
      .select("id, role, discord_id")
      .eq("discord_id", String(discordId))
      .maybeSingle();

    if (selErr) return { ok: false, error: selErr.message };
    if (!u?.id) return { ok: false, error: "USER_NOT_LINKED" };

    const patch = { role: nextRole, updated_at: new Date().toISOString() };
    if (vipUntilIso !== undefined) patch.vip_until = vipUntilIso;

    const { error: upErr } = await supabase.from("users").update(patch).eq("id", u.id);
    if (upErr) return { ok: false, error: upErr.message };

    return { ok: true, userId: u.id };
  }

  // ---- render router ----
  async function showPanel(interaction, { update = false } = {}) {
    const state = getState(interaction.user.id);
    const guild = interaction.guild;
    const channelOptions = guild ? await listTextChannelOptions(guild) : [];

    let embed = buildHomeEmbed(state);
    let components = homeComponents();

    if (state.mode === "broadcast") {
      embed = buildBroadcastPanelEmbed(state);
      components = broadcastComponents(state, channelOptions);
    } else if (state.mode === "moderation") {
      embed = buildModerationEmbed(state);
      components = moderationComponents(state);
    } else if (state.mode === "vip") {
      embed = buildVipEmbed(state);
      components = vipComponents(state);
    } else if (state.mode === "stats") {
      embed = await buildStatsEmbed(state, guild, supabase);
      components = statsComponents();
    } else if (state.mode === "logs") {
      embed = await buildLogsEmbed(state, guild, supabase);
      components = logsComponents();
    } else if (state.mode === "history") {
      embed = await buildHistoryEmbed(state, guild, supabase);
      components = historyComponents(state);
    } else if (state.mode === "cleanup") {
      embed = buildCleanupEmbed(state);
      components = cleanupComponents(state);
    }

    const payload = { embeds: [embed], components, flags: 64 };

    if (update) {
      if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
      return interaction.update(payload);
    }

    return interaction.reply(payload);
  }

  // ---- command register: ONLY /panel ----
  async function registerDiscordCommands() {
    const token = process.env.DISCORD_BOT_TOKEN;
    const appId = process.env.DISCORD_APP_ID;
    const guildId = process.env.DISCORD_GUILD_ID;

    if (!token || !appId || !guildId) {
      console.log("[discord] skip command register: missing DISCORD_BOT_TOKEN / DISCORD_APP_ID / DISCORD_GUILD_ID");
      return;
    }

    const commands = [
      new SlashCommandBuilder()
        .setName("panel")
        .setDescription("Открыть админ-панель (админ)")
        .toJSON(),

      // поставить/сменить пароль (только админам)
      new SlashCommandBuilder()
        .setName("apanel_set")
        .setDescription("Задать пароль админ-панели (админ)")
        .addStringOption((o) => o.setName("password").setDescription("Новый пароль").setRequired(true))
        .toJSON(),

      // очистка сообщений (только после входа в /panel)
      new SlashCommandBuilder()
        .setName("clear")
        .setDescription("Очистить сообщения в канале (нужен вход через /panel)")
        .addIntegerOption((o) =>
          o
            .setName("count")
            .setDescription("Сколько последних сообщений удалить (1-100)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(100)
        )
        .addIntegerOption((o) =>
          o
            .setName("days")
            .setDescription("Удалить сообщения за последние X дней (1-14)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(14)
        )
        .toJSON(),
    ];

    const rest = new REST({ version: "10" }).setToken(token);
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });
    console.log("[discord] /panel command registered (setup removed)");
  }

  // ---- Tickets ----
  async function createTicket(interaction) {
    const guild = interaction.guild;
    if (!guild) return { ok: false, error: "no_guild" };

    const categoryId = String(process.env.TICKETS_CATEGORY_ID || "");
    const supportRoleId = String(process.env.SUPPORT_ROLE_ID || "");
    const requesterId = interaction.user.id;

    const name = `ticket-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9\-]/g, "").slice(0, 90);

    const overwrites = [
      { id: guild.roles.everyone.id, deny: ["ViewChannel"] },
      { id: requesterId, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory", "AttachFiles", "EmbedLinks"] },
    ];
    if (supportRoleId) {
      overwrites.push({ id: supportRoleId, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"] });
    }
    // also allow admins by default via permissions; they can see if they have Administrator

    const ch = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: categoryId || null,
      permissionOverwrites: overwrites,
      reason: "Support ticket created via panel",
    });

    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ticket_close").setLabel("✅ Закрыть тикет").setStyle(ButtonStyle.Danger)
    );

    const e = new EmbedBuilder()
      .setTitle("🎫 Тикет поддержки")
      .setDescription(`Создатель: <@${requesterId}>\nОпиши проблему одним сообщением. Саппорт ответит тут.`)
      .setColor(color())
      .setTimestamp(new Date());

    await ch.send({ embeds: [e], components: [closeRow] });

    // best-effort DB link (optional table)
    try {
      await supabase.from("tickets").insert({
        channel_id: ch.id,
        creator_discord_id: requesterId,
        created_at: new Date().toISOString(),
        status: "open",
      });
    } catch { }

    return { ok: true, channelId: ch.id };
  }

  async function closeTicket(interaction) {
    const ch = interaction.channel;
    if (!ch || ch.type !== ChannelType.GuildText) return { ok: false, error: "not_text_channel" };

    try {
      await ch.send({ content: "✅ Тикет закрыт. Канал будет удалён через 10 секунд." });
    } catch { }

    // best-effort db
    try {
      await supabase.from("tickets").update({ status: "closed", closed_at: new Date().toISOString() }).eq("channel_id", ch.id);
    } catch { }

    setTimeout(async () => {
      try { await ch.delete("Ticket closed"); } catch { }
    }, 10_000);

    return { ok: true };
  }

  // ---- Automod (simple) ----
  const SPAM_BUCKET = new Map(); // userId -> { last: number, count: number }
  function isInviteLike(text) {
    const t = String(text || "").toLowerCase();
    return t.includes("discord.gg/") || t.includes("discord.com/invite/");
  }

  async function maybeAutoMod(message) {
    try {
      if (!message.guild) return;
      if (message.author?.bot) return;

      // apply only if toggles enabled at least for one admin state; keep global from env + in memory
      // We'll use a shared object on appLocals to avoid per-admin states; initialize once.
      if (!appLocals.automod) appLocals.automod = { antiInvite: true, antiSpam: true };
      const cfg = appLocals.automod;

      // Anti-invite (non-admins)
      if (cfg.antiInvite) {
        const isAdmin = message.memberPermissions?.has(PermissionFlagsBits.Administrator);
        if (!isAdmin && isInviteLike(message.content)) {
          await message.delete().catch(() => { });
          await message.channel.send({ content: `❌ ${message.author}, инвайты запрещены.` }).then(m => setTimeout(() => m.delete().catch(() => { }), 5000)).catch(() => { });
          await logModAction(message.client, message.guild, "automod_delete_invite", message.author.id, message.client.user?.id, "Invite link");
          return;
        }
      }

      // Anti-spam (simple burst)
      if (cfg.antiSpam) {
        const now = Date.now();
        const uid = message.author.id;
        const b = SPAM_BUCKET.get(uid) || { last: 0, count: 0 };
        if (now - b.last < 4000) b.count += 1;
        else b.count = 1;
        b.last = now;
        SPAM_BUCKET.set(uid, b);

        if (b.count >= 6) {
          // timeout 2 minutes
          const member = await ensureMember(message.guild, uid);
          if (member) {
            await member.timeout(2 * 60 * 1000, "AutoMod spam").catch(() => { });
          }
          await logModAction(message.client, message.guild, "automod_timeout", uid, message.client.user?.id, "Spam burst");
          b.count = 0;
          SPAM_BUCKET.set(uid, b);
        }
      }
    } catch { }
  }

  // ---- interactions ----
  client.on("messageCreate", maybeAutoMod);

  // Prevent crashes on gateway rate limit / ws errors
  client.on("error", (err) => {
    console.error("[discord] client error:", err?.name || err, err?.message || "");
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        if (!interaction.guild) return interaction.reply({ content: "Эта команда работает только на сервере.", flags: 64 });


        // =======================
        // CLEAR: bulk delete
        // =======================
        if (interaction.commandName === "clear") {
          if (!hasAdminAccess(interaction)) return interaction.reply({ content: "❌ Нет доступа.", flags: 64 });

          const ch = interaction.channel;
          if (!ch || ch.type !== ChannelType.GuildText) {
            return interaction.reply({ content: "Эту команду можно использовать только в текстовом канале.", flags: 64 });
          }

          const countOpt = interaction.options.getInteger("count");
          const daysOpt = interaction.options.getInteger("days");

          if (countOpt == null && daysOpt == null) {
            return interaction.reply({ content: "Укажи `count` или `days`.", flags: 64 });
          }

          const count = countOpt != null ? Math.min(100, Math.max(1, Math.floor(countOpt))) : null;
          const days = daysOpt != null ? Math.min(14, Math.max(1, Math.floor(daysOpt))) : null;

          const limit = Math.min(100, count || 100);
          const msgs = await ch.messages.fetch({ limit }).catch(() => null);
          if (!msgs) return interaction.reply({ content: "Не смог получить сообщения.", flags: 64 });

          const now = Date.now();
          const maxAgeMs = 14 * 24 * 60 * 60 * 1000;
          const daysMs = days ? days * 24 * 60 * 60 * 1000 : null;

          const filtered = [];
          for (const m of msgs.values()) {
            const age = now - m.createdTimestamp;
            if (age > maxAgeMs) continue;
            if (daysMs != null && age > daysMs) continue;
            filtered.push(m);
          }

          const toDelete = count ? filtered.slice(0, count) : filtered;
          if (!toDelete.length) {
            return interaction.reply({ content: "Нечего удалять (или сообщения слишком старые > 14 дней).", flags: 64 });
          }

          await interaction.reply({ content: `🧹 Удаляю: ${toDelete.length}...`, flags: 64 });
          try {
            await ch.bulkDelete(toDelete, true);
          } catch (e) {
            return interaction.editReply({ content: "❌ Не смог удалить. Нужны права Manage Messages, и сообщения должны быть не старше 14 дней." });
          }

          return interaction.editReply({ content: `✅ Готово. Удалено: ${toDelete.length}` });
        }

        // =======================
        // APANEL: password -> 5 minute session
        // =======================
        if (interaction.commandName === "apanel") {
          if (!hasAdminAccess(interaction)) {
            return interaction.reply({ content: "❌ Нет доступа. Нужны права Администратор или роль Admin.", flags: 64 });
          }

          const pw = interaction.options.getString("password", true);
          const hash = await getApanelPasswordHash(interaction.guild.id);
          if (!hash) {
            return interaction.reply({
              content: "⚠️ Пароль админ-панели не задан. Админ должен выполнить: `/apanel_set <password>` (или задать APANEL_PASSWORD/APANEL_PASSWORD_HASH в .env / таблице apanel_settings).",
              flags: 64,
            });
          }
          const ok = sha256Hex(pw) === String(hash);
          if (!ok) return interaction.reply({ content: "❌ Неверный пароль.", flags: 64 });

          apanelGrant(interaction.guild.id, interaction.user.id);
          return interaction.reply({ content: "✅ Доступ открыт на 5 минут. Теперь можно: `/s`, `/kick`, `/ban`.", flags: 64 });
        }

        if (interaction.commandName === "apanel_set") {
          if (!hasAdminAccess(interaction)) {
            return interaction.reply({ content: "❌ Нет доступа. Нужны права Администратор или роль Admin.", flags: 64 });
          }
          const pw = interaction.options.getString("password", true);
          const h = sha256Hex(pw);
          const gid = String(interaction.guild.id);
          const nowIso = new Date().toISOString();
          const { error } = await supabase
            .from("apanel_settings")
            .upsert({ guild_id: gid, password_hash: h, updated_at: nowIso }, { onConflict: "guild_id" });
          if (error) {
            return interaction.reply({ content: `❌ Не смог сохранить пароль в БД: ${error.message}`, flags: 64 });
          }
          APANEL_PW_CACHE.set(gid, { hash: h, cachedAtMs: Date.now() });
          return interaction.reply({ content: "✅ Пароль админ-панели обновлён.", flags: 64 });
        }

        // =======================
        // APANEL commands
        // =======================
        if (interaction.commandName === "s") {
          if (!(await requireApanel(interaction))) return;

          const text = interaction.options.getString("text", true);
          const chOpt = interaction.options.getChannel("channel", false);
          const ch = chOpt || interaction.channel;
          if (!ch || ch.type !== ChannelType.GuildText) {
            return interaction.reply({ content: "❌ Можно писать только в текстовый канал.", flags: 64 });
          }
          await ch.send({ content: text });
          return interaction.reply({ content: `✅ Отправил в <#${ch.id}>`, flags: 64 });
        }

        if (interaction.commandName === "kick") {
          if (!(await requireApanel(interaction))) return;
          const user = interaction.options.getUser("user", true);
          const reason = interaction.options.getString("reason", false) || "—";

          const member = await ensureMember(interaction.guild, user.id);
          if (!member) return interaction.reply({ content: "❌ Не нашёл участника на сервере.", flags: 64 });

          await interaction.reply({ content: "⏳ Кикаю…", flags: 64 });
          await member.kick(`Kick via /kick (apanel): ${reason}`).catch((e) => {
            throw new Error(e?.message || String(e));
          });
          await logModAction(interaction.client, interaction.guild, "kick", user.id, interaction.user.id, reason);
          return interaction.followUp({ content: `✅ Kick: <@${user.id}>`, flags: 64 });
        }

        if (interaction.commandName === "ban") {
          if (!(await requireApanel(interaction))) return;
          const user = interaction.options.getUser("user", true);
          const minutes = interaction.options.getInteger("minutes", false);
          const reason = interaction.options.getString("reason", false) || "—";

          await interaction.reply({ content: "⏳ Баню…", flags: 64 });

          await interaction.guild.members.ban(user.id, { reason: `Ban via /ban (apanel): ${reason}` }).catch((e) => {
            throw new Error(e?.message || String(e));
          });

          // temp ban support
          if (minutes && Number(minutes) > 0) {
            const unbanAt = new Date(Date.now() + Number(minutes) * 60 * 1000).toISOString();
            await supabase.from("temp_bans").insert({
              guild_id: String(interaction.guild.id),
              user_id: String(user.id),
              unban_at: unbanAt,
              reason,
              mod_id: String(interaction.user.id),
              created_at: new Date().toISOString(),
            }).catch(() => { });
          }

          await logModAction(interaction.client, interaction.guild, minutes && minutes > 0 ? "ban_temp" : "ban", user.id, interaction.user.id, minutes && minutes > 0 ? `${reason} (minutes=${minutes})` : reason);
          return interaction.followUp({ content: `✅ Ban: <@${user.id}>${minutes && minutes > 0 ? ` (на ${minutes} мин)` : ""}`, flags: 64 });
        }

        if (interaction.commandName === "clear") {
          if (!(await requireApanel(interaction))) return;

          const channel = interaction.channel;
          if (!channel || !channel.isTextBased?.()) {
            return interaction.reply({ content: "❌ Команда доступна только в текстовом канале.", flags: 64 });
          }

          const count = interaction.options.getInteger("count", false);
          const days = interaction.options.getInteger("days", false);

          // Приоритет: count -> days -> default 50
          if (count && Number(count) > 0) {
            await interaction.reply({ content: `⏳ Удаляю последние ${count} сообщений…`, flags: 64 });
            const deleted = await channel.bulkDelete(Number(count), true).catch(() => null);
            const n = deleted?.size ?? 0;
            return interaction.followUp({ content: `✅ Готово. Удалено: ${n}`, flags: 64 });
          }

          const useDays = days && Number(days) > 0 ? Number(days) : null;
          if (useDays && useDays > 14) {
            return interaction.reply({ content: "❌ Discord не даёт удалять bulk-ом сообщения старше 14 дней. Укажи days от 1 до 14.", flags: 64 });
          }

          const cutoffMs = useDays ? (Date.now() - useDays * 24 * 60 * 60 * 1000) : (Date.now() - 24 * 60 * 60 * 1000);
          await interaction.reply({ content: `⏳ Чищу сообщения за последние ${useDays ?? 1} дн…`, flags: 64 });

          let total = 0;
          let lastId = null;

          for (let i = 0; i < 15; i++) {
            const batch = await channel.messages.fetch({ limit: 100, before: lastId || undefined }).catch(() => null);
            if (!batch || batch.size === 0) break;

            const toDelete = [];
            for (const msg of batch.values()) {
              if (msg.pinned) continue;
              const ts = msg.createdTimestamp || 0;
              if (ts < cutoffMs) continue;
              toDelete.push(msg.id);
            }

            if (toDelete.length) {
              const del = await channel.bulkDelete(toDelete, true).catch(() => null);
              total += del?.size ?? 0;
            }

            const oldest = batch.last();
            lastId = oldest?.id;
            if (!oldest) break;

            // если дошли до сообщений старше cutoff — дальше нет смысла
            if ((oldest.createdTimestamp || 0) < cutoffMs) break;
          }

          return interaction.followUp({ content: `✅ Готово. Удалено: ${total}`, flags: 64 });
        }


        if (interaction.commandName === "panel") {
          if (!hasAdminAccess(interaction)) {
            return interaction.reply({ content: "❌ Нет доступа. Нужны права Администратор или роль Admin.", flags: 64 });
          }

          // Если сессии нет — покажем модалку для пароля (как /apanel, только внутри /panel)
          if (!apanelIsActive(interaction)) {
            const modal = new ModalBuilder()
              .setCustomId("panel_login_modal")
              .setTitle("Вход в админ‑панель");

            const pw = new TextInputBuilder()
              .setCustomId("panel_pw")
              .setLabel("Пароль")
              .setStyle(TextInputStyle.Short)
              .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(pw));
            return interaction.showModal(modal);
          }

          const state = getState(interaction.user.id);
          state.mode = "home";
          return showPanel(interaction);
        }


      }

      // NAV buttons (home/modules)
      if (interaction.isButton()) {
        if (!hasAdminAccess(interaction)) return interaction.reply({ content: "❌ Нет доступа.", flags: 64 });

        const state = getState(interaction.user.id);

        const navMap = {
          panel_nav_home: "home",
          panel_nav_broadcast: "broadcast",
          panel_nav_moderation: "moderation",
          panel_nav_vip: "vip",
          panel_nav_stats: "stats",
          panel_nav_logs: "logs",
          panel_nav_history: "history",
          panel_nav_cleanup: "cleanup",
        };

        if (navMap[interaction.customId]) {
          state.mode = navMap[interaction.customId];
          return showPanel(interaction, { update: true });
        }

        // Broadcast buttons
        if (interaction.customId === "broadcast_preview") return showPanel(interaction, { update: true });
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

          modal.addComponents(new ActionRowBuilder().addComponents(titleInput), new ActionRowBuilder().addComponents(descInput));
          return interaction.showModal(modal);
        }
        if (interaction.customId === "broadcast_send") {
          if (!state.broadcast.channelIds.length) return interaction.reply({ content: "Выбери хотя бы один канал.", flags: 64 });

          await interaction.reply({ content: "📤 Рассылаю…", flags: 64 });
          const embed = buildPostEmbed(state.broadcast.title, state.broadcast.desc);

          const results = [];
          for (const channelId of state.broadcast.channelIds) {
            try {
              const ch = await interaction.guild.channels.fetch(channelId);
              if (!ch || ch.type !== ChannelType.GuildText) { results.push(`❌ <#${channelId}> (не текстовый)`); continue; }

              if (state.broadcast.pin) await upsertPinnedEmbed(ch, embed);
              else await upsertLastEmbed(ch, embed);

              results.push(`✅ <#${channelId}>`);
            } catch (e) {
              results.push(`❌ <#${channelId}> (${e?.message || e})`);
            }
          }

          await interaction.followUp({ content: "Готово:\n" + results.join("\n"), flags: 64 });
          return;
        }

        // Moderation buttons
        if (interaction.customId === "mod_kick" || interaction.customId === "mod_ban" || interaction.customId === "mod_mute") {
          if (!state.moderation.targetId) return interaction.reply({ content: "Сначала выбери пользователя.", flags: 64 });

          const modal = new ModalBuilder().setCustomId("mod_action_modal").setTitle("Подтверждение действия");
          const reasonInput = new TextInputBuilder()
            .setCustomId("reason")
            .setLabel("Причина (опционально)")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(300);

          const durationInput = new TextInputBuilder()
            .setCustomId("minutes")
            .setLabel("Минуты (только для Mute)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(6)
            .setPlaceholder("например 10, 60, 1440");

          modal.addComponents(
            new ActionRowBuilder().addComponents(reasonInput),
            new ActionRowBuilder().addComponents(durationInput),
          );

          state.moderation.action = interaction.customId === "mod_kick" ? "kick" : interaction.customId === "mod_ban" ? "ban" : "mute";
          return interaction.showModal(modal);
        }

        if (interaction.customId === "mod_unmute") {
          if (!state.moderation.targetId) return interaction.reply({ content: "Сначала выбери пользователя.", flags: 64 });

          await interaction.reply({ content: "🔊 Снимаю мут…", flags: 64 });
          const member = await ensureMember(interaction.guild, state.moderation.targetId);
          if (!member) return interaction.followUp({ content: "❌ Не удалось найти участника на сервере.", flags: 64 });

          await member.timeout(null, "Unmute via panel").catch((e) => { throw e; });
          await logModAction(interaction.client, interaction.guild, "unmute", state.moderation.targetId, interaction.user.id, "—");
          return interaction.followUp({ content: `✅ Unmute: <@${state.moderation.targetId}>`, flags: 64 });
        }

        // VIP buttons
        if (interaction.customId === "vip_set_days") {
          const modal = new ModalBuilder().setCustomId("vip_days_modal").setTitle("Настройка дней VIP");
          const daysInput = new TextInputBuilder()
            .setCustomId("days")
            .setLabel("Дни (число) или 'lifetime'")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(20)
            .setValue(state.vip.days == null ? "lifetime" : String(state.vip.days));
          modal.addComponents(new ActionRowBuilder().addComponents(daysInput));
          return interaction.showModal(modal);
        }

        if (interaction.customId === "vip_give_vip" || interaction.customId === "vip_give_gold" || interaction.customId === "vip_remove") {
          if (!state.vip.targetId) return interaction.reply({ content: "Сначала выбери пользователя.", flags: 64 });

          await interaction.reply({ content: "⏳ Применяю…", flags: 64 });

          const targetId = state.vip.targetId;
          const days = state.vip.days;
          const now = new Date();

          if (interaction.customId === "vip_remove") {
            // DB role -> user, vip_until null
            const dbRes = await setUserRoleInDbByDiscordId(supabase, targetId, "free", null);
            if (!dbRes.ok) {
              const msg = dbRes.error === "USER_NOT_LINKED"
                ? "❌ Этот пользователь ещё не привязан к базе (он должен хотя бы раз залогиниться в приложении)."
                : `❌ Ошибка БД: ${dbRes.error}`;
              return interaction.followUp({ content: msg, flags: 64 });
            }
            await syncVipRoleForUser(interaction.guild, targetId, "free");
            await logModAction(interaction.client, interaction.guild, "vip_remove", targetId, interaction.user.id, "—");
            return interaction.followUp({ content: `✅ Снял VIP/GOLD у <@${targetId}>`, flags: 64 });
          }

          const nextRole = interaction.customId === "vip_give_gold" ? "gold" : "vip";
          let vipUntilIso = null;
          if (days == null) {
            vipUntilIso = new Date("2099-12-31T00:00:00.000Z").toISOString();
          } else {
            const d = Math.max(1, Number(days || 1));
            const vipUntil = new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
            vipUntilIso = vipUntil.toISOString();
          }

          const dbRes2 = await setUserRoleInDbByDiscordId(supabase, targetId, nextRole, vipUntilIso);
          if (!dbRes2.ok) {
            const msg = dbRes2.error === "USER_NOT_LINKED"
              ? "❌ Этот пользователь ещё не привязан к базе (он должен хотя бы раз залогиниться в приложении)."
              : `❌ Ошибка БД: ${dbRes2.error}`;
            return interaction.followUp({ content: msg, flags: 64 });
          }
          await syncVipRoleForUser(interaction.guild, targetId, nextRole);
          await logModAction(interaction.client, interaction.guild, `vip_set_${nextRole}`, targetId, interaction.user.id, `days=${days == null ? "lifetime" : days}`);

          return interaction.followUp({ content: `✅ Поставил **${nextRole.toUpperCase()}** для <@${targetId}> (until: ${vipUntilIso})`, flags: 64 });
        }
        // Tickets
        if (interaction.customId === "tickets_refresh") {
          await interaction.deferUpdate();
          return showPanel(interaction, { update: true });
        }


        if (interaction.customId === "ticket_close") {
          if (!hasAdminAccess(interaction)) return interaction.reply({ content: "❌ Нет доступа.", flags: 64 });
          await interaction.reply({ content: "Закрываю…", flags: 64 });
          const r = await closeTicket(interaction);
          if (!r.ok) return interaction.followUp({ content: `❌ Ошибка: ${r.error || "unknown"}`, flags: 64 });
          return;
        }

        // Automod toggles
        if (interaction.customId === "automod_toggle_invite") {
          state.automod.antiInvite = !state.automod.antiInvite;
          if (!appLocals.automod) appLocals.automod = { antiInvite: true, antiSpam: true };
          appLocals.automod.antiInvite = state.automod.antiInvite;
          return showPanel(interaction, { update: true });
        }
        if (interaction.customId === "automod_toggle_spam") {
          state.automod.antiSpam = !state.automod.antiSpam;
          if (!appLocals.automod) appLocals.automod = { antiInvite: true, antiSpam: true };
          appLocals.automod.antiSpam = state.automod.antiSpam;
          return showPanel(interaction, { update: true });
        }

        // Stats refresh
        if (interaction.customId === "stats_refresh") {
          await interaction.deferUpdate();
          return showPanel(interaction, { update: true });
        }

        // Logs
        if (interaction.customId === "logs_refresh") {
          await interaction.deferUpdate();
          return showPanel(interaction, { update: true });
        }

        // History
        if (interaction.customId === "history_refresh") {
          await interaction.deferUpdate();
          return showPanel(interaction, { update: true });
        }
        if (interaction.customId === "history_clear_selection") {
          state.history.discordId = null;
          await interaction.deferUpdate();
          return showPanel(interaction, { update: true });
        }

        // Cleanup modal
        if (interaction.customId === "cleanup_open_modal") {
          const modal = new ModalBuilder().setCustomId("cleanup_modal").setTitle("Clear сообщений");

          const countInput = new TextInputBuilder()
            .setCustomId("cleanup_count")
            .setLabel("Сколько последних сообщений удалить (1-100)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(3)
            .setValue(String(state?.cleanup?.count || 50));

          const daysInput = new TextInputBuilder()
            .setCustomId("cleanup_days")
            .setLabel("За сколько дней удалить (1-14) (опционально)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(2)
            .setValue(state?.cleanup?.days ? String(state.cleanup.days) : "");

          modal.addComponents(new ActionRowBuilder().addComponents(countInput), new ActionRowBuilder().addComponents(daysInput));
          return interaction.showModal(modal);
        }
      }

      // Select menus
      if (interaction.isStringSelectMenu()) {
        if (!hasAdminAccess(interaction)) return interaction.reply({ content: "❌ Нет доступа.", flags: 64 });

        const state = getState(interaction.user.id);


        if (interaction.customId === "broadcast_template") {
          const v = interaction.values?.[0] || "none";
          if (v && v !== "none") {
            const p = presetPayload(v);
            state.broadcast.title = p.title;
            state.broadcast.desc = p.desc;
          }
          return showPanel(interaction, { update: true });
        }

        if (interaction.customId === "broadcast_channels") {
          state.broadcast.channelIds = interaction.values || [];
          return showPanel(interaction, { update: true });
        }
      }

      if (interaction.isUserSelectMenu()) {
        if (!hasAdminAccess(interaction)) return interaction.reply({ content: "❌ Нет доступа.", flags: 64 });

        const state = getState(interaction.user.id);

        if (interaction.customId === "mod_user_select") {
          state.moderation.targetId = interaction.values?.[0] || null;
          return showPanel(interaction, { update: true });
        }

        if (interaction.customId === "vip_user_select") {
          state.vip.targetId = interaction.values?.[0] || null;
          return showPanel(interaction, { update: true });
        }

        if (interaction.customId === "history_user_select") {
          state.history.discordId = interaction.values?.[0] || null;
          return showPanel(interaction, { update: true });
        }
      }

      // Modals
      if (interaction.isModalSubmit()) {
        const state = getState(interaction.user.id);

        if (interaction.customId === "panel_login_modal") {
          if (!interaction.guild) {
            return interaction.reply({ content: "Эта команда работает только на сервере.", flags: 64 }).catch(() => { });
          }
          if (!hasAdminAccess(interaction)) {
            return interaction.reply({ content: "❌ Нет доступа. Нужны права Администратор или роль Admin.", flags: 64 }).catch(() => { });
          }

          const pw = String(interaction.fields.getTextInputValue("panel_pw") || "");
          const hash = await getApanelPasswordHash(interaction.guild.id);

          if (!hash) {
            return interaction.reply({ content: "❌ Пароль админ‑панели ещё не задан. Овнер/админ должен сделать: `/apanel_set <пароль>`", flags: 64 }).catch(() => { });
          }

          if (sha256Hex(pw) !== String(hash).trim()) {
            return interaction.reply({ content: "❌ Неверный пароль.", flags: 64 }).catch(() => { });
          }

          apanelGrant(interaction.guild.id, interaction.user.id);

          state.mode = "home";
          return showPanel(interaction);
        }

        if (interaction.customId === "broadcast_modal") {
          state.broadcast.title = String(interaction.fields.getTextInputValue("m_title") || "").slice(0, 100);
          state.broadcast.desc = String(interaction.fields.getTextInputValue("m_desc") || "").slice(0, 4000);
          await interaction.reply({ content: "✅ Текст сохранён. Жми «Разослать».", flags: 64 });
          return;
        }

        if (interaction.customId === "vip_days_modal") {
          const raw = String(interaction.fields.getTextInputValue("days") || "").trim().toLowerCase();
          if (raw === "lifetime" || raw === "∞") state.vip.days = null;
          else {
            const n = Number(raw);
            state.vip.days = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 30;
          }
          await interaction.reply({ content: `✅ Дни обновлены: ${state.vip.days == null ? "lifetime" : state.vip.days}`, flags: 64 });
          return;
        }

        if (interaction.customId === "mod_action_modal") {
          if (!hasAdminAccess(interaction)) return interaction.reply({ content: "❌ Нет доступа.", flags: 64 });

          const targetId = state.moderation.targetId;
          const action = state.moderation.action;
          const reason = String(interaction.fields.getTextInputValue("reason") || "").trim();
          const minutesRaw = String(interaction.fields.getTextInputValue("minutes") || "").trim();
          const minutes = minutesRaw ? Math.max(1, Math.min(10080, Number(minutesRaw))) : null;

          if (!targetId || !action) return interaction.reply({ content: "❌ Нет цели/действия.", flags: 64 });

          await interaction.reply({ content: "⏳ Выполняю…", flags: 64 });

          const member = await ensureMember(interaction.guild, targetId);

          if (action === "kick") {
            if (!member) return interaction.followUp({ content: "❌ Не удалось найти участника.", flags: 64 });
            await member.kick(reason || "Kick via panel").catch((e) => { throw e; });
            await setAccessStatusByDiscordId(targetId, "left");
            await logModAction(interaction.client, interaction.guild, "kick", targetId, interaction.user.id, reason);
            return interaction.followUp({ content: `✅ Kick: <@${targetId}>`, flags: 64 });
          }

          if (action === "ban") {
            await interaction.guild.members.ban(targetId, { reason: reason || "Ban via panel" }).catch((e) => { throw e; });
            await setAccessStatusByDiscordId(targetId, "banned");
            await logModAction(interaction.client, interaction.guild, "ban", targetId, interaction.user.id, reason);
            return interaction.followUp({ content: `✅ Ban: <@${targetId}>`, flags: 64 });
          }

          if (action === "mute") {
            if (!member) return interaction.followUp({ content: "❌ Не удалось найти участника.", flags: 64 });
            const mins = minutes || 10;
            await member.timeout(mins * 60 * 1000, reason || "Mute via panel").catch((e) => { throw e; });
            await logModAction(interaction.client, interaction.guild, "mute", targetId, interaction.user.id, `mins=${mins} ${reason ? "| " + reason : ""}`);
            return interaction.followUp({ content: `✅ Mute: <@${targetId}> на ${mins} мин.`, flags: 64 });
          }

          return;
        }

        if (interaction.customId === "cleanup_modal") {
          if (!hasAdminAccess(interaction)) return interaction.reply({ content: "❌ Нет доступа.", flags: 64 });

          const ch = interaction.channel;
          if (!ch || ch.type !== ChannelType.GuildText) {
            return interaction.reply({ content: "Эту операцию можно делать только в текстовом канале.", flags: 64 });
          }

          const rawCount = String(interaction.fields.getTextInputValue("cleanup_count") || "").trim();
          const rawDays = String(interaction.fields.getTextInputValue("cleanup_days") || "").trim();

          let count = rawCount ? Number(rawCount) : null;
          let days = rawDays ? Number(rawDays) : null;

          if (count == null && days == null) {
            return interaction.reply({ content: "Укажи хотя бы `count` или `days`.", flags: 64 });
          }

          if (count != null) {
            if (!Number.isFinite(count)) count = null;
            else count = Math.min(100, Math.max(1, Math.floor(count)));
          }

          if (days != null) {
            if (!Number.isFinite(days)) days = null;
            else days = Math.min(14, Math.max(1, Math.floor(days)));
          }

          const limit = Math.min(100, count || 100);
          const msgs = await ch.messages.fetch({ limit }).catch(() => null);
          if (!msgs) return interaction.reply({ content: "Не смог получить сообщения.", flags: 64 });

          const now = Date.now();
          const maxAgeMs = 14 * 24 * 60 * 60 * 1000;
          const daysMs = days ? days * 24 * 60 * 60 * 1000 : null;

          const filtered = [];
          for (const m of msgs.values()) {
            const age = now - m.createdTimestamp;
            if (age > maxAgeMs) continue; // Discord bulkDelete limitation
            if (daysMs != null && age > daysMs) continue;
            filtered.push(m);
          }

          const toDelete = count ? filtered.slice(0, count) : filtered;
          if (!toDelete.length) {
            return interaction.reply({ content: "Нечего удалять по этим параметрам (или сообщения слишком старые > 14 дней).", flags: 64 });
          }

          await interaction.reply({ content: `🧹 Удаляю: ${toDelete.length}...`, flags: 64 });
          try {
            await ch.bulkDelete(toDelete, true);
          } catch (e) {
            return interaction.editReply({ content: "❌ Не смог удалить. Проверь права бота (Manage Messages) и что сообщения не старше 14 дней." });
          }

          try {
            const MOD_LOG_CHANNEL_ID = process.env.MOD_LOG_CHANNEL_ID;
            if (MOD_LOG_CHANNEL_ID && interaction.guild) {
              const logCh = await interaction.guild.channels.fetch(MOD_LOG_CHANNEL_ID).catch(() => null);
              if (logCh && logCh.type === ChannelType.GuildText) {
                await logCh.send({
                  embeds: [baseEmbed("🧹 Clear", `Админ <@${interaction.user.id}> удалил **${toDelete.length}** сообщений в <#${ch.id}>`)]
                }).catch(() => { });
              }
            }
          } catch { }

          return;
        }
      }
    } catch (e) {
      try {
        const msg = `❌ Ошибка: ${e?.message || e}`;
        if (interaction.deferred || interaction.replied) await interaction.followUp({ content: msg, flags: 64 });
        else await interaction.reply({ content: msg, flags: 64 });
      } catch { }
    }
  });

  // login MUST be last (after handlers are registered)
  await client.login(DISCORD_BOT_TOKEN);
}

// --- entrypoint ---
startDiscordBot().catch((e) => console.error('[discord] fatal:', e?.stack || e));