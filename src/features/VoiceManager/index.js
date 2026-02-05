// src/features/VoiceManager/index.js
module.exports = (client, db) => {
  const register = require("./voiceManager");
  return register(client, db);
};
