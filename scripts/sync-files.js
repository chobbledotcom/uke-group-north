const { sync } = require('./prepare-dev');

if (require.main === module) sync();

module.exports = { sync };