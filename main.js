const page = document.querySelector('#top');

function parseMarkdown(markdown) {
  const blocks = [];
  let paragraph = [];
  let list = [];

  function flush() {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
    if (list.length) blocks.push({ type: 'list', items: list });
    paragraph = [];
    list = [];
  }

  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim()) { flush(); continue; }
    const heading = line.match(/^(#{1,2})\s+(.+)$/);
    if (heading) { flush(); blocks.push({ type: `h${heading[1].length}`, text: heading[2] }); continue; }
    if (/^---+$/.test(line.trim())) { flush(); blocks.push({ type: 'divider' }); continue; }
    if (line.startsWith('> ')) { flush(); blocks.push({ type: 'quote', text: line.slice(2) }); continue; }
    if (line.startsWith('- ')) { list.push(line.slice(2)); continue; }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
}

function inline(text) {
  return escapeHtml(text).replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|#[\w-]+)\)/g, '<a href="$2">$1</a>');
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function renderList(items, className) {
  return `<ul class="${className}">${items.map(item => `<li>${inline(item)}</li>`).join('')}</ul>`;
}

function renderSection(heading, blocks) {
  const id = slug(heading.text);
  const paragraphs = blocks.filter(block => block.type === 'paragraph' || block.type === 'quote');
  const lists = blocks.filter(block => block.type === 'list');
  const copy = paragraphs.map(block => `<p>${inline(block.text)}</p>`).join('');
  return `<section id="${id}" aria-labelledby="${id}-title"><h2 id="${id}-title">${inline(heading.text)}</h2>${copy ? `<div class="copy">${copy}</div>` : ''}${lists.map(block => renderList(block.items, 'minor-list')).join('')}</section>`;
}

function render(markdown) {
  const blocks = parseMarkdown(markdown);
  const title = blocks.find(block => block.type === 'h1');
  const start = blocks.indexOf(title) + 1;
  const sections = blocks.slice(start).filter(block => block.type === 'h2');
  const firstSection = blocks.indexOf(sections[0]);
  const hero = blocks.slice(start, firstSection);
  document.title = title.text;

  const heroTitle = `<h1>${inline(title.text)}</h1>`;
  const overline = hero.find(block => block.type === 'quote');
  const intro = hero.filter(block => block.type === 'paragraph').map(block => `<p>${inline(block.text)}</p>`).join('');
  const links = hero.filter(block => block.type === 'list').map(block => renderList(block.items, 'links')).join('');
  const divider = hero.some(block => block.type === 'divider') ? '<div class="divider" aria-hidden="true"></div>' : '';
  const renderedSections = sections.map((section, index) => {
    const next = sections[index + 1];
    const end = next ? blocks.indexOf(next) : blocks.length;
    return renderSection(section, blocks.slice(blocks.indexOf(section) + 1, end));
  }).join('');

  page.innerHTML = `${overline ? `<p class="overline">${inline(overline.text)}</p>` : ''}${heroTitle}${intro ? `<div class="intro">${intro}</div>` : ''}${links}${divider}${renderedSections}`;
  document.querySelector('#page-footer').innerHTML = `<span>© ${escapeHtml(title.text)}</span>`;
}

async function loadContent() {
  try {
    const response = await fetch('content.md');
    if (!response.ok) throw new Error('Content request failed');
    render(await response.text());
  } catch {
    page.innerHTML = '<p>Could not load page content.</p>';
  }
}

function setupTheme() {
  const root = document.documentElement;
  const button = document.querySelector('#theme-toggle');
  const modes = ['system', 'light', 'dark'];
  let mode = localStorage.getItem('bjorn-theme') || 'system';
  const systemDark = matchMedia('(prefers-color-scheme: dark)');

  function apply() {
    root.dataset.theme = mode;
    const name = mode[0].toUpperCase() + mode.slice(1);
    button.setAttribute('aria-label', `Color theme: ${name}. Activate to change.`);
    button.title = `Color theme: ${name}`;
    button.querySelector('.icon-system').toggleAttribute('hidden', mode !== 'system');
    button.querySelector('.icon-light').toggleAttribute('hidden', mode !== 'light');
    button.querySelector('.icon-dark').toggleAttribute('hidden', mode !== 'dark');
    document.querySelector('meta[name="theme-color"]').content = mode === 'dark' || (mode === 'system' && systemDark.matches) ? '#1e1e2e' : '#eff1f5';
  }

  button.addEventListener('click', () => {
    mode = modes[(modes.indexOf(mode) + 1) % modes.length];
    localStorage.setItem('bjorn-theme', mode);
    apply();
  });
  systemDark.addEventListener('change', () => { if (mode === 'system') apply(); });
  apply();
}

loadContent();
setupTheme();
