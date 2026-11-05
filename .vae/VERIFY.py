"""Project-local verifier policy. Agents MAY extend it; every gate executes it fail-closed."""

CONFIG = {
    "coverage_min": 60,
    "lint_command": None,          # None → `make lint` (uv run ruff check . | bunx oxlint --deny-warnings).
    "test_command": None,          # None → `make test`. Commands run in the repo root.
    "coverage_command": None,      # None → `make coverage`; output needs `TOTAL <n>%` or an `All files |…|` table.
    "integration_commands": [],    # [] → `make integration` if present.
    "e2e_commands": [],            # [] → `make e2e`: build + consume the publishable artifact.
    "e2e_paths": [],               # globs e2e depends on, e.g. ["web/*"]: e2e reruns only when one (or a build file) changed; [] → any code file.
    "timeout_s": 180,
    # `init` on a GitHub remote writes .github/workflows/verify.yml (uv/bun via their official setup actions) unless a
    # workflow already runs `make verify`, these commands or every verify verb. None → make setup, make verify.
    "ci": None,                    # None | False (no CI workflow) | ["make setup", "make ci"] (one step each)
    "layout": True,                # Makefile verbs + gitignored secrets, runtime state, dist/, caches and package folders.
    "strict": True,               # docs.pages, gitignore and package block; False makes them warnings (a project created before 0.6.0 has False).
    "gitignore_exempt": [],        # required ignore lines this project may skip, e.g. ["dist/"] for a GitHub Action that commits its build.
    "toolchain": True,             # new (sub)projects start on bun (JS/TS) / uv (Python): newly added npm/yarn/pnpm/poetry/pipenv/pdm/pip lockfiles fail.
    # Static check of every changed doc page (*.md|*.mdx|*.markdown); False disables it.
    # allow: {glob: characters a page may use as house style}, e.g. {"docs/de/*.md": "\u201e\u201c"} for German quotes.
    # phrases: extra slop regexes (any language), case-insensitive, flagged as findings.
    # html: globs of HTML pages that are prose (a project site, e.g. ["docs/*.html"]), checked in their text and
    # reader-facing attributes; other HTML files (templates, reports) are code.
    # HYPOTHESIS: most projects need no allow entry; add one only for a page whose house style needs a flagged character.
    # README.md covers the root and each package with a changed CLI|API; ARCH.md each package with changed production code
    # or deployment|schema files. A page covers the folders below it up to the next package manifest; tests, examples,
    # docs, config and data need none.
    "readme": {"exclude": []},     # folder globs exempt from README.md coverage; False drops it (the root still needs one)
    "arch": {"exclude": []},       # folder globs exempt from ARCH.md coverage; False drops it
    # Changed package.json: packageManager, description, license, author; new packages also type, linter, library build.
    "package": {"manager": "bun", "type": "module", "lint": "oxlint", "library_build": "pkgroll"},  # False disables
    # Optional for edit runs (references/EDIT.md): "guidelines" (textsorte, zielgruppe, kommunikationsziel, hausstil,
    # geschuetzte_begriffe: terms a replacement must keep) and "edit" (max_part_chars, heading_depth, attempts, the
    # budgets, tool_scope, trace, max_tokens_total); unset keys keep pro-edit's defaults.
    # allow: the archived engine release README keeps its typography; AGENTS.md's arrows sit in defuss-vae's own managed block.
    "prose": {"allow": {"source/engine/README.md": "\u2019", "AGENTS.md": "\u2192"}, "phrases": [], "html": []},
}

# Deterministic invariants only; no semantic guesses.
# kinds: command | file_exists | contains | regex | not_regex
# When none of these can express an invariant (it needs parsing, several files, a running program or project
# semantics), plan the check like a test: write .vae/checks/<id>.py (stdlib, exits non-zero and prints what to fix)
# and add {"id": "<id>", "kind": "command", "command": "python3 .vae/checks/<id>.py", "claim": "..."}.
# scope: "path" = one exact file; "glob" = every changed code file matching (fnmatch); "glob" + "docs": True = every
# changed doc page matching, e.g. {"id": "docs.arch.diagram", "kind": "contains", "path": "docs/ARCHITECTURE.md",
# "text": "```mermaid", "claim": "architecture page keeps its diagram"}.
RULES = [{
    "id": "docs.build-fresh",
    "kind": "command",
    # docs/ is deployed as committed. tsc rewrites every emitted module on each build; copied files keep their source
    # mtimes (Bun cpSync), so they cannot mark the build. Regression: a gate started with a stale docs/, its own e2e
    # rebuilt it, and the fingerprint changed under the review attestation.
    "command": "test -f docs/app/main.js && test -z \"$(find src public -type f -newer docs/app/main.js | head -1)\" || { echo 'docs/ is older than src/ or public/: run make build'; exit 1; }",
    "claim": "the committed site in docs/ is built from the current src/ and public/",
}, {
    "id": "models.not-in-repo",
    "kind": "command",
    # The packs live on Hugging Face (src/shared/site.ts MODEL_PACK_URL); a copy under public/ would also land in docs/.
    "command": "test -z \"$(find public docs -name '*.pack' 2>/dev/null)\" || { echo 'model packs found under public/ or docs/: delete them; the site loads them from Hugging Face and tests use .cache/model (make models)'; exit 1; }",
    "claim": "model packs are not part of the repository or the built site",
}, {
    "id": "source.no-invisible-controls",
    "kind": "not_regex",
    "glob": "*.ts",
    # Escapes only, so this file never matches itself. Regression: a write turned the \u202a… escapes of a regex into literals.
    "pattern": r"[\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]",
    "claim": "TypeScript sources contain no literal bidirectional-override or zero-width characters; regexes spell them as escapes",
}, {
    "id": "tests.no-mocks",
    "kind": "not_regex",
    "glob": "*",
    # Every alternative contains an escape, so this file never matches its own pattern.
    "pattern": r"unittest\.mock|from\s+unittest\s+import\s+mock|MagicMock\(|mock\.patch|mocker\.|"
               r"jest\.(?:mock|fn|spyOn)\(|vi\.(?:mock|fn|spyOn)\(|sinon\.|gomock\.|mock\.Mock\b|Mockito\.|@Mock\s|mockk\(|"
               r"@Mock(?:ito)?Bean\b|new\s+Mock<|Mock\.Of<|Substitute\.For<|A\.Fake<|mockall:{2}|#\[automock\]",
    "claim": "tests exercise real subsystems, not mock frameworks",
}]
