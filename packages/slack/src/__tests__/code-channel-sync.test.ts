vi.mock('@roomote/db/server', () => ({ db: {} }));
vi.mock('@roomote/communication', () => ({
  resolveThreadReplyLivePreviewUrl: vi.fn(),
}));

import {
  fitDiffForSlack,
  SLACK_CODE_CHANNEL_DIFF_MAX_BYTES,
} from '../code-channel-sync';

function fileDiff(name: string, bytes: number): string {
  const header = `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1 @@\n+`;
  return `${header}${'x'.repeat(Math.max(0, bytes - header.length - 1))}\n`;
}

describe('fitDiffForSlack', () => {
  it('passes a diff under the limit through unchanged', () => {
    const diff = fileDiff('a.ts', 1_000);
    expect(fitDiffForSlack(diff)).toBe(diff);
  });

  it('drops whole files from the end to fit Slack’s view limit', () => {
    const half = Math.floor(SLACK_CODE_CHANNEL_DIFF_MAX_BYTES / 2) - 10;
    const first = fileDiff('a.ts', half);
    const second = fileDiff('b.ts', half);
    const third = fileDiff('c.ts', half);

    const fitted = fitDiffForSlack(first + second + third);

    expect(fitted).toBe(first + second);
    expect(Buffer.byteLength(fitted, 'utf8')).toBeLessThanOrEqual(
      SLACK_CODE_CHANNEL_DIFF_MAX_BYTES,
    );
  });
});
