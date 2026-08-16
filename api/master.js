/* api/master.js — re-export core (anti-truncation + file-edit rules live in lib/master-core.js) */
var core = require('../lib/master-core.js');
module.exports = core;
if (core.config) module.exports.config = core.config;
