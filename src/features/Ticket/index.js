module.exports = (client, db, config) => {
  const register = require("./ticket");
  return register(client, db, config);
};