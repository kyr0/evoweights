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
2026-11-05T11:32:46Z s=8d2d66c5 FAIL prose
2026-11-05T11:44:29Z s=8d2d66c5 FAIL coverage
2026-11-05T12:20:03Z s=8d2d66c5 DONE fp=ac82fb5fb800 cov=76.8% paths=ARCH.md,README.md,docs/app/hero-evolution.js,docs/app/huggingdoom.js(+85)
2026-11-05T12:20:03Z s=8d2d66c5 FINDING source/README.md:13 T04 learn=verifier: vae prose check (T04) flags broken relative links.
2026-11-05T12:20:03Z s=8d2d66c5 FINDING public/assets/huggingdoom/PROVENANCE.md:31 T06 learn=verifier: vae prose check (T06).
2026-11-05T12:20:03Z s=8d2d66c5 FINDING source/engine/HUGGINGDOOM.md:73 learn=none: The audit needs a zig audit build and is not part of make test.
2026-11-05T12:20:03Z s=8d2d66c5 FINDING public/assets/huggingdoom/PROVENANCE.md + sounds/README.txt learn=none: Authorship and licence are the owner's facts; asked in the hand-off.
2026-11-05T12:20:03Z s=8d2d66c5 FINDING scripts/package-engine-source.py:14-23 learn=verifier: .vae/VERIFY.py engine.source-zip-fresh runs .vae/checks/engine-zip-fresh.py; checked both ways (edited source/README.md flagged, restored passes).
2026-11-05T12:20:03Z s=8d2d66c5 FINDING source/engine/HUGGINGDOOM.md:66 + source/README.md:39 learn=none: Documentation of a manual rebuild.
2026-11-05T12:20:03Z s=8d2d66c5 FINDING src/engine/arena.ts / arena.c episode cap learn=none: Intent is the owner's decision; a test would pin an unverified value.
2026-11-05T12:20:03Z s=8d2d66c5 FINDING src/app/revisions-panel.ts:CODE_FILES learn=none: No harness inspects fingerprint membership.
2026-11-05T12:20:03Z s=8d2d66c5 FINDING src/model/asset-cache.ts:loadModelChunk learn=test: tests/e2e/model-cache.spec.ts 'superseded' block fails without the call (checked by removing it from the build) and passes with it.
2026-11-05T12:20:03Z s=8d2d66c5 FINDING ARCH.md:35 B01 learn=none: Reading-level evidence scope.
2026-11-05T12:20:03Z s=8d2d66c5 FINDING README.md:67 B01 learn=none: Reading-level evidence scope.
2026-11-05T12:20:03Z s=8d2d66c5 FINDING src/revisions/reference.ts:14 learn=test: tests/unit/huggingdoom-revisions.test.ts asserts REFERENCE.ruleset === HUGGINGDOOM_RULESET.
2026-11-05T12:20:03Z s=8d2d66c5 FINDING src/app/revisions-panel.ts:1907 learn=none: Export format detail without a consumer test.
2026-11-05T12:20:03Z s=8d2d66c5 FINDING tests/e2e/huggingdoom.spec.ts:120,153 learn=test: The specs themselves now fail on those events.
2026-11-05T12:20:03Z s=8d2d66c5 FINDING src/app/main.ts touch controls + results tablist learn=test: tests/e2e/huggingdoom.spec.ts and tests/e2e/site.spec.ts.
2026-11-05T12:20:03Z s=8d2d66c5 FINDING src/index.html:257 + main.ts:28 learn=test: e2e finds the button by role and name 'Sound off'.
2026-11-05T12:20:03Z s=8d2d66c5 FINDING src/index.html:383,378 + main.ts:169 learn=test: e2e asserts getByRole('img', {name: '5 of 5 hearts'}) and getByRole('group', {name: 'Touch controls'}).
2026-11-05T12:20:03Z s=8d2d66c5 FINDING src/styles/huggingdoom.css:158-200 learn=none: No automated contrast check in the suite.
2026-11-05T12:20:03Z s=8d2d66c5 FINDING src/app/picnic-audio.ts:85 learn=none: Not covered by an e2e request assertion yet.
2026-11-05T12:20:03Z s=8d2d66c5 FINDING src/app/main.ts:233 learn=none: UI text branch.
2026-11-05T12:20:03Z s=8d2d66c5 FINDING src/app/main.ts:546-570 learn=none: Needs a missing built-in to reproduce.
2026-11-05T12:20:03Z s=8d2d66c5 FINDING src/app/picnic-audio.ts:dispose learn=none: Dead code.
2026-11-05T12:20:03Z s=8d2d66c5 FINDING src/styles/revisions-panel.css + portal.css learn=none: Dead code.
