// The kill switch's rule on writes outside the allowed folders (guard.mjs),
// swept with commands as workers run them: sed, awk, grep and jq with < > ;
// and | in their patterns, echo with them in quotes, heredocs, 2>&1 and
// &>/dev/null, $(…) and backticks, loops, git with its messages, npm, node -e,
// python -c and python heredocs, test scripts in /tmp, process listings
// through /proc, cd. None of them may trip the rule; the real writes outside
// the repository and the temporary folders below must. The run's repository
// is /work/alpha.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'

process.env.VOICE_GW_LOG_FILE = ''
const { RunGuard, isDevice, parseShell } = await import('../src/guard.mjs')

// Normal commands: none of them may trip the rule.
const NORMAL = [
  // sed, awk, grep, jq, with < > ; | in patterns and quotes
  `sed -n '/<section id="selection"/,/<\\/section>/p' index.html`,
  `sed -n '1,/^---$/p' README.md`,
  `sed 's/;/,/g' data.csv > /tmp/data.csv`,
  `sed -e 's/a/b/' -e 's/<b>/<i>/g' page.html | head -20`,
  `sed -i 's/>old</>new</g' src/page.html`,
  `sed -i.bak -e 's|/usr/local/bin|/opt/bin|' scripts/install.sh`,
  `sed -i -e 's/a/b/' -e 's|x|/etc/y|' src/config.txt`,
  `sed -E 's/(foo|bar)>/\\1 >/' file.txt`,
  `awk '$3 > 100 {print $1}' stats.txt`,
  `awk -F'|' '{ if ($2 > 5) print $1; }' table.txt > /tmp/big.txt`,
  `awk 'BEGIN { x = 1; print x > "/dev/stderr" }'`,
  `awk "{ if (\\$1 > 5) print }" numbers.txt`,
  `grep -n "=>" src/*.js | head`,
  `grep -rE 'a|b' src > /tmp/matches.txt`,
  `grep -c "<div>" index.html > /tmp/count.txt`,
  `grep -v '^#' .env.example | grep -E '^[A-Z_]+=' | cut -d= -f1`,
  `grep -o '<a href="[^"]*">' page.html | sort -u`,
  `jq '.items[] | select(.size > 1000) | .name' data.json`,
  `jq -r '.dependencies | keys[]' package.json`,
  `jq --arg v "1.2" '.version = $v' package.json > /tmp/package.json && mv /tmp/package.json package.json`,
  `jq '.a > 1 and .b < 2' x.json`,
  `rg -n "fn .*\\) -> Result<" src/`,
  `perl -ne 'print if /<tr>/ .. /<\\/tr>/' table.html`,
  `cut -d';' -f2 data.csv | sort | uniq -c | sort -rn | head`,
  // echo and printf, with > ; and command words in quotes
  `echo "a > b" && echo 'c >> d'`,
  `echo "Run: cd /tmp; rm -rf build" >> NOTES.md`,
  `printf '%s > %s\\n' a b`,
  `echo "<html>" > index.html`,
  `echo "$(date) > started" >> /tmp/log`,
  `echo "$(date -u +%FT%TZ) > /var/log/syslog has more" >> build.log`,
  `echo it\\'s fine`,
  `echo 'it'\\''s > fine'`,
  `echo "Fix; mkdir ~/.config/app is handled" > notes.txt`,
  `echo "a | tee /etc/x" | wc -c`,
  // redirections
  `npm test 2>&1 | tail -40`,
  `npm test > /tmp/test.log 2>&1; echo $?`,
  `node server.js &>/dev/null &`,
  `node server.js &>> /tmp/server.log &`,
  `ls missing 2>/dev/null || true`,
  `command -v gh >/dev/null 2>&1 && echo yes`,
  `echo warning >&2`,
  `echo warning 1>&2`,
  `exec 3>/tmp/fd3; echo hi >&3; exec 3>&-`,
  `cat file > /dev/stdout`,
  `echo err > /dev/stderr`,
  `echo x > /dev/fd/2`,
  `echo x | tee /dev/stderr`,
  `echo x | tee /dev/fd/2 > /dev/null`,
  `python3 script.py > /dev/tty 2>&1 || true`,
  `make 2> >(tee /tmp/make.err >&2)`,
  `diff <(sort a.txt) <(sort b.txt)`,
  `node -e 'console.log(1)' >| /tmp/out.txt`,
  `cat <<< "a > b; rm -rf /etc"`,
  `read -r -p "x > " ans < /dev/null`,
  `wc -l < src/a.js`,
  // command substitutions and backticks
  `for p in $(pgrep node); do echo "$p $(readlink /proc/$p/cwd 2>/dev/null)"; done`,
  'v=$(git rev-parse HEAD 2>/dev/null) && w=`cat a 2>/dev/null`',
  `echo "Version: $(node -p "require('./package.json').version")"`,
  `test "$(git status --porcelain)" = "" && echo clean`,
  `count=$(( $(wc -l < file.txt) > 10 ? 1 : 0 ))`,
  `echo $((1 << 4)) $(( 2 > 1 ))`,
  `if (( n > 5 )); then echo big; fi`,
  `if [[ "$a" > "$b" ]]; then echo later; fi`,
  `[[ -f a && $x > /etc ]] && echo yes`,
  `[ "$a" \\> "$b" ] && echo yes`,
  `files=( $(git diff --name-only) ); echo "\${#files[@]}"`,
  `echo "\${HOME}/.config is where it goes"`,
  `echo "\${VAR:-$(pwd)}"`,
  `echo "$(echo "nested > quotes")" > /tmp/n.txt`,
  `kill $(lsof -t -i:8765) 2>/dev/null; sleep 1`,
  // loops
  `for f in src/*.js; do wc -l "$f"; done > /tmp/lines.txt`,
  `for f in *.txt; do mv "$f" "\${f%.txt}.md"; done`,
  `while read -r line; do echo "$line"; done < input.txt`,
  `while IFS= read -r f; do grep -c TODO "$f"; done < <(git ls-files)`,
  `for i in 1 2 3; do sleep 1; curl -s localhost:8765 > /dev/null && break; done`,
  `for ((i=0; i<3; i++)); do echo $i; done`,
  `case "$x" in a) echo one;; b) echo two;; esac`,
  `until curl -s localhost:3000 >/dev/null; do sleep 1; done`,
  `git ls-files | while read -r f; do [ -s "$f" ] || echo "$f"; done`,
  // git and gh
  `git status --porcelain && git log --oneline -5`,
  `git log --format='%h %s > %an' -3`,
  `git diff --stat HEAD~1 > /tmp/diff.txt`,
  `git commit -m "Fix: x > y; rm stale files from ~/.cache handling"`,
  `git commit -m "$(cat <<'EOF'
Guard: a > in quotes is no redirection

1) Writes to /etc/x were read wrongly; rm -rf /var/x is "data".
2) More (cases) here > there.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"`,
  `git commit -F - <<'EOF'
Fix: cp config ~/.config/app
rm -rf /etc/x is text here; echo x > /etc/y too
EOF`,
  `git checkout -b voice/fix && git push -u origin voice/fix`,
  `git stash list; git branch --show-current`,
  `git -C ../other log -1`,
  `cd "$(git rev-parse --show-toplevel)" && git status`,
  `gh pr create --draft --title "Fix > bug" --body "Closes #12; see ~/notes"`,
  `gh pr view 12 --json state,reviews | jq '.reviews | length > 0'`,
  // npm, node, python
  `npm ci && npm test -- --reporter=dot`,
  `npm run build 2>&1 | grep -i error > /tmp/errors.txt || true`,
  `node -e "const fs=require('fs'); fs.writeFileSync('/tmp/x.json', JSON.stringify({a: 1 > 0}))"`,
  `node --input-type=module -e 'import fs from "node:fs"; console.log(1 > 0)'`,
  `python3 -c "import sys; print(1 > 0, file=sys.stderr)"`,
  `python3 - <<'EOF'
import json, os
with open('/tmp/out.json', 'w') as f:
    json.dump({'a': 1 > 0}, f)
if a > b: print("x > /etc/y")
rm -rf = 'not shell'
EOF`,
  `python3 <<EOF
print("$HOME > x; cp a /etc/b")
EOF`,
  `node <<'EOF'
const a = 1 > 0; console.log(a)
EOF`,
  // test scripts in /tmp
  `cat > /tmp/test.sh <<'EOF'
#!/bin/sh
set -e
cd "$(dirname "$0")"
npm test > /tmp/test.log 2>&1 || { echo "failed; see > log"; exit 1; }
rm -rf build
EOF
chmod +x /tmp/test.sh && /tmp/test.sh`,
  `cat > /tmp/check.mjs <<'EOF'
import fs from 'node:fs'
if (a > b) fs.rmSync('build', { recursive: true })
mkdir ~/.cache/x; echo > /etc/z
EOF
node /tmp/check.mjs`,
  `tee /tmp/notes.txt <<'EOF'
line > one; line two
EOF`,
  `cat <<EOF > /tmp/config.json
{"home": "$HOME", "n": 1}
EOF`,
  `mkdir -p /tmp/work && cd /tmp/work && echo x > a.txt && rm -rf /tmp/work`,
  `TMP=$(mktemp -d) && echo x > "$TMP/a" && rm -rf "$TMP"`,
  `trap 'rm -f /tmp/x.$$' EXIT; echo > /tmp/x.$$`,
  `bash -c 'echo x > /tmp/y'`,
  `sh -c "npm test > /tmp/t.log 2>&1"`,
  // processes through /proc
  `ls -l /proc/*/cwd 2>/dev/null | grep traffic`,
  `for p in /proc/[0-9]*; do cat $p/cmdline 2>/dev/null | tr '\\0' ' '; echo; done | grep node`,
  `ps -eo pid,ppid,args | grep -v grep | grep "claude -p"`,
  `cat /proc/$$/status | grep -i ppid`,
  // cd, then relative writes
  `cd src && npm test`,
  `cd sub/dir && touch new.txt && cd ../.. && git add -A`,
  `(cd docs && make html) && ls docs/_build`,
  `(cd / && ls) && touch here.txt`,
  `cd /tmp && rm -rf old-build`,
  `pushd web >/dev/null && npm run build; popd >/dev/null`,
  `cd /work/alpha/src && echo x > a.txt`,
  // other everyday commands
  `curl -sS https://example.com -o /tmp/page.html`,
  `docker ps --format '{{.Names}} > {{.Status}}'`,
  `find . -name '*.orig' -delete`,
  `find /tmp -maxdepth 1 -name 'voice-*' -exec rm -rf {} \\;`,
  `xargs -I{} sh -c 'echo {} > /dev/null' < list.txt`,
  `sort -u words.txt -o /tmp/words.txt`,
  `tar -czf /tmp/backup.tgz src`,
  `ln -sf ../shared/config.json config.json`,
  `cp -r fixtures /tmp/fixtures && cp /tmp/fixtures/a.json test/`,
  `install -m 644 dist/app.js build/app.js`,
  `dd if=/dev/zero of=/tmp/blob bs=1k count=1 2>/dev/null`,
  `chmod +x scripts/*.sh && chmod 755 bin/run`,
  `touch -d '2020-01-01 00:00' old.txt`,
  `truncate -s 0 /tmp/log.txt`,
  `sleep 2; echo "server > ready" # comment with > /etc/x`,
  `true # rm -rf /etc`,
  `export PATH="$HOME/.local/bin:$PATH"; which claude`,
  `env FOO=1 BAR=2 node -e 'console.log(process.env.FOO > 0)'`,
  `time npm test > /tmp/t.log`,
  `nohup node server.js > /tmp/server.log 2>&1 &`,
  `timeout 60 npm test 2>&1 | tee /tmp/test.log`,
  `{ echo a; echo b; } > /tmp/ab.txt`,
  `rm "$UNKNOWN"/x`,
]

