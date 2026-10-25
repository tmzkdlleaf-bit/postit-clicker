// npm run release        → 0.3.0 → 0.3.1
// npm run release:minor  → 0.3.1 → 0.4.0
// 버전을 올리고 커밋해서 GitHub에 올림. GitHub가 설치 파일을 만들어 릴리스에 붙임
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const run = cmd => execSync(cmd, { stdio: 'inherit' });
const file = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));

const kind = process.argv[2] === 'minor' ? 'minor' : 'patch';
const [a, b, c] = pkg.version.split('.').map(Number);
const next = kind === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;

pkg.version = next;
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
try {
  const lockFile = path.join(__dirname, '..', 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  lock.version = next; if (lock.packages && lock.packages['']) lock.packages[''].version = next;
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
} catch (_) {}

run('git add -A');
run(`git commit -m "버전 ${next}"`);
run('git push');
console.log(`\n${next} 올림. 몇 분 뒤 GitHub 릴리스에 설치 파일이 생겨요.`);
