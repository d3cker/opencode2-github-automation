import { BranchName } from "./config.js";

// A standalone directive is unambiguous and works for both English and non-English issues.
export function requestedBase(texts: string[], fallback: string): string {
  let selected = fallback;
  for (const text of texts) {
    let fence: string | undefined;
    for (const line of text.split(/\r?\n/)) {
      const delimiter = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (delimiter) {
        if (!fence) fence = delimiter;
        else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = undefined;
        continue;
      }
      if (fence) continue;
      const match = /^\s*(?:\/base\s+|base\s+branch\s*:\s*)(\S+)\s*$/i.exec(line);
      if (match) selected = BranchName.parse(match[1]!.replace(/^`([^`]+)`$/, "$1"));
    }
  }
  return selected;
}