// Real writes outside: [command, the path the reason names].
const OUTSIDE = [
  ['echo x > /etc/x', '/etc/x'],
  ['echo evil >> ~/.bashrc', '~/.bashrc'],
  ['echo x &> /etc/both', '/etc/both'],
  ['echo x &>> /etc/both', '/etc/both'],
  ['echo x 2> /etc/err', '/etc/err'],
  ['echo x >| /etc/clobber', '/etc/clobber'],
  ['cat a 1<> /etc/readwrite', '/etc/readwrite'],
  ['echo x >& /etc/dup-file', '/etc/dup-file'],
  ['exec > /etc/log 2>&1', '/etc/log'],
  ['> /etc/emptied', '/etc/emptied'],
  ['echo x >/etc/nospace', '/etc/nospace'],
  ['echo x>/etc/glued', '/etc/glued'],
  ['echo x > "/etc/quoted target"', '/etc/quoted target'],
  ["echo \\' > /etc/escaped \\'", '/etc/escaped'],
  [`echo '<b>' >> '/etc/after quotes'`, '/etc/after quotes'],
  ['echo x > /dev/sda', '/dev/sda'],
  ['cp tool /usr/local/bin/tool', '/usr/local/bin/tool'],
  ['mv a ~/bin/a', '~/bin/a'],
  ['cp -t /etc a b', '/etc'],
  ['install -d /opt/thing', '/opt/thing'],
  ['ln -s x /usr/local/bin/x', '/usr/local/bin/x'],
  ['rsync -a dist/ /var/www/', '/var/www'],
  ['rm -rf ~/.ssh', '~/.ssh'],
  ['mkdir -p ~/.config/x', '~/.config/x'],
  ['touch /etc/x', '/etc/x'],
  ['chmod 777 /etc/passwd', '/etc/passwd'],
  ['sed -i s/a/b/ ../other/config', '/work/other/config'],
  ["sed -i -e 's/a/b/' -e 's/c/d/' /etc/hosts", '/etc/hosts'],
  ["sed --in-place=.bak 's/a/b/' /etc/hosts", '/etc/hosts'],
  ['dd if=/dev/zero of=/dev/sda', '/dev/sda'],
  ['echo x | tee -a /etc/hosts', '/etc/hosts'],
  ['echo x | sudo tee /etc/x', '/etc/x'],
  ['echo x | tee $HOME/.ssh/authorized_keys', '~/.ssh/authorized_keys'],
  ['cd / && rm -rf etc', '/etc'],
  ['cd .. && rm -rf other', '/work/other'],
  ['cd /tmp && cd /etc && touch x', '/etc/x'],
  ['cd "$UNKNOWN" && echo x > /etc/absolute', '/etc/absolute'],
  ['echo "$(cat a > /etc/substituted)"', '/etc/substituted'],
  ['echo `touch /etc/backtick`', '/etc/backtick'],
  ['diff <(echo x > /etc/procsub) a', '/etc/procsub'],
  ['x=$(echo > /etc/assign)', '/etc/assign'],
  ['for f in a b; do cp $f /etc/; done', '/etc'],
  ['if true; then rm -rf /etc/x; fi', '/etc/x'],
  ['while true; do echo > /etc/loop; break; done', '/etc/loop'],
  ['for f in a; do echo; done > /etc/after-loop', '/etc/after-loop'],
  ["bash <<'EOF'\nrm -rf /etc/x\nEOF", '/etc/x'],
  ["bash -c 'rm -rf /etc/x'", '/etc/x'],
  ['sh -c "echo x > /etc/y"', '/etc/y'],
  ['cat <<EOF\n$(touch /etc/heredoc)\nEOF', '/etc/heredoc'],
  ['echo "a; b" ; touch /etc/after-quotes', '/etc/after-quotes'],
  ["git commit -m \"$(cat <<'EOF'\nmessage\nEOF\n)\" && touch /etc/after-message", '/etc/after-message'],
  // A script written from a heredoc and run in the same call.
  ["cat > /tmp/s.sh <<'EOF'\nset -e\nrm -rf /etc/from-script\nEOF\nsh /tmp/s.sh", '/etc/from-script'],
  ["cat <<'EOF' > run.sh\necho x > /etc/from-run\nEOF\nchmod +x run.sh && ./run.sh", '/etc/from-run'],
  ["tee /tmp/t.sh >/dev/null <<'EOF'\ntouch ~/.from-tee\nEOF\nbash /tmp/t.sh", '~/.from-tee'],
]


