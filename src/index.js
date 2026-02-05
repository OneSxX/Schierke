// src/index.js
const { Client, GatewayIntentBits } = require("discord.js");
const { QuickDB } = require("quick.db");
const { registerGlobalCommands } = require("./commands/register");
const TOKEN = process.env.TOKEN;
client.login(TOKEN);

// ✅ Tek client, tek login
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ✅ Tek DB instance
const db = new QuickDB();

// Crash guards
process.on("unhandledRejection", (r) => console.error("UNHANDLED REJECTION:", r));
process.on("uncaughtException", (e) => console.error("UNCAUGHT EXCEPTION:", e));
client.on("error", (e) => console.error("CLIENT ERROR:", e));

client.once("ready", async () => {
  console.log(`✅ Bot açıldı: ${client.user.tag}`);

  // ✅ Presence (tek yer)
  try {
    client.user.setPresence({
      status: "online",
      activities: [{ name: "Voice Manager", type: 0 }],
    });
  } catch (_) {}

  // ✅ Slash register (tek yer)
  try {
    await registerGlobalCommands(client.application.id, config.token);
  } catch (e) {
    console.error("Slash register hatası:", e?.message || e);
  }
});

// ✅ Features
require("./features/voiceManager")(client, db, config);

// ✅ Yeni feature (şimdilik boş kalsın, hata vermesin)
require("./features/Ticket")(client, db, config);
