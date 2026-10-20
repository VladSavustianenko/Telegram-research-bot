import { describe, expect, it } from 'vitest';
import { submissionRetryDelaySeconds } from './research-worker.service';

describe('submission retry delay (TRB-060)', () => {
  it('follows Retry-After, rounded up, within 1..300 seconds', () => {
    expect(submissionRetryDelaySeconds(4_200, 30)).toBe(5);
    expect(submissionRetryDelaySeconds(0, 30)).toBe(1);
    expect(submissionRetryDelaySeconds(3_600_000, 30)).toBe(300);
  });

  it('uses the configured delay when the provider sent none', () => {
    expect(submissionRetryDelaySeconds(null, 30)).toBe(30);
  });
});
