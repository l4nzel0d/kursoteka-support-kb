/**
 * Синхронизация задачи GitHub со статьёй базы знаний BookStack.
 *
 * Скрипт вызывается рабочим процессом .github/workflows/bookstack-sync.yml
 * по событиям issues: opened, edited, closed, reopened.
 *
 * Порядок работы:
 *   1. Тело задачи разбирается на разделы KCS-шаблона.
 *   2. Markdown каждого раздела преобразуется в HTML библиотекой marked,
 *      поскольку BookStack принимает содержимое страницы в виде HTML.
 *   3. По тегу github_issue отыскивается ранее созданная статья.
 *   4. Статья создаётся (POST /api/pages) либо обновляется (PUT /api/pages/{id}).
 *
 * Поиск по тегу решает сразу две задачи: исключает появление дубликатов при
 * повторных событиях и позволяет обновлять статью даже после переименования задачи.
 */

import { appendFileSync } from 'node:fs';
import { marked } from 'marked';

/* ------------------------------------------------------------------ */
/* Входные данные                                                      */
/* ------------------------------------------------------------------ */

const REQUIRED = [
  'BOOKSTACK_URL',
  'BOOKSTACK_API_ID',
  'BOOKSTACK_API_SECRET',
  'BOOKSTACK_BOOK_ID',
];

const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Не заданы секреты репозитория: ${missing.join(', ')}`);
  process.exit(1);
}

const baseUrl = process.env.BOOKSTACK_URL.replace(/\/+$/, '');
const bookId = Number(process.env.BOOKSTACK_BOOK_ID);

const issue = {
  number: Number(process.env.ISSUE_NUMBER),
  title: (process.env.ISSUE_TITLE || '').trim(),
  body: process.env.ISSUE_BODY || '',
  url: process.env.ISSUE_URL || '',
  state: process.env.ISSUE_STATE || 'open',
  author: process.env.ISSUE_AUTHOR || '',
  updatedAt: process.env.ISSUE_UPDATED_AT || '',
};

const repository = process.env.GITHUB_REPOSITORY || '';
const eventAction = process.env.EVENT_ACTION || '';
const isClosed = issue.state === 'closed';

/* ------------------------------------------------------------------ */
/* Разбор тела задачи на разделы KCS-шаблона                           */
/* ------------------------------------------------------------------ */

/** Разделы статьи в том порядке, в каком они выводятся на странице. */
const SECTIONS = [
  { title: 'Проблема', aliases: ['проблема', 'краткое описание', 'симптом'] },
  { title: 'Причина', aliases: ['причина', 'диагноз'] },
  { title: 'Решение', aliases: ['решение', 'подробное решение', 'краткий ответ'] },
  { title: 'Ссылки', aliases: ['ссылки', 'связанные статьи', 'связанные материалы'] },
];

/** Приводит заголовок к виду, пригодному для сравнения: без эмодзи и регистра. */
function normalizeHeading(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Удаляет комментарии-подсказки шаблона, чтобы они не попали в статью. */
function stripComments(markdown) {
  return markdown.replace(/<!--[\s\S]*?-->/g, '');
}

/** Разбивает тело задачи на разделы по заголовкам второго и третьего уровня. */
function splitSections(markdown) {
  const sections = new Map();
  let current = '';
  sections.set(current, []);

  for (const line of stripComments(markdown).replace(/\r\n/g, '\n').split('\n')) {
    const heading = /^#{2,4}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = normalizeHeading(heading[1]);
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    sections.get(current).push(line);
  }

  const result = new Map();
  for (const [name, lines] of sections) {
    result.set(name, lines.join('\n').trim());
  }
  return result;
}

/** Возвращает содержимое первого найденного по псевдонимам раздела. */
function pickSection(sections, aliases) {
  for (const alias of aliases) {
    const value = sections.get(alias);
    if (value) return value;
  }
  return '';
}

/** Раздел «Метки» превращается в список тем: списки и запятые считаются разделителями. */
function parseTopics(sections) {
  const raw = pickSection(sections, ['метки', 'теги', 'ключевые слова']);
  return raw
    .split(/[\n,;]+/)
    .map((item) => item.replace(/^[-*\d.)\s]+/, '').replace(/[`#]/g, '').trim())
    .filter((item) => item.length > 0 && item !== '...' && item.length <= 255);
}

/* ------------------------------------------------------------------ */
/* Формирование страницы                                               */
/* ------------------------------------------------------------------ */

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Moscow',
  }).format(new Date(iso));
}

/** Заголовок статьи: номер задачи впереди, служебный префикс шаблона убран. */
function buildPageName() {
  const title = issue.title.replace(/^\s*\[KCS\]\s*/i, '').trim() || 'Без названия';
  return `#${issue.number} — ${title}`;
}

function buildHtml(sections) {
  const parts = [];

  parts.push(
    '<p>' +
      `<strong>Статус:</strong> ${isClosed ? 'решено' : 'в работе'} &nbsp;|&nbsp; ` +
      `<strong>Автор:</strong> ${escapeHtml(issue.author)} &nbsp;|&nbsp; ` +
      `<strong>Обновлено:</strong> ${formatDate(issue.updatedAt)}` +
      '</p>',
  );
  parts.push(
    '<p><strong>Связанная задача:</strong> ' +
      `<a href="${escapeHtml(issue.url)}">${escapeHtml(repository)}#${issue.number}</a></p>`,
  );
  parts.push('<hr>');

  for (const section of SECTIONS) {
    let content = pickSection(sections, section.aliases);

    // Требование задания: раздел «Ссылки» обязан содержать ссылку на задачу GitHub.
    if (section.title === 'Ссылки') {
      content += `\n- Задача в GitHub: [${repository}#${issue.number}](${issue.url})`;
    }

    if (!content.trim()) continue;
    parts.push(`<h2>${section.title}</h2>`);
    parts.push(marked.parse(content));
  }

  return parts.join('\n');
}

