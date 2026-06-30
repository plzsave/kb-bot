---
name: kiro-discovery-issue
description: GitHub issue 番号を渡すと、その本文を idea として kiro-discovery を実行する薄いラッパー。
allowed-tools: Bash(gh issue view:*), Read, Write, Glob, Grep, Agent, WebSearch, WebFetch, AskUserQuestion
argument-hint: <issue-number>
---

# kiro-discovery-issue Skill

下の「Issue 本文」は、コマンド実行時に `gh` で取得済みの GitHub issue #$ARGUMENTS の中身です（dynamic context injection によりこのテキストは確定済み・再取得不要）。

## やること
1. `.claude/skills/kiro-discovery/SKILL.md` を読み、その手順に従う。
2. 以下の「Issue 本文」を、kiro-discovery の `$ARGUMENTS`（= idea / request）として扱う。
3. それ以外は kiro-discovery と完全に同じ挙動（経路判定 → brief.md 作成 → 次の一歩の提示）。

## 起点 issue の記録（必須）
この作業は GitHub issue #$ARGUMENTS を起点とする。完了時に自動でクローズ・PR 紐づけできるよう、番号を必ず成果物に残すこと（CLAUDE.md「Issue-Sourced Work Linkage」参照）。
- **spec を作る経路（Path C/D/E）**: 作成する `brief.md` の `## Source` 欄に `GitHub issue #$ARGUMENTS` を記録する。
- **spec を作らない経路（Path A/B）**: brief.md が無いので、次の一歩の提示文に「起点 issue #$ARGUMENTS（完了時に `Closes #$ARGUMENTS` で紐づけ・クローズ）」を明記して引き継ぐ。

## Issue 本文（#$ARGUMENTS）
!`gh issue view $ARGUMENTS --json number,title,body -q '"# \(.title)\n\n\(.body)"'`
