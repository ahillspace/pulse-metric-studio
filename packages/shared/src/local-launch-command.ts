export interface LocalLaunchCommand {
  file: string;
  args: string[];
}

/** Split an executable and prefix options without invoking a shell or expanding values. */
export function parseLaunchCommand(command: string): LocalLaunchCommand {
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(command)) throw new Error('Launch commands cannot contain control characters.');
  const tokens: string[] = [];
  let token = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === '"' && character === '\\') {
      let end = index;
      while (command[end] === '\\') end += 1;
      const count = end - index;
      if (command[end] === '"') {
        token += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) token += '"';
        else quote = null;
        index = end;
      } else {
        token += '\\'.repeat(count);
        index = end - 1;
      }
    } else if (quote) {
      if (character === quote) quote = null;
      else token += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) tokens.push(token);
      token = '';
      started = false;
    } else {
      token += character;
      started = true;
    }
  }
  if (quote) throw new Error('Close the quoted value in the launch command.');
  if (started) tokens.push(token);
  const [file, ...args] = tokens;
  if (!file) throw new Error('Enter an executable followed by any launch options.');
  return { file, args };
}
