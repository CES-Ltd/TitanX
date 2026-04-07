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

// ─── Comic chat bubble (SVG bubble rendered near pet) ────────────────────────

const speechGroup = document.getElementById('speech-group');
const speechBubbleText = document.getElementById('speech-bubble-text') as unknown as SVGTextElement | null;
const speechBubbleBg = document.getElementById('speech-bubble-bg');
const speechTailCover = document.getElementById('speech-tail-cover');
const speechOverlay = document.getElementById('speech-overlay');
let bubbleHideTimer: ReturnType<typeof setTimeout> | null = null;

const BUBBLE_PADDING_X = 4; // horizontal padding inside bubble
const BUBBLE_PADDING_Y = 3; // vertical padding
const BUBBLE_HEIGHT = 10;
const BUBBLE_Y = -16;
const PET_CENTER_X = 11; // center of pet in viewBox coords

function showBubble(text: string, durationMs = 3000): void {
  if (!speechGroup || !speechBubbleText || !speechBubbleBg || !speechOverlay) return;

  // Set text first so we can measure it
  speechBubbleText.textContent = text;

  // Measure text width in SVG coordinates
  let textWidth: number;
  try {
    textWidth = speechBubbleText.getComputedTextLength();
  } catch {
    // Fallback: estimate ~2px per character at font-size 3.2px
    textWidth = text.length * 2;
  }

  // Calculate bubble width with padding (minimum 20 units)
  const bubbleWidth = Math.max(20, textWidth + BUBBLE_PADDING_X * 2);
  // Center the bubble over the pet
  const bubbleX = PET_CENTER_X - bubbleWidth / 2;

  // Update bubble rect
  speechBubbleBg.setAttribute('x', String(bubbleX));
  speechBubbleBg.setAttribute('width', String(bubbleWidth));
  speechBubbleBg.setAttribute('y', String(BUBBLE_Y));
  speechBubbleBg.setAttribute('height', String(BUBBLE_HEIGHT));

  // Update text position (centered in bubble)
  speechBubbleText.setAttribute('x', String(PET_CENTER_X));
  speechBubbleText.setAttribute('y', String(BUBBLE_Y + BUBBLE_HEIGHT / 2));

  // Update tail cover position
  if (speechTailCover) {
    speechTailCover.setAttribute('x', String(PET_CENTER_X - 3));
    speechTailCover.setAttribute('y', String(BUBBLE_Y + BUBBLE_HEIGHT - 0.5));
    speechTailCover.setAttribute('width', '6');
  }

  // Expand viewBox if bubble extends beyond current bounds
  const minX = Math.min(-18, bubbleX - 2);
  const totalWidth = Math.max(58, bubbleWidth + 8);
  speechOverlay.setAttribute('viewBox', `${minX} -20 ${totalWidth} 62`);

  // Show
  speechGroup.classList.add('visible');
  if (bubbleHideTimer) clearTimeout(bubbleHideTimer);
  bubbleHideTimer = setTimeout(() => {
    speechGroup.classList.remove('visible');
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
