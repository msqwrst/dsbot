require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits
} = require("discord.js");

/* =======================
   CONFIG
======================= */

const pick = (...keys) => {
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
};

const TOKEN = pick("DISCORD_TOKEN", "DISCORD_BOT_TOKEN", "DISCORD_BOT", "BOT_TOKEN");
const CLIENT_ID = pick("DISCORD_CLIENT_ID", "DISCORD_APP_ID", "CLIENT_ID");
const GUILD_ID = pick("DISCORD_GUILD_ID", "GUILD_ID");
const ADMIN_ROLE_ID = pick("ADMIN_ROLE_ID", "DISCORD_ADMIN_ROLE_ID");
const PORT = process.env.PORT || 3000;

// 🔎 дебаг: значения не показываем, только true/false
console.log("[env] DISCORD_TOKEN:", !!process.env.DISCORD_TOKEN);
console.log("[env] DISCORD_BOT_TOKEN:", !!process.env.DISCORD_BOT_TOKEN);
console.log("[env] DISCORD_CLIENT_ID:", !!process.env.DISCORD_CLIENT_ID);
console.log("[env] DISCORD_APP_ID:", !!process.env.DISCORD_APP_ID);
console.log("[env] DISCORD_GUILD_ID:", !!process.env.DISCORD_GUILD_ID);
console.log("[env] PORT:", !!process.env.PORT);

if (!TOKEN) {
  console.error("❌ Missing env: DISCORD_TOKEN (or DISCORD_BOT_TOKEN)");
  process.exit(1);
}

if (!CLIENT_ID) {
  console.warn("⚠️ DISCORD_CLIENT_ID missing: commands will NOT auto-register.");
}


/* =======================
   SIMPLE FILE DB
======================= */

const DB_FILE = path.join(__dirname, "data.json");

function readDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { vip: {}, links: {} };
  }
}

function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}

/* =======================
   AUTH HELPERS
======================= */

function isAdminMember(member) {
  // 1) Если в env задана роль админа — проверяем её
  if (ADMIN_ROLE_ID && member?.roles?.cache?.has(ADMIN_ROLE_ID)) return true;

  // 2) Иначе — достаточно прав администратора
  if (member?.permissions?.has(PermissionFlagsBits.Administrator)) return true;

  return false;
}

