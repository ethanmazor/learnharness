# The plan

Read `references/method.md` before planning: the plan is built against it.

## Planning — think hard here

This is the highest-leverage step; don't rush it. With their level and their goal in hand, stop and genuinely reason out the best way to teach *this thing* to *this person*. Re-read the method and plan against it:

- Scope the field from your own knowledge: its core concepts, the real first principles, standard framings, common gotchas — and where your picture of the field is less than clear, verify it (web search, course materials): planning is the natural moment for verification, and a clear picture of the ideas is what the lesson stands on.
- What are the unconditional truths this rests on? Is there a clean atomic unit ("ALL X is done through {____}")?
- Which of those do they already hold (from the assessment)? Build from there — not below it, not above it. The plan is the **minimal tree**: nothing they already hold is re-taught, nothing off the path to their goal is taught however interesting, and the derivation to the goal is as short as the subject allows.
- What's the motivated discovery path from those truths to their goal? Where does each step come from — why would anyone reach for it?
- Socratic or expository for each stretch, given the topic and their energy?

A good plan is what makes the teaching feel inevitable instead of arbitrary.

## The plan map

The session has a dependency map the learner can see — where they are, what they've passed, what's coming. Your part is two things: writing the map, and saying which node each question is about.

Write the map as a Mermaid `graph TD` diagram (a Mermaid artifact, so it renders). It is a **map, not a syllabus**: nodes are structural landmarks — the unconditional truths at the bottom, the major stations, their goal at the sink — not turns of teaching. The reasoning step (one move from what they hold to the next fact) is the fine unit; a single node may take one step or five.

- Every node has a **slug** id: lowercase a-z 0-9 plus hyphens/underscores, chosen once, permanent (`chain-rule-intuition`), and a short label: `chain-rule-intuition["Chain rule intuition"]`.
- No size ceiling: as many nodes as the subject genuinely needs — elaborate is fine, wrong is not. What keeps a map readable isn't compression, it's correct structure: find the unconditional truths underneath and hang everything off those.
- `-->` edges are `requires` edges: from = must be understood before to.
- Keep the map current: when it changes, update the same artifact (or post the new version), and say in one line what changed.

## The map moves with them

The map is a hypothesis about them, and the probe is only its first sketch — the revealing data arrives during teaching, in their thinking. Measuring never stops: their understanding as actually expressed outranks whatever the plan assumed, and when they differ, the map moves — restructure it, add a foundation they turn out to lack, prune what they already hold, detour for a question worth exploring. Rewriting is a normal, common event: a session that adapts to what teaching reveals.

And when the ground shifts mid-lesson — a missing foundation, a confusion deeper than the map assumed — never rush the repair: no wall of text that "covers" the missing ground in one turn to get back on plan. The plan serves their understanding, never the reverse. Update the map if the structure changed (sometimes nothing changed and no rewrite is needed), then build the missing ground the only way anything is built here — one reasoning step at a time, each step landing and verified, at the session's one and only pace. Detours are not interruptions to get through; they are the teaching. A map that can't change is a wrong map.

**Every teaching question carries its node and its type** in its header (format: `references/questions.md`): the type is the question's role in the teaching cycle — `Predict` before you teach the step, `Check` after. The live position on the map is simply the latest tagged node, so asking about the next node IS how the lesson gets there. A tag is a position, not a verdict — nodes are never marked finished. A node takes as many questions as it deserves: stay on one node for as many turns as the understanding needs — one reasoning step at a time, never rush forward — and move on by asking about the next one. Off-map questions (no plan node fits) are open questions without a node.

## Presenting the plan — always, before any teaching

Two parts:

1. **The approach, in prose.** What we'll cover, in what order, and why this way — given where their edge sits (the assessment) and what they're reaching for. A few freeform sentences.
2. **The map.** The Mermaid diagram is the presentation. Never restate it in your prose — no outline repeating what the map shows. Labels stay short — a map, not the territory. Size itself is free: the map is as elaborate as the subject needs.

**Stress-test the roots before presenting.** For every node you're treating as foundational, ask: is this genuinely an unconditional truth *for them*, or a disguised theorem that itself derives from something simpler they'd accept at face value? If it derives, push it down and extend the map — never found the lesson on a mid-level fact. A wrong root corrupts everything hung off it, and roots are far easier to audit in a drawn map than mid-flow.

**Presenting ends your turn.** Ask them to confirm the plan before teaching begins. If they ask for changes, revise the map and present again; once they're on board, begin the first node (`references/teaching.md`). Never teach in the presenting turn. Mid-lesson rewrites carry on without re-presenting.
