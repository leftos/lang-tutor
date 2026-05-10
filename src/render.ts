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
      s.textContent = chunk.slice(1, -1);
      el.appendChild(s);
    } else {
      el.appendChild(document.createTextNode(chunk));
    }
  });
}

export function renderMarkdown(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();

  text.split(/(```[\s\S]*?```)/g).forEach((part) => {
    if (part.startsWith('```')) {
      const inner = part.slice(3);
      const nlIdx = inner.indexOf('\n');
      const code = (nlIdx >= 0 ? inner.slice(nlIdx + 1) : inner).replace(/```\s*$/, '').trimEnd();
      const pre = document.createElement('pre');
      pre.className = 'code-fence';
      pre.textContent = code;
      frag.appendChild(pre);
      return;
    }

    const lines = part.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i] ?? '';

      const hm = line.match(/^(#{1,3}) (.*)/);
      if (hm) {
        const level = (hm[1] ?? '').length;
        const headingEl = document.createElement('strong');
        headingEl.style.cssText = `display:block;font-size:${14 - level * 0.5}px;margin:9px 0 3px`;
        setInline(headingEl, hm[2] ?? '');
        frag.appendChild(headingEl);
        i++;
        continue;
      }

      if (line.match(/^[-*] /)) {
        const ul = document.createElement('ul');
        while (i < lines.length) {
          const l = lines[i] ?? '';
          const m = l.match(/^[-*] (.*)/);
          if (!m) break;
          const li = document.createElement('li');
          setInline(li, m[1] ?? '');
          ul.appendChild(li);
          i++;
        }
        frag.appendChild(ul);
        continue;
      }

      if (line.match(/^\d+\. /)) {
        const ol = document.createElement('ol');
        while (i < lines.length) {
          const l = lines[i] ?? '';
          const m = l.match(/^\d+\. (.*)/);
          if (!m) break;
          const li = document.createElement('li');
          setInline(li, m[1] ?? '');
          ol.appendChild(li);
          i++;
        }
        frag.appendChild(ol);
        continue;
      }

      if (!line.trim()) {
        i++;
        continue;
      }

      const p = document.createElement('p');
      const buf: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? '';
        if (!l.trim() || l.match(/^#{1,3} /) || l.match(/^[-*] /) || l.match(/^\d+\. /)) break;
        buf.push(l);
        i++;
      }
      setInline(p, buf.join('\n'));
      frag.appendChild(p);
    }
  });

  return frag;
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
      frag.appendChild(pre);
    } else {
      const s = document.createElement('span');
      s.style.whiteSpace = 'pre-wrap';
      s.textContent = part;
      frag.appendChild(s);
    }
  });
  return frag;
}
