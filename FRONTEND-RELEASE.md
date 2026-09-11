# Frontend release boundary

Deploy the frontend only from the verified frontend release branch, currently
`codex/frontend-recovery-20260911`. API branches contain historical app sources;
never deploy their app directory without comparing it to this frontend baseline.

Recovery baseline: Vercel dpl_2XFvb2Uf2gzMYBpzG2VojST3pNbV
(`app-55iuaelgl-nanoigajoa-s-projects.vercel.app`). All 71 uploaded app files
matched the preserved source by SHA-1 before adding the kiosk import fix.
Baseline source was committed as f6deb58.

API remains at 15f40f21aafb19230e63b22057e50f9aa497dd00. Do not deploy the API
directory from this frontend branch.

Checks: production build, TypeScript, changed-file lint, mocked mobile browser
checks for menu/favorites/notifications/notices/lounge/themes, and kiosk pending
and active imports updating the open room sheet and stored booking together.

Before promotion, compare source changes with the baseline and verify favorites,
lounge and notices routes plus kiosk synchronization in the resulting bundle.
