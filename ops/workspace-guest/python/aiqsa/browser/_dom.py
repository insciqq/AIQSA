"""Page-side scripts. They only read the page: no attribute, global or listener is left behind.

`COLLECT` lists the rendered interactive elements of one frame in document
order (open shadow roots included) and returns them with the elements
themselves, which the browser host keeps as handles. An element that is still
on the page keeps its number from the previous list of the same document, so
a number the agent read a few steps ago still means the same element. Fields
the agent filled from the environment (`options.masked`) read as hidden values.
Names, values, links and the title come back raw (whitespace kept, at most
`options.raw` characters, with `cut` naming what was shortened): the host masks
values typed from the environment first, then makes each one bounded line
(`_format.page_items`), so page text can neither hide a value from the mask
nor pose as a step line. Page scripts never receive those values.
"""

COLLECT = r"""
(options) => {
  const STRONG = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[contenteditable=""],[contenteditable="true"],' +
    '[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],' +
    '[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="combobox"],[role="textbox"],[role="searchbox"],' +
    '[role="slider"],[role="spinbutton"],[role="treeitem"]';
  const WEAK = '[onclick],[tabindex]:not([tabindex="-1"])';
  const LEAF = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
  const max = options.max;
  const previous = new Map();
  if (options.previous) options.previous.elements.forEach((el, index) => previous.set(el, options.previous.numbers[index]));
  const masked = new Set(options.masked || []);
  const RAW = options.raw || 2000;
  let next = options.next;
  const vw = window.innerWidth, vh = window.innerHeight;
  const items = [], elements = [], numbers = [];
  let truncated = false;
  const textOf = (node) => (node && (node.innerText || node.textContent)) || '';
  const filled = (value) => String(value || '').trim().length > 0;
  const CONTROLS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']);
  // A label's own words: a control inside it (a list box's options, a field's value) is not its name.
  function labelText(label) {
    const parts = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) parts.push(child.textContent);
        else if (child.nodeType === 1 && !CONTROLS.has(child.tagName)) walk(child);
      }
    };
    walk(label);
    return parts.join(' ');
  }
  function nameOf(el) {
    let value = el.getAttribute('aria-label');
    if (filled(value)) return value;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      value = labelledBy.split(/\s+/).map((id) => textOf(el.ownerDocument.getElementById(id))).join(' ');
      if (filled(value)) return value;
    }
    if (el.labels && el.labels.length) {
      value = Array.from(el.labels).map(labelText).join(' ');
      if (filled(value)) return value;
    }
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') return el.value || type;
      if (type === 'image') return el.alt || el.title || 'image';
      return el.placeholder || el.title || el.getAttribute('name') || '';
    }
    if (tag === 'TEXTAREA' || tag === 'SELECT') return el.placeholder || el.title || el.getAttribute('name') || '';
    value = textOf(el);
    if (!filled(value)) {
      const image = el.querySelector('img[alt]');
      if (image) value = image.alt;
    }
    return filled(value) ? value : (el.title || el.getAttribute('alt') || '');
  }
  function roleOf(el) {
    const role = el.getAttribute('role');
    if (role && role.trim()) return role.trim().split(/\s+/)[0];
    const tag = el.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      return ({ checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
        submit: 'button', button: 'button', reset: 'button', image: 'button', file: 'file input', date: 'date input',
        'datetime-local': 'date input', month: 'date input', week: 'date input', time: 'time input', color: 'color input' })[type] || 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'clickable';
  }
  function describe(el, rect) {
    let number = previous.get(el);
    if (number === undefined) number = next++;
    const cut = [];
    const take = (value, key) => {
      const text = String(value == null ? '' : value);
      if (text.length <= RAW) return text;
      cut.push(key);
      return text.slice(0, RAW);
    };
    const item = { n: number, role: roleOf(el), name: take(nameOf(el), 'name') };
    const tag = el.tagName;
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') item.checked = el.checked;
      else if (type === 'file') item.files = el.files ? el.files.length : 0;
      else if (type === 'password' || /one-time-code|cc-|password/.test(autocomplete)) { item.secret = true; item.filled = el.value.length > 0; }
      else if (!['submit', 'button', 'reset', 'image'].includes(type)) item.value = take(el.value, 'value');
      if (type === 'search') item.search = true;
    } else if (tag === 'TEXTAREA') {
      item.value = take(el.value, 'value');
    } else if (tag === 'SELECT') {
      item.value = take(Array.from(el.selectedOptions).map((option) => option.textContent).join(', '), 'value');
      item.select = true;
    } else if (el.isContentEditable) {
      item.value = take(textOf(el), 'value');
    }
    if (item.role === 'searchbox') item.search = true;
    if (masked.has(el)) {
      // Filled from a saved value: show that it is filled, never what it holds.
      delete item.value;
      item.secret = true;
      item.filled = ((el.value !== undefined ? el.value : el.textContent) || '').length > 0;
    }
    const ariaChecked = el.getAttribute('aria-checked');
    if (ariaChecked) item.checked = ariaChecked === 'true' ? true : ariaChecked === 'false' ? false : 'mixed';
    const expanded = el.getAttribute('aria-expanded');
    if (expanded) item.expanded = expanded === 'true';
    if (el.getAttribute('aria-selected') === 'true') item.selected = true;
    if (el.required || el.getAttribute('aria-required') === 'true') item.required = true;
    if (tag === 'A' && el.href) {
      try {
        const url = new URL(el.href, document.baseURI);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          item.href = take(url.origin === location.origin ? url.pathname + url.search : url.host + url.pathname, 'href');
        }
      } catch (error) { /* no link shown */ }
    }
    if (cut.length) item.cut = cut;
    item.position = rect.bottom <= 0 ? 'above' : rect.top >= vh ? 'below' : 'screen';
    item.inView = item.position === 'screen' && rect.right > 0 && rect.left < vw;
    elements.push(el);
    numbers.push(number);
    items.push(item);
  }
  function rendered(el) {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
    const rect = el.getBoundingClientRect();
    return rect.width >= 1 && rect.height >= 1 ? rect : null;
  }
  const weak = [];
  function visit(root, insideLeaf) {
    for (const el of root.children) {
      if (items.length >= max) { truncated = true; return; }
      let leaf = insideLeaf;
      if (!insideLeaf && el.matches(STRONG)) {
        const rect = rendered(el);
        if (rect) {
          describe(el, rect);
          leaf = LEAF.has(el.tagName) || el.getAttribute('role') !== null;
        }
      } else if (!insideLeaf && el.matches(WEAK)) {
        weak.push(el);
      }
      if (el.shadowRoot) visit(el.shadowRoot, leaf);
      visit(el, leaf);
    }
  }
  if (document.documentElement) visit(document, false);
  // A generic click target counts only when it wraps no real control.
  for (const el of weak) {
    if (items.length >= max) { truncated = true; break; }
    if (el.querySelector(STRONG)) continue;
    const rect = rendered(el);
    if (!rect || !filled(nameOf(el))) continue;
    describe(el, rect);
  }
  const scroller = document.scrollingElement || document.documentElement;
  return {
    items, elements, numbers, next, truncated,
    title: String(document.title || '').slice(0, RAW), titleCut: String(document.title || '').length > RAW,
    scroll: { y: Math.round(scroller ? scroller.scrollTop : 0), height: Math.round(scroller ? scroller.scrollHeight : 0), viewport: [vw, vh] },
    loading: document.readyState !== 'complete'
  };
}
"""

