# Agentic SDLC and Spec-Driven Development

Kiro-style Spec-Driven Development on an agentic SDLC

## Default Working Mode (READ FIRST — overrides the spec-driven workflow below)

**By default, do NOT use cc-sdd (the Kiro spec-driven flow / `/kiro-*` skills). Never invoke discovery or spec generation on your own initiative.**

For most work — debugging, tuning, small/medium changes — use this **lightweight loop**: hypothesis → **run it to check the premise first** → make the smallest change → verify → commit. Validate premises empirically *before* building mechanisms.

Use the spec-driven workflow (the sections below) **only when the user explicitly asks for it** — typically a large or high-uncertainty new feature. The "Spec-Driven Workflow", the 3-phase approval, and "invoke a skill if 1% relevant" all apply **only in that opt-in mode**, not by default.

Rationale: spec ceremony applied to small/exploratory work adds friction, can lock unvalidated premises behind a veneer of rigor, and makes churn look like progress. (See user memory `dev-process-lightweight-default`.)

## Project Context

### Paths
- Steering: `.kiro/steering/`
- Specs: `.kiro/specs/`

### Steering vs Specification

**Steering** (`.kiro/steering/`) - Guide AI with project-wide rules and context
**Specs** (`.kiro/specs/`) - Formalize development process for individual features

### Active Specifications
- Check `.kiro/specs/` for active specifications
- Use `/kiro-spec-status [feature-name]` to check progress

## Development Guidelines
- Think in English, generate responses in Japanese. All Markdown content written to project files (e.g., requirements.md, design.md, tasks.md, research.md, validation reports) MUST be written in the target language configured for this specification (see spec.json.language).

## Spec-Driven Workflow (opt-in — only when the user explicitly requests it)
- Phase 0 (optional): `/kiro-steering`, `/kiro-steering-custom`
- Discovery: `/kiro-discovery "idea"` — determines action path, writes brief.md + roadmap.md for multi-spec projects
- Phase 1 (Specification):
  - Single spec: `/kiro-spec-quick {feature} [--auto]` or step by step:
    - `/kiro-spec-init "description"`
    - `/kiro-spec-requirements {feature}`
    - `/kiro-validate-gap {feature}` (optional: for existing codebase)
    - `/kiro-spec-design {feature} [-y]`
    - `/kiro-validate-design {feature}` (optional: design review)
    - `/kiro-spec-tasks {feature} [-y]`
  - Multi-spec: `/kiro-spec-batch` — creates all specs from roadmap.md in parallel by dependency wave
- Phase 2 (Implementation): `/kiro-impl {feature} [tasks]`
  - Without task numbers: autonomous mode (subagent per task + independent review + final validation)
  - With task numbers: manual mode (selected tasks in main context, still reviewer-gated before completion)
  - `/kiro-validate-impl {feature}` (standalone re-validation)
- Progress check: `/kiro-spec-status {feature}` (use anytime)

## Skills Structure
Skills are located in `.claude/skills/kiro-*/SKILL.md`
- Each skill is a directory with a `SKILL.md` file
- Skills run inline with access to conversation context
- Skills may delegate parallel research to subagents for efficiency
- Additional files (templates, examples) can be added to skill directories
- `kiro-review` — task-local adversarial review protocol used by reviewer subagents
- `kiro-debug` — root-cause-first debug protocol used by debugger subagents
- `kiro-verify-completion` — fresh-evidence gate before success or completion claims
- **In opt-in spec-driven mode**, if there is even a 1% chance a kiro skill applies, invoke it. **In the default lightweight mode, do NOT auto-invoke the kiro spec skills** (`kiro-discovery`, `kiro-spec-*`, `kiro-impl`, etc.) — use them only when the user asks. Non-spec skills (e.g. `verify`) remain usable as normal.

## Development Rules
- (Spec-driven mode only) 3-phase approval workflow: Requirements → Design → Tasks → Implementation
- (Spec-driven mode only) Human review required each phase; use `-y` only for intentional fast-track
- Keep steering current and verify alignment with `/kiro-spec-status`
- Follow the user's instructions precisely, and within that scope act autonomously: gather the necessary context and complete the requested work end-to-end in this run, asking questions only when essential information is missing or the instructions are critically ambiguous.

## Issue-Sourced Work Linkage
When work originates from a GitHub issue (e.g., started via `/kiro-discovery-issue <n>`), close the loop on that issue automatically as part of finishing — do not leave it to the user to ask.
- **Record the source**: The originating issue number is captured in the spec's `brief.md` under `## Source` (e.g., `GitHub issue #28`). Treat that as the link target for the rest of the workflow. For no-spec paths (discovery Path A/B), carry the issue number forward explicitly in the next-step suggestion.
- **Link via the PR**: The PR that completes the work MUST include a closing keyword in its body (`Closes #<n>`). On merge, GitHub then auto-closes the issue and shows it as linked in the Development panel — no manual step needed.
- **If a merge slipped through without it**: add `Closes #<n>` to the (already-merged) PR body to establish the linkage, then close the issue manually with a brief completion comment (`gh issue close <n> --reason completed --comment ...`). Match the repo's PR/commit writing conventions (Japanese, concise, scope-explicit; reference the PR and merge commit).
- **Partial scope**: If the issue is only partially addressed (follow-on issues remain), do NOT auto-close; comment what was delivered and which issues continue the work, and leave it open.

## Steering Configuration
- Load entire `.kiro/steering/` as project memory
- Default files: `product.md`, `tech.md`, `structure.md`
- Custom files are supported (managed via `/kiro-steering-custom`)
