/* RESTORE_FROM_LOCAL — if you see this, push failed */
module.exports = async function handler(req, res) {
  res.status(500).json({ error: 'master-core not uploaded' });
};
module.exports.config = { maxDuration: 120 };
