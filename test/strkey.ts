import { AccountNotFoundError } from '@veronicdev/ledgertax-core';

export { AccountNotFoundError };

/**
 * A throwaway string shaped like a Stellar secret key (S followed by 55 base32 characters). It is
 * not a real key for any account; it exists only to test that such input is rejected.
 */
export function StrKey_forTests(): string {
  return `S${'ABCDEFGH'.repeat(7).slice(0, 55)}`;
}
