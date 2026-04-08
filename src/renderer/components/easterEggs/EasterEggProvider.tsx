/**
 * @license Apache-2.0
 * Easter Egg Provider — centralized easter egg detection and activation.
 * Mount once at app root. Handles Konami code, Matrix mode, retro terminal,
 * secret stats, and other hidden features.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Message, Modal, Descriptions, Tag } from '@arco-design/web-react';
import { activityLog, costTracking, type IActivityEntry } from '@/common/adapter/ipcBridge';

// ── Konami Code Detection ────────────────────────────────────────────────────

const KONAMI_CODE = [
  'ArrowUp',
  'ArrowUp',
  'ArrowDown',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowLeft',
  'ArrowRight',
  'b',
  'a',
];

// ── Matrix Rain CSS ──────────────────────────────────────────────────────────

const MATRIX_CHARS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン01';

function createMatrixColumn(left: number, delay: number): HTMLDivElement {
  const col = document.createElement('div');
  col.style.cssText = `
    position: fixed; top: -100vh; left: ${left}px; z-index: 99999;
    font-family: 'Courier New', monospace; font-size: 14px; color: #00ff41;
    writing-mode: vertical-rl; text-orientation: upright; line-height: 1.2;
    animation: matrix-fall ${3 + Math.random() * 4}s linear ${delay}s infinite;
    pointer-events: none; opacity: ${0.3 + Math.random() * 0.7};
    text-shadow: 0 0 8px #00ff41, 0 0 16px #003300;
  `;
  let text = '';
  for (let i = 0; i < 30; i++) {
    text += MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)];
  }
  col.textContent = text;
  return col;
}

// ── Retro CRT Styles ────────────────────────────────────────────────────────

const RETRO_STYLE_ID = 'titanx-retro-terminal';
const RETRO_CSS = `
  .retro-terminal-mode {
    filter: saturate(0.3) brightness(0.9);
  }
  .retro-terminal-mode * {
    font-family: 'Courier New', 'Monaco', monospace !important;
    color: #33ff33 !important;
  }
  .retro-terminal-mode .arco-card,
  .retro-terminal-mode .arco-table,
  .retro-terminal-mode .arco-tabs {
    background: #0a0a0a !important;
    border-color: #1a3a1a !important;
  }
  .retro-terminal-mode::after {
    content: '';
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: repeating-linear-gradient(
      0deg, rgba(0,0,0,0.15) 0px, transparent 1px, transparent 2px
    );
    pointer-events: none;
    z-index: 99998;
  }
`;

// ── Haiku Templates ──────────────────────────────────────────────────────────

const HAIKUS = [
  'Agents think in loops\nTokens flow like mountain streams\nBugs are but lessons',
  'Code compiles at dawn\nSilent servers hum their song\nDeploy brings us peace',
  'Neural nets dream deep\nGradients descend with grace\nLoss converges slow',
  'Pull request reviewed\nMerge conflicts resolved with care\nMain branch stays pristine',
  'Kubernetes pods\nScale up under heavy load\nContainers find rest',
  'Prompt engineering\nFew-shot examples align\nThe model complies',
  'Sprint board cards migrate\nFrom backlog through to done lane\nVelocity grows',
  'Audit logs record\nEvery toggle, every call\nNothing goes unseen',
  'Blueprints guard the gates\nAgents follow strict decrees\nSecurity wins',
  'Easter eggs lie hidden\nFor the curious to find\nDelight in surprise',
];

// ── Agent Mood Phrases ───────────────────────────────────────────────────────

const MOODS: Array<{ emoji: string; label: string; message: string }> = [
  { emoji: '😊', label: 'Happy', message: 'This agent is vibing! Productivity is high.' },
  { emoji: '🤔', label: 'Thoughtful', message: 'Deep in contemplation. Big ideas brewing.' },
  { emoji: '😤', label: 'Determined', message: 'On a mission. Do not disturb.' },
  { emoji: '😴', label: 'Sleepy', message: 'Needs a wake-up call. Has been idle too long.' },
  { emoji: '🔥', label: 'On Fire', message: 'Crushing it! Multiple tasks completed.' },
  { emoji: '🤖', label: 'Robotic', message: 'Pure efficiency. Zero emotion. Maximum output.' },
  { emoji: '🎭', label: 'Dramatic', message: 'Everything is either a crisis or a triumph.' },
  { emoji: '🧘', label: 'Zen', message: 'Calm and collected. One task at a time.' },
];

// ── Rap Battle Lines ─────────────────────────────────────────────────────────

const RAP_LINES_A = [
  "I'm the lead agent, I run this show 🎤",
  "My tokens per second? Watch 'em flow 💨",
  "I ship features while you're still thinking 🚀",
  'My sprint velocity got the board blinking ⚡',
  "I don't just code, I orchestrate the team 👑",
];

const RAP_LINES_B = [
  'Hold up, hold up, let me set it straight 🎯',
  'I handle edge cases, never late ⏰',
  "You talk big but your context window's small 📏",
  'I debug in production, never fall 🛡️',
  'When the build breaks, who they gonna call? ME 📞',
];

// ── Component ────────────────────────────────────────────────────────────────

const userId = 'system_default_user';

const EasterEggProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const konamiIndex = useRef(0);
  const [matrixActive, setMatrixActive] = useState(false);
  const [retroActive, setRetroActive] = useState(false);
  const [statsVisible, setStatsVisible] = useState(false);
  const [haikuVisible, setHaikuVisible] = useState(false);
  const [currentHaiku, setCurrentHaiku] = useState('');
  const [moodVisible, setMoodVisible] = useState(false);
  const [currentMood, setCurrentMood] = useState(MOODS[0]);
  const [rapVisible, setRapVisible] = useState(false);
  const [stats, setStats] = useState<Record<string, string>>({});
  const logoClickCount = useRef(0);
  const logoClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aboutClickCount = useRef(0);
  const aboutClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Konami Code listener ─────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === KONAMI_CODE[konamiIndex.current]) {
        konamiIndex.current++;
        if (konamiIndex.current === KONAMI_CODE.length) {
          konamiIndex.current = 0;
          Message.info({
            content: '🕵️ Agent 007 activated! "The name is Bond... JSON Bond." 🍸',
            duration: 5000,
          });
          // Store discovery
          localStorage.setItem('titanx:konami-discovered', 'true');
        }
      } else {
        konamiIndex.current = 0;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── /retro and /haiku command listener ───────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const target = e.target as HTMLElement;
      if (!target || target.tagName !== 'TEXTAREA') return;
      const textarea = target as HTMLTextAreaElement;
      const val = textarea.value.trim();

      if (val === '/retro') {
        e.preventDefault();
        textarea.value = '';
        toggleRetro();
      } else if (val === '/haiku') {
        e.preventDefault();
        textarea.value = '';
        showHaiku();
      } else if (val === '/rapbattle') {
        e.preventDefault();
        textarea.value = '';
        showRapBattle();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  // ── Matrix mode (triggered by triple-clicking app logo) ──────────────────

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'IMG' && target.classList.contains('app-titlebar__brand-logo')) {
        logoClickCount.current++;
        if (logoClickTimer.current) clearTimeout(logoClickTimer.current);
        logoClickTimer.current = setTimeout(() => {
          logoClickCount.current = 0;
        }, 500);

        if (logoClickCount.current >= 3) {
          logoClickCount.current = 0;
          activateMatrix();
        }
      }

      // Agent Mood Ring: 5 rapid clicks on any agent-related element
      const agentEl = (e.target as HTMLElement).closest?.('[class*="agent"], [class*="Agent"], [class*="teammate"]');
      if (agentEl) {
        logoClickCount.current++;
        if (logoClickTimer.current) clearTimeout(logoClickTimer.current);
        logoClickTimer.current = setTimeout(() => {
          logoClickCount.current = 0;
        }, 1000);
        if (logoClickCount.current >= 5) {
          logoClickCount.current = 0;
          window.dispatchEvent(new Event('titanx:mood-ring'));
        }
      }

      // Secret stats: Shift+click the about section 3 times
      if (e.shiftKey) {
        const closest = (e.target as HTMLElement).closest?.('[class*="about"]');
        if (closest || window.location.hash.includes('about')) {
          aboutClickCount.current++;
          if (aboutClickTimer.current) clearTimeout(aboutClickTimer.current);
          aboutClickTimer.current = setTimeout(() => {
            aboutClickCount.current = 0;
          }, 1000);

          if (aboutClickCount.current >= 3) {
            aboutClickCount.current = 0;
            void showSecretStats();
          }
        }
      }
    };
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, []);

  // ── Agent mood ring (exposed as global function) ─────────────────────────

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__titanxMoodRing = (agentName?: string) => {
      const mood = MOODS[Math.floor(Math.random() * MOODS.length)];
      setCurrentMood(mood);
      setMoodVisible(true);
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__titanxMoodRing;
    };
  }, []);

  // Also listen for custom event from agent avatar clicks
  useEffect(() => {
    const handler = () => {
      const mood = MOODS[Math.floor(Math.random() * MOODS.length)];
      setCurrentMood(mood);
      setMoodVisible(true);
    };
    window.addEventListener('titanx:mood-ring', handler);
    return () => window.removeEventListener('titanx:mood-ring', handler);
  }, []);

  // ── Matrix mode ──────────────────────────────────────────────────────────

  const activateMatrix = useCallback(() => {
    if (matrixActive) return;
    setMatrixActive(true);
    Message.success({ content: '🟩 Matrix mode activated! Follow the white rabbit...', duration: 3000 });

    // Inject keyframe animation
    const style = document.createElement('style');
    style.id = 'matrix-rain-style';
    style.textContent = `
      @keyframes matrix-fall {
        0% { transform: translateY(-100vh); }
        100% { transform: translateY(200vh); }
      }
    `;
    document.head.appendChild(style);

    // Create matrix columns
    const container = document.createElement('div');
    container.id = 'matrix-rain-container';
    container.style.cssText =
      'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;pointer-events:none;overflow:hidden;';
    const width = window.innerWidth;
    for (let x = 0; x < width; x += 20) {
      container.appendChild(createMatrixColumn(x, Math.random() * 3));
    }
    document.body.appendChild(container);

    // Remove after 30 seconds
    setTimeout(() => {
      container.remove();
      style.remove();
      setMatrixActive(false);
      Message.info({ content: '🔴 You took the red pill. Welcome back.', duration: 3000 });
    }, 30000);
  }, [matrixActive]);

  // ── Retro terminal mode ──────────────────────────────────────────────────

  const toggleRetro = useCallback(() => {
    const existing = document.getElementById(RETRO_STYLE_ID);
    if (existing || retroActive) {
      existing?.remove();
      document.body.classList.remove('retro-terminal-mode');
      setRetroActive(false);
      Message.info({ content: '💻 Back to the future! Modern UI restored.', duration: 3000 });
    } else {
      const style = document.createElement('style');
      style.id = RETRO_STYLE_ID;
      style.textContent = RETRO_CSS;
      document.head.appendChild(style);
      document.body.classList.add('retro-terminal-mode');
      setRetroActive(true);
      Message.success({ content: '📺 RETRO TERMINAL MODE ENGAGED. Type /retro again to exit.', duration: 3000 });
    }
  }, [retroActive]);

  // ── Haiku ────────────────────────────────────────────────────────────────

  const showHaiku = useCallback(() => {
    const haiku = HAIKUS[Math.floor(Math.random() * HAIKUS.length)];
    setCurrentHaiku(haiku);
    setHaikuVisible(true);
  }, []);

  // ── Rap Battle ───────────────────────────────────────────────────────────

  const showRapBattle = useCallback(() => {
    setRapVisible(true);
  }, []);

  // ── Secret Stats ─────────────────────────────────────────────────────────

  const showSecretStats = useCallback(async () => {
    try {
      const [logResult, costResult] = await Promise.all([
        activityLog.list
          .invoke({ userId, limit: 1, offset: 0 })
          .catch(() => ({ total: 0, data: [] as IActivityEntry[] })),
        costTracking.summary
          .invoke({ userId })
          .catch(() => ({ totalCostCents: 0, totalEvents: 0, inputTokens: 0, outputTokens: 0 })),
      ]);

      const discoveries = [
        localStorage.getItem('titanx:konami-discovered') ? '✅ Konami Code' : '❌ Konami Code',
        localStorage.getItem('titanx:bollywood-mode') === 'true' ? '✅ Bollywood Mode' : '❌ Bollywood Mode',
      ].join(', ');

      setStats({
        'Total Audit Events': String(logResult.total),
        'Total Cost Events': String((costResult as Record<string, number>).totalEvents ?? 0),
        'Input Tokens Processed': String((costResult as Record<string, number>).inputTokens ?? 0),
        'Output Tokens Generated': String((costResult as Record<string, number>).outputTokens ?? 0),
        'Total Spend': `$${(((costResult as Record<string, number>).totalCostCents ?? 0) / 100).toFixed(2)}`,
        'App Uptime': `${Math.floor((Date.now() - performance.timeOrigin) / 60000)} minutes`,
        'Easter Eggs Found': discoveries,
        Build: `TitanX v1.9.8 / Electron ${navigator.userAgent.match(/Electron\/([\d.]+)/)?.[1] ?? '?'}`,
      });
      setStatsVisible(true);
    } catch {
      Message.error('Failed to load secret stats');
    }
  }, []);

  return (
    <>
      {children}

      {/* Haiku Modal */}
      <Modal
        visible={haikuVisible}
        onCancel={() => setHaikuVisible(false)}
        title='🎋 AI Haiku'
        footer={null}
        style={{ maxWidth: 400 }}
      >
        <pre
          className='text-center text-16px leading-relaxed whitespace-pre-wrap py-16px'
          style={{ fontFamily: 'Georgia, serif' }}
        >
          {currentHaiku}
        </pre>
      </Modal>

      {/* Mood Ring Modal */}
      <Modal
        visible={moodVisible}
        onCancel={() => setMoodVisible(false)}
        title='💍 Agent Mood Ring'
        footer={null}
        style={{ maxWidth: 360 }}
      >
        <div className='text-center py-16px'>
          <div className='text-48px mb-8px'>{currentMood.emoji}</div>
          <Tag color='arcoblue' size='large'>
            {currentMood.label}
          </Tag>
          <div className='text-14px text-t-secondary mt-12px'>{currentMood.message}</div>
        </div>
      </Modal>

      {/* Rap Battle Modal */}
      <Modal
        visible={rapVisible}
        onCancel={() => setRapVisible(false)}
        title='🎤 Agent Rap Battle'
        footer={null}
        style={{ maxWidth: 500 }}
      >
        <div className='py-8px'>
          <div className='mb-16px'>
            <Tag color='red' size='large'>
              Agent Alpha
            </Tag>
            <div className='mt-8px p-12px rounded-8px' style={{ background: 'var(--color-fill-2)' }}>
              {RAP_LINES_A.map((line, i) => (
                <div key={i} className='py-2px text-14px'>
                  {line}
                </div>
              ))}
            </div>
          </div>
          <div className='text-center text-20px my-8px'>⚡ VS ⚡</div>
          <div>
            <Tag color='blue' size='large'>
              Agent Beta
            </Tag>
            <div className='mt-8px p-12px rounded-8px' style={{ background: 'var(--color-fill-2)' }}>
              {RAP_LINES_B.map((line, i) => (
                <div key={i} className='py-2px text-14px'>
                  {line}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Modal>

      {/* Secret Stats Modal */}
      <Modal
        visible={statsVisible}
        onCancel={() => setStatsVisible(false)}
        title='🔓 Secret Developer Stats'
        footer={null}
        style={{ maxWidth: 500 }}
      >
        <Descriptions
          column={1}
          size='large'
          data={
            Object.entries(stats).map(([label, value]) => ({ label, value })) as Array<{ label: string; value: string }>
          }
        />
      </Modal>
    </>
  );
};

export default EasterEggProvider;
