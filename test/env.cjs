// Loaded before the tests (npm test: node --require ./test/env.cjs --test,
// which Node.js 20 knows from its first version; CommonJS for that):
// whoever runs them, none of their settings reach the tests, which set what
// they need themselves, and through the test files' process environment
// nothing reaches the gateways, workers and scripts they start either. Run
// from the controller session, its start script has exported the settings
// file (VOICE_GW_*), Claude Code its session's own variables, and a service
// manager marks what it started (systemd's INVOCATION_ID, launchd's
// XPC_SERVICE_NAME). scripts/check-macos.sh runs the suite with it too.

const PREFIXES = ['VOICE_GW_', 'VOICE_SETUP_']
const NAMES = [
  'FUNNEL_PORT', // scripts/funnel.sh
  'VOICE_CLEAN_ROOT', // scripts/fetch-from-container.sh
  'VOICE_SECRETS', // the worker image
  'INVOCATION_ID',
  'XPC_SERVICE_NAME',
  // Claude Code's session (workers.mjs, SESSION_ENV)
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PROJECT_DIR',
  'AI_AGENT',
]

for (const name of Object.keys(process.env)) {
  if (PREFIXES.some(prefix => name.startsWith(prefix)) || NAMES.includes(name)) delete process.env[name]
}
