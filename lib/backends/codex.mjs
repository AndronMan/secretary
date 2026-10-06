import { existsSync, readdirSync } from 'node:fs';
import { access, chmod, copyFile, lstat, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ensurePrivateDir, stateParent } from '../core.mjs';

export async function prepareIsolatedCodexHome(codexHome, env = process.env) {
  await ensurePrivateDir(codexHome);
  // Windows sets USERPROFILE, not HOME. Without this fallback sourceHome becomes the relative
  // path '.codex', auth is never found, and the child runs unauthenticated.
  const homeDirectory = env.HOME || env.USERPROFILE || homedir() || '';
  const sourceHome = env.SECRETARY_SOURCE_CODEX_HOME || env.CODEX_HOME || path.join(homeDirectory, '.codex');
  const sourceAuth = path.join(sourceHome, 'auth.json');
  const targetAuth = path.join(codexHome, 'auth.json');
  try {
    await access(targetAuth);
  } catch {
    try {
      const metadata = await lstat(sourceAuth);
      if (!metadata.isFile() && !metadata.isSymbolicLink()) return { codexHome, authLinked: false };
      try {
        await symlink(sourceAuth, targetAuth);
      } catch (error) {
        // Windows refuses symlinks with EPERM unless Developer Mode or elevation is on, and the
        // previous behaviour swallowed that and handed Codex an empty home, producing a 401 that
        // blames authentication rather than the link. Fall back to a copy into the already
        // private CODEX_HOME. Symlink stays preferred so no credential copy exists when the
        // host permits linking.
        if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
        await copyFile(sourceAuth, targetAuth);
        try {
          await chmod(targetAuth, 0o600);
        } catch {
          // POSIX modes are advisory on Windows; the parent directory is the real boundary.
        }
      }
    } catch {
      return { codexHome, authLinked: false };
    }
  }
  return { codexHome, authLinked: true };
}

// Windows has no `codex` executable on PATH. npm installs a `codex.cmd` shim, and spawn runs with
// shell:false, so naming the shim raises EINVAL and naming the bare command raises ENOENT. Both
// surface as "child API preflight could not start", which reads like an auth or network fault.
// Resolve the vendored native binary the shim would have launched instead.
export function resolveCodexBinary(env = process.env, platform = process.platform) {
  if (env.SECRETARY_CODEX_BIN) return env.SECRETARY_CODEX_BIN;
  if (platform !== 'win32') return 'codex';
  const directories = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const direct = path.join(directory, 'codex.exe');
    if (existsSync(direct)) return direct;
  }
  for (const directory of directories) {
    if (!existsSync(path.join(directory, 'codex.cmd'))) continue;
    const vendorRoot = path.join(
      directory,
      'node_modules', '@openai', 'codex', 'node_modules',
      `@openai/codex-win32-${process.arch}`.replace('/', path.sep),
      'vendor',
    );
    if (!existsSync(vendorRoot)) continue;
    for (const triple of readdirSync(vendorRoot)) {
      const candidate = path.join(vendorRoot, triple, 'bin', 'codex.exe');
      if (existsSync(candidate)) return candidate;
    }
  }
  return 'codex';
}

export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function buildCodexInvocation({ neutralCwd, codexHome, model, reasoningEffort, outputSchema, env = process.env, binary }) {
  if (!outputSchema) throw new Error('Codex output schema path is required');
  if (reasoningEffort && !CODEX_REASONING_EFFORTS.includes(reasoningEffort)) {
    throw new Error(`reasoning effort must be one of ${CODEX_REASONING_EFFORTS.join(', ')}`);
  }
  const writableParent = stateParent(env);
  const args = [
    'exec',
    '--json',
    '--ignore-user-config',
    '--skip-git-repo-check',
    '--output-schema', outputSchema,
    '-s', 'read-only',
    '-c', 'sandbox_workspace_write.network_access=true',
    // JSON.stringify escapes backslashes and quotes exactly as a TOML basic string requires.
    // A raw Windows path here (C:\Users\...) makes Codex parse the value as a string rather
    // than a sequence, and it exits 1 before the run starts. No-op for POSIX paths.
    '-c', `sandbox_workspace_write.writable_roots=[${JSON.stringify(writableParent)}]`,
    '-c', 'approval_policy="never"',
    '-C', neutralCwd,
  ];
  if (model) args.push('-m', model);
  // --ignore-user-config drops the host config.toml, so effort is the model default unless it is
  // set here explicitly.
  if (reasoningEffort) args.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
  args.push('-');
  return { command: binary || resolveCodexBinary(env), args, env: { ...env, CODEX_HOME: codexHome } };
}

export function parseCodexResult({ exitCode, stdout, stderr, timedOut = false }) {
  if (timedOut) return { ok: false, error: 'Codex run timed out', raw: { stdout, stderr, exitCode } };
  const events = [];
  for (const [index, line] of stdout.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      return { ok: false, error: `Codex JSONL line ${index + 1} is not JSON`, raw: { stdout, stderr, exitCode } };
    }
  }
  const failed = events.find((event) => event.type === 'turn.failed');
  if (failed) return { ok: false, error: failed.error?.message || 'Codex turn failed', events };
  if (exitCode !== 0) return { ok: false, error: `Codex exited ${exitCode}: ${stderr}`.trim(), events };
  if (!events.some((event) => event.type === 'turn.completed')) return { ok: false, error: 'Codex output lacks turn.completed', events };
  const messages = events
    .filter((event) => event.type === 'item.completed' && event.item?.type === 'agent_message')
    .map((event) => event.item.text)
    .filter((text) => typeof text === 'string');
  if (messages.length === 0) return { ok: false, error: 'Codex output lacks a completed agent message', events };
  let structuredOutput;
  try {
    structuredOutput = JSON.parse(messages.at(-1));
  } catch {
    return { ok: false, error: 'Codex final agent message is not JSON', events };
  }
  if (!structuredOutput || typeof structuredOutput !== 'object' || Array.isArray(structuredOutput)) {
    return { ok: false, error: 'Codex final agent message is not a JSON object', events };
  }
  const envelope = { type: 'result', is_error: false, structured_output: structuredOutput };
  return { ok: true, envelope, structuredOutput, events };
}

export function parseCodexPreflight(input) {
  const parsed = parseCodexResult(input);
  if (!parsed.ok) return parsed;
  if (parsed.structuredOutput.ok !== true) return { ok: false, error: 'Codex preflight response was not ok', events: parsed.events };
  return parsed;
}
