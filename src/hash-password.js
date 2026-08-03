/**
 * Print a scrypt hash for WIKIFLIP_ADMIN_PASSWORD_HASH.
 *
 *   npm run hash-password -- 'my secret password'
 *   echo 'my secret password' | npm run hash-password
 */

import { hashPassword } from './auth.js';

const fromArg = process.argv[2];

if (fromArg) {
  console.log(hashPassword(fromArg));
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    const password = input.trim();
    if (password === '') {
      console.error("Usage: npm run hash-password -- 'your password'");
      process.exit(1);
    }
    console.log(hashPassword(password));
  });
}
