const LOAD_TIMEOUT = 3000;

// ─── Thinking / Bollywood phrases ────────────────────────────────────────────

const THINKING_PHRASES = [
  'Krahing',
  'Caffeinating',
  'Yak-shaving',
  'Bikeshedding',
  'Docker-containerizing',
  'Git-pushing',
  'Nat-twentying',
  'Speed-running',
  'Mind-melding',
  'Matrixing',
  'Lateralizing',
  'Koan-contemplating',
  'Zazen-meditating',
  'Pour-overing',
  'Bug-bountying',
  'Chmod-777ing',
  'Ship-of-Theseusing',
  'Amor-fati-ing',
  'Spiraling-out',
  'Kaizen-improving',
  'Wabi-sabi-accepting',
  'Dragon-slaying',
  'Side-questing',
  'Neuromancing',
  'Boldly going',
  'Making it so',
  'Backpropagating',
  'Self-attending',
  'Chain-of-thought-reasoning',
  'Seppuku-refactoring',
  'Samurai-coding',
  'Consciousness-pondering',
  'Foundation-building',
  'Psychohistorying',
  'Stormlight-archiving',
];

const BOLLYWOOD_DIALOGUES = [
  'Mogambo khush hua! 🎬',
  'Kitne aadmi the? 🤔',
  'Seh lenge thoda 😤',
  'Abhi maza aaega na bhidu! 🎉',
  '50 rupees kaat overacting ka ✂️',
  'Jor jor se bolke sabko scheme bata de! 📢',
  'Mujhe ghar jana hai 🏠',
  'Tension lene ka nahi, sirf dene ka 😎',
  "How's the josh? HIGH SAAAAR! 🫡",
  'All izz well 🙆',
  'Picture abhi baaki hai mere dost 🎬',
  'Babumoshai, zindagi badi honi chahiye 🎭',
  'Pushpa, I hate tears 😭',
  'Jal lijiye 🥤',
  'Hera Pheri chal rahi hai yahan 🎪',
];

function getRandomPhrase(): string {
  try {
    const isBollywood = localStorage.getItem('titanx:bollywood-mode') === 'true';
    const list = isBollywood ? BOLLYWOOD_DIALOGUES : THINKING_PHRASES;
    return list[Math.floor(Math.random() * list.length)];
  } catch {
    return THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)];
  }
}

// ─── Speech bubble ───────────────────────────────────────────────────────────

let bubbleEl: HTMLDivElement | null = null;
let bubbleTimeout: ReturnType<typeof setTimeout> | null = null;

function createBubble(): HTMLDivElement {
  if (bubbleEl) return bubbleEl;
  const el = document.createElement('div');
  el.style.cssText = `
    position: fixed; top: -8px; left: 50%; transform: translateX(-50%);
    background: rgba(255,255,255,0.95); color: #333; font-size: 10px;
    padding: 4px 8px; border-radius: 8px; white-space: nowrap;
    box-shadow: 0 2px 8px rgba(0,0,0,0.15); border: 1px solid rgba(100,100,200,0.2);
    pointer-events: none; opacity: 0; transition: opacity 0.3s ease;
    font-family: system-ui, sans-serif; max-width: 180px; overflow: hidden;
    text-overflow: ellipsis; z-index: 9999;
  `;
  document.body.appendChild(el);
  bubbleEl = el;
  return el;
}

function showBubble(text: string, durationMs = 3000): void {
  const bubble = createBubble();
  bubble.textContent = text;
  bubble.style.opacity = '1';
  if (bubbleTimeout) clearTimeout(bubbleTimeout);
  bubbleTimeout = setTimeout(() => {
    bubble.style.opacity = '0';
  }, durationMs);
}

// ─── Click handler — show thinking phrase ────────────────────────────────────

document.addEventListener('click', () => {
  showBubble(getRandomPhrase(), 3000);
});

// ─── Random idle speech (every 15-45 seconds) ────────────────────────────────

function scheduleRandomSpeech(): void {
  const delay = 15000 + Math.random() * 30000; // 15-45 sec
  setTimeout(() => {
    showBubble(getRandomPhrase(), 4000);
    scheduleRandomSpeech();
  }, delay);
}
scheduleRandomSpeech();

// ─── Theme resolution ────────────────────────────────────────────────────────

function resolveBasePath(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    const theme = params.get('theme') || 'default';
    if (theme !== 'default') return `../pet-themes/${theme}`;
  } catch {
    // ignore
  }
  return '../pet-states';
}

const PET_STATES_BASE_PATH = resolveBasePath();
let currentObject: HTMLObjectElement | null = document.getElementById('pet') as HTMLObjectElement;

function getStateAssetPath(state: string): string {
  return `${PET_STATES_BASE_PATH}/${state}.svg`;
}

function setupTransitions(): void {
  if (!currentObject) return;
  const doc = currentObject.contentDocument;
  if (!doc) return;

  const eye = doc.querySelector('.idle-eye') as SVGElement | null;
  const body = doc.querySelector('.idle-body') as SVGElement | null;

  if (eye) eye.style.transition = 'transform 0.2s ease-out';
  if (body) body.style.transition = 'transform 0.2s ease-out';
}

function loadSvg(svgPath: string): void {
  const newObj = document.createElement('object');
  newObj.type = 'image/svg+xml';
  newObj.id = 'pet';
  newObj.style.width = '100%';
  newObj.style.height = '100%';
  newObj.data = svgPath;

  let loaded = false;
  const timeout = setTimeout(() => {
    if (!loaded) {
      newObj.remove();
    }
  }, LOAD_TIMEOUT);

  newObj.addEventListener('load', () => {
    loaded = true;
    clearTimeout(timeout);
    if (currentObject) currentObject.remove();
    currentObject = newObj;
    setupTransitions();
  });

  document.body.appendChild(newObj);
}

// Load initial SVG with theme-aware path
if (currentObject) {
  currentObject.data = getStateAssetPath('idle');
  currentObject.addEventListener('load', () => {
    setupTransitions();
  });
}

window.petAPI.onStateChange((state: string) => {
  loadSvg(getStateAssetPath(state));
  // Show a thinking phrase when entering thinking/working states
  if (state === 'thinking' || state === 'working' || state === 'building') {
    showBubble(getRandomPhrase(), 4000);
  }
});

window.petAPI.onEyeMove(({ eyeDx, eyeDy, bodyDx, bodyRotate }) => {
  if (!currentObject) return;
  const doc = currentObject.contentDocument;
  if (!doc) return;

  const eye = doc.querySelector('.idle-eye') as SVGElement | null;
  const body = doc.querySelector('.idle-body') as SVGElement | null;

  if (eye) eye.style.transform = `translate(${eyeDx}px, ${eyeDy}px)`;
  if (body) body.style.transform = `translate(${bodyDx}px, 0) rotate(${bodyRotate}deg)`;
});
