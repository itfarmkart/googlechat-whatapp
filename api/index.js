// Vercel entry point. The Express app is itself a (req, res) handler; every
// route is rewritten here via vercel.json. Local dev still uses `node server.js`.
module.exports = require("../server");
