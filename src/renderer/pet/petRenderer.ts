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
];

const BOLLYWOOD_DIALOGUES = [
  'Mogambo khush hua! 🎬',
  'Kitne aadmi the? 🤔',
  'Seh lenge thoda 😤',
  'Abhi maza aaega na bhidu!',
  '50 rupees kaat ✂️',
  'Scheme bata de! 📢',
  'Ghar jana hai 🏠',
  'Tension nahi lene ka 😎',
  'HIGH SAAAAR! 🫡',
  'All izz well 🙆',
  'Baaki hai mere dost 🎬',
  'Pushpa, I hate tears 😭',
  'Jal lijiye 🥤',
  'Hera Pheri! 🎪',
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

// ─── Speech bubble (rendered as HTML overlay positioned near pet) ─────────────

let bubbleEl: HTMLDivElement | null = null;
let bubbleTimeout: ReturnType<typeof setTimeout> | null = null;

function ensureBubble(): HTMLDivElement {
  if (bubbleEl) return bubbleEl;
  const el = document.createElement('div');
  el.style.cssText = [
    'position: absolute',
    'bottom: 100%',
    'left: 50%',
    'transform: translateX(-50%) translateY(-4px)',
    'background: rgba(255,255,255,0.95)',
    'color: #333',
    'font-size: 9px',
    'line-height: 1.3',
    'padding: 3px 7px',
    'border-radius: 6px',
    'white-space: nowrap',
    'box-shadow: 0 1px 6px rgba(0,0,0,0.18)',
    'border: 1px solid rgba(100,100,200,0.25)',
    'pointer-events: none',
    'opacity: 0',
    'transition: opacity 0.25s ease',
    'font-family: system-ui, -apple-system, sans-serif',
    'max-width: 160px',
    'overflow: hidden',
    'text-overflow: ellipsis',
    'z-index: 9999',
  ].join('; ');
  // Tail triangle
  const tail = document.createElement('div');
  tail.style.cssText = [
    'position: absolute',
    'top: 100%',
    'left: 50%',
    'transform: translateX(-50%)',
    'width: 0',
    'height: 0',
    'border-left: 4px solid transparent',
    'border-right: 4px solid transparent',
    'border-top: 4px solid rgba(255,255,255,0.95)',
  ].join('; ');
  el.appendChild(tail);
  document.body.style.position = 'relative';
  document.body.appendChild(el);
  bubbleEl = el;
  return el;
}

function showBubble(text: string, durationMs = 3000): void {
  const bubble = ensureBubble();
  // Set text (keep tail as last child)
  const tail = bubble.lastElementChild;
  bubble.textContent = text;
  if (tail) bubble.appendChild(tail);
  bubble.style.opacity = '1';
  if (bubbleTimeout) clearTimeout(bubbleTimeout);
  bubbleTimeout = setTimeout(() => {
    bubble.style.opacity = '0';
  }, durationMs);
}

// ─── IPC: speech bubble on every click (forwarded from petManager) ───────────

window.petAPI.onShowSpeech(() => {
  showBubble(getRandomPhrase(), 3000);
});

// ─── Random idle speech (every 20-50 seconds) ───────────────────────────────

function scheduleRandomSpeech(): void {
  const delay = 20000 + Math.random() * 30000;
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
    if (!loaded) newObj.remove();
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
  currentObject.addEventListener('load', () => setupTransitions());
}

window.petAPI.onStateChange((state: string) => {
  loadSvg(getStateAssetPath(state));
  // Show phrase on AI activity states
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
