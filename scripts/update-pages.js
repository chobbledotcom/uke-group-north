const { execSync } = require('child_process');
const fs = require('fs');

function updatePages() {
  const url = 'https://raw.githubusercontent.com/chobbledotcom/chobble-template/refs/heads/main/.pages.yml';
  const content = execSync(`curl -sL "${url}"`).toString();
  const updated = content.replace(/src\//g, '');
  
  fs.writeFileSync('.pages.yml', updated);
  console.log('Updated .pages.yml from chobble-template (with src/ removed)');
}

if (require.main === module) updatePages();

module.exports = { updatePages };