/* =======================
   COMMANDS
======================= */

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Проверка, жив ли бот"),

  new SlashCommandBuilder()
    .setName("vip_grant")
    .setDescription("Выдать VIP пользователю (только админ)")
    .addUserOption(opt =>
      opt.setName("user").setDescription("Кому выдать VIP").setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName("note").setDescription("Заметка/причина").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("vip_revoke")
    .setDescription("Снять VIP у пользователя (только админ)")
    .addUserOption(opt =>
      opt.setName("user").setDescription("С кого снять VIP").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("vip_status")
    .setDescription("Проверить VIP статус")
    .addUserOption(opt =>
      opt.setName("user").setDescription("Пользователь (если не указать — ты)").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("link_set")
    .setDescription("Привязать внешний id (например Telegram ID) к Discord аккаунту")
    .addStringOption(opt =>
      opt.setName("external_id").setDescription("Например telegramId").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("link_get")
    .setDescription("Посмотреть привязанный внешний id (например Telegram ID)")
    .addUserOption(opt =>
      opt.setName("user").setDescription("Пользователь (если не указать — ты)").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Сделать объявление в канал (только админ)")
    .addChannelOption(opt =>
      opt.setName("channel").setDescription("Куда отправить").setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName("text").setDescription("Текст объявления").setRequired(true)
    )
].map(c => c.toJSON());

async function registerCommands() {
  if (!CLIENT_ID) return;
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  try {
    if (GUILD_ID) {
      // Быстро: только в одну гильдию
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
        body: commands
      });
      console.log("✅ Slash commands registered (guild)");
    } else {
      // Глобально: может обновляться до ~1 часа
      await rest.put(Routes.applicationCommands(CLIENT_ID), {
        body: commands
      });
      console.log("✅ Slash commands registered (global)");
    }
  } catch (e) {
    console.error("❌ Failed to register commands:", e);
  }
}

/* =======================
   DISCORD CLIENT
======================= */

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    const db = readDB();

    if (interaction.commandName === "ping") {
      return interaction.reply({ content: "pong ✅", ephemeral: true });
    }

    if (interaction.commandName === "vip_grant") {
      if (!isAdminMember(interaction.member)) {
        return interaction.reply({ content: "⛔ Нет прав.", ephemeral: true });
      }

      const user = interaction.options.getUser("user", true);
      const note = interaction.options.getString("note") || "";

      db.vip[user.id] = {
        grantedAt: Date.now(),
        grantedBy: interaction.user.id,
        note
      };
      writeDB(db);

      return interaction.reply({
        content: `✅ VIP выдан: <@${user.id}>` + (note ? `\n📝 ${note}` : ""),
        ephemeral: false
      });
    }

    if (interaction.commandName === "vip_revoke") {
      if (!isAdminMember(interaction.member)) {
        return interaction.reply({ content: "⛔ Нет прав.", ephemeral: true });
      }

      const user = interaction.options.getUser("user", true);
      if (!db.vip[user.id]) {
        return interaction.reply({ content: `ℹ️ У <@${user.id}> и так нет VIP.`, ephemeral: true });
      }

      delete db.vip[user.id];
      writeDB(db);

      return interaction.reply({
        content: `🗑️ VIP снят: <@${user.id}>`,
        ephemeral: false
      });
    }

    if (interaction.commandName === "vip_status") {
      const user = interaction.options.getUser("user") || interaction.user;
      const rec = db.vip[user.id];

      if (!rec) {
        return interaction.reply({ content: `❌ VIP нет у <@${user.id}>`, ephemeral: true });
      }

      const when = new Date(rec.grantedAt).toLocaleString("ru-RU");
      return interaction.reply({
        content:
          `✅ VIP есть у <@${user.id}>\n` +
          `📅 Выдан: ${when}\n` +
          (rec.note ? `📝 ${rec.note}\n` : "") +
          `👤 Выдал: <@${rec.grantedBy}>`,
        ephemeral: true
      });
    }

    if (interaction.commandName === "link_set") {
      const externalId = interaction.options.getString("external_id", true).trim();

      // минимальная валидация
      if (externalId.length < 3 || externalId.length > 64) {
        return interaction.reply({ content: "❌ external_id слишком короткий/длинный.", ephemeral: true });
      }

      db.links[interaction.user.id] = {
        externalId,
        updatedAt: Date.now()
      };
      writeDB(db);

      return interaction.reply({
        content: `🔗 Привязка сохранена.\nDiscord: <@${interaction.user.id}>\nExternal ID: \`${externalId}\``,
        ephemeral: true
      });
    }

    if (interaction.commandName === "link_get") {
      const user = interaction.options.getUser("user") || interaction.user;
      const rec = db.links[user.id];

      if (!rec) {
        return interaction.reply({ content: `ℹ️ У <@${user.id}> нет привязки.`, ephemeral: true });
      }

      return interaction.reply({
        content: `🔗 Привязка <@${user.id}>: \`${rec.externalId}\``,
        ephemeral: true
      });
    }

    if (interaction.commandName === "announce") {
      if (!isAdminMember(interaction.member)) {
        return interaction.reply({ content: "⛔ Нет прав.", ephemeral: true });
      }
      const channel = interaction.options.getChannel("channel", true);
      const text = interaction.options.getString("text", true);

      // Проверка что это текстовый канал (на минималках)
      if (!channel || !channel.isTextBased?.()) {
        return interaction.reply({ content: "❌ Выбери текстовый канал.", ephemeral: true });
      }

      await channel.send({ content: text });
      return interaction.reply({ content: "✅ Отправлено.", ephemeral: true });
    }
  } catch (e) {
    console.error("interaction error:", e);
    if (interaction?.replied || interaction?.deferred) {
      interaction.followUp({ content: "❌ Ошибка выполнения команды.", ephemeral: true }).catch(() => {});
    } else {
      interaction.reply({ content: "❌ Ошибка выполнения команды.", ephemeral: true }).catch(() => {});
    }
  }
});

/* =======================
   HEALTH SERVER (Railway)
======================= */

const app = express();
app.get("/", (req, res) => res.status(200).send("OK"));
app.listen(PORT, () => console.log(`🌐 Health server on :${PORT}`));

/* =======================
   START
======================= */

(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();
