const { spawn } = require('child_process');
const path = require('path');
const { prep } = require('./prepare-dev');

const dev = path.join(__dirname, '..', '.build', 'dev');

prep();

console.log('Starting server...');

const watch = spawn('node', [path.join(__dirname, 'watch.js')], { 
  stdio: 'inherit' 
});

const eleventy = spawn('pnpm', ['exec', 'eleventy', '--serve'], { 
  cwd: dev, 
  stdio: 'inherit', 
  shell: true 
});

process.on('SIGINT', () => {
  console.log('\nStopping...');
  watch.kill();
  eleventy.kill();
  process.exit();
});