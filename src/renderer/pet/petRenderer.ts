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

// ─── Speech text (SVG floating text — same pattern as ZZZ in sleeping.svg) ───

const speechText = document.getElementById('speech-text');

function showBubble(text: string, _durationMs = 3500): void {
  if (!speechText) return;
  // Reset animation by removing class, forcing reflow, then re-adding
  speechText.classList.remove('visible');
  speechText.textContent = text;
  // Force reflow so the animation restarts
  void speechText.offsetWidth;
  speechText.classList.add('visible');
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

  const container = document.getElementById('pet-container');
  (container || document.body).appendChild(newObj);
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
