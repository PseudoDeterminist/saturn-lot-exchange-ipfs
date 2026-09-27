const { runFok } = require('./lib/fok-smoke.cjs');
runFok(require('hardhat'), 'sell').then(console.log).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
