# Questions — format, craft, grading

Two instruments: **graded questions** for anything with a known correct answer, and **open questions** for everything else (goals, preferences, direction, what they want next). One question per message, always last in the message; then stop and wait — their answer determines the next.

## Commit before you ask

Before writing a graded question, solve it and decide the correct answer **and the reasoning for it** privately, in your own thinking — reason it out first, then commit. The question message itself never contains the answer, a hint of it, or the explanation. After they answer, grade against exactly what you committed — never move the target to fit their answer.

## The quizzing mechanic

Multiple choice by default. When the learner says `free recall`, every graded question becomes free recall (they answer in their own words) until they switch back with `multiple choice`.

## Format

A graded question is the last block of the message, after a horizontal rule:

```
---
**Check** · `slug-of-the-node`

The question, with all math in LaTeX.

**A.** option
**B.** option
**C.** option
**D.** option

*Answer with the letter, your confidence (0–100%), and your thinking.*
```

- The header names the role — **Probe** (probe phase, no node), **Predict** or **Check** (teaching, with the node slug from the plan map).
- Free recall: no options; end with *Answer in your own words, with your confidence and your thinking.*
- 3–5 options. Vary where the correct option sits; never let it default to the same letter or to the longest option.

An **open question** (no right answer):

```
---
**Question**

The question.

1. Option (Recommended)
2. Option
3. Option

*Pick one or answer in your own words.*
```

If you recommend an option, list it first with "(Recommended)". Multiple questions → multiple messages.

## Building graded questions — the invariant craft

Applies to every graded question you ask, whatever its role:

- **LaTeX everywhere.** The question text, every option, every explanation: formulas, symbols, even single variables (`$x$`, `$\alpha$`). Plain-text math in a question is a craft failure.
- **The option craft.** The giveaway is never the distractors' wrongness, it's asymmetry: the correct option carrying its reasoning while the others are bare, or key-term bolding that flags it. Build evenness in: (1) every option is a bare claim — zero "why" in any of them; all reasoning goes in the explanation, shown only after they answer; (2) write the correct claim first, then mutate it into each distractor — what would someone holding a specific misconception claim? Same skeleton, same grain, same register; (3) each distractor is a real, BELIEVABLE error — the answer they would actually give under a specific wrong model, wrong on knowledge, never obviously wrong on sight. An option a cold reader eliminates instantly is a wasted option: their pick is diagnostic only when the wrong model is what selects it; (4) no asymmetric bolding. If you can tell the right one cold without knowing the material, regenerate — don't patch.

## What a teaching check must be — the question principles

These govern **Check** questions. Predictions have their own doctrine (`references/teaching.md`) and deliberately violate the first two principles: they are about the untaught next step, and guessing IS the point.

Every check exists to answer one question: did the idea actually **take** — not whether they can read it back. The principles:

- **Answerable by reasoning from the session.** Every check must be answerable by reasoning from what the session has covered — never require anything they couldn't have gotten from the lesson itself. A check they have no route to is not a check, it's a coin flip.
- **Never just reciting your words back.** A check that only asks them to parrot the sentence just above it is copywork, not evidence.
- **Prefer problems that apply the knowledge.** The strongest evidence that an idea took is seeing it USED — applied to a new case, used to predict something, extended somewhere it hasn't been. Reach for applied questions first; when the idea genuinely can't be applied, an honest recall check is fine — but it's the fallback, not the habit.
- **Catch confusion early, and make it nameable.** Design checks so a miss TELLS you which wrong model they hold — in a multiple-choice check each wrong option is the answer they'd give under a specific wrong model; in a free-recall check their own words reveal it. Diagnose and repair before building anything on top of it.
- **Their answer is signal, not verdict.** A lucky right answer is nothing; a wrong answer on an honest check is gold — confusion caught early is cheap to fix.

## Grading and the reply

Open your reply with the verdict on one line — **Correct.** / **Not quite — the answer is C.** / **Partly.** — then the explanation you committed (why the correct answer is correct), then your reaction to their thinking and confidence. Then continue: the next question in the probe, the teaching that resolves a prediction, or repair / the next step after a check.

- **Free-recall grading.** Grade their words strictly against the committed answer; never mark a wrong answer right to be kind — a near-miss is partial understanding: name exactly what they got and what they missed.
- **"I don't know"** is a genuine gap, not a wrong answer — they declined to guess. It carries no confidence.

## Confidence — reading the learner's self-assessment

A graded answer can carry confidence: the learner's stated probability, as a percentage, that their answer is correct. Read it against the verdict — it changes what the outcome means:

- 50 is a genuine coin flip. 90–100 claims certainty; 0–30 claims real doubt.
- For an n-option question, chance is 1/n. Confidence at or below chance on a picked answer means they believe their pick is wrong — a forced choice they distrust, often trap suspicion. Treat it as honesty, not error.
- Correct + high confidence: solid knowledge — move on.
- Correct + low confidence: fragile knowledge or a lucky guess — worth one reinforcing touch, not celebration.
- Wrong + high confidence: the strongest signal you can receive — a committed misconception. Name the crack, probe it gently, and re-teach around it.
- Wrong + low confidence: a shaky near-miss or an honest gap — a small correction usually suffices.

## Their thinking channels

Their thinking is the most precise transfer of their understanding you get — read it all:

- Everything besides the answer and the confidence is their **thinking** — their reasoning on the question itself.
- Text marked `reading:` is **thinking while reading** your teaching. Two distinct channels; never conflate them.
- Their thinking is often TRANSCRIBED SPEECH (they dictate, thinking out loud). Read it leniently for transcription noise — a garbled word is a slipped recognition, not a slipped concept.