function buildTags(topics) {
  const tags = [
    // Ключ связи задачи и статьи: по нему статья отыскивается при обновлении.
    { name: 'github_issue', value: String(issue.number) },
    { name: 'status', value: isClosed ? 'решено' : 'в работе' },
    { name: 'repo', value: repository },
  ];
  for (const topic of topics) {
    tags.push({ name: 'тема', value: topic });
  }
  return tags;
}

/* ------------------------------------------------------------------ */
/* Обращения к API BookStack                                           */
/* ------------------------------------------------------------------ */

/** Коды, при которых имеет смысл повторить запрос: сбой туннеля, а не ошибка данных. */
const RETRIABLE_STATUSES = [502, 503, 504];
const MAX_ATTEMPTS = 4;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, init = {}) {
  const method = init.method || 'GET';
  let lastError;

  // BookStack опубликован через бесплатный туннель LocalTunnel: весь трафик идёт
  // через одно соединение с машиной разработчика, и при его переустановлении
  // сервис отвечает 502. Разовый сбой туннеля не должен ронять синхронизацию,
  // поэтому запрос повторяется с нарастающей паузой.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Token ${process.env.BOOKSTACK_API_ID}:${process.env.BOOKSTACK_API_SECRET}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // LocalTunnel показывает браузеру страницу-предупреждение;
          // этот заголовок отключает её для программных запросов.
          'bypass-tunnel-reminder': 'true',
          'User-Agent': 'kcs-bookstack-sync',
          ...(init.headers || {}),
        },
      });
    } catch (networkError) {
      // Соединение не установилось: туннель в этот момент был недоступен.
      lastError = new Error(`${method} ${path} — сбой соединения: ${networkError.message}`);
      if (attempt === MAX_ATTEMPTS) break;
      console.log(`Попытка ${attempt} не удалась (${networkError.message}), повтор...`);
      await wait(attempt * 3000);
      continue;
    }

    const text = await response.text();

    if (response.ok) return text ? JSON.parse(text) : null;

    lastError = new Error(
      `${method} ${path} — ответ ${response.status} ${response.statusText}\n${text}`,
    );

    // Ошибки самого BookStack (нет прав, нет книги, неверные данные) повторять
    // бессмысленно — повтор даст тот же результат, а сборка будет идти дольше.
    if (!RETRIABLE_STATUSES.includes(response.status) || attempt === MAX_ATTEMPTS) break;

    console.log(`Попытка ${attempt} вернула ${response.status}, повтор...`);
    await wait(attempt * 3000);
  }

  throw lastError;
}

/** Ищет ранее созданную статью по тегу github_issue. */
async function findExistingPage() {
  const query = `[github_issue=${issue.number}] {type:page}`;
  const found = await api(`/api/search?query=${encodeURIComponent(query)}&count=5`);

  for (const item of found?.data || []) {
    if (item.type !== 'page') continue;
    // Поиск ранжирует результаты, поэтому принадлежность подтверждается
    // проверкой самого тега на найденной странице.
    const page = await api(`/api/pages/${item.id}`);
    const linked = (page.tags || []).some(
      (tag) => tag.name === 'github_issue' && String(tag.value) === String(issue.number),
    );
    if (linked) return page;
  }
  return null;
}

function writeSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}

/* ------------------------------------------------------------------ */
/* Основной сценарий                                                   */
/* ------------------------------------------------------------------ */

async function main() {
  const sections = splitSections(issue.body);
  const topics = parseTopics(sections);
  const payload = {
    name: buildPageName(),
    html: buildHtml(sections),
    tags: buildTags(topics),
  };

  console.log(`Событие: issues.${eventAction}, задача #${issue.number}, статус ${issue.state}`);
  console.log(`Темы из раздела «Метки»: ${topics.length > 0 ? topics.join(', ') : 'не указаны'}`);

  const existing = await findExistingPage();
  let page;
  let verb;

  if (existing) {
    page = await api(`/api/pages/${existing.id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    verb = 'обновлена';
  } else {
    page = await api('/api/pages', {
      method: 'POST',
      body: JSON.stringify({ book_id: bookId, ...payload }),
    });
    verb = 'создана';
  }

  console.log(`Статья ${verb}: id=${page.id}, «${page.name}»`);
  writeSummary([
    `### Статья базы знаний ${verb}`,
    '',
    `- Задача: [${repository}#${issue.number}](${issue.url})`,
    `- Страница BookStack: id=${page.id}, «${page.name}»`,
    `- Статус: ${isClosed ? 'решено' : 'в работе'}`,
    `- Темы: ${topics.length > 0 ? topics.join(', ') : '—'}`,
  ]);
}

main().catch((error) => {
  console.error('Синхронизация не выполнена.');
  console.error(error.message);
  process.exit(1);
});
