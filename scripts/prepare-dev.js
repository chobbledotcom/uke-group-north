const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { templateRepo, buildDir } = require('./consts');

const root = path.resolve(__dirname, '..');
const build = path.join(root, buildDir);
const template = path.join(build, 'template');
const dev = path.join(build, 'dev');

const templateExcludes = ['.git', 'node_modules', '*.md', 'test', 'test-*'];
const rootExcludes = ['.git', '*.nix', 'README.md', buildDir, 'scripts', 'node_modules', 'package*.json'];

function prep() {
  console.log('Preparing build...');
  fs.mkdirSync(build, { recursive: true });
  
  if (!fs.existsSync(template)) {
    console.log('Cloning template...');
    execSync(`git clone --depth 1 ${templateRepo} "${template}"`);
  } else {
    console.log('Updating template...');
    execSync('git reset --hard && git pull', { cwd: template });
  }
  
  fs.rmSync(path.join(template, 'test'), { recursive: true, force: true });
  
  execSync(`find "${dev}" -type f -name "*.md" -delete 2>/dev/null || true`);
  
  const templateExcludeArgs = templateExcludes
    .map(e => `--exclude="${e}"`)
    .join(' ');
  
  const rootExcludeArgs = rootExcludes
    .map(e => `--exclude="${e}"`)
    .join(' ');
  
  execSync(`rsync -r --delete ${templateExcludeArgs} "${template}/" "${dev}/"`);
  execSync(`rsync -r ${rootExcludeArgs} "${root}/" "${dev}/src/"`);
  
  sync();
  
  if (!fs.existsSync(path.join(dev, 'node_modules'))) {
    console.log('Installing dependencies...');
    execSync('npm install', { cwd: dev });
  }
  
  fs.rmSync(path.join(dev, '_site'), { recursive: true, force: true });
  console.log('Build ready.');
}

function sync() {
  const excludes = rootExcludes
    .map(e => `--exclude="${e}"`)
    .join(' ');
  
  const cmd = [
    'rsync -ru',
    excludes,
    '--include="*/"',
    '--include="**/*.md"',
    '--include="**/*.scss"',
    '--exclude="*"',
    `"${root}/"`,
    `"${dev}/src/"`
  ].join(' ');
  
  execSync(cmd);
}

if (require.main === module) prep();

module.exports = { prep, sync };