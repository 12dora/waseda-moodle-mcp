import type { MessageKey } from '../i18n';

/** Setup guides for the "Connect an AI client" card; every snippet is built from the live MCP URL. */

const NAME = 'waseda-moodle';
const KEY = '<API_KEY>';
const AUTH_HEADER = `Authorization: Bearer ${KEY}`;
/** API keys go in WMM_API_KEY; WMM_TOKEN is the stdio entry's Moodle token. */
const KEY_ENV = 'WMM_API_KEY';
const VSCODE_INPUT = 'wmm-api-key';

export type ClientId = 'claude' | 'chatgpt' | 'grok' | 'code' | 'ide' | 'cli' | 'other';

/** One numbered step; `code` renders as a copy field labelled with the step text. */
export interface ClientStep {
  text: MessageKey;
  code?: string;
}

export interface ClientGuide {
  id: ClientId;
  label: MessageKey;
  steps: ClientStep[];
  /** API-key variant, only for clients that can send a request header. */
  keySteps?: ClientStep[];
  /** One muted line, e.g. a plan requirement. */
  note?: MessageKey;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

export const claudeCodeCommand = (url: string, withKey = false) =>
  withKey
    ? `claude mcp add --transport http ${NAME} ${url} \\\n  --header "${AUTH_HEADER}"`
    : `claude mcp add --transport http ${NAME} ${url}`;

/** Cursor: the key comes from the environment (`${env:…}`), never written into mcp.json. */
export const cursorConfig = (url: string, withKey = false) =>
  json({
    mcpServers: { [NAME]: withKey ? { url, headers: { Authorization: `Bearer \${env:${KEY_ENV}}` } } : { url } },
  });

/** VS Code: with a key, prompt for it once (stored as a secret) instead of writing it into the workspace file. */
export const vscodeConfig = (url: string, withKey = false) =>
  withKey
    ? json({
        inputs: [{ type: 'promptString', id: VSCODE_INPUT, description: 'Waseda Moodle MCP API key', password: true }],
        servers: { [NAME]: { type: 'http', url, headers: { Authorization: `Bearer \${input:${VSCODE_INPUT}}` } } },
      })
    : json({ servers: { [NAME]: { type: 'http', url } } });

export const codexCommands = (url: string, withKey = false) =>
  withKey
    ? `codex mcp add ${NAME} --url ${url} --bearer-token-env-var ${KEY_ENV}`
    : `codex mcp add ${NAME} --url ${url}\ncodex mcp login ${NAME}`;

export const geminiCommands = (url: string) =>
  `gemini mcp add --transport http ${NAME} ${url}\n# then in Gemini CLI: /mcp auth ${NAME}`;

/** Gemini CLI settings.json: `httpUrl` is Streamable HTTP (`url` would mean SSE). */
export const geminiKeyConfig = (url: string) =>
  json({ mcpServers: { [NAME]: { httpUrl: url, headers: { Authorization: `Bearer ${KEY}` } } } });

export const grokCommand = (url: string, withKey = false) =>
  withKey
    ? `grok mcp add --transport http ${NAME} ${url} \\\n  --header "${AUTH_HEADER}"`
    : `grok mcp add --transport http ${NAME} ${url}`;

export function clientGuides(url: string): ClientGuide[] {
  return [
    {
      id: 'claude',
      label: 'client.tab.claude',
      steps: [{ text: 'client.claude.step1' }, { text: 'client.claude.step2' }, { text: 'client.claude.step3' }],
      note: 'client.claude.note',
    },
    {
      id: 'chatgpt',
      label: 'client.tab.chatgpt',
      steps: [{ text: 'client.chatgpt.step1' }, { text: 'client.chatgpt.step2' }, { text: 'client.chatgpt.step3' }],
      note: 'client.chatgpt.note',
    },
    {
      id: 'grok',
      label: 'client.tab.grok',
      steps: [{ text: 'client.grok.step1' }, { text: 'client.grok.step2' }],
      note: 'client.grok.note',
    },
    {
      id: 'code',
      label: 'client.tab.code',
      steps: [{ text: 'client.code.step1', code: claudeCodeCommand(url) }, { text: 'client.code.step2' }],
      keySteps: [{ text: 'client.code.key', code: claudeCodeCommand(url, true) }],
    },
    {
      id: 'ide',
      label: 'client.tab.ide',
      steps: [
        { text: 'client.ide.cursor', code: cursorConfig(url) },
        { text: 'client.ide.vscode', code: vscodeConfig(url) },
        { text: 'client.ide.connect' },
      ],
      keySteps: [
        { text: 'client.ide.cursorKey', code: cursorConfig(url, true) },
        { text: 'client.ide.vscodeKey', code: vscodeConfig(url, true) },
      ],
    },
    {
      id: 'cli',
      label: 'client.tab.cli',
      steps: [
        { text: 'client.cli.codex', code: codexCommands(url) },
        { text: 'client.cli.gemini', code: geminiCommands(url) },
        { text: 'client.cli.grok', code: grokCommand(url) },
      ],
      note: 'client.cli.note',
      keySteps: [
        { text: 'client.cli.codexKey', code: codexCommands(url, true) },
        { text: 'client.cli.geminiKey', code: geminiKeyConfig(url) },
        { text: 'client.cli.grok', code: grokCommand(url, true) },
      ],
    },
    {
      id: 'other',
      label: 'client.tab.other',
      steps: [{ text: 'client.other.step1' }, { text: 'client.other.step2' }],
      keySteps: [{ text: 'client.other.key', code: AUTH_HEADER }],
      note: 'client.other.stdio',
    },
  ];
}
