import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

function disableNativeDrag(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>('a, img, pre, code, table, blockquote')) {
    el.draggable = false;
    el.setAttribute('draggable', 'false');
  }
}

export function setInline(el: HTMLElement, text: string): void {
  text.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\n)/g).forEach((chunk) => {
    if (chunk === '\n') {
      el.appendChild(document.createElement('br'));
    } else if (chunk.startsWith('**') && chunk.endsWith('**') && chunk.length > 4) {
      const s = document.createElement('strong');
      s.textContent = chunk.slice(2, -2);
      el.appendChild(s);
    } else if (chunk.startsWith('*') && chunk.endsWith('*') && chunk.length > 2) {
      const s = document.createElement('em');
      s.textContent = chunk.slice(1, -1);
      el.appendChild(s);
    } else if (chunk.startsWith('`') && chunk.endsWith('`') && chunk.length > 2) {
      const s = document.createElement('code');
      s.className = 'inline-code';
      s.draggable = false;
      s.textContent = chunk.slice(1, -1);
      el.appendChild(s);
    } else {
      el.appendChild(document.createTextNode(chunk));
    }
  });
}

export function renderMarkdown(text: string): DocumentFragment {
  const rawHtml = marked.parse(text, { async: false }) as string;
  const template = document.createElement('template');
  template.innerHTML = DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
  });

  for (const code of template.content.querySelectorAll('code')) {
    if (code.closest('pre') === null) code.classList.add('inline-code');
  }

  for (const pre of template.content.querySelectorAll('pre')) {
    pre.classList.add('code-fence');
  }

  for (const table of template.content.querySelectorAll('table')) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-table-scroll';
    table.replaceWith(wrap);
    wrap.appendChild(table);
  }

  disableNativeDrag(template.content);

  return template.content;
}

export function renderPlainWithFences(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  text.split(/(```[\s\S]*?```)/g).forEach((part) => {
    if (part.startsWith('```')) {
      const lines = part.slice(3).split('\n');
      lines.shift();
      const pre = document.createElement('pre');
      pre.className = 'code-fence';
      pre.textContent = lines
        .join('\n')
        .replace(/```\s*$/, '')
        .trimEnd();
      pre.draggable = false;
      frag.appendChild(pre);
    } else {
      const s = document.createElement('span');
      s.style.whiteSpace = 'pre-wrap';
      s.draggable = false;
      s.textContent = part;
      frag.appendChild(s);
    }
  });
  return frag;
}