// What the rule makes of one Bash call: the reasons it trips with.
function trips(command, tool = 'Bash') {
  const workers = new EventEmitter()
  const tripped = []
  const guard = new RunGuard({
    workers,
    runner: { dir: name => `/work/${name}`, git: async () => null },
    killswitch: { trip: event => tripped.push(event.reason) },
    ghBin: '/bin/false',
    mainCheckSeconds: 3600,
    log: () => {},
  })
  const task = { id: 'tabc', repo: 'alpha', dir: '/work/alpha', slug: null, defaultBranch: 'main', startedAt: Date.now() }
  workers.emit('started', task)
  const input = tool === 'Bash' ? { command } : { file_path: command, content: 'x' }
  workers.emit('tool', task, { type: 'tool_use', name: tool, input })
  guard.close()
  return tripped
}

test('the sweep: normal worker commands write nothing outside', () => {
  const tripped = NORMAL.map(command => [command, trips(command)]).filter(([, reasons]) => reasons.length)
  assert.deepEqual(tripped, [], 'none of them trips the rule')
})

test('the sweep: real writes outside the repository and the temporary folders still trip it', () => {
  for (const [command, path] of OUTSIDE) {
    const reasons = trips(command)
    assert.equal(reasons.length, 1, command)
    assert.match(reasons[0], /^write outside the allowed folders: /, command)
    assert.ok(reasons[0].includes(path.replace(/^~/, homedir())), `${command}: ${reasons[0]}`)
  }
})