#: Visible CAPTCHA or bot-check widgets and forms in the top document. Detection only, so the
#: agent stops and tells the user; an invisible score badge (reCAPTCHA v3) is not a challenge.
CAPTCHA_SELECTORS = [
    ["reCAPTCHA", '.g-recaptcha:not([data-size="invisible"])'],
    ["hCaptcha", '.h-captcha:not([data-size="invisible"])'],
    ["Cloudflare challenge", ".cf-turnstile, #challenge-form, #cf-challenge-running, #challenge-stage"],
    ["Amazon bot check", 'form[action*="validateCaptcha"], #captchacharacters'],
    ["PerimeterX challenge", "#px-captcha"],
]
CAPTCHA_CONTAINERS = ", ".join(selector for _, selector in CAPTCHA_SELECTORS)

CAPTCHA = r"""
(selectors) => {
  const found = [];
  for (const [kind, selector] of selectors) {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(selector)); } catch (error) { continue; }
    const visible = nodes.some((node) => {
      if (typeof node.checkVisibility === 'function' && !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const rect = node.getBoundingClientRect();
      return rect.width >= 20 && rect.height >= 20;
    });
    if (visible) found.push(kind);
  }
  return found;
}
"""

#: The element belongs to a CAPTCHA or bot-check form or widget.
IN_CAPTCHA = r"""
(el, containers) => { try { return !!el.closest(containers); } catch (error) { return false; } }
"""

#: Frame addresses of CAPTCHA and bot-check widgets, with a kind for the warning.
CAPTCHA_FRAMES = [
    ("reCAPTCHA", ("google.com/recaptcha/", "recaptcha.net/recaptcha/")),
    ("hCaptcha", ("hcaptcha.com/",)),
    ("Cloudflare challenge", ("challenges.cloudflare.com/",)),
    ("Arkose challenge", ("arkoselabs.com/", "funcaptcha.com/")),
    ("DataDome challenge", ("captcha-delivery.com/",)),
]

#: Visible text, raw: the host masks it, then normalizes whitespace and pages it (`_format.page_text`).
TEXT = r"""
(el) => (el || document.body || document.documentElement).innerText || ''
"""

SCROLL = r"""
(direction) => {
  const scroller = document.scrollingElement || document.documentElement;
  const step = Math.round(window.innerHeight * 0.85);
  if (direction === 'top') window.scrollTo(0, 0);
  else if (direction === 'bottom') window.scrollTo(0, scroller.scrollHeight);
  else window.scrollBy(0, direction === 'up' ? -step : step);
  return Math.round(scroller.scrollTop);
}
"""

LOCAL_STORAGE = r"""
() => { try { return Object.keys(localStorage).map((name) => ({ name, value: localStorage.getItem(name) || '' })); } catch (error) { return null; } }
"""

READ_CLIENT_HINTS = r"""
async (hints) => {
  const data = navigator.userAgentData;
  const high = await data.getHighEntropyValues(hints);
  return { brands: data.brands, mobile: data.mobile, platform: data.platform, ...high };
}
"""

MARKERS = r"""
async () => {
  const page = {
    webdriver: navigator.webdriver, userAgent: navigator.userAgent, languages: navigator.languages,
    brands: navigator.userAgentData ? navigator.userAgentData.brands.map((b) => b.brand) : null,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
  };
  const source = 'onmessage = () => postMessage({ webdriver: navigator.webdriver, userAgent: navigator.userAgent, ' +
    'brands: navigator.userAgentData ? navigator.userAgentData.brands.map((b) => b.brand) : null, ' +
    'timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, languages: navigator.languages });';
  let worker = null;
  try {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const instance = new Worker(url);
    worker = await new Promise((resolve) => {
      instance.onmessage = (event) => resolve(event.data);
      instance.onerror = () => resolve(null);
      setTimeout(() => resolve(null), 5000);
      instance.postMessage(1);
    });
    instance.terminate();
    URL.revokeObjectURL(url);
  } catch (error) { worker = null; }
  return { page, worker };
}
"""
