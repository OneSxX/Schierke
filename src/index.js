// src/index.js
const { Client, GatewayIntentBits } = require("discord.js");
const { QuickDB } = require("quick.db");

// Eğer bu dosya kullanılıyorsa kalsın, yoksa kaldırabilirsin
// const { registerGlobalCommands } = require("./commands/register");

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  throw new Error("TOKEN env missing. Railway Variables kısmına TOKEN ekle.");
}

// ✅ Tek client
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
  } catch (e) {
    console.error("Presence hatası:", e?.message || e);
  }

  // ✅ Slash register (opsiyonel)
  // Eğer registerGlobalCommands fonksiyonun token istemiyorsa bunu aç:
  /*
  try {
    await registerGlobalCommands(client.application.id);
  } catch (e) {
    console.error("Slash register hatası:", e?.message || e);
  }
  */
});

// ✅ Features (config kaldırıldı)
try {
  require("./features/VoiceManager")(client, db);
} catch (e) {
  console.error("VoiceManager load hatası:", e?.message || e);
}

try {
  require("./features/Ticket")(client, db);
} catch (e) {
  console.error("Ticket load hatası:", e?.message || e);
}

// ✅ EN SON login (client tanımlandıktan sonra)
client.login(TOKEN);

setInterval(() => {
  console.log("⏱️ Bot alive:", new Date().toISOString());
}, 5 * 60 * 1000); // 5 dakikada bir
