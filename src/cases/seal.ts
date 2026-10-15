import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';

/**
 * Sealed solutions. AES-256-GCM with a key derived by scrypt from the suspect id and case id.
 * This is a speed bump, not security: there are six suspects, so anyone can try them all.
 * The point is that the solution is not readable by accident.
 */
const MAGIC = 'casebook-sealed/1';
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export function deriveKey(suspectId: string, caseId: string, salt: Buffer): Buffer {
  return scryptSync(`${suspectId}|${caseId}`, salt, 32, SCRYPT);
}

function wrap(hex: string, width = 96): string {
  const lines: string[] = [];
  for (let i = 0; i < hex.length; i += width) lines.push(hex.slice(i, i + width));
  return lines.join('\n');
}

/** Encrypts and encodes as hex text, so the sealed file is diffable and contains no words. */
export function seal(plaintext: string, suspectId: string, caseId: string, salt = randomBytes(16), iv = randomBytes(12)): string {
  const cipher = createCipheriv('aes-256-gcm', deriveKey(suspectId, caseId, salt), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [MAGIC, `salt ${salt.toString('hex')}`, `iv ${iv.toString('hex')}`, `tag ${cipher.getAuthTag().toString('hex')}`, 'data', wrap(data.toString('hex')), ''].join('\n');
}

/** Returns the plaintext, or null when the suspect is wrong (the GCM tag does not verify). */
export function unseal(sealed: string, suspectId: string, caseId: string): string | null {
  const lines = sealed.trim().split('\n');
  if (lines[0] !== MAGIC) throw new Error('Not a sealed solution file.');
  const field = (name: string): Buffer => {
    const line = lines.find((candidate) => candidate.startsWith(`${name} `));
    if (!line) throw new Error(`Sealed file is missing ${name}.`);
    return Buffer.from(line.slice(name.length + 1), 'hex');
  };
  const dataStart = lines.indexOf('data');
  const data = Buffer.from(lines.slice(dataStart + 1).join(''), 'hex');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(suspectId, caseId, field('salt')), field('iv'));
  decipher.setAuthTag(field('tag'));
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function verdictHash(caseId: string, suspectId: string): string {
  return createHash('sha256').update(`casebook/verdict/${caseId}/${suspectId}`).digest('hex');
}

export function redHerringHash(caseId: string, suspectId: string): string {
  return createHash('sha256').update(`casebook/red-herring/${caseId}/${suspectId}`).digest('hex');
}
