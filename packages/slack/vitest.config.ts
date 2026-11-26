import { configDefaults, defineConfig } from 'vitest/config';

// These real-DB suites write slack_installations, which the workspace
// predicate counts across the whole table. Run them one file at a time after
// the parallel suites so none observes another file's live installation.
const slackInstallationTests = [
  'src/__tests__/slack-task-run-workspace-scope.test.ts',
  'src/__tests__/code-channels.db.test.ts',
  'src/__tests__/code-channels.integration.db.test.ts',
];

export default defineConfig({
  test: {
    globals: true,
    watch: false,
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'slack',
          exclude: [...configDefaults.exclude, ...slackInstallationTests],
        },
      },
      {
        extends: true,
        test: {
          name: 'slack-installations',
          include: slackInstallationTests,
          sequence: { groupOrder: 1 },
          fileParallelism: false,
        },
      },
    ],
  },
});
