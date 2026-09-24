# How to Propose the "Labels" Feature to Monochrome Upstream

A beginner-friendly, step-by-step guide for contributing your record-label
browse/save feature to **monochrome-music/monochrome**.

> Personal note for you — **do NOT include this file in your PR.** Keep it out of
> the branch you submit (or delete it first).

Everything below is checked against upstream's *real* `CONTRIBUTING.md`, their PR
template, and their CI — not generic advice.

---

## 0. The mental model (read this first)

Contributing to open source works like this:

```
  YOUR FORK                          UPSTREAM REPO
  (mtsbh/monochrome)                 (monochrome-music/monochrome)
        │                                    ▲
        │  1. make a branch                  │
        │  2. push it to YOUR fork           │
        │  3. open a "Pull Request" ─────────┘
        │     = "please pull my changes in"
        │
        └─ maintainers review → ask for tweaks → merge (or decline)
```

A **Pull Request (PR)** is just a polite, formal request:
*"Here are commits on my fork — would you merge them into yours?"*
The people who review/merge here are **Samidy** and **Valerie** (`atvalerie`).

**Two things you are NOT doing:**
- You're *not* uploading your personal data (your 197 labels, playlists). Those
  stay yours. You contribute the *feature* so anyone can save labels.
- You're *not* pushing to upstream directly (you can't). You push to *your fork*,
  then *request* a merge.

---

## ⚠️ 1. Two rules from THEIR contributing guide you must respect

I read their `CONTRIBUTING.md`. Two things matter a lot for you:

### Rule 1 — "Consult on Major Features" BEFORE coding
> *"If you're looking into contributing a big feature, please speak with us
> before starting work... via a GitHub Issue or on our Discord."*

A label feature is a "big feature." So **Phase A (ask first) is not optional
politeness — it's their stated process.** Reach them via:
- A GitHub Issue, **and/or**
- Their Discord: **https://monochrome.tf/discord**

### Rule 2 — Zero-tolerance "AI slop" policy
> *"We have a zero-tolerance policy for Vibecoding... If we can verify that a PR
> is just unvetted AI/Vibecoded work, it will be automatically closed without
> review. If you can't explain your code, it doesn't belong in Monochrome."*

This is critical because the label code was written/refined with AI help. To stay
on the right side of their policy:
- **Understand every line** before you submit. Read through `label-utils.js` and
  the `renderLabelsPage`/`renderLabelPage` logic until you could explain it.
- They explicitly **allow** AI as a tool *and* allow saying you used it. So in
  your PR, a line like *"I used AI to help refactor the copyright-parsing regex;
  I've reviewed and tested every rule"* is honest and permitted.
- Be ready to answer "why does this regex do X?" in review.

They also **recommend opening Draft PRs early** so they can catch issues before
you over-invest. We'll use that below.

---

## 2. Why split this into TWO contributions

Your label feature has two layers:

| Layer | Files | Needs your PocketBase? |
|-------|-------|------------------------|
| **Browse + save (core)** | `js/label-utils.js`, label code in `js/ui.js`, routes in `js/router.js`, Qobuz proxies in `functions/` + `netlify/functions/`, markup in `index.html` | ❌ No — pure `localStorage` |
| **Cloud sync of labels** | `js/accounts/pocketbase.js` (`saved_labels`) | ✅ Yes |

Upstream **removed PocketBase**, so a PR containing the cloud-sync layer can't be
merged as-is. The plan:

- **Phase A** — Ask first (GitHub Issue + Discord). *Required by their guide.*
- **Phase B** — If yes, open a **Draft PR** with just the **core** (localStorage).
- **Phase C** *(optional, later)* — Add cloud sync adapted to *their* system.

---

## 3. PHASE A — Ask first (Issue + Discord)

### Steps

1. Go to **https://github.com/monochrome-music/monochrome/issues**
2. Click the green **`New issue`** button (top-right).

   ```
   ┌─────────────────────────────────────────────────────────┐
   │  Issues   Pull requests   ...            [ New issue ]   │  ← click
   └─────────────────────────────────────────────────────────┘
   ```

3. They have a *Bug Report* template — since this is an enhancement, choose
   **"Open a blank issue"** at the bottom of the template chooser.
4. **Title:**
   ```
   Feature: Browse & save record labels (Qobuz catalog by label)
   ```
5. **Body:** paste the text from §6 below.
6. **Label:** add `enhancement` (right sidebar → Labels). If you can't set
   labels, a maintainer will.
