// Write the newest commit of every app that follows its repo (has `repo` and no `commit` pin)
// into apps.lock.json. sync-apps.yml runs this and commits the change, and that commit is
// what makes Vercel redeploy the site.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const apps = JSON.parse(readFileSync('apps.json', 'utf8'));
const lock = {};
for (const a of apps) {
  if (!a.repo || a.commit) continue;
  const ref = a.branch ? `refs/heads/${a.branch}` : 'HEAD';
  const sha = execFileSync('git', ['ls-remote', a.repo, ref], { encoding: 'utf8' }).split('\t')[0].trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${a.id}: no commit for ${ref} in ${a.repo}`);
  lock[a.id] = sha;
}
writeFileSync('apps.lock.json', JSON.stringify(lock, null, 2) + '\n');
console.log(lock);