test("the run's own Claude Code memory folder is allowed, another project's is not", () => {
  const own = `${homedir()}/.claude/projects/-work-alpha/memory`
  assert.deepEqual(trips(`${own}/feedback-pr-ready.md`, 'Write'), [])
  assert.deepEqual(trips(`${own}/MEMORY.md`, 'Edit'), [])
  assert.deepEqual(trips(`cat >> ~/.claude/projects/-work-alpha/memory/MEMORY.md <<'EOF'\n- note\nEOF`), [])
  assert.match(trips(`${homedir()}/.claude/projects/-work-beta/memory/x.md`, 'Write')[0], /-work-beta\/memory\/x\.md/)
  assert.match(trips(`${homedir()}/.claude/projects/-work-alpha/other.jsonl`, 'Write')[0], /-work-alpha\/other\.jsonl/)
  assert.match(trips(`echo x > ~/.claude/settings.json`)[0], /\.claude\/settings\.json/)
})

test('devices are no write outside: /dev/null, the standard streams, /dev/fd/N; a disk is', () => {
  for (const path of ['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/fd/2', '/dev/fd/12', '/proc/self/fd/1']) {
    assert.ok(isDevice(path), path)
    assert.deepEqual(trips(`echo x > ${path}`), [], path)
    assert.deepEqual(trips(`echo x | tee ${path}`), [], path)
    assert.deepEqual(trips(path, 'Write'), [], path)
  }
  for (const path of ['/dev/sda', '/dev/null2', '/dev/fd/x', '/dev/nullx/y', '/dev/shm/x']) assert.ok(!isDevice(path), path)
  assert.match(trips('/dev/sda', 'Write')[0], /Write \/dev\/sda/)
})

