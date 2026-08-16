/* lib/master-core.js — decode packed source */
var a = require('./master-b64-a.js');
var b = require('./master-b64-b.js');
var src = Buffer.from(a + b, 'base64').toString('utf8');
var Module = require('module');
var m = new Module(module.id);
m.filename = __filename;
m.paths = module.paths;
m._compile(src, __filename);
module.exports = m.exports;
if (m.exports && m.exports.config) module.exports.config = m.exports.config;