7. **Attach a screenshot** (big impact — see §5).
8. Click **`Submit new issue`** and **write down the issue number** (e.g. `#681`).
9. *(Recommended)* Also drop a short message in their **Discord
   (https://monochrome.tf/discord)** linking the issue — their guide points there
   for feature discussion, and you'll usually get a faster read.
10. **Wait for a 👍 / "go ahead"** before building the PR. Volunteers — give it
    days, bump politely after ~a week.

---

## 4. PHASE B — Prepare and submit the code (Draft PR)

Start once a maintainer signals interest.

### B1. Branch from upstream's latest `main`
Their guide: *"create your branch from `main`."* Don't PR from your messy merged
`main`. Start clean:

```bash
git fetch upstream
git checkout -b feature/label-browse upstream/main
```

This branch starts exactly at *their* current code, so the PR contains **only**
label changes — none of your fork's other stuff (Android Auto, PocketBase, etc.).

### B2. Add ONLY the label files
Self-contained files to copy in:

```
js/label-utils.js                  copyright → label-name parser
functions/api/label/index.js       Qobuz label catalog proxy
netlify/functions/label.js         same, Netlify flavor
netlify/functions/label-art.js     Discogs label artwork
netlify/functions/qobuz-album.js   album lookup helper
```

Shared-file edits (hand-copy just these blocks):
- `js/ui.js` → `renderLabelsPage()`, `renderLabelPage()`,
  `getSavedLabels/saveLabel/unsaveLabel/isLabelSaved`, the label-art cache
  helpers, and the `import { extractLabelName }` line.
- `js/router.js` → the `labels`, `label`, `label-id` switch cases.
- `index.html` → the `page-labels` + `page-label` sections + the sidebar
  "Labels" nav link.

### B3. Decouple from PocketBase (important)
In `js/ui.js`, saving currently pushes to your cloud:

```js
_persistSavedLabels(labels) {
    localStorage.setItem('saved_labels', JSON.stringify(labels));
    if (authManager.user) syncManager.setSavedLabels(labels).catch(() => {}); // ← DELETE for the PR
}
```

For the first PR, **delete that second line** and **omit
`loadSavedLabelsFromCloud()`**. Labels still work 100% on localStorage. Cloud
sync becomes the optional Phase C follow-up.

### B4. Lint, format, build (REQUIRED — their CI runs these)
Their guide: *"A GitHub Action automatically runs `bun run lint` on every push
and pull request."* And their checklist asks you to self-review and test.

```bash
bun install            # first time only
bun run format         # Prettier auto-format
bun run lint           # ESLint + Stylelint + HTMLHint — must pass clean
bun run build          # confirm it builds
bun run dev            # open app → click Labels → search/save a label → verify
```

Fix anything lint flags before continuing.

### B5. Commit using THEIR style — Conventional Commits
Their guide mandates **Conventional Commits**: `type(scope): description`,
present tense, imperative, no capital first letter, no trailing period, ≤72 chars.
Good scopes they list include `ui`, `api`, `library`. Example:

```bash
git add js/label-utils.js functions/api/label/ netlify/functions/label.js \
        netlify/functions/label-art.js netlify/functions/qobuz-album.js \
        js/ui.js js/router.js index.html
git commit -m "feat(library): add record label browse & save"
```

### B6. Push to YOUR fork
```bash
git push origin feature/label-browse
```
> Pushes to **origin** (`mtsbh/monochrome`) — never upstream. Correct.

### B7. Open a DRAFT Pull Request
Their guide explicitly recommends **Draft PRs early**.

1. After pushing, your fork shows a banner: **"feature/label-browse had recent
   pushes — [Compare & pull request]"** → click it.
2. Check direction:
   ```
   base: monochrome-music/monochrome  : main          ← INTO their main
   head: mtsbh/monochrome : feature/label-browse        ← FROM your branch
   ```
3. **Title:** `feat(library): add record label browse & save`
4. **Description:** GitHub auto-loads *their* PR template. Fill it per §7.
5. **Click the dropdown arrow next to the green button → choose
   "Create draft pull request."**

   ```
   ┌──────────────────────────────────────────────┐
   │  [ Create pull request  ▾ ]                   │
   │      └─ Create draft pull request   ← pick    │
   └──────────────────────────────────────────────┘
   ```

6. Watch the **checks** box. CI runs Lint + Tests:
   - ✅ green = good.
   - ❌ red = click **Details**, read error, fix locally, then `git commit` +
     `git push origin feature/label-browse`. The PR updates automatically.
7. When you're confident and CI is green, click **"Ready for review"** to take it
   out of draft.

> Their merge process needs **sign-off from two developers**, and they may
> request changes. Expect a round or two — totally normal.

---

## 5. How to attach screenshots ("photos")

A shot of your Labels page (197 saved looks great!) sells the proposal.

1. Capture: **`Win + Shift + S`**, drag a box → copied to clipboard.
2. In any GitHub text box, just **paste** (`Ctrl + V`) — GitHub uploads it and
   inserts the image. (Or drag the image file in.)
3. Good shots: the Labels page (saved grid/list) + a single label's Qobuz catalog.

---

## 6. Copy-paste: Issue text (Phase A)

```markdown
## Feature: Browse & save record labels

### What it does
Adds a **Labels** page. Paste a Qobuz label URL (or a label name) and it shows
that label's full album catalog from the Qobuz API. You can **save** labels and
revisit them later in a grid/list view, with label artwork.

### Why it's useful
Discovery-by-label is big for electronic, jazz, and indie, where the label is a
strong taste signal. There's currently no way to follow a label in Monochrome.

### Screenshots
<!-- paste your Labels page + a label catalog page here -->

### Implementation status
I have this working in my fork, split into two layers:

1. **Browse + save (core)** — self-contained, `localStorage` only, no dependency
   on the account/auth system. This is what I'd submit first as a focused PR.
2. **Cloud sync** (optional, later) — syncs saved labels across devices. I built
   it on the old PocketBase backend; I can adapt it to the current `/api/sync`
   model in a follow-up PR if you want it.

Core files: `js/label-utils.js` (a copyright→label-name parser with documented
rules), label rendering in `js/ui.js`, routes in `js/router.js`, and Qobuz/Discogs
proxies under `functions/` + `netlify/functions/`.

### Note on AI use
I used AI as a tool to help refactor the copyright-parsing regex and clean up
code; I've reviewed and tested every line and can explain how it works.

### Question
Would you accept a PR for the localStorage-only core? Happy to match your
conventions and adjust anything.
```

---

## 7. Copy-paste: PR description (Phase B)

Their PR template has sections like Description / Related Issue / Type of Change /
Checklist. Fill them like this:

```markdown
## Description

Adds a Labels feature: browse a record label's Qobuz catalog and save labels for
later. Saving is localStorage-only, so there's no dependency on the account/auth
system.

- New `/labels` page: saved list with grid/list toggle and a search box.
- Label pages `/label/:name` and `/label-id/:id` with "Load more" pagination.
- `js/label-utils.js` parses a label name out of freeform copyright strings
  (documented regex rules + by-example tests in comments).
- Proxies under `functions/` / `netlify/functions/` call the Qobuz label API and
  Discogs for label artwork.

This PR intentionally excludes cloud sync of saved labels (it depended on the old
PocketBase backend). Happy to follow up with a version adapted to the current
`/api/sync` model if desired.

I used AI as a tool to help refactor parts of this; I've reviewed and tested
every line and can explain it.

## Related Issue

Closes #<ISSUE_NUMBER>

## Type of Change

- [x] New feature (non-breaking change which adds functionality)

## Checklist

- [x] My code follows the style guidelines of this project
- [x] I have performed a self-review of my own code
- [x] I have commented my code, particularly in hard-to-understand areas
- [x] I have tested my changes
- [x] My changes generate no new warnings
- [x] I have read the CONTRIBUTING document
```

---

## 8. Etiquette & expectations

- **Ask before building** — it's their rule, not just manners.
- **Be patient** — volunteers; days of silence is normal.
- **Two reviewers required** to merge.
- **Be open to changes / rejection** — their guide literally says "No Hard
  Feelings"; a closed PR often just means they're working on something similar.
  Your fork keeps the feature regardless.
- **Own your code** — be able to explain every line (AI-slop policy).
- **Keep it focused** — one feature, no unrelated fork changes.

---

## 9. Quick reference — the whole flow

```
Phase A:  New Issue (label: enhancement) + ping Discord → wait for 👍
Phase B:  git fetch upstream
          git checkout -b feature/label-browse upstream/main
          add label files; delete the syncManager.setSavedLabels line
          bun run format && bun run lint && bun run build   (all must pass)
          bun run dev                                        (manually verify)
          git commit -m "feat(library): add record label browse & save"
          git push origin feature/label-browse
          open DRAFT PR: monochrome-music/monochrome:main ⬅ mtsbh:feature/label-browse
          fill their template, Closes #<issue>; fix CI; "Ready for review"
          wait for 2 reviewers
Phase C:  (optional) follow-up PR: cloud sync via /api/sync
```

---

*Want help with Phase B?* The decoupling (B2–B4) is the fiddly part. I can build
the clean `feature/label-browse` branch for you — files copied, PocketBase calls
stripped, `format`/`lint`/`build` passing, app verified — ready for you to review
and push. Just ask.
