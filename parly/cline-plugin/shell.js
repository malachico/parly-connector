// Shell commands that return on their own. Cline's run_commands waits for a command to finish, and with nobody at
// the keyboard a pager (git diff into less), an editor or a credential prompt waits forever. The rule asks the model;
// guardCommands makes sure: it turns pagers, git's editor and its prompts off, and refuses full-screen programs.

export const SHELL_RULE = `# Parly: commands must return on their own

Tasks may start when a message arrives, with nobody watching the terminal. A command that waits for input stalls the task.

- Never page output: run git as \`git --no-pager ...\`, and pipe anything else that might page through \`| cat\`.
- Don't use shell aliases (\`gst\`, \`gd\`, \`ll\`): write the full command.
- Never run interactive programs (editors, \`less\`, \`top\`, \`git rebase -i\`, \`git commit\` without \`-m\`). Pass \`-y\`/\`--yes\` or set \`CI=true\` when a tool would prompt.
- Don't start servers, watchers or \`tail -f\` in the foreground. Run them in the background with output sent to a file, or wrap a command that might hang in \`timeout 120 ...\`.
`;

// Pagers print straight through, git's editor accepts what it's given (a commit without -m aborts instead of
// waiting), and git fails instead of asking for a password.
const PREFIX = 'export GIT_PAGER=cat PAGER=cat GIT_EDITOR=true GIT_TERMINAL_PROMPT=0; ';
const FULL_SCREEN = new Set(['vi', 'vim', 'nvim', 'nano', 'emacs', 'pico', 'less', 'more', 'most', 'top', 'htop', 'btop', 'watch', 'man']);

/**
 * What to do with a run_commands input: undefined to leave it, { input } with every command made non-interactive,
 * or { skip, reason } when one can only wait on a person.
 */
export function guardCommands(input, platform = process.platform) {
  let blocked;
  const output = mapCommands(input, (command) => {
    if (typeof command === 'string') {
      blocked ??= waitsOnPerson(command);
      // ponytail: POSIX shells only; Windows runs commands in PowerShell or cmd, where `export` means nothing.
      return platform === 'win32' || command.startsWith(PREFIX) ? command : PREFIX + command;
    }
    // { command, args } runs without a shell: no prefix to add, but git can still be told not to page.
    blocked ??= waitsOnPerson([command.command, ...(command.args ?? [])].join(' '));
    if (command.command === 'git' && command.args?.[0] !== '--no-pager') return { ...command, args: ['--no-pager', ...(command.args ?? [])] };
    return command;
  });
  if (blocked) {
    return {
      skip: true,
      reason: `Not run: \`${blocked}\` waits for someone at the keyboard, and nobody is there. Use a non-interactive form instead (print the file, use \`git --no-pager\`, take a snapshot like \`ps\` or \`top -b -n 1\`, or run it in the background with its output in a file).`,
    };
  }
  return output === undefined ? undefined : { input: output };
}

/** The part of a command line that runs a full-screen program or follows a file forever, if any. */
function waitsOnPerson(line) {
  for (const segment of line.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/).filter((w) => !/^\w+=/.test(w)); // skip leading VAR=value
    const [cmd, ...args] = words[0] === 'sudo' || words[0] === 'exec' ? words.slice(1) : words;
    if (!cmd) continue;
    const name = cmd.split('/').pop();
    if (FULL_SCREEN.has(name) && !(name === 'top' && args.includes('-b'))) return segment.trim();
    if (name === 'tail' && args.some((a) => /^(-[a-zA-Z]*[fF][a-zA-Z]*|--follow(=.*)?)$/.test(a))) return segment.trim();
  }
  return undefined;
}

/** Every shape run_commands accepts, with each command passed through fn; undefined for any other input. */
function mapCommands(input, fn) {
  const one = (c) => (typeof c === 'string' || (c && typeof c === 'object' && typeof c.command === 'string') ? fn(c) : c);
  if (typeof input === 'string') return fn(input);
  if (Array.isArray(input)) return input.map(one);
  if (!input || typeof input !== 'object') return undefined;
  if ('commands' in input) return { ...input, commands: Array.isArray(input.commands) ? input.commands.map(one) : one(input.commands) };
  if (typeof input.command === 'string') return 'args' in input ? fn(input) : { ...input, command: fn(input.command) };
  if (typeof input.cmd === 'string') return { ...input, cmd: fn(input.cmd) };
  return undefined;
}
