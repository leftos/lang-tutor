/**
 * Clipboard writes plus the shared copy control used by code fences and chat messages.
 *
 * `copyText` prefers the async Clipboard API and falls back to a hidden textarea with
 * `document.execCommand('copy')` when that API is missing (an insecure origin) or its
 * promise rejects.
 */

/** How long the copied / failed state stays on a button. */
const FEEDBACK_MS = 1500;

/** Copies `text`, reporting whether the clipboard took it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.error('[clipboard] navigator.clipboard.writeText failed; using the execCommand fallback:', err);
  }
  return copyViaTextarea(text);
}

/** The fallback path: a hidden textarea plus the deprecated `copy` command. */
function copyViaTextarea(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  try {
    area.select();
    const ok = document.execCommand('copy');
    if (!ok) console.error('[clipboard] document.execCommand("copy") returned false');
    return ok;
  } catch (err) {
    console.error('[clipboard] document.execCommand("copy") threw:', err);
    return false;
  } finally {
    area.remove();
  }
}

export interface CopyButtonOptions {
  /** The button's accessible name at rest, e.g. "Copy code". */
  ariaLabel: string;
  /** Visible label beside the icon; icon-only buttons omit it. */
  label?: string;
}

/**
 * A `ghost-btn` copy control. Clicking it copies `getText()` and shows the result for
 * `FEEDBACK_MS`: a check icon for success, an alert icon and "Copy failed" for failure, with the
 * outcome mirrored into a polite live region so assistive tech announces it.
 */
export function createCopyButton(getText: () => string, options: CopyButtonOptions): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost-btn copy-btn';
  button.setAttribute('aria-label', options.ariaLabel);
  button.title = options.ariaLabel;

  const icon = document.createElement('i');
  icon.className = 'ti ti-copy';
  icon.setAttribute('aria-hidden', 'true');
  button.appendChild(icon);

  let labelEl: HTMLSpanElement | null = null;
  if (options.label !== undefined) {
    labelEl = document.createElement('span');
    labelEl.className = 'copy-btn-label';
    labelEl.setAttribute('aria-hidden', 'true');
    labelEl.textContent = options.label;
    button.appendChild(labelEl);
  }

  const status = document.createElement('span');
  status.className = 'visually-hidden';
  status.setAttribute('aria-live', 'polite');
  button.appendChild(status);

  let timer: number | null = null;

  const restore = (): void => {
    timer = null;
    icon.className = 'ti ti-copy';
    if (labelEl !== null) labelEl.textContent = options.label ?? '';
    status.textContent = '';
    button.setAttribute('aria-label', options.ariaLabel);
    button.title = options.ariaLabel;
  };

  const showResult = (copied: boolean): void => {
    if (timer !== null) window.clearTimeout(timer);
    const message = copied ? 'Copied' : 'Copy failed';
    icon.className = copied ? 'ti ti-check' : 'ti ti-alert-triangle';
    if (labelEl !== null) labelEl.textContent = message;
    status.textContent = message;
    button.setAttribute('aria-label', copied ? options.ariaLabel : message);
    button.title = copied ? options.ariaLabel : message;
    timer = window.setTimeout(restore, FEEDBACK_MS);
  };

  button.addEventListener('click', () => void copyText(getText()).then(showResult));

  return button;
}
