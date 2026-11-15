# Project Rules — ChemLab Studio (`virtual lab`)

## 1. Auto-Publish to GitHub on Completed Versions
- Whenever a new feature, milestone, or bugfix version is completed and verified in this workspace, **automatically commit and push** the changes to `origin/main` (`https://github.com/iamjulies/virtuallab.git`) without waiting for the user to ask.
- Before pushing:
  1. Ensure `git` and `gh` are available in `PATH` (on Windows PowerShell, refresh `Machine` + `User` `Path` environment variables if needed).
  2. Run verification (`tests/engine_verify.html` via local server / headless check when engine, species, reactions, or physics files change) and confirm all tests pass.
  3. If any new files were added or renamed, update the `ASSETS` precache list (and bump `CACHE_NAME`) in `sw.js` so PWA/GitHub Pages offline caching stays in sync.
  4. Never stage or commit secrets, tokens, or `.env`/credential files.
  5. Use clear Conventional Commit messages (e.g., `feat: ...`, `fix: ...`) and report the commit hash + live GitHub Pages URL (`https://iamjulies.github.io/virtuallab/`) in the final reply.

## 2. Project Design & Chemistry Invariants
- **Strict IUPAC Nomenclature:** All chemical names, element names, and foreign proper nouns in both `vi` and `en` UI strings (`src/data/i18n.js`, `src/data/species.js`, `src/data/reactions.js`) MUST use official IUPAC English spellings (never Vietnamese phonetic transliteration).
- **Bilingual, Theme & Device Parity:** Every UI addition must support both Vietnamese (`vi`) and English (`en`), `Light` and `Dark` themes (including Canvas rendering contrast), and `Desktop / Tablet / Mobile` responsive layouts.
- **Zero-Build Static / PWA Architecture:** Keep the codebase pure ES Modules + HTML5 Canvas + self-contained CSS with relative `./` paths so it deploys directly to GitHub Pages with zero build step.
