/* restored - see next */
module.exports = async function handler(req, res) {
  res.status(503).json({ error: 'Video module temporarily being restored' });
};
module.exports.config = { maxDuration: 300 };
