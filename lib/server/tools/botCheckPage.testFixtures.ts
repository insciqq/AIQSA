/** Synthetic pages only: no site's markup, names or content. */
export const htmlPage = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

export const BOT_CHECK_PAGES = [
  { name: "English title", html: htmlPage("Checking your browser", "<p>Please wait while the connection is checked.</p>") },
  { name: "English body", html: htmlPage("One more step", "<p>Verify you are human before continuing.</p>") },
  { name: "English robot question", html: htmlPage("One more step", "<p>Are you a robot?</p>") },
  { name: "Russian title", html: htmlPage("Проверка браузера", "<p>Пожалуйста, подождите.</p>") },
  { name: "Russian body", html: htmlPage("Ещё один шаг", "<p>Подтвердите, что вы не робот.</p>") },
  { name: "Russian widget label", html: htmlPage("Ещё один шаг", "<p>Капча: введите символы с картинки.</p>") },
  { name: "widget", html: htmlPage("One more step", '<p>Complete the check to continue.</p><div class="captcha-widget"></div>') },
  { name: "empty widget shell", html: htmlPage("One more step", '<div id="captcha-widget"></div>') }
] as const;

export const CAPTCHA_ARTICLES = [
  { name: "English article", quote: "CAPTCHA widgets ask visitors to verify they are human.", html: htmlPage("Checking your browser: how CAPTCHA works",
    `<article><h1>CAPTCHA widgets explained</h1>${"<p>CAPTCHA widgets ask visitors to verify they are human. A prompt may say checking your browser, verify you are human, or are you a robot. This article describes accessibility, usability and the differences between visual and text challenges.</p>".repeat(20)}</article><div class="captcha-widget"></div>`) },
  { name: "Russian article", quote: "Капча предлагает посетителю подтвердить, что он человек.", html: htmlPage("Проверка браузера: как устроена капча",
    `<article><h1>Как работает капча</h1>${"<p>Капча предлагает посетителю подтвердить, что он человек. Проверка браузера может показывать сообщение «Подтвердите, что вы не робот». В этой статье рассматриваются доступность интерфейса и различия между текстовыми и графическими заданиями.</p>".repeat(20)}</article><div class="captcha-widget"></div>`) }
] as const;
