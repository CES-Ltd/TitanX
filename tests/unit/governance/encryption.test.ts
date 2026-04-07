/**
 * @license Apache-2.0
 * Tests for TitanX AES-256-GCM encryption.
 */

import crypto from 'crypto';
import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, sha256 } from '@process/services/secrets/encryption';

const TEST_KEY = crypto.randomBytes(32);

describe('secrets/encryption', () => {
  it('should round-trip encrypt and decrypt a value', () => {
    const plaintext = 'my-super-secret-api-key-12345';
    const material = encrypt(plaintext, TEST_KEY);
    const decrypted = decrypt(material, TEST_KEY);
    expect(decrypted).toBe(plaintext);
  });

  it('should produce different ciphertexts for the same plaintext (unique IVs)', () => {
    const plaintext = 'same-value';
    const a = encrypt(plaintext, TEST_KEY);
    const b = encrypt(plaintext, TEST_KEY);
    expect(a).not.toBe(b);
    // But both decrypt to the same value
    expect(decrypt(a, TEST_KEY)).toBe(plaintext);
    expect(decrypt(b, TEST_KEY)).toBe(plaintext);
  });

  it('should handle empty strings', () => {
    const material = encrypt('', TEST_KEY);
    const decrypted = decrypt(material, TEST_KEY);
    expect(decrypted).toBe('');
  });

  it('should handle unicode and multi-byte characters', () => {
    const plaintext = '密码 🔑 пароль';
    const material = encrypt(plaintext, TEST_KEY);
    expect(decrypt(material, TEST_KEY)).toBe(plaintext);
  });

  it('should detect tampered ciphertext', () => {
    const material = encrypt('sensitive', TEST_KEY);
    const parsed = JSON.parse(material);
    // Flip one hex char in the ciphertext
    const tampered = parsed.ciphertext.replace(/[0-9a-f]/, (c: string) => (c === '0' ? '1' : '0'));
    parsed.ciphertext = tampered;
    expect(() => decrypt(JSON.stringify(parsed), TEST_KEY)).toThrow();
  });

  it('should reject decryption with wrong key', () => {
    const material = encrypt('secret', TEST_KEY);
    const wrongKey = crypto.randomBytes(32);
    expect(() => decrypt(material, wrongKey)).toThrow();
  });

  it('should reject unsupported scheme', () => {
    const material = JSON.stringify({ scheme: 'unknown-v1', iv: 'aa', tag: 'bb', ciphertext: 'cc' });
    expect(() => decrypt(material, TEST_KEY)).toThrow('Unsupported encryption scheme');
  });

  it('should produce correct SHA-256 hashes', () => {
    const value = 'hello world';
    const expected = crypto.createHash('sha256').update(value, 'utf-8').digest('hex');
    expect(sha256(value)).toBe(expected);
  });
});
