# Episodes

<!-- Newest last. The gate appends FAIL|DONE|FINDING; past 100 entries it trims only its own oldest DONE|FAIL|learned
FINDING (git keeps them). Leads (LESSON, FINDING learn=none) stay until wrap settles them; doctor fails above 30.
Agents append `<UTC ISO> s=<session> LESSON <VAE-DIALECT>` only for a falsified HYPOTHESIS, a dead end, or a root cause.
Session start injects the 3 newest open entries: LESSON, FINDING learn=none, FAIL without a later DONE.
Wrap: EVERY lead becomes a test | .vae/VERIFY.py rule | one MEMORY line with BC, then delete; OR delete BC evidence. -->

2026-11-05T01:25:04Z s=8d2d66c5 FAIL prose,lint,tests.e2e.1
2026-11-05T01:51:00Z s=8d2d66c5 DONE fp=acd116dedae6 cov=81.0% paths=.oxlintrc.json,.prettierrc.json,AGENTS.md,ARCH.md(+163)
2026-11-05T01:51:00Z s=8d2d66c5 FINDING src/styles/portal-lab.css:url(poster.webp) learn=test: tests/unit/site-files.test.ts resolves every CSS url() and HTML reference; it failed on the original path.
2026-11-05T01:51:00Z s=8d2d66c5 FINDING src/index.html:#perf-research learn=test: tests/e2e/site.spec.ts toggles both benchmark panels and asserts each is visible on its own.
2026-11-05T01:51:00Z s=8d2d66c5 FINDING src/revisions/store.ts:safeName learn=verifier: .vae/VERIFY.py rule source.no-invisible-controls rejects literal invisible/bidi characters in *.ts; tests/unit/revisions.test.ts asserts names with control and 
2026-11-05T01:51:00Z s=8d2d66c5 FINDING README.md:36 B01 learn=none: Doc claim; no mechanical check ties prose to markup visibility.
2026-11-05T01:51:00Z s=8d2d66c5 FINDING ARCH.md:29 P09 learn=none: Narration of change is reading-level (P09), not static.
2026-11-05T01:51:00Z s=8d2d66c5 FINDING source/README.md:19 B09/P09 learn=none: Reading-level prose rule.
2026-11-05T02:43:04Z s=8d2d66c5 DONE fp=8f6c63e07971 cov=81.0% paths=.oxlintrc.json,.prettierrc.json,AGENTS.md,ARCH.md(+164)
2026-11-05T02:43:04Z s=8d2d66c5 FINDING tests/unit/model.test.ts:89 learn=verifier: .vae/VERIFY.py models.not-in-repo keeps packs out of public/ and docs/; any test reading them there fails the same way.
2026-11-05T02:43:04Z s=8d2d66c5 FINDING src/shared/site.ts:MODEL_PACK_URL learn=test: tests/e2e/site.spec.ts asserts W4 and FP32 pack requests go to the pinned resolve/<commit>/base/(4bit|fp32)/ URL and that browsing alone requests none.
2026-11-05T02:43:04Z s=8d2d66c5 FINDING src/workers/training-worker.ts:prefetchAssets learn=none: No offline Hugging Face simulation is available without a test seam in production code.
2026-11-05T02:43:04Z s=8d2d66c5 FINDING ARCH.md:41 P01 learn=none: Reading-level prose rule.
2026-11-05T02:43:04Z s=8d2d66c5 FINDING docs/ (build output) learn=verifier: .vae/VERIFY.py docs.build-fresh fails when any src/ or public/ file is newer than docs/app/main.js; checked both ways (touch src/theme.ts detected as stale, fre
2026-11-05T03:17:43Z s=8d2d66c5 DONE fp=914914cc80db cov=81.0% paths=.oxlintrc.json,.prettierrc.json,AGENTS.md,ARCH.md(+164)
2026-11-05T03:17:43Z s=8d2d66c5 FINDING src/index.html:561 learn=test: tests/unit/site-files.test.ts 'page paragraphs open and close in pairs' fails on the edited file (stray </p> at line 561) and passes on the fix.