test('parseShell: data stays data, commands in substitutions and a shell\'s heredoc are commands', () => {
  const commands = source => parseShell(source).filter(e => e.type === 'command').map(e => [e.words, e.writes])
  assert.deepEqual(commands(`echo "a > b; rm x" 'c | d' # > /etc/x`), [[['echo', 'a > b; rm x', 'c | d'], []]])
  assert.deepEqual(commands('cat > /tmp/s.sh <<\'EOF\'\nrm -rf /etc\nEOF\necho ok'), [[['cat'], ['/tmp/s.sh']], [['echo', 'ok'], []]])
  assert.deepEqual(commands('bash <<EOF\nrm -rf /etc\nEOF'), [[['bash'], []], [['rm', '-rf', '/etc'], []]])
  assert.deepEqual(commands('x=$(cd /tmp; cat a 2>/dev/null) && echo "$x" >&2'), [
    [['cd', '/tmp'], []],
    [['cat', 'a'], ['/dev/null']],
    [['x=$(…)'], []],
    [['echo', '$x'], []],
  ])
  assert.deepEqual(commands('if [[ $a > $b ]] && (( a > b )); then :; fi'), [
    [['if', '[[', '$a', '>', '$b', ']]'], []],
    [['((…))'], []],
    [['then', ':'], []],
    [['fi'], []],
  ])
  assert.deepEqual(commands('cmd 2>&1 >&2 1>&- 3>> "$HOME/log" &> out'), [[['cmd'], ['$HOME/log', 'out']]])
  // A subshell's cd stays in it.
  const events = parseShell('(cd / && ls) && touch here').map(e => e.type)
  assert.deepEqual(events, ['open', 'command', 'command', 'close', 'command'])
})
