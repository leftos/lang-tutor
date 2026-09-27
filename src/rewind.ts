import type { Message, Progress, TextBlock } from './types';

// A "bundle" is the structured payload emitted by evaluateCode / evaluateProjectCode:
// `[NOTE]\n…\n\n[CODE]\n```…```\n\n[OUTPUT]\n…` etc.
const BUNDLE_TAG_PATTERN = /^\[(NOTE|CODE|OUTPUT|LSP|FILES|DOM|CONSOLE|SERVER|BUILD|COMPILER FLAGS|SCREENSHOT)\]\n/;
const BUNDLE_NON_NOTE_PATTERN = /\[(?:CODE|OUTPUT|LSP|FILES|DOM|CONSOLE|SERVER|BUILD|COMPILER FLAGS|SCREENSHOT)\]\n/;

export interface BundleBlock {
  tag: string;
  body: string;
}

/** True when `text` is a Send-to-tutor bundle: it opens with a bundle tag and carries a non-note block. */
export function isBundleText(text: string): boolean {
  return BUNDLE_TAG_PATTERN.test(text) && BUNDLE_NON_NOTE_PATTERN.test(text);
}

/** Splits a bundle into its tagged blocks, in order. */
export function parseBundleBlocks(text: string): BundleBlock[] {
  const blocks: BundleBlock[] = [];
  const re = /\[([A-Z][A-Z ]*)\]\n([\s\S]*?)(?=\n\n\[[A-Z][A-Z ]*\]\n|$)/g;
  for (const m of text.matchAll(re)) {
    const tag = m[1] ?? '';
    const body = (m[2] ?? '').trimEnd();
    if (tag === '') continue;
    blocks.push({ tag, body });
  }
  return blocks;
}

/** The text a user message was rendered from: the string itself, or its first text block. */
export function primaryText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.find((b): b is TextBlock => b.type === 'text')?.text ?? '';
}

/** True when `message` is a user message carrying a Send-to-tutor bundle. */
export function isBundleMessage(message: Message): boolean {
  return message.role === 'user' && isBundleText(primaryText(message));
}

/** The `[NOTE]` text of a bundle message, or `''` when it has none. */
export function noteOf(message: Message): string {
  const note = parseBundleBlocks(primaryText(message)).find((b) => b.tag === 'NOTE');
  return note?.body ?? '';
}

export interface RewindResult {
  /** Messages before the target. */
  kept: Message[];
  /** The target message and everything after it. */
  removed: Message[];
  /** The target's progress snapshot; `undefined` when it has none, meaning the current progress stays. */
  progressBefore: Progress | null | undefined;
}

/** Splits `history` at `index`: the target message and everything after it are removed. */
export function rewindAt(history: readonly Message[], index: number): RewindResult {
  const target = history[index];
  return {
    kept: history.slice(0, index),
    removed: history.slice(index),
    progressBefore: target?.progressBefore,
  };
}

/** Undoes a rewind: drops everything after the kept prefix (the new exchange) and restores the removed slice. */
export function undoRewind(current: readonly Message[], keptLength: number, removed: readonly Message[]): Message[] {
  return [...current.slice(0, keptLength), ...removed];
}
