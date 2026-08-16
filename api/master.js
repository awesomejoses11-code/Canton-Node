/* api/master.js — entry */
var core = require('../lib/master-core.js');
module.exports = core;
module.exports.config = (core && core.config) || { maxDuration: 120 };
