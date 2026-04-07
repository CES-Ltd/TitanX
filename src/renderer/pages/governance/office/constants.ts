/**
 * @license Apache-2.0
 * Constants for the TitanX pixel-art office.
 */

export const TILE_SIZE = 16;
export const SCALE = 2; // Render at 2x for crisp pixels
export const WALK_SPEED = 48; // px/sec at 1x scale
export const WALK_FRAME_DURATION = 0.15; // seconds per walk frame
export const TYPE_FRAME_DURATION = 0.3; // seconds per typing frame
export const WANDER_PAUSE_MIN = 2.0; // min seconds idle before wandering
export const WANDER_PAUSE_MAX = 8.0; // max seconds idle before wandering
export const WANDER_MOVES_MIN = 2;
export const WANDER_MOVES_MAX = 5;
export const SEAT_REST_MIN = 10.0; // seconds resting at seat before wandering again
export const SEAT_REST_MAX = 30.0;
export const CHAT_BUBBLE_DURATION = 3.0; // seconds to show chat bubble
export const GREETING_DISTANCE = 2; // tiles proximity to trigger greeting

export const IDLE_CHAT_MESSAGES = [
  'Need more coffee ☕',
  'Tokens go brrr...',
  'Is it Friday yet?',
  'Debugging my dreams',
  'sudo make coffee',
  'Segfault in kitchen',
  '404: Motivation not found',
  'git push --force life',
  'while(true) { eat(); sleep(); code(); }',
  'AI agents need breaks too!',
  'Compiling lunch plans...',
  'rm -rf monday/',
  'ping google.com... pong!',
  'My GPU is overheating 🔥',
  'Optimizing snack intake',
];

export const GREETING_MESSAGES = ['Hi!', 'Hey! 👋', 'Yo!', 'Sup?', '🤖💬'];
