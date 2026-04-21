# Wiki maintenance

How the [TitanX Wiki](https://github.com/CES-Ltd/TitanX/wiki) is organized, edited, and kept in sync with the codebase.

---

## What the wiki is (and isn't)

The wiki is **human-facing documentation**: installation, guided tutorials, conceptual overviews, and help content. It complements — rather than duplicates — the `/docs` folder, which holds canonical technical specs, ADRs, and contributor conventions.

| Topic                                                                   | Belongs in...                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| "How do I install TitanX?"                                              | **Wiki**                                                            |
| "What's the ADR for moving Queen drift detection into its own service?" | **`/docs/adr`**                                                     |
| "What's the fleet command envelope format?"                             | **Wiki (summary)** + **`/docs/feature/fleet`** (authoritative spec) |
| "How do I set up the dev environment?"                                  | **Wiki (guided)** + **`/docs/development.md`** (reference)          |
| "How does this specific test work?"                                     | **Code comments** + **`/docs/conventions/*`**                       |

**Rule:** when a topic has a canonical source in the repo, the wiki summarizes + links out. Wiki never becomes the source of truth for anything code-reviewed.

---

## Editing the wiki

Two ways:

### 1. Web UI (fast, for small edits)

Go to [github.com/CES-Ltd/TitanX/wiki](https://github.com/CES-Ltd/TitanX/wiki), find the page, click **Edit**. Commits go straight to the wiki's git remote.

### 2. Git clone (recommended for new pages + bulk edits)

```bash
git clone https://github.com/CES-Ltd/TitanX.wiki.git
cd TitanX.wiki
# edit pages as .md files
git add .
git commit -m "docs(wiki): <what you changed>"
git push origin master
```

The wiki has a default branch of `master` (GitHub-imposed), not `main`. Don't @#$% with that.

**Important:** the wiki repo is **not** the same as the main repo. It's a sibling at `.wiki.git`. Edits don't go through PRs — they publish immediately.

---

## Who can edit?

Settings at [Settings → Features → Wiki](https://github.com/CES-Ltd/TitanX/settings) control this:

- **Restrict editing to contributors only** (current setting): only repo collaborators can push. External users can still propose changes via the "Suggest a change" flow.
- **Everyone**: public edits allowed. Useful for a community wiki, risky for an enterprise one.

Current setting: **contributors only**.

---

## File naming + structure

GitHub wikis are flat — no folders. Page names become URLs via:

- Spaces → hyphens: `Fleet Mode Overview` → `Fleet-Mode-Overview`
- Filenames use hyphens: `Fleet-Mode-Overview.md`
- Links use `[[Page Name]]` (with spaces) or `[label](Page-Name)` (with hyphens)

Two reserved filenames:

- `_Sidebar.md` — left navigation
- `_Footer.md` — appears below every page

Both support Markdown and auto-render.

---

## Voice + tone

| Section                                              | Voice                            | Example                                                                     |
| ---------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| Home, Getting Started, First Launch, Your First Team | **Founder ("I")**                | "We just shipped this — here's how to try it."                              |
| Core Concepts, Fleet Mode, Dream Mode, Security      | **Product (third-person)**       | "TitanX captures every trajectory…"                                         |
| Reference pages (Configuration Keys, Env Vars, etc.) | **Neutral technical**            | "The following environment variables are honored by the slave push worker." |
| Troubleshooting, FAQ                                 | **Conversational second-person** | "If you see X, check Y."                                                    |

Keep it. Consistency across a page is more important than matching tone perfectly — just don't swap voices mid-page.

---

## Images + assets

**Host in the main repo, reference from the wiki with raw URLs.**

Why: GitHub wikis don't support LFS, and uploading binaries to wiki pages via the web UI produces ugly `...wiki/uploads/...` URLs that break on wiki disable.

Canonical pattern:

```markdown
<img src="https://github.com/CES-Ltd/TitanX/raw/main/docs/diagrams/dream-mode.gif" alt="Dream Mode" width="820">
```

Asset locations in the main repo:

- `docs/diagrams/*.gif` — animated architecture diagrams
- `docs/screenshots/*.png` — UI screenshots
- `docs/screenshots/titanx-architecture-v2.gif` — the original animated architecture

When you add a new image, commit it to the main repo first (normal PR), then reference it from the wiki.

---

## Sync strategy (staying current)

### Per release

For every minor release (v2.6, v2.7, …) run a 20-minute audit:

1. **Home.md footer** — bump "Last updated for **vX.Y.Z**"
2. **Installation.md** — update filenames + sizes + SHA256 hints
3. **Release Notes wiki page** — add the new version's summary + link to full GitHub release
4. **Reference pages** (Configuration Keys, Env Variables, Database Schema, Fleet Command Types) — audit for new flags, commands, columns
5. **Feature pages** (Fleet / Dream / specific feature docs) — if the release added or changed a feature, update the relevant page
6. **FAQ.md** — pull any new frequently-asked questions from GitHub Issues

For patch releases (v2.5.1, v2.5.2, …) usually just the footer.

### On feature PR merge

If a PR adds a user-visible feature, the PR description should reference which wiki page(s) need updating. Merge the PR → update the wiki same day.

### Stale-content check

Quarterly: open every wiki page, skim, ask "is this still true?" Any content referencing code that's moved, renamed, or removed → fix or delete.

---

## Page-to-canonical-source map

Wiki pages that link out to authoritative sources in the main repo:

| Wiki page                 | Canonical source                                                            |
| ------------------------- | --------------------------------------------------------------------------- |
| [[Fleet Mode Overview]]   | [`/docs/feature/fleet/README.md`](docs/feature/fleet/README.md)             |
| [[Architecture Overview]] | [`/docs/tech/architecture.md`](docs/tech/architecture.md)                   |
| [[Development Setup]]     | [`/docs/development.md`](docs/development.md)                               |
| [[Project Structure]]     | [`/docs/conventions/file-structure.md`](docs/conventions/file-structure.md) |
| [[Code Conventions]]      | [`AGENTS.md`](AGENTS.md)                                                    |
| [[Testing]]               | [`.claude/skills/testing/SKILL.md`](.claude/skills/testing/)                |
| [[Pull Request Workflow]] | [`.claude/skills/oss-pr/SKILL.md`](.claude/skills/oss-pr/)                  |
| [[IAM Policies]]          | [`/docs/feature/iam/README.md`](docs/feature/iam/)                          |

When the canonical source changes, the wiki summary may drift — that's OK for minor detail, not OK for the high-level claim (e.g., the wiki saying "slaves poll every 30s" when we change the default to 60s).

---

## Phased rollout

The wiki ships in two phases:

### Phase 1 (shipped with this doc — 12 pages)

The "evaluator + first-time user" journey end-to-end:

- Home
- Installation
- First Launch
- Your First Team
- Architecture Overview
- Agents and Teams
- Fleet Mode Overview
- Dream Mode Overview
- Security Model
- Development Setup
- Troubleshooting
- FAQ
- \_Sidebar + \_Footer

### Phase 2 (to land incrementally — ~45 more pages)

Full reference + all feature-specific guides. Each page self-contained; add them as scope justifies. See the wiki plan in the original wiki-plan discussion for the full list.

---

## Who owns the wiki?

**You do** (or whoever the current maintainer is).

GitHub wiki edits are not PR-gated, so there's no review safety net. Two mitigations:

1. Use the git-clone flow for anything non-trivial → local diff review before push
2. Pair-review large rewrites via a pull-request-like flow: clone to a branch, share a patch, merge after feedback

For community contributions, direct contributors to this doc — the editing mechanics are unusual enough that a simple "edit on GitHub" button doesn't explain the commit flow.

---

## Quick commands

```bash
# Clone
git clone https://github.com/CES-Ltd/TitanX.wiki.git ~/titanx-wiki
cd ~/titanx-wiki

# Pull latest
git pull origin master

# Edit a page (example: FAQ)
vim FAQ.md
# or
code FAQ.md

# Preview locally (grip — pip install grip)
grip FAQ.md

# Commit + push
git add FAQ.md
git commit -m "docs(wiki): add question about Dream Mode cost cap"
git push origin master
```

Changes go live on the wiki instantly — no build, no PR, no CI.

---

## Questions about the wiki itself?

[Open a discussion](https://github.com/CES-Ltd/TitanX/discussions) rather than an issue — wiki changes usually aren't bugs.